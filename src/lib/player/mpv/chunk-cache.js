// Sparse LRU chunk store over OPFS, used inside the cache worker only
// (createSyncAccessHandle is worker-only, and reads must be synchronous so
// serving a cache hit never yields to the event loop).
//
// Layout on disk: one pre-sized "slot file" (capacity = slotCount × chunkSize)
// plus meta.json. Chunks live in whichever slot the index says — eviction is
// just slot reuse, so there is no file create/delete churn and disk usage is
// exactly bounded. The in-memory index is mirrored to meta.json (debounced) so
// it survives a worker restart within the session; cross-browser-session
// persistence is deliberately out of scope for v1, but the on-disk format
// (cacheId dir + fileSize/chunkSize validation on load) is already sufficient
// to add it later without a rewrite.

const CACHE_ROOT_DIR = 'sveltefin-mpv-cache';
const META_FLUSH_MS = 5_000;
const META_VERSION = 1;

/**
 * @typedef {Object} ChunkEntry
 * @property {number} slot
 * @property {number} bytes actual byte count (final chunk may be short)
 * @property {number} lastAccess monotonic counter, not wall time
 */

/**
 * @param {{ cacheId: string, chunkSize: number, capacityBytes: number, fileSize: number,
 *           protectHeadBytes?: number, protectWindowBytes?: number }} opts
 */
