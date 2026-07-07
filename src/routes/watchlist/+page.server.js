import { getWatchlist } from '$lib/server/jellyfin.js';

export async function load({ locals }) {
    const result = await getWatchlist(locals.session);
    return { items: result?.Items ?? [] };
}
