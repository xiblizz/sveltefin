// SharedArrayBuffer rendezvous protocol between the thread that services mpv's
// file reads (the "reader", which is allowed to block) and the cache worker
// (which owns OPFS + network and must stay async-capable, so it never blocks).
//
// Layout: a small Int32 header followed by a payload region that read results
// are copied into. One request is in flight at a time — mpv's demuxer issues
// reads sequentially per file, and the reader loops for reads larger than the
// payload region.
//
// State machine (IDX_STATE):
//   IDLE     — reader may publish a request
//   REQUEST  — request published; cache worker picks it up
//   RESPONSE — payload/result valid; reader consumes, then sets IDLE
//   ERROR    — result is a negative error code from ERR_*
//   CLOSED   — cache worker shut down; all reads fail fast

export const HEADER_BYTES = 64; // one cache line; payload starts after this
export const DEFAULT_PAYLOAD_BYTES = 4 * 1024 * 1024;

export const IDX_STATE = 0;
export const IDX_OFFSET_LO = 1;
export const IDX_OFFSET_HI = 2;
export const IDX_LENGTH = 3;
export const IDX_RESULT = 4;
export const IDX_GENERATION = 5;

export const STATE_IDLE = 0;
export const STATE_REQUEST = 1;
export const STATE_RESPONSE = 2;
export const STATE_ERROR = 3;
export const STATE_CLOSED = 4;

export const ERR_IO = -1;
export const ERR_RANGE_UNSUPPORTED = -2;
export const ERR_CLOSED = -3;
export const ERR_TIMEOUT = -4;

/**
 * @param {SharedArrayBuffer} sab
 * @returns {{ i32: Int32Array, payload: Uint8Array }}
 */
export function views(sab) {
	return {
		i32: new Int32Array(sab, 0, HEADER_BYTES / 4),
		payload: new Uint8Array(sab, HEADER_BYTES)
	};
}

/** @param {number} payloadBytes */
export function createProtocolBuffer(payloadBytes = DEFAULT_PAYLOAD_BYTES) {
	return new SharedArrayBuffer(HEADER_BYTES + payloadBytes);
}

/** Split a byte offset into two int32 halves (files can exceed 2^32). */
export function storeOffset(i32, offset) {
	i32[IDX_OFFSET_LO] = offset >>> 0;
	i32[IDX_OFFSET_HI] = Math.floor(offset / 0x1_0000_0000);
}

/** @returns {number} */
export function loadOffset(i32) {
	return i32[IDX_OFFSET_HI] * 0x1_0000_0000 + (i32[IDX_OFFSET_LO] >>> 0);
}
