import { env } from '$env/dynamic/private';

// Sessions are stateless: the Jellyfin access token is sealed into the cookie
// with AES-256-GCM so it never reaches the browser in readable form and no
// server-side store is needed. Rotating SESSION_SECRET invalidates all sessions.

export const SESSION_COOKIE = 'sf_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let keyPromise;

function getKey() {
	if (!keyPromise) {
		const secret = env.SESSION_SECRET;
		if (!secret || secret.length < 32) {
			throw new Error('SESSION_SECRET must be set to at least 32 characters (openssl rand -hex 32)');
		}
		keyPromise = crypto.subtle
			.digest('SHA-256', new TextEncoder().encode(secret))
			.then((bits) => crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']));
	}
	return keyPromise;
}

/**
 * @param {{ token: string, userId: string, name: string, deviceId: string }} data
 * @returns {Promise<string>} opaque cookie value
 */
export async function seal(data) {
	const key = await getKey();
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = new TextEncoder().encode(JSON.stringify({ ...data, exp: Date.now() + SESSION_TTL_MS }));
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
	return `${Buffer.from(iv).toString('base64url')}.${Buffer.from(ciphertext).toString('base64url')}`;
}

/**
 * @param {string | undefined} cookie
 * @returns {Promise<{ token: string, userId: string, name: string, deviceId: string } | null>}
 */
export async function unseal(cookie) {
	if (!cookie) return null;
	try {
		const [ivPart, dataPart] = cookie.split('.');
		const key = await getKey();
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: Buffer.from(ivPart, 'base64url') },
			key,
			Buffer.from(dataPart, 'base64url')
		);
		const session = JSON.parse(new TextDecoder().decode(plaintext));
		if (!session.exp || session.exp < Date.now()) return null;
		return session;
	} catch {
		return null;
	}
}