export async function openChunkCache({
	cacheId,
	chunkSize,
	capacityBytes,
	fileSize,
	protectHeadBytes = 4 * 1024 * 1024,
	protectWindowBytes = 32 * 1024 * 1024
}) {
	const slotCount = Math.max(4, Math.floor(capacityBytes / chunkSize));
	const root = await navigator.storage.getDirectory();
	const cacheRoot = await root.getDirectoryHandle(CACHE_ROOT_DIR, { create: true });

	// v1 keeps a single file's cache: drop other items' leftovers up front so
	// total OPFS usage stays bounded to one capacityBytes.
	for await (const name of keysOf(cacheRoot)) {
		if (name !== cacheId) await cacheRoot.removeEntry(name, { recursive: true }).catch(() => {});
	}

	const dir = await cacheRoot.getDirectoryHandle(cacheId, { create: true });
	// createSyncAccessHandle is missing from this TS lib version's FileSystemFileHandle.
	const slotsHandle = await /** @type {any} */ (
		await dir.getFileHandle('slots.bin', { create: true })
	).createSyncAccessHandle();
	const metaHandle = await /** @type {any} */ (
		await dir.getFileHandle('meta.json', { create: true })
	).createSyncAccessHandle();

	/** @type {Map<number, ChunkEntry>} */
	const index = new Map();
	/** @type {number[]} */
	let freeSlots = [];
	let accessCounter = 0;
	let protectCenter = 0;
	let metaDirty = false;
	/** @type {ReturnType<typeof setInterval> | null} */
	let metaTimer = null;
	let hits = 0;
	let misses = 0;

	// Some engines reject reads/writes into SharedArrayBuffer-backed views
	// (BufferSource vs AllowSharedBufferSource in the OPFS spec changed over
	// time). Probe lazily and fall back to a scratch copy.
	/** @type {Uint8Array | null} */
	let scratch = null;
	let sabViewsWork = true;

	const protectHeadChunks = Math.ceil(protectHeadBytes / chunkSize);
	const lastChunkIndex = Math.max(0, Math.ceil(fileSize / chunkSize) - 1);

	loadMeta();
	rebuildFreeSlots();
	metaTimer = setInterval(() => {
		if (metaDirty) flushMeta();
	}, META_FLUSH_MS);

	function loadMeta() {
		try {
			const size = metaHandle.getSize();
			if (!size) return;
			const buf = new Uint8Array(size);
			metaHandle.read(buf, { at: 0 });
			const meta = JSON.parse(new TextDecoder().decode(buf));
			if (
				meta.version !== META_VERSION ||
				meta.fileSize !== fileSize ||
				meta.chunkSize !== chunkSize ||
				meta.slotCount !== slotCount
			) {
				return; // config changed → start empty; slots.bin content is garbage now
			}
			for (const [chunkIndex, slot, bytes] of meta.entries) {
				index.set(chunkIndex, { slot, bytes, lastAccess: 0 });
			}
		} catch {
			// Corrupt/absent metadata is not fatal — start with an empty cache.
		}
	}

	function flushMeta() {
		const meta = {
			version: META_VERSION,
			fileSize,
			chunkSize,
			slotCount,
			entries: [...index.entries()].map(([chunkIndex, e]) => [chunkIndex, e.slot, e.bytes])
		};
		const bytes = new TextEncoder().encode(JSON.stringify(meta));
		try {
			metaHandle.truncate(0);
			metaHandle.write(bytes, { at: 0 });
			metaHandle.flush();
			metaDirty = false;
		} catch {
			// Best effort; worst case the next worker start begins cold.
		}
	}

	function rebuildFreeSlots() {
		const used = new Set([...index.values()].map((e) => e.slot));
		freeSlots = [];
		for (let s = slotCount - 1; s >= 0; s--) if (!used.has(s)) freeSlots.push(s);
	}

	/** @param {number} chunkIndex */
	function isProtected(chunkIndex) {
		if (chunkIndex < protectHeadChunks) return true;
		const chunkByte = chunkIndex * chunkSize;
		return Math.abs(chunkByte - protectCenter) <= protectWindowBytes;
	}

	/** Pick a slot for a new chunk, evicting the LRU unprotected chunk if full. */
	function acquireSlot() {
		const free = freeSlots.pop();
		if (free !== undefined) return free;

		let victim = -1;
		let victimAccess = Infinity;
		let fallback = -1;
		let fallbackAccess = Infinity;
		for (const [chunkIndex, entry] of index) {
			if (entry.lastAccess < fallbackAccess) {
				fallbackAccess = entry.lastAccess;
				fallback = chunkIndex;
			}
			if (!isProtected(chunkIndex) && entry.lastAccess < victimAccess) {
				victimAccess = entry.lastAccess;
				victim = chunkIndex;
			}
		}
		// Cache smaller than the protect window: evict LRU anyway rather than fail.
		if (victim === -1) victim = fallback;
		const entry = /** @type {ChunkEntry} */ (index.get(victim));
		index.delete(victim);
		metaDirty = true;
		return entry.slot;
	}

	/**
	 * @param {any} handle FileSystemSyncAccessHandle (absent from lib.dom here)
	 * @param {'read' | 'write'} op
	 * @param {Uint8Array} view possibly SAB-backed
	 * @param {number} at
	 */
	function ioAt(handle, op, view, at) {
		if (sabViewsWork) {
			try {
				return op === 'read' ? handle.read(view, { at }) : handle.write(view, { at });
			} catch (err) {
				if (!(err instanceof TypeError)) throw err;
				sabViewsWork = false; // fall through to scratch copy
			}
		}
		if (!scratch || scratch.byteLength < view.byteLength) scratch = new Uint8Array(chunkSize);
		const tmp = scratch.subarray(0, view.byteLength);
		if (op === 'write') {
			tmp.set(view);
			return handle.write(tmp, { at });
		}
		const n = handle.read(tmp, { at });
		view.set(tmp.subarray(0, n));
		return n;
	}

	return {
		chunkSize,
		slotCount,

		/** @param {number} chunkIndex */
		has(chunkIndex) {
			return index.has(chunkIndex);
		},

		/**
		 * Hot path: copy cached bytes straight into `out` (which may view the
		 * rendezvous SharedArrayBuffer). Synchronous; returns bytes copied or
		 * -1 on a miss. Never triggers eviction or I/O beyond the one read.
		 * @param {number} chunkIndex
		 * @param {number} within offset inside the chunk
		 * @param {number} length
		 * @param {Uint8Array} out
		 * @param {number} outOffset
		 */
		readInto(chunkIndex, within, length, out, outOffset) {
			const entry = index.get(chunkIndex);
			if (!entry || within + length > entry.bytes) {
				misses++;
				return -1;
			}
			entry.lastAccess = ++accessCounter;
			hits++;
			return ioAt(
				slotsHandle,
				'read',
				out.subarray(outOffset, outOffset + length),
				entry.slot * chunkSize + within
			);
		},

		/**
		 * Store a chunk (cold path — runs after a network fetch, so eviction
		 * cost lives here, never in the hit path).
		 * @param {number} chunkIndex
		 * @param {Uint8Array} bytes full chunk, or short for the final chunk
		 */
		write(chunkIndex, bytes) {
			const existing = index.get(chunkIndex);
			const slot = existing ? existing.slot : acquireSlot();
			ioAt(slotsHandle, 'write', bytes, slot * chunkSize);
			index.set(chunkIndex, { slot, bytes: bytes.byteLength, lastAccess: ++accessCounter });
			metaDirty = true;
		},

		/** Recenter the eviction protect window around the playback read head. */
		setProtectCenter(byteOffset) {
			protectCenter = byteOffset;
		},

		/** Merged [start, end) byte ranges currently cached — for the buffer bar. */
		cachedRanges() {
			const indices = [...index.keys()].sort((a, b) => a - b);
			/** @type {Array<[number, number]>} */
			const ranges = [];
			for (const chunkIndex of indices) {
				const entry = /** @type {ChunkEntry} */ (index.get(chunkIndex));
				const start = chunkIndex * chunkSize;
				const end = start + entry.bytes;
				const last = ranges[ranges.length - 1];
				if (last && last[1] >= start) last[1] = Math.max(last[1], end);
				else ranges.push([start, end]);
			}
			return ranges;
		},

		stats() {
			let bytes = 0;
			for (const entry of index.values()) bytes += entry.bytes;
			return {
				cachedBytes: bytes,
				capacityBytes: slotCount * chunkSize,
				chunkCount: index.size,
				hits,
				misses
			};
		},

		/** True when `chunkIndex` is inside the file at all. */
		inFile(chunkIndex) {
			return chunkIndex >= 0 && chunkIndex <= lastChunkIndex;
		},

		flush() {
			if (metaDirty) flushMeta();
		},

		close() {
			if (metaTimer) clearInterval(metaTimer);
			if (metaDirty) flushMeta();
			try {
				slotsHandle.close();
				metaHandle.close();
			} catch {
				// already closed
			}
		}
	};
}

/**
 * FileSystemDirectoryHandle async iteration, tolerating both `keys()` and the
 * older `entries()`-only surface.
 * @param {FileSystemDirectoryHandle} dir
 */
async function* keysOf(dir) {
	if (dir.keys) yield* dir.keys();
	else for await (const [name] of /** @type {any} */ (dir)) yield name;
}
