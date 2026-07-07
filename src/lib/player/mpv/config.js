// Tunables for the mpv direct-play cache. Values are per playing file; the
// OPFS cache keeps only the currently playing file's chunks (see chunk-cache).

export const MPV_CACHE_DEFAULTS = {
	/** Cache granularity. 2 MiB ≈ a few seconds of high-bitrate video. */
	chunkSize: 2 * 1024 * 1024,
	/** Total OPFS budget for cached chunks (LRU beyond this). */
	capacityBytes: 768 * 1024 * 1024,
	/** Never evict the first N bytes (mkv EBML head + seek thrash guard). */
	protectHeadBytes: 4 * 1024 * 1024,
	/** Never evict chunks within ± this window of the read head. */
	protectWindowBytes: 32 * 1024 * 1024,
	/** Chunks to warm ahead of sequential playback. */
	prefetchAheadChunks: 6,
	/** Parallel prefetch fetches (demand fills are unaffected). */
	prefetchConcurrency: 2,
	/** SAB payload region — upper bound for a single rendezvous round trip. */
	payloadBytes: 4 * 1024 * 1024
};

/** Where the vendored libmpv-wasm artifacts are served from (static/mpv/). */
export const MPV_ASSET_BASE = '/mpv';
export const MPV_WRAPPER_URL = `${MPV_ASSET_BASE}/mpv-player.mjs`;
export const MPV_LOADER_URL = `${MPV_ASSET_BASE}/libmpv.js`;

/**
 * BroadcastChannel linking the engine's pthread workers to the cache worker.
 * The externalfs backend executes its JS (getFile/reads) on the *calling
 * pthread's worker*, which has no MessagePort to us — BroadcastChannel is the
 * only same-origin bus that reaches it (see pthread-patch.js).
 */
export const MPV_BROADCAST_CHANNEL = 'sveltefin-mpv-cache';
