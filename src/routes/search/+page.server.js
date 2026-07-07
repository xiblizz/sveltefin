import { search } from '$lib/server/jellyfin.js';
import { seerrEnabled, searchSeerr, requestAction, toCard } from '$lib/server/seerr.js';

export async function load({ locals, url }) {
	const query = (url.searchParams.get('q') ?? '').trim();
	if (!query) return { query, items: [], seerr: [] };

	const [result, seerrResult] = await Promise.all([
		search(locals.session, query),
		// Seerr trouble must never break library search.
		seerrEnabled() ? searchSeerr(query).catch(() => null) : null
	]);
	return {
		query,
		items: result?.Items ?? [],
		// Fully available titles are already in the Jellyfin row above —
		// listing them again as Seerr cards would just duplicate results.
		seerr: (seerrResult?.results ?? [])
			.map(toCard)
			.filter((card) => card && card.status !== 'Available')
	};
}

export const actions = {
	request: ({ request }) => requestAction(request)
};
