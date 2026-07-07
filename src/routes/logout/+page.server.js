import { redirect } from '@sveltejs/kit';
import { logout } from '$lib/server/jellyfin.js';
import { SESSION_COOKIE } from '$lib/server/session.js';

export const actions = {
	default: async ({ locals, cookies }) => {
		if (locals.session) await logout(locals.session);
		cookies.delete(SESSION_COOKIE, { path: '/' });
		redirect(303, '/login');
	}
};
