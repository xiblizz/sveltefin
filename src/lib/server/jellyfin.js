import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';

const CLIENT_NAME = 'SvelteFin';
const CLIENT_VERSION = '0.1.0';

// Library types this client exposes; everything else (music, books, ...) is filtered out.
export const SUPPORTED_COLLECTION_TYPES = ['movies', 'tvshows'];

export function jellyfinUrl() {
	const url = env.JELLYFIN_URL;
	if (!url) throw new Error('JELLYFIN_URL is not set');
	return url.replace(/\/+$/, '');
}

/** Stable per-user device id so Jellyfin groups our sessions sensibly. */
export async function deviceIdFor(username) {
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sveltefin:${username}`));
	return Buffer.from(hash).toString('hex').slice(0, 20);
}

export function authHeader(deviceId, token) {
	let header = `MediaBrowser Client="${CLIENT_NAME}", Device="Web", DeviceId="${deviceId}", Version="${CLIENT_VERSION}"`;
	if (token) header += `, Token="${token}"`;
	return header;
}

/**
 * Low-level fetch against the Jellyfin server. Only ever called server-side;
 * the browser never receives or sends a Jellyfin token.
 *
 * @param {{ token: string, deviceId: string }} session
 * @param {string} path
 * @param {{ params?: Record<string, any>, method?: string, body?: any }} [opts]
 */
export async function jf(session, path, { params, method = 'GET', body } = {}) {
	const url = new URL(jellyfinUrl() + path);
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
	}
	const res = await fetch(url, {
		method,
		headers: {
			Authorization: authHeader(session.deviceId, session.token),
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	if (res.status === 401) error(401, 'Jellyfin session expired');
	if (!res.ok) error(502, `Jellyfin returned ${res.status} for ${path}`);
	if (res.status === 204 || res.headers.get('content-length') === '0') return null;
	const type = res.headers.get('content-type') ?? '';
	return type.includes('json') ? res.json() : null;
}

/** @returns {Promise<{ token: string, userId: string, name: string, deviceId: string } | null>} */
export async function login(username, password) {
	const deviceId = await deviceIdFor(username);
	const res = await fetch(`${jellyfinUrl()}/Users/AuthenticateByName`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: authHeader(deviceId) },
		body: JSON.stringify({ Username: username, Pw: password })
	});
	if (res.status === 401) return null;
	if (!res.ok) throw new Error(`Jellyfin login failed with ${res.status}`);
	const data = await res.json();
	return { token: data.AccessToken, userId: data.User.Id, name: data.User.Name, deviceId };
}

export async function logout(session) {
	try {
		await jf(session, '/Sessions/Logout', { method: 'POST' });
	} catch {
		// Session may already be gone on the Jellyfin side; the cookie gets deleted regardless.
	}
}

/** Movie/show libraries only, in server order (rendered left to right in the header). */
export async function getViews(session) {
	const data = await jf(session, '/UserViews', { params: { userId: session.userId } });
	return (data?.Items ?? [])
		.filter((view) => SUPPORTED_COLLECTION_TYPES.includes(view.CollectionType))
		.map((view) => ({
			id: view.Id,
			name: view.Name,
			collectionType: view.CollectionType,
			imageTags: view.ImageTags ?? {}
		}));
}

const CARD_FIELDS = 'PrimaryImageAspectRatio,ProductionYear,ParentId';

/** Page size shared by the library page's first load and its infinite-scroll API. */
export const LIBRARY_PAGE_SIZE = 60;

export function getResume(session, limit = 12) {
	return jf(session, '/UserItems/Resume', {
		params: {
			userId: session.userId,
			limit,
			mediaTypes: 'Video',
			fields: CARD_FIELDS,
			enableImageTypes: 'Primary,Backdrop,Thumb'
		}
	});
}

export function getNextUp(session, limit = 12) {
	return jf(session, '/Shows/NextUp', {
		params: {
			userId: session.userId,
			limit,
			fields: CARD_FIELDS,
			enableImageTypes: 'Primary,Backdrop,Thumb'
		}
	});
}

export function getLatest(session, parentId, limit = 12) {
	return jf(session, '/Items/Latest', {
		params: { userId: session.userId, parentId, limit, fields: CARD_FIELDS }
	});
}

export function getItems(session, params) {
	return jf(session, '/Items', {
		params: { userId: session.userId, fields: CARD_FIELDS, ...params }
	});
}

export function getItem(session, itemId) {
	return jf(session, `/Items/${encodeURIComponent(itemId)}`, {
		params: { userId: session.userId }
	});
}

export function getSeasons(session, seriesId) {
	return jf(session, `/Shows/${encodeURIComponent(seriesId)}/Seasons`, {
		params: { userId: session.userId }
	});
}

export function getEpisodes(session, seriesId, seasonId) {
	return jf(session, `/Shows/${encodeURIComponent(seriesId)}/Episodes`, {
		params: {
			userId: session.userId,
			seasonId,
			fields: `${CARD_FIELDS},Overview`
		}
	});
}

/** The episode plus its immediate neighbours (series-wide, crosses season boundaries). */
export function getAdjacentEpisodes(session, seriesId, episodeId) {
	return jf(session, `/Shows/${encodeURIComponent(seriesId)}/Episodes`, {
		params: { userId: session.userId, adjacentTo: episodeId }
	});
}

export function getSimilar(session, itemId, limit = 12) {
	return jf(session, `/Items/${encodeURIComponent(itemId)}/Similar`, {
		params: { userId: session.userId, limit, fields: CARD_FIELDS }
	});
}

export function getPlaybackInfo(session, itemId, body) {
	return jf(session, `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {
		method: 'POST',
		body: { UserId: session.userId, ...body }
	});
}

