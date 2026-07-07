// Bridges mpv's file reads to the cache worker. Two adapters:
//
//  1. mountVirtualFile() — registers the mount so the engine can resolve it:
//     the externalfs backend loads a *real* FileSystemDirectoryHandle from
//     IndexedDB ('externalfs_db'; duck-typed objects are rejected — instanceof
//     check in addDirectory + structured clone into IDB), then opens files via
//     parentHandle.getFileHandle(name) → getFile() → Blob and serves reads as
//     `blob.slice(pos, pos+len)` → `await slice.arrayBuffer()`.
//     CRITICAL (verified live 2026-07): that backend JS executes on the
//     ENGINE'S OWN PTHREAD WORKERS (upstream proxies every open to its C++
//     "side thread"), NOT on the main thread. The main-thread getFile patch
//     below therefore never fires for real playback — the interception that
//     matters is injected into every pthread worker via pthread-patch.js
//     (mainScriptUrlOrBlob Blob wrapper), and reads travel to the cache
//     worker over a BroadcastChannel. This module's patch is kept as
//     defense-in-depth for builds that do open on the main thread.
//
//  2. attachLegacyFsNode() — fallback for custom builds WITHOUT -sWASMFS:
//     the classic Emscripten JS-FS node whose stream_ops.read() blocks on the
//     SAB rendezvous via createSyncReader() (Atomics.wait in workers, spin
//     with a logged warning if it ever lands on the main thread).

import {
	views,
	storeOffset,
	IDX_STATE,
	IDX_LENGTH,
	IDX_RESULT,
	STATE_IDLE,
	STATE_REQUEST,
	STATE_ERROR,
	STATE_CLOSED,
	ERR_TIMEOUT,
	ERR_CLOSED
} from './sab-protocol.js';

const DEFAULT_TIMEOUT_MS = 20_000;

export class MpvBridgeError extends Error {
	/** @param {string} message @param {number} [code] */
	constructor(message, code = 0) {
		super(message);
		this.name = 'MpvBridgeError';
		this.code = code;
	}
}

/**
 * @typedef {Object} SyncReader
 * @property {number} fileSize
 * @property {(position: number, target: Uint8Array) => number} read
 *   Blocking read of target.byteLength bytes at position; returns bytes read
 *   (0 at EOF, short only at EOF). Splits requests larger than the SAB
 *   payload region transparently.
 */

/**
 * Reader-side endpoint of the rendezvous. Safe to construct anywhere; read()
 * must run on a thread that may block (any worker) — main-thread use spins
 * and warns.
 * @param {{ sab: SharedArrayBuffer, fileSize: number, timeoutMs?: number }} opts
 * @returns {SyncReader}
 */
export function createSyncReader({ sab, fileSize, timeoutMs = DEFAULT_TIMEOUT_MS }) {
	const { i32, payload } = views(sab);
	let warnedSpin = false;

	/** Block until IDX_STATE leaves STATE_REQUEST; returns the new state. */
	function awaitResponse() {
		// Decide per call: what matters is the thread read() runs on, which is
		// wherever mpv's FS layer invokes the handle — not where it was built.
		const onMainThread = typeof window !== 'undefined';
		const deadline = performance.now() + timeoutMs;
		if (!onMainThread) {
			while (performance.now() < deadline) {
				const left = deadline - performance.now();
				Atomics.wait(i32, IDX_STATE, STATE_REQUEST, Math.max(1, left));
				const stateNow = Atomics.load(i32, IDX_STATE);
				if (stateNow !== STATE_REQUEST) return stateNow;
			}
			return STATE_REQUEST;
		}
		if (!warnedSpin) {
			warnedSpin = true;
			console.warn(
				'[mpv-bridge] read() is running on the main thread — falling back to a spin ' +
					'wait. Playback will work but jank; see README "thread placement" notes.'
			);
		}
		for (;;) {
			const stateNow = Atomics.load(i32, IDX_STATE);
			if (stateNow !== STATE_REQUEST) return stateNow;
			if (performance.now() >= deadline) return STATE_REQUEST;
		}
	}

	/** One protocol round trip for length ≤ payload size. */
	function readPiece(position, target) {
		if (Atomics.load(i32, IDX_STATE) === STATE_CLOSED) {
			throw new MpvBridgeError('cache worker is closed', ERR_CLOSED);
		}
		storeOffset(i32, position);
		i32[IDX_LENGTH] = target.byteLength;
		Atomics.store(i32, IDX_STATE, STATE_REQUEST);
		Atomics.notify(i32, IDX_STATE);

		const stateNow = awaitResponse();
		if (stateNow === STATE_REQUEST) {
			throw new MpvBridgeError(`read timed out after ${timeoutMs}ms`, ERR_TIMEOUT);
		}
		if (stateNow === STATE_CLOSED) {
			throw new MpvBridgeError('cache worker closed mid-read', ERR_CLOSED);
		}
		if (stateNow === STATE_ERROR) {
			const code = i32[IDX_RESULT];
			Atomics.store(i32, IDX_STATE, STATE_IDLE);
			throw new MpvBridgeError(`cache worker reported error ${code}`, code);
		}
		// STATE_RESPONSE
		const n = i32[IDX_RESULT];
		target.set(payload.subarray(0, n));
		Atomics.store(i32, IDX_STATE, STATE_IDLE);
		return n;
	}

	return {
		fileSize,
		read(position, target) {
			let done = 0;
			while (done < target.byteLength) {
				const piece = target.subarray(done, Math.min(target.byteLength, done + payload.byteLength));
				const n = readPiece(position + done, piece);
				done += n;
				if (n < piece.byteLength) break; // EOF
			}
			return done;
		}
	};
}

