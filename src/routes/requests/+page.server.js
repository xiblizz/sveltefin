import { error } from '@sveltejs/kit';
import { seerrEnabled, discoverTrending, searchSeerr, requestAction, toCard } from '$lib/server/seerr.js';

export async function load({ url }) {
	if (!seerrEnabled()) error(404, 'Seerr integration is not configured');

	const query = (url.searchParams.get('q') ?? '').trim();
	const data = query ? await searchSeerr(query) : await discoverTrending();
	return {
		query,
		results: (data.results ?? []).map(toCard).filter(Boolean)
	};
}

export const actions = {
	request: ({ request }) => requestAction(request)
};
