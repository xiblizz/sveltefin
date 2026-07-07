// Player backend registry. The watch page resolves a component from
// `data.kind` and renders it; backend-specific wiring stays inside the
// backend component, page-level concerns (progress reporting, skip segments,
// track selectors) talk to whichever backend is active only through the
// PlayerController contract below.

import HtmlPlayer from './HtmlPlayer.svelte';
import MpvPlayer from './MpvPlayer.svelte';

/**
 * @typedef {Object} PlayerController
 * @property {() => number} getCurrentTime seconds
 * @property {() => boolean} isPaused
 * @property {(seconds: number) => void} seek
 * @property {(index: number) => void} setTextTrack external text track by
 *   stream index, -1 = off (no-op on backends without external tracks)
 * @property {() => void} togglePlay play/pause toggle (keyboard shortcut)
 */

/**
 * @param {string} kind 'direct' | 'hls' | 'mpv'
 * @returns {typeof HtmlPlayer | typeof MpvPlayer}
 */
export function playerComponentFor(kind) {
	return kind === 'mpv' ? MpvPlayer : HtmlPlayer;
}