/**
 * Adapter 1 — classic Emscripten JS FS (non-WASMFS builds only).
 *
 * Creates `path` as a regular file node whose stat reports the real remote
 * size (so mpv's demuxer can seek anywhere immediately) and whose stream_ops
 * pull bytes through the sync reader. Mirrors FS.createLazyFile's structure,
 * which is the long-standing documented pattern for custom-backed nodes.
 *
 * @param {any} Module Emscripten module exposing the legacy `FS` object
 * @param {{ path?: string, reader: SyncReader }} opts
 * @returns {string} the absolute FS path mpv should open
 */
export function attachLegacyFsNode(Module, { path = '/stream/video.mkv', reader }) {
	const FS = Module?.FS;
	if (!FS || typeof FS.create !== 'function') {
		throw new MpvBridgeError(
			'Module.FS is unavailable — this build uses WASMFS (upstream default); ' +
				'use mountExternalFsFile() instead, or rebuild without -sWASMFS.'
		);
	}

	const dir = path.slice(0, path.lastIndexOf('/')) || '/';
	const name = path.slice(path.lastIndexOf('/') + 1);
	if (dir !== '/') FS.mkdirTree ? FS.mkdirTree(dir) : FS.createPath('/', dir.slice(1), true, true);

	const node = FS.create(path, 0o444);
	node.usedBytes = reader.fileSize;

	const getattr = node.node_ops.getattr;
	node.node_ops = {
		...node.node_ops,
		getattr(n) {
			const attr = getattr(n);
			attr.size = reader.fileSize;
			return attr;
		}
	};
	node.stream_ops = {
		...node.stream_ops,
		/**
		 * @param {any} stream @param {Uint8Array} buffer heap view
		 * @param {number} offset into buffer @param {number} length
		 * @param {number} position byte offset in the file
		 */
		read(stream, buffer, offset, length, position) {
			if (position >= reader.fileSize) return 0;
			const want = Math.min(length, reader.fileSize - position);
			return reader.read(position, buffer.subarray(offset, offset + want));
		},
		llseek(stream, offset, whence) {
			let position = offset;
			if (whence === 1) position += stream.position;
			else if (whence === 2) position += reader.fileSize;
			if (position < 0) throw new FS.ErrnoError(28); // EINVAL
			return position;
		}
	};
	return path;
}

// --- Adapter 1: virtual Blob behind the real externalfs backend ---------------

const MOUNT_DIR = 'sveltefin-mount';

/** Sentinel filenames whose getFile() is redirected to a virtual Blob. */
const virtualFiles = new Map();
let getFilePatched = false;
/** @type {((...args: any[]) => Promise<File>) | null} */
let originalGetFile = null;

function installGetFilePatch() {
	if (getFilePatched) return;
	if (typeof FileSystemFileHandle === 'undefined') {
		throw new MpvBridgeError('FileSystemFileHandle is unavailable in this browser');
	}
	originalGetFile = FileSystemFileHandle.prototype.getFile;
	FileSystemFileHandle.prototype.getFile = function () {
		const virtual = virtualFiles.get(this.name);
		return virtual ? Promise.resolve(virtual) : originalGetFile.apply(this, arguments);
	};
	getFilePatched = true;
}

function removeGetFilePatch() {
	if (getFilePatched && virtualFiles.size === 0 && originalGetFile) {
		FileSystemFileHandle.prototype.getFile = originalGetFile;
		getFilePatched = false;
	}
}

/**
 * Async read client for the cache worker's message protocol (the worker's
 * SAB protocol is not involved here).
 * @param {Worker} worker
 */
