import { json, error } from '@sveltejs/kit';
import { setFavorite, setPlayed, clearResume } from '$lib/server/jellyfin.js';

// Single endpoint for the small per-item mutations triggered from cards and
// the item page. Actions are a fixed whitelist; anything else is rejected.
// The watchlist is backed by Jellyfin favorites (see docs/roadmap.md) — the
// former playlist-based implementation and its favorite/unfavorite twin
// actions were removed when the two features merged.
export async function POST({ request, locals }) {
    let data;
    try {
        data = await request.json();
    } catch {
        error(400, 'Invalid JSON');
    }

    const { action, itemId } = data;
    if (typeof itemId !== 'string' || !itemId) error(400, 'itemId required');

    switch (action) {
        case 'watchlist-add':
            await setFavorite(locals.session, itemId, true);
            break;
        case 'watchlist-remove':
            await setFavorite(locals.session, itemId, false);
            break;
        case 'remove-resume':
            await clearResume(locals.session, itemId);
            break;
        case 'mark-played':
            await setPlayed(locals.session, itemId, true);
            break;
        case 'mark-unplayed':
            await setPlayed(locals.session, itemId, false);
            break;
        default:
            error(400, 'Unknown action');
    }

    return json({ ok: true });
}
