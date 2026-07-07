import { fail, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { login } from '$lib/server/jellyfin.js';
import { seal, SESSION_COOKIE } from '$lib/server/session.js';
import { env } from '$env/dynamic/private';

// Simple in-memory brute-force throttle. Good enough behind a reverse proxy
// for a single instance; see docs/roadmap.md for hardening notes.
const attempts = new Map();
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

function throttled(ip) {
    const now = Date.now();
    const entry = attempts.get(ip) ?? { count: 0, windowStart: now };
    if (now - entry.windowStart > WINDOW_MS) {
        entry.count = 0;
        entry.windowStart = now;
    }
    entry.count += 1;
    attempts.set(ip, entry);
    if (attempts.size > 10_000) attempts.clear();
    return entry.count > MAX_ATTEMPTS;
}

export function load({ locals }) {
    if (locals.session) redirect(303, '/');
    return { data: { appName: env.APP_NAME } };
}

export const actions = {
    default: async ({ request, cookies, getClientAddress }) => {
        if (throttled(getClientAddress())) {
            return fail(429, { error: 'Too many attempts, try again in a minute.', username: '' });
        }

        const form = await request.formData();
        const username = String(form.get('username') ?? '').trim();
        const password = String(form.get('password') ?? '');
        if (!username) return fail(400, { error: 'Username is required.', username });

        let session;
        try {
            session = await login(username, password);
        } catch {
            return fail(502, { error: 'Could not reach the Jellyfin server.', username });
        }
        if (!session) return fail(401, { error: 'Invalid username or password.', username });

        cookies.set(SESSION_COOKIE, await seal(session), {
            path: '/',
            httpOnly: true,
            secure: !dev,
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60,
        });
        redirect(303, '/');
    },
};