function createAsyncRangeReader(worker) {
	let nextId = 1;
	/** @type {Map<number, { resolve: (buf: ArrayBuffer) => void, reject: (err: Error) => void }>} */
	const pending = new Map();
	const onMessage = (/** @type {MessageEvent} */ event) => {
		const msg = event.data;
		if (msg?.type !== 'read-result') return;
		const entry = pending.get(msg.id);
		if (!entry) return;
		pending.delete(msg.id);
		if (!msg.ok) {
			console.error('[mpv-bridge] read failed:', msg.message);
			entry.reject(new MpvBridgeError(`cache worker read failed: ${msg.message}`));
		} else {
			entry.resolve(
				msg.byteLength === msg.buffer.byteLength
					? msg.buffer
					: msg.buffer.slice(0, msg.byteLength) // short read at EOF
			);
		}
	};
	worker.addEventListener('message', onMessage);
	return {
		/** @param {number} offset @param {number} length @returns {Promise<ArrayBuffer>} */
		read(offset, length) {
			return new Promise((resolve, reject) => {
				const id = nextId++;
				pending.set(id, { resolve, reject });
				worker.postMessage({ type: 'read', id, offset, length });
			});
		},
		dispose() {
			worker.removeEventListener('message', onMessage);
			for (const entry of pending.values()) {
				entry.reject(new MpvBridgeError('reader disposed'));
			}
			pending.clear();
		}
	};
}

/**
 * Blob stand-in covering exactly the surface the compiled externalfs backend
 * touches: `.size` (get_size_file / get_size_blob), `.slice(a, b)` and
 * `.arrayBuffer()` on the slice (read_blob). Bounds behave like a real Blob.
 * @param {{ read: (offset: number, length: number) => Promise<ArrayBuffer> }} reader
 * @param {number} fileSize
 * @param {string} filename
 */
function createVirtualBlob(reader, fileSize, filename) {
	return {
		name: filename,
		size: fileSize,
		type: 'video/x-matroska',
		lastModified: Date.now(),
		/** @param {number} [start] @param {number} [end] */
		slice(start = 0, end = fileSize) {
			const from = Math.min(Math.max(start, 0), fileSize);
			const to = Math.min(Math.max(end, from), fileSize);
			return {
				size: to - from,
				arrayBuffer: () => reader.read(from, to - from)
			};
		},
		arrayBuffer() {
			return reader.read(0, fileSize);
		},
		stream() {
			throw new MpvBridgeError('virtual blob does not implement stream()');
		}
	};
}

/**
 * Adapter 1 — mount the HTTP-backed file into the upstream WASMFS/externalfs
 * build. Registers a real OPFS directory containing a real (empty)
 * placeholder file via `module.ExternalFS.addDirectory()` — the backend
 * demands genuine handles (instanceof check + IndexedDB structured clone) —
 * then redirects getFile() for that filename to the virtual Blob.
 *
 * Note: the backend initializes at most ONE mount root per module instance
 * (`init_root_directory` bails if a root is already registered), which fits
 * the one-file-per-page-load lifecycle here.
 *
 * @param {any} module libmpv-wasm MainModule (exposes ExternalFS)
 * @param {{ worker: Worker, filename: string, fileSize: number }} opts
 * @returns {Promise<{ path: string, dispose: () => void }>}
 */
export async function mountVirtualFile(module, { worker, filename, fileSize }) {
	if (!module?.ExternalFS?.addDirectory) {
		throw new MpvBridgeError('module.ExternalFS.addDirectory not found — upstream API changed?');
	}
	if (!navigator.storage?.getDirectory) {
		throw new MpvBridgeError('OPFS is unavailable — cannot create the placeholder mount');
	}

	// Real OPFS directory + empty placeholder file (content is never read:
	// getFile() is intercepted before the backend can touch it).
	const root = await navigator.storage.getDirectory();
	const dir = await root.getDirectoryHandle(MOUNT_DIR, { create: true });
	for await (const name of dir.keys()) {
		if (name !== filename) await dir.removeEntry(name).catch(() => {});
	}
	await dir.getFileHandle(filename, { create: true });

	const reader = createAsyncRangeReader(worker);
	installGetFilePatch();
	virtualFiles.set(filename, createVirtualBlob(reader, fileSize, filename));

	const dispose = () => {
		virtualFiles.delete(filename);
		removeGetFilePatch();
		reader.dispose();
	};

	try {
		const key = await module.ExternalFS.addDirectory(dir);
		if (key === null || key === undefined) {
			throw new MpvBridgeError(
				'ExternalFS.addDirectory rejected the OPFS directory handle (returned null)'
			);
		}
	} catch (err) {
		dispose();
		throw err instanceof MpvBridgeError
			? err
			: new MpvBridgeError(`ExternalFS.addDirectory failed: ${err?.message ?? err}`);
	}

	return { path: `/${MOUNT_DIR}/${filename}`, dispose };
}
