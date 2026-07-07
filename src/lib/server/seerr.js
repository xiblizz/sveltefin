import { env } from '$env/dynamic/private';
import { error, fail } from '@sveltejs/kit';

// Optional Jellyseerr/Overseerr integration, exposed as a "Requests" tab.
// Auth uses a single admin API key server-side; requests are made on behalf
// of that key's user. Per-user Seerr auth is a roadmap item (docs/seerr.md).

export function seerrEnabled() {
	return Boolean(env.SEERR_URL && env.SEERR_API_KEY);
}

/**
 * @param {string} path
 * @param {{ params?: Record<string, any>, method?: string, body?: any }} [opts]
 */
async function seerr(path, { params, method = 'GET', body } = {}) {
	const url = new URL(env.SEERR_URL.replace(/\/+$/, '') + '/api/v1' + path);
	// Build the query string by hand: URLSearchParams encodes spaces as '+',
	// which Seerr's /search endpoint rejects with a 400 — it needs %20.
	const query = Object.entries(params ?? {})
		.filter(([, value]) => value !== undefined && value !== null)
		.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
		.join('&');
	if (query) url.search = query;
	const res = await fetch(url, {
		method,
		headers: {
			'X-Api-Key': env.SEERR_API_KEY,
			...(body ? { 'Content-Type': 'application/json' } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	if (!res.ok) error(502, `Seerr returned ${res.status} for ${path}`);
	return res.json();
}

// Seerr media status codes → labels (1 = unknown/not requested)
const STATUS = { 2: 'Requested', 3: 'Processing', 4: 'Partly available', 5: 'Available' };

/** Maps a Seerr search/discover result to the shape the Requests UI renders. */
export function toCard(result) {
	if (result.mediaType !== 'movie' && result.mediaType !== 'tv') return null;
	return {
		tmdbId: result.id,
		mediaType: result.mediaType,
		title: result.title ?? result.name,
		year: (result.releaseDate ?? result.firstAirDate ?? '').slice(0, 4),
		poster: result.posterPath ? `https://image.tmdb.org/t/p/w342${result.posterPath}` : null,
		overview: result.overview ?? '',
		status: STATUS[result.mediaInfo?.status] ?? null
	};
}

/**
 * Full details for the request-page dialog, from Seerr's /movie/{id} or
 * /tv/{id} (both proxy TMDB and merge in the local mediaInfo status).
 * @param {'movie' | 'tv'} mediaType
 * @param {number} tmdbId
 */
export async function getMediaDetails(mediaType, tmdbId) {
	const data = await seerr(`/${mediaType}/${tmdbId}`);
	return {
		tmdbId: data.id,
		mediaType,
		title: data.title ?? data.name,
		year: (data.releaseDate ?? data.firstAirDate ?? '').slice(0, 4),
		tagline: data.tagline ?? '',
		overview: data.overview ?? '',
		poster: data.posterPath ? `https://image.tmdb.org/t/p/w342${data.posterPath}` : null,
		backdrop: data.backdropPath ? `https://image.tmdb.org/t/p/w1280${data.backdropPath}` : null,
		genres: (data.genres ?? []).map((genre) => genre.name),
		runtime: data.runtime ?? data.episodeRunTime?.[0] ?? null,
		numberOfSeasons: data.numberOfSeasons ?? null,
		contentStatus: data.status ?? '',
		voteAverage: data.voteAverage ? Math.round(data.voteAverage * 10) / 10 : null,
		status: STATUS[data.mediaInfo?.status] ?? null,
		cast: (data.credits?.cast ?? []).slice(0, 10).map((member) => ({
			name: member.name,
			character: member.character ?? '',
			photo: member.profilePath ? `https://image.tmdb.org/t/p/w185${member.profilePath}` : null
		}))
	};
}

/**
 * Jellyfin item ids of the API-key user's requests that are now available in
 * the library, most recently added first. "My" requests: with single-user
 * auth every request made through this app belongs to the key's user, so we
 * filter by that user's id (from /auth/me) to exclude requests other Seerr
 * users made elsewhere. Feeds the home page's "Requested by me" row.
 * @returns {Promise<string[]>}
 */
export async function getMyAvailableRequestIds(take = 30) {
	const me = await seerr('/auth/me');
	const data = await seerr('/request', {
		params: { take, filter: 'available', sort: 'added', requestedBy: me.id }
	});
	const ids = (data.results ?? [])
		.map((req) => req.media?.jellyfinMediaId)
		.filter(Boolean);
	return [...new Set(ids)];
}

export function discoverTrending(page = 1) {
	return seerr('/discover/trending', { params: { page } });
}

export function searchSeerr(query, page = 1) {
	return seerr('/search', { params: { query, page } });
}

/**
 * Shared body for the `request` form action (used by /requests and /search —
 * the SeerrGrid component posts to `?/request` on whichever page hosts it).
 * @param {Request} request
 */
export async function requestAction(request) {
	if (!seerrEnabled()) error(404, 'Seerr integration is not configured');

	const form = await request.formData();
	const mediaType = String(form.get('mediaType'));
	const tmdbId = Number(form.get('tmdbId'));
	if (!['movie', 'tv'].includes(mediaType) || !Number.isInteger(tmdbId)) {
		return fail(400, { error: 'Invalid request' });
	}

	try {
		await createRequest(mediaType, tmdbId);
	} catch {
		return fail(502, { error: 'Seerr rejected the request.' });
	}
	return { requested: tmdbId };
}

export async function createRequest(mediaType, tmdbId) {
	const body = { mediaType, mediaId: tmdbId };
	if (mediaType === 'tv') {
		const show = await seerr(`/tv/${tmdbId}`);
		body.seasons = (show.seasons ?? [])
			.map((season) => season.seasonNumber)
			.filter((seasonNumber) => seasonNumber > 0);
	}
	return seerr('/request', { method: 'POST', body });
}
