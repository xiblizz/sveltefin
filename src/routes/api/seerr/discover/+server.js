import { json, error } from '@sveltejs/kit';
import { seerrEnabled, discoverTrending, toCard } from '$lib/server/seerr.js';

// JSON pages for the Requests "Load more" button.
export async function GET({ url }) {
    if (!seerrEnabled()) error(404, 'Seerr integration is not configured');

    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const data = await discoverTrending(page);
    return json({ results: (data.results ?? []).map(toCard).filter(Boolean) });
}
