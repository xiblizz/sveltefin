// Dedicated worker owning the whole cache stack for one media file:
// OPFS chunk store, Jellyfin range client (via the same-origin proxy, cookie
// auth), prefetch scheduler, and the serving side of the SAB rendezvous.
//
// It must never block: cache misses are awaited async fetches while the
// *reader* thread sleeps in Atomics.wait. That is why sync XHR is not used
// here at all — this worker stays responsive so prefetch, stats and eviction
// keep running during a stall.
//
// Messages in:  { type: 'init', sab, config }   { type: 'close' }
//               { type: 'read', id, offset, length }   (async read protocol —
//               used by the ExternalFS blob bridge, where mpv's reads surface
//               as awaited Blob.arrayBuffer() calls on the main thread)
// Messages out: { type: 'ready', fileSize }     { type: 'stats', ... }
//               { type: 'read-result', id, ok, byteLength, buffer | message }
//               { type: 'fatal', message }
//
// The SAB rendezvous protocol is served in parallel; it is only exercised by
// the legacy-FS fallback adapter (see mpv-fs-bridge.js).

import {
	views,
	loadOffset,
	IDX_STATE,
	IDX_LENGTH,
	IDX_RESULT,
	STATE_REQUEST,
	STATE_RESPONSE,
	STATE_ERROR,
	STATE_CLOSED,
	ERR_IO,
	ERR_RANGE_UNSUPPORTED
} from './sab-protocol.js';
import { createRangeClient, RangeUnsupportedError } from './range-client.js';
import { openChunkCache } from './chunk-cache.js';
import { createPrefetchScheduler } from './prefetch-scheduler.js';
import { MPV_BROADCAST_CHANNEL } from './config.js';

const STATS_INTERVAL_MS = 1_000;
const POLL_FAST_MS = 2; // fallback poll cadence while reads are flowing
const POLL_IDLE_MS = 15;
const POLL_FAST_WINDOW_MS = 250;
// Sanity cap on a single read. mpv's stream layer reads a few MB at most; a
// larger request means the engine fell into a whole-blob arrayBuffer() path,
// and honoring it would allocate ~fileSize and OOM the renderer.
const MAX_READ_BYTES = 64 * 1024 * 1024;

/** @type {ReturnType<typeof createState> | null} */
let state = null;

function createState() {
	return {
		/** @type {Int32Array} */ i32: /** @type {any} */ (null),
		/** @type {Uint8Array} */ payload: /** @type {any} */ (null),
		/** @type {ReturnType<typeof createRangeClient>} */ client: /** @type {any} */ (null),
		/** @type {Awaited<ReturnType<typeof openChunkCache>> | null} */ cache: null,
		/** @type {ReturnType<typeof createPrefetchScheduler> | null} */ prefetcher: null,
		/** @type {Map<number, { promise: Promise<void>, abort: () => void, owner: string }>} */
		inflight: new Map(),
		filename: '',
		fileSize: 0,
		chunkSize: 0,
		lastReadPos: 0,
		lastActivity: 0,
		closed: false,
		/** @type {ReturnType<typeof setInterval> | null} */ statsTimer: null,
		/** @type {BroadcastChannel | null} */ channel: null,
		/** @type {Map<string, BroadcastChannel>} per-requester result channels */
		resultChannels: new Map()
	};
}

/** @param {NonNullable<typeof state>} s @param {string} tag */
function resultChannelFor(s, tag) {
	let ch = s.resultChannels.get(tag);
	if (!ch) {
		ch = new BroadcastChannel(`${MPV_BROADCAST_CHANNEL}:${tag}`);
		s.resultChannels.set(tag, ch);
	}
	return ch;
}

self.onmessage = (event) => {
	const msg = event.data;
	if (msg?.type === 'init') {
		init(msg).catch((err) => {
			self.postMessage({ type: 'fatal', message: err?.message ?? String(err) });
		});
	} else if (msg?.type === 'read') {
		serveMessageRead(msg);
	} else if (msg?.type === 'close') {
		shutdown();
	}
};

/**
 * Read served over the BroadcastChannel for the engine's pthread workers.
 * postMessage on a channel structured-clones (no transfer), which is the
 * price of reaching a worker we didn't create.
 * @param {{ tag: string, id: number, offset: number, length: number }} msg
 */
async function serveBroadcastRead({ tag, id, offset, length }) {
	const s = state;
	if (!s?.cache || s.closed || !s.channel) return;
	if (length > MAX_READ_BYTES) {
		console.error(
			`[mpv-cache] REJECTING absurd read: offset=${offset} len=${length} ` +
				'(whole-blob arrayBuffer()? honoring it would OOM the renderer)'
		);
		resultChannelFor(s, tag).postMessage({
			type: 'read-result',
			id,
			ok: false,
			message: `read of ${length} bytes exceeds the ${MAX_READ_BYTES}-byte cap`
		});
		return;
	}
	// Watchdog: a read that never returns parks mpv's demuxer forever — make
	// that state loud instead of a silent freeze.
	const watchdog = setTimeout(() => {
		console.warn(
			`[mpv-cache] read offset=${offset} len=${length} still pending after 10s;` +
				` inflight chunks: [${[...s.inflight.keys()]}]`
		);
	}, 10_000);
	try {
		const target = new Uint8Array(Math.max(0, length));
		const n = await produceInto(s, offset, target.byteLength, target);
		clearTimeout(watchdog);
		resultChannelFor(s, tag).postMessage({ type: 'read-result', id, ok: true, byteLength: n, buffer: target.buffer });
	} catch (err) {
		clearTimeout(watchdog);
		resultChannelFor(s, tag).postMessage({
			type: 'read-result',
			id,
			ok: false,
			message: err instanceof Error ? err.message : String(err)
		});
	}
}

