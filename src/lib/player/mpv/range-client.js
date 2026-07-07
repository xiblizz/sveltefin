// HTTP Range client for one media file behind our authenticated proxy.
//
// The URL is always a same-origin /api/media/Videos/... path — per the trust
// boundary (docs/architecture.md) the browser never sees a Jellyfin URL or
// token. Auth is the sf_session cookie, which fetch()/XHR attach automatically
// on same-origin requests, so this module deliberately has no auth handling:
// the proxy route is the single place upstream auth lives.

/** Error thrown when the server ignores Range requests for non-zero offsets. */
export class RangeUnsupportedError extends Error {
	constructor() {
		super('Server ignored the Range header (200 instead of 206) — cannot stream sparsely');
		this.name = 'RangeUnsupportedError';
	}
}

/** @typedef {{ size: number, supportsRanges: boolean }} SizeProbe */

/**
 * @param {string} url Same-origin proxied stream URL (Range-capable, static=true).
 */
export function createRangeClient(url) {
	return {
		url,

		/**
		 * Determine total file size without downloading the body.
		 * Uses `Range: bytes=0-0` rather than HEAD because the media proxy
		 * route only implements GET (SvelteKit synthesizes HEAD from GET, but
		 * that would stream the whole body server-side just to discard it).
		 * @returns {Promise<SizeProbe>}
		 */
		async probeSize() {
			const controller = new AbortController();
			const res = await fetch(url, {
				headers: { Range: 'bytes=0-0' },
				signal: controller.signal
			});
			try {
				if (res.status === 206) {
					const total = parseContentRangeTotal(res.headers.get('content-range'));
					if (total !== null) return { size: total, supportsRanges: true };
				}
				if (res.status === 200) {
					const len = Number(res.headers.get('content-length'));
					if (Number.isFinite(len) && len > 0) return { size: len, supportsRanges: false };
				}
				throw new Error(`Size probe failed: HTTP ${res.status}`);
			} finally {
				controller.abort(); // never download the body
			}
		},

		/**
		 * Fetch [start, end) as bytes. Handles 206, and a 200 fallback only
		 * when start === 0 (reads the needed prefix, then aborts the rest).
		 * @param {number} start
		 * @param {number} end exclusive
		 * @param {{ signal?: AbortSignal }} [opts]
		 * @returns {Promise<Uint8Array>}
		 */
		async fetchRange(start, end, { signal } = {}) {
			const res = await fetch(url, {
				headers: { Range: `bytes=${start}-${end - 1}` },
				signal
			});
			if (res.status === 206) {
				const buf = new Uint8Array(await res.arrayBuffer());
				// Servers may return less than asked near EOF; never more.
				return buf.byteLength > end - start ? buf.subarray(0, end - start) : buf;
			}
			if (res.status === 200) {
				if (start !== 0) {
					res.body?.cancel().catch(() => {});
					throw new RangeUnsupportedError();
				}
				return readPrefix(res, end);
			}
			res.body?.cancel().catch(() => {});
			throw new Error(`Range fetch ${start}-${end - 1} failed: HTTP ${res.status}`);
		},

		/**
		 * Synchronous variant using blocking XMLHttpRequest — legal only in
		 * dedicated workers (browsers reject sync XHR with a binary response
		 * type on the main thread). This is the documented fallback transport
		 * for setups where mpv's read callback runs on a worker we did not
		 * create and the SAB rendezvous is unavailable; the primary path is
		 * the cache worker (see cache-worker.js / mpv-fs-bridge.js).
		 * @param {number} start
		 * @param {number} end exclusive
		 * @returns {Uint8Array}
		 */
		fetchRangeSync(start, end) {
			const xhr = new XMLHttpRequest();
			xhr.open('GET', url, false);
			xhr.responseType = 'arraybuffer';
			xhr.setRequestHeader('Range', `bytes=${start}-${end - 1}`);
			xhr.send();
			if (xhr.status === 206) {
				const buf = new Uint8Array(/** @type {ArrayBuffer} */ (xhr.response));
				return buf.byteLength > end - start ? buf.subarray(0, end - start) : buf;
			}
			if (xhr.status === 200 && start === 0) {
				return new Uint8Array(/** @type {ArrayBuffer} */ (xhr.response), 0, end);
			}
			if (xhr.status === 200) throw new RangeUnsupportedError();
			throw new Error(`Sync range fetch ${start}-${end - 1} failed: HTTP ${xhr.status}`);
		}
	};
}

/** @param {string | null} header e.g. "bytes 0-0/123456" */
function parseContentRangeTotal(header) {
	const match = /\/(\d+)\s*$/.exec(header ?? '');
	return match ? Number(match[1]) : null;
}

/**
 * Read the first `end` bytes of a 200 response, then abort the stream so a
 * multi-GB body is not downloaded.
 * @param {Response} res
 * @param {number} end
 */
async function readPrefix(res, end) {
	const out = new Uint8Array(end);
	let got = 0;
	const reader = res.body?.getReader();
	if (!reader) throw new Error('Response has no body');
	while (got < end) {
		const { done, value } = await reader.read();
		if (done) break;
		const take = Math.min(value.byteLength, end - got);
		out.set(value.subarray(0, take), got);
		got += take;
	}
	reader.cancel().catch(() => {});
	return got === end ? out : out.subarray(0, got);
}
