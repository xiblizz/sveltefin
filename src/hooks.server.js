import { redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { unseal, SESSION_COOKIE } from '$lib/server/session.js';

export async function handle({ event, resolve }) {
	event.locals.session = await unseal(event.cookies.get(SESSION_COOKIE));

	const { pathname } = event.url;
	if (!event.locals.session && pathname !== '/login') {
		if (pathname.startsWith('/api/')) {
			return new Response('Unauthorized', { status: 401 });
		}
		redirect(303, '/login');
	}

	const response = await resolve(event);

	// A 401 page despite a session cookie means the Jellyfin token died — e.g.
	// logging in from another browser/device revokes older tokens for the same
	// per-user device id (jellyfin.js deviceIdFor). Drop the stale cookie and
	// send the browser to login instead of the error page. API routes keep
	// their plain 401 (client fetches handle it). Built by hand: after resolve()
	// neither cookies.delete() nor throwing redirect() is allowed in handle.
	if (response.status === 401 && event.locals.session && !pathname.startsWith('/api/')) {
		return new Response(null, {
			status: 303,
			headers: {
				location: '/login',
				'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${dev ? '' : '; Secure'}`
			}
		});
	}

	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'same-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	// Cross-origin isolation for SharedArrayBuffer (libmpv-wasm backend).
	// Static assets bypass this hook in prod (adapter-node serves them first),
	// so the reverse proxy must also set these — see src/lib/player/mpv/README.md.
	if (env.ENABLE_MPV_BACKEND === '1' || env.ENABLE_MPV_BACKEND === 'true') {
		response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
		response.headers.set('Cross-Origin-Embedder-Policy', env.MPV_COEP || 'credentialless');
	}
	return response;
}
