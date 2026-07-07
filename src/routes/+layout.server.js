import { getViews } from '$lib/server/jellyfin.js';
import { seerrEnabled } from '$lib/server/seerr.js';
import { env } from '$env/dynamic/private';

export async function load({ locals }) {
    if (!locals.session) {
        return { user: null, views: [], seerr: false, appName: env.APP_NAME };
    }

    let views = [];
    try {
        views = await getViews(locals.session);
    } catch {
        // A dead Jellyfin connection shouldn't take down the shell; pages surface their own errors.
    }

    return {
        user: { name: locals.session.name },
        views,
        seerr: seerrEnabled(),
        appName: env.APP_NAME,
    };
}