const PLAYING_PATHS = {
	start: '/Sessions/Playing',
	progress: '/Sessions/Playing/Progress',
	stopped: '/Sessions/Playing/Stopped'
};

export function reportPlaying(session, event, body) {
	const path = PLAYING_PATHS[event];
	if (!path) error(400, 'Unknown playback event');
	return jf(session, path, { method: 'POST', body });
}

/**
 * Active sessions visible to this user (all of them for admins, own otherwise).
 * Feeds the header streams widget; the raw DTOs are trimmed in /api/streams
 * before anything reaches the browser.
 */
export function getSessions(session, activeWithinSeconds = 960) {
	return jf(session, '/Sessions', { params: { activeWithinSeconds } });
}

export function setFavorite(session, itemId, favorite) {
	return jf(session, `/UserFavoriteItems/${encodeURIComponent(itemId)}`, {
		method: favorite ? 'POST' : 'DELETE',
		params: { userId: session.userId }
	});
}

/**
 * The Watchlist is backed by Jellyfin favorites (IsFavorite). An earlier
 * implementation used a personal "Watchlist" playlist, but Jellyfin's playlist
 * semantics for shows didn't fit — scrapped 2026-07 (docs/roadmap.md).
 */
/** Mark an item (movie, episode, or a whole series) played/unplayed. */
export function setPlayed(session, itemId, played) {
	return jf(session, `/UserPlayedItems/${encodeURIComponent(itemId)}`, {
		method: played ? 'POST' : 'DELETE',
		params: { userId: session.userId }
	});
}

export function getWatchlist(session, limit = 200) {
	return getItems(session, {
		filters: 'IsFavorite',
		recursive: true,
		includeItemTypes: 'Movie,Series',
		sortBy: 'SortName',
		sortOrder: 'Ascending',
		limit,
		enableImageTypes: 'Primary'
	});
}

/** Removes an item from Continue Watching by resetting its resume position. */
export function clearResume(session, itemId) {
	return jf(session, `/UserItems/${encodeURIComponent(itemId)}/UserData`, {
		method: 'POST',
		params: { userId: session.userId },
		body: { PlaybackPositionTicks: 0 }
	});
}

/**
 * Intro/outro markers from Jellyfin's media segments API (fed by plugins like
 * Intro Skipper). Types are filtered here rather than via includeSegmentTypes
 * to avoid depending on array query-param binding behavior.
 */
export async function getSkippableSegments(session, itemId) {
	try {
		const result = await jf(session, `/MediaSegments/${encodeURIComponent(itemId)}`);
		return (result?.Items ?? []).filter((segment) => ['Intro', 'Outro'].includes(segment.Type));
	} catch {
		return [];
	}
}

export function search(session, term, limit = 40) {
	return getItems(session, {
		searchTerm: term,
		recursive: true,
		includeItemTypes: 'Movie,Series',
		limit,
		enableImageTypes: 'Primary'
	});
}