/** @param {{ id: number, offset: number, length: number }} msg */
async function serveMessageRead({ id, offset, length }) {
	const s = state;
	if (!s?.cache || s.closed) {
		self.postMessage({ type: 'read-result', id, ok: false, message: 'cache not ready' });
		return;
	}
	try {
		const target = new Uint8Array(Math.max(0, length));
		const n = await produceInto(s, offset, target.byteLength, target);
		// Cast: TS resolves self.postMessage to the Window overload here, but
		// this is a DedicatedWorkerGlobalScope with a transfer-list signature.
		/** @type {any} */ (self).postMessage(
			{ type: 'read-result', id, ok: true, byteLength: n, buffer: target.buffer },
			[target.buffer]
		);
	} catch (err) {
		self.postMessage({ type: 'read-result', id, ok: false, message: err?.message ?? String(err) });
	}
}

/** @param {{ sab: SharedArrayBuffer, config: any }} msg */
async function init({ sab, config }) {
	const s = (state = createState());
	({ i32: s.i32, payload: s.payload } = views(sab));
	s.chunkSize = config.chunkSize;
	s.client = createRangeClient(config.streamUrl);

	const probe = await s.client.probeSize();
	if (!probe.supportsRanges) {
		// A 200-only server would force linear full downloads; that defeats the
		// whole design, so fail loudly rather than degrade silently.
		self.postMessage({ type: 'fatal', message: 'Upstream does not support HTTP Range requests' });
		Atomics.store(s.i32, IDX_STATE, STATE_CLOSED);
		return;
	}
	s.fileSize = probe.size;

	s.cache = await openChunkCache({
		cacheId: config.cacheId,
		chunkSize: config.chunkSize,
		capacityBytes: config.capacityBytes,
		fileSize: s.fileSize,
		protectHeadBytes: config.protectHeadBytes,
		protectWindowBytes: config.protectWindowBytes
	});
	s.prefetcher = createPrefetchScheduler({
		chunkSize: s.chunkSize,
		fileSize: s.fileSize,
		isCached: (chunkIndex) => /** @type {any} */ (s.cache).has(chunkIndex),
		ensureChunk: (chunkIndex, owner) => ensureChunk(chunkIndex, owner),
		aheadChunks: config.prefetchAheadChunks,
		concurrency: config.prefetchConcurrency
	});

	const ranges = s.cache.cachedRanges();
	console.info(
		`[mpv-cache] open: size=${s.fileSize}, reusing ${ranges.length} cached range(s) from OPFS`,
		ranges.slice(0, 5)
	);

	// Serve the engine's pthread workers (see pthread-patch.js): the externalfs
	// backend reads the file from a worker we didn't create, so its only route
	// to this cache is the BroadcastChannel. Announce the virtual file eagerly
	// AND on query, so it works regardless of which side spawned first.
	s.filename = config.filename ?? '';
	if (s.filename) {
		const announce = () =>
			s.channel?.postMessage({ type: 'virtual-file', filename: s.filename, fileSize: s.fileSize });
		s.channel = new BroadcastChannel(MPV_BROADCAST_CHANNEL);
		s.channel.onmessage = ({ data: msg }) => {
			if (msg?.type === 'virtual-file?') announce();
			else if (msg?.type === 'read') serveBroadcastRead(msg);
		};
		announce();
	}

	s.statsTimer = setInterval(postStats, STATS_INTERVAL_MS);
	self.postMessage({ type: 'ready', fileSize: s.fileSize });
	serveLoop();
}

function shutdown() {
	const s = state;
	if (!s || s.closed) return;
	s.closed = true;
	s.channel?.close();
	for (const ch of s.resultChannels.values()) ch.close();
	s.resultChannels.clear();
	if (s.statsTimer) clearInterval(s.statsTimer);
	s.prefetcher?.stop();
	for (const task of s.inflight.values()) task.abort();
	s.cache?.close();
	Atomics.store(s.i32, IDX_STATE, STATE_CLOSED);
	Atomics.notify(s.i32, IDX_STATE);
	self.close();
}

function postStats() {
	const s = state;
	if (!s?.cache) return;
	self.postMessage({
		type: 'stats',
		fileSize: s.fileSize,
		position: s.lastReadPos,
		ranges: s.cache.cachedRanges(),
		...s.cache.stats()
	});
}

