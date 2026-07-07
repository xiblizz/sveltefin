import { json, error } from '@sveltejs/kit';
import { reportPlaying } from '$lib/server/jellyfin.js';

// Receives playback progress from the player and forwards it to Jellyfin so
// watch state, resume points and "Next Up" stay in sync. The body sent to
// Jellyfin is constructed here from a fixed set of fields — the client cannot
// smuggle arbitrary payloads through.
export async function POST({ request, locals }) {
	let data;
	try {
		data = await request.json();
	} catch {
		error(400, 'Invalid JSON');
	}

	const { event, itemId, mediaSourceId, playSessionId, positionTicks, isPaused, playMethod } = data;
	if (!['start', 'progress', 'stopped'].includes(event) || typeof itemId !== 'string') {
		error(400, 'Invalid playback report');
	}

	await reportPlaying(locals.session, event, {
		ItemId: itemId,
		MediaSourceId: typeof mediaSourceId === 'string' ? mediaSourceId : undefined,
		PlaySessionId: typeof playSessionId === 'string' ? playSessionId : undefined,
		PositionTicks: Number.isFinite(positionTicks) ? Math.round(positionTicks) : 0,
		IsPaused: Boolean(isPaused),
		PlayMethod: playMethod === 'DirectPlay' ? 'DirectPlay' : 'Transcode',
		CanSeek: true
	});

	return json({ ok: true });
}
