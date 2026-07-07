import { getResume, getNextUp, getLatest, getItems } from '$lib/server/jellyfin.js';
import { seerrEnabled, getMyAvailableRequestIds } from '$lib/server/seerr.js';

export async function load({ locals, parent }) {
	const session = locals.session;
	const { views } = await parent();

	const [resume, nextUp, requested, ...latest] = await Promise.all([
		getResume(session),
		getNextUp(session),
		getRequestedByMe(session),
		...views.map((view) => getLatest(session, view.id, 24))
	]);

	return {
		resume: resume?.Items ?? [],
		nextUp: nextUp?.Items ?? [],
		requested,
		latest: views.map((view, i) => ({ view, items: latest[i] ?? [] }))
	};
}

/**
 * "Requested by me" row: Seerr requests that are available in the library,
 * resolved to Jellyfin items (Seerr stores the Jellyfin id per request).
 * Empty when Seerr is off or unreachable — the row just doesn't render.
 */
async function getRequestedByMe(session) {
	if (!seerrEnabled()) return [];
	try {
		const ids = await getMyAvailableRequestIds();
		if (!ids.length) return [];
		const items = (await getItems(session, { ids: ids.join(','), enableImageTypes: 'Primary' }))?.Items ?? [];
		// Jellyfin doesn't guarantee ids order; keep Seerr's most-recent-first.
		const byId = new Map(items.map((item) => [item.Id, item]));
		return ids.map((id) => byId.get(id)).filter(Boolean);
	} catch {
		return [];
	}
}