/**
 * Watch IDX_STATE for STATE_REQUEST transitions. Prefers Atomics.waitAsync;
 * falls back to adaptive polling where it is unavailable (the poll only runs
 * while a stream is open, and idles at POLL_IDLE_MS).
 */
async function serveLoop() {
	const s = /** @type {NonNullable<typeof state>} */ (state);
	const canWaitAsync = typeof Atomics.waitAsync === 'function';
	while (!s.closed) {
		const current = Atomics.load(s.i32, IDX_STATE);
		if (current === STATE_REQUEST) {
			await serveOne(s);
			s.lastActivity = performance.now();
			continue;
		}
		if (canWaitAsync) {
			const wait = Atomics.waitAsync(s.i32, IDX_STATE, current);
			if (wait.async) await wait.value;
		} else {
			const idle = performance.now() - s.lastActivity > POLL_FAST_WINDOW_MS;
			await sleep(idle ? POLL_IDLE_MS : POLL_FAST_MS);
		}
	}
}

/** @param {NonNullable<typeof state>} s */
async function serveOne(s) {
	const offset = loadOffset(s.i32);
	const length = s.i32[IDX_LENGTH];
	let result;
	try {
		result = await produceInto(s, offset, Math.min(length, s.payload.byteLength), s.payload);
	} catch (err) {
		result = err instanceof RangeUnsupportedError ? ERR_RANGE_UNSUPPORTED : ERR_IO;
		if (result === ERR_IO) console.error('[mpv-cache] read failed', err);
	}
	s.i32[IDX_RESULT] = result;
	Atomics.store(s.i32, IDX_STATE, result < 0 ? STATE_ERROR : STATE_RESPONSE);
	Atomics.notify(s.i32, IDX_STATE);
}

/**
 * Fill `target` with [offset, offset+length) — from cache when possible,
 * awaiting network fills for the missing chunks. Returns bytes produced
 * (0 at/after EOF). Concurrent calls are safe: chunk fetches dedupe through
 * ensureChunk and OPFS reads are synchronous per call.
 * @param {NonNullable<typeof state>} s
 * @param {number} offset
 * @param {number} length
 * @param {Uint8Array} target
 */
async function produceInto(s, offset, length, target) {
	const cache = /** @type {NonNullable<typeof s.cache>} */ (s.cache);
	if (offset >= s.fileSize) return 0;
	length = Math.min(length, s.fileSize - offset, target.byteLength);

	let done = 0;
	while (done < length) {
		const pos = offset + done;
		const chunkIndex = Math.floor(pos / s.chunkSize);
		const within = pos - chunkIndex * s.chunkSize;
		const take = Math.min(s.chunkSize - within, length - done);

		if (cache.readInto(chunkIndex, within, take, target, done) < 0) {
			const task = ensureChunk(chunkIndex, 'demand');
			if (task) await task.promise;
			if (cache.readInto(chunkIndex, within, take, target, done) < 0) {
				throw new Error(`chunk ${chunkIndex} still missing after fetch`);
			}
		}
		done += take;
	}

	s.lastReadPos = offset + length;
	cache.setProtectCenter(offset);
	// Prefetch decisions happen off the serve path.
	queueMicrotask(() => s.prefetcher?.onRead(offset, length));
	return length;
}

/**
 * Single in-flight table shared by demand reads and prefetch, so the same
 * chunk is never fetched twice. A prefetch that a demand read starts waiting
 * on is promoted to 'demand' and becomes non-abortable.
 * @param {number} chunkIndex
 * @param {'demand' | 'prefetch'} owner
 */
function ensureChunk(chunkIndex, owner) {
	const s = /** @type {NonNullable<typeof state>} */ (state);
	const cache = /** @type {NonNullable<typeof s.cache>} */ (s.cache);
	if (!cache.inFile(chunkIndex) || cache.has(chunkIndex)) return null;

	const existing = s.inflight.get(chunkIndex);
	if (existing) {
		if (owner === 'demand') existing.owner = 'demand';
		return owner === 'prefetch'
			? null // prefetcher shouldn't double-track it
			: { promise: existing.promise, abort: () => {} };
	}

	const controller = new AbortController();
	const start = chunkIndex * s.chunkSize;
	const end = Math.min(start + s.chunkSize, s.fileSize);
	/** @type {{ promise: Promise<void>, abort: () => void, owner: string }} */
	const task = {
		owner,
		abort: () => {
			if (task.owner === 'prefetch') controller.abort();
		},
		promise: s.client
			.fetchRange(start, end, { signal: controller.signal })
			.then((bytes) => {
				if (bytes.byteLength !== end - start) {
					throw new Error(`short range response for chunk ${chunkIndex}`);
				}
				cache.write(chunkIndex, bytes);
			})
			.catch((err) => {
				if (task.owner !== 'prefetch' || !controller.signal.aborted) {
					console.error(`[mpv-cache] chunk ${chunkIndex} fetch failed (${owner}):`, err?.message ?? err);
				}
				throw err;
			})
			.finally(() => {
				s.inflight.delete(chunkIndex);
			})
	};
	s.inflight.set(chunkIndex, task);
	return task;
}

/** @param {number} ms */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
