import { json, error } from '@sveltejs/kit';
import { seerrEnabled, getMediaDetails } from '$lib/server/seerr.js';

// Details for the SeerrGrid dialog (movie/show info like Seerr's own modal).
export async function GET({ url }) {
    if (!seerrEnabled()) error(404, 'Seerr integration is not configured');

    const type = url.searchParams.get('type');
    const id = Number(url.searchParams.get('id'));
    if ((type !== 'movie' && type !== 'tv') || !Number.isInteger(id) || id <= 0) {
        error(400, 'Invalid type or id');
    }

    return json(await getMediaDetails(type, id));
}
