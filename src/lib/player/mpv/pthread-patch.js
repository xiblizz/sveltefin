// Source for the code injected into EVERY engine pthread worker.
//
// Discovery that forced this (2026-07): the externalfs backend runs its JS
// imports (init_root_directory, getFileHandle, getFile, blob reads) on the
// *calling pthread's worker* — upstream proxies all file opens to its C++
// "side thread", so none of it ever touches the main browser thread. A
// getFile() patch installed on the main thread therefore never fires; the
// engine opens the real (empty) OPFS placeholder and mpv idles silently.
//
// Fix: MpvPlayer.svelte passes `mainScriptUrlOrBlob` as a Blob of
//   (<this function>)(channelName); importScripts(<absolute libmpv.js>);
// so this runs first in every pthread worker (libmpv.js:1734 honors Blob).
// It intercepts FileSystemFileHandle.getFile for registered virtual files and
// serves slice().arrayBuffer() through a BroadcastChannel round trip to the
// cache worker — the only same-origin bus reaching a worker we didn't create.
//
// HARD CONSTRAINT: this function is injected via `.toString()`, so it must be
// fully self-contained — no imports, no outer-scope references, syntax only.

/** @param {string} channelName */
export function installPthreadVirtualFile(channelName) {
	if (typeof FileSystemFileHandle === 'undefined' || typeof BroadcastChannel === 'undefined') {
		return;
	}
	/** @type {Map<string, number>} filename → fileSize */
	const virtualSizes = new Map();
	/** @type {Map<number, { resolve: (buf: ArrayBuffer) => void, reject: (err: Error) => void }>} */
	const pending = new Map();
	const tag = Math.random().toString(36).slice(2); // read-result routing across workers
	let nextId = 1;

	const channel = new BroadcastChannel(channelName);
	channel.onmessage = (event) => {
		const msg = event.data;
		if (msg?.type === 'virtual-file' && typeof msg.filename === 'string') {
			virtualSizes.set(msg.filename, msg.fileSize);
		}
	};
	// Read results arrive on a per-worker channel so the payload clones are
	// delivered ONLY here — a broadcast payload would queue up in every other
	// pthread worker too, and workers parked in Atomics.wait never drain their
	// queues (unbounded growth during playback).
	const resultChannel = new BroadcastChannel(`${channelName}:${tag}`);
	resultChannel.onmessage = (event) => {
		const msg = event.data;
		if (msg?.type !== 'read-result') return;
		const entry = pending.get(msg.id);
		if (!entry) return;
		pending.delete(msg.id);
		if (!msg.ok) {
			entry.reject(new Error(msg.message || 'virtual file read failed'));
		} else if (msg.byteLength === msg.buffer.byteLength) {
			entry.resolve(msg.buffer);
		} else {
			entry.resolve(msg.buffer.slice(0, msg.byteLength)); // short read at EOF
		}
	};
	// The cache worker announces on init and answers this query, so
	// registration works regardless of which side came up first.
	channel.postMessage({ type: 'virtual-file?' });

	/** @param {number} offset @param {number} length @returns {Promise<ArrayBuffer>} */
	const read = (offset, length) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			channel.postMessage({ type: 'read', tag, id, offset, length });
		});

	const originalGetFile = FileSystemFileHandle.prototype.getFile;
	FileSystemFileHandle.prototype.getFile = function () {
		const size = virtualSizes.get(this.name);
		if (size === undefined) return originalGetFile.apply(this, arguments);
		console.info(`[mpv-pthread] getFile('${this.name}') → virtual blob (${size} bytes)`);
		return Promise.resolve({
			name: this.name,
			size,
			type: 'video/x-matroska',
			lastModified: Date.now(),
			/** @param {number} [start] @param {number} [end] */
			slice(start, end) {
				const from = Math.min(Math.max(start ?? 0, 0), size);
				const to = Math.min(Math.max(end ?? size, from), size);
				if (to - from > 8 * 1024 * 1024) {
					console.warn(`[mpv-pthread] LARGE slice requested: ${from}-${to} (${to - from} bytes)`);
				}
				return { size: to - from, arrayBuffer: () => read(from, to - from) };
			},
			arrayBuffer: () => {
				console.warn(`[mpv-pthread] whole-blob arrayBuffer() requested (${size} bytes)!`);
				return read(0, size);
			}
		});
	};
}
