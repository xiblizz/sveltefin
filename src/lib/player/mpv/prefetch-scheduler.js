// Sequential read-ahead scheduling. Pure policy: the cache worker injects
// `ensureChunk` (which dedupes against demand fetches for the same chunk) and
// `isCached`; this module only decides which chunk indices to warm and when a
// position jump means "the user scrubbed, drop the old window".
//
// Prefetch is strictly background work — it is kicked off *after* a demand
// read has been served (queueMicrotask), never awaited by the read path.

/**
 * @param {{
 *   chunkSize: number,
 *   fileSize: number,
 *   isCached: (chunkIndex: number) => boolean,
 *   ensureChunk: (chunkIndex: number, owner: 'prefetch') => { promise: Promise<void>, abort: () => void } | null,
 *   aheadChunks?: number,
 *   concurrency?: number
 * }} opts
 */
export function createPrefetchScheduler({
	chunkSize,
	fileSize,
	isCached,
	ensureChunk,
	aheadChunks = 6,
	concurrency = 2
}) {
	const lastChunkIndex = Math.max(0, Math.ceil(fileSize / chunkSize) - 1);
	// A read is "sequential" if it lands within the window we were already
	// warming (plus one chunk of slack behind for demuxer back-seeks).
	const seekSlackBytes = 2 * chunkSize;

	/** @type {Map<number, { abort: () => void }>} */
	const inflight = new Map();
	let windowStartChunk = 0;
	let lastReadEnd = 0;
	let stopped = false;

	function fill() {
		if (stopped) return;
		for (
			let chunkIndex = windowStartChunk;
			chunkIndex <= Math.min(windowStartChunk + aheadChunks - 1, lastChunkIndex) &&
			inflight.size < concurrency;
			chunkIndex++
		) {
			if (isCached(chunkIndex) || inflight.has(chunkIndex)) continue;
			const task = ensureChunk(chunkIndex, 'prefetch');
			if (!task) continue; // already being fetched on demand
			inflight.set(chunkIndex, task);
			task.promise
				.catch(() => {}) // aborted or failed; demand path will retry if needed
				.finally(() => {
					inflight.delete(chunkIndex);
					fill();
				});
		}
	}

	function cancelAll() {
		for (const task of inflight.values()) task.abort();
		inflight.clear();
	}

	return {
		/**
		 * Called (async, off the hot path) after each served demand read.
		 * @param {number} offset
		 * @param {number} length
		 */
		onRead(offset, length) {
			if (stopped) return;
			const end = offset + length;
			const isSeek =
				offset + seekSlackBytes < lastReadEnd ||
				offset > (windowStartChunk + aheadChunks) * chunkSize + seekSlackBytes;
			lastReadEnd = end;
			windowStartChunk = Math.floor(end / chunkSize);
			if (isSeek) cancelAll(); // stale window — stop warming the old position
			queueMicrotask(fill);
		},

		stop() {
			stopped = true;
			cancelAll();
		}
	};
}
