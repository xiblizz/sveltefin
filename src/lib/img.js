// Builds image URLs pointing at our authenticated proxy (/api/media/...),
// never directly at Jellyfin. Safe to use from client and server code.

/**
 * @param {any} item - Jellyfin BaseItemDto (or the trimmed view object)
 * @param {'Primary' | 'Backdrop' | 'Thumb' | 'Logo'} type
 * @param {{ maxWidth?: number, fallbackToSeries?: boolean }} [opts]
 * @returns {string | null}
 */
export function imgUrl(item, type = 'Primary', { maxWidth = 400, fallbackToSeries = true } = {}) {
	if (!item) return null;

	if (type === 'Backdrop') {
		const tag = item.BackdropImageTags?.[0];
		if (tag) return buildUrl(item.Id, 'Backdrop', tag, maxWidth);
		if (fallbackToSeries && item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
			return buildUrl(item.ParentBackdropItemId, 'Backdrop', item.ParentBackdropImageTags[0], maxWidth);
		}
		return null;
	}

	const tags = item.ImageTags ?? item.imageTags ?? {};
	if (tags[type]) return buildUrl(item.Id ?? item.id, type, tags[type], maxWidth);

	// Episodes often have no Primary of their own; fall back to the series poster.
	if (fallbackToSeries && item.SeriesId && item.SeriesPrimaryImageTag) {
		return buildUrl(item.SeriesId, 'Primary', item.SeriesPrimaryImageTag, maxWidth);
	}
	return null;
}

function buildUrl(itemId, type, tag, maxWidth) {
	return `/api/media/Items/${itemId}/Images/${type}?tag=${encodeURIComponent(tag)}&maxWidth=${maxWidth}&quality=90`;
}

/** Ticks are 100ns units; 10,000,000 ticks per second. */
export function ticksToSeconds(ticks) {
	return (ticks ?? 0) / 10_000_000;
}

export function formatRuntime(ticks) {
	const totalMinutes = Math.round(ticksToSeconds(ticks) / 60);
	if (!totalMinutes) return '';
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}
