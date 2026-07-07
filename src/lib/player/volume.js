// Shared volume persistence for both player backends. The slider fraction
// (0–1, linear like video.volume) lives in localStorage as 'sf_volume'; the
// mpv backend maps it through its cubic gain curve separately (toMpvVolume).

const KEY = 'sf_volume';

/**
 * Saved slider fraction, safely parsed. Gotcha: `parseFloat(null)` is NaN and
 * `NaN ?? fallback` does NOT fall back — an unseeded browser profile must not
 * leak NaN into an <input type=range> value.
 * @returns {number} 0–1
 */
export function savedVolumeFraction() {
    const stored = parseFloat(localStorage.getItem(KEY) ?? '0.5');
    return Number.isFinite(stored) ? Math.min(1, Math.max(0, stored)) : 0.5;
}

/** @param {number} value slider fraction 0–1 */
export function saveVolumeFraction(value) {
    localStorage.setItem(KEY, String(value));
}
