import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

// Dev/preview parity for the mpv backend: hooks.server.js sets COOP/COEP on
// SSR responses, but module/worker chunks and static/ files are served by
// vite/sirv middlewares (vite's `server.headers` does not reach sirv), and
// every response needs the headers for crossOriginIsolated to hold.
// Worker *scripts* must be served with COEP require-corp, not credentialless:
// Firefox accepts credentialless on documents but not on dedicated worker
// scripts and hard-blocks the load (NS_ERROR_DOM_COEP_FAILED). require-corp is
// cross-origin-isolation-compatible with a credentialless document in every
// engine, so the split is safe. Covers vite's dev worker URLs (?worker_file),
// the vendored libmpv assets (pthread workers boot from /mpv/libmpv.js), and
// built worker chunks (vite preview).
const isWorkerScript = (url = '') =>
	url.includes('worker_file') ||
	url.startsWith('/mpv/') ||
	url.startsWith('/_app/immutable/workers/');

/** @param {string} documentCoep */
const mpvIsolationPlugin = (documentCoep) => ({
	name: 'sveltefin-mpv-isolation-headers',
	/** @param {import('vite').ViteDevServer} server */
	configureServer(server) {
		server.middlewares.use((req, res, next) => {
			res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
			res.setHeader(
				'Cross-Origin-Embedder-Policy',
				isWorkerScript(req.url) ? 'require-corp' : documentCoep
			);
			next();
		});
	},
	configurePreviewServer(server) {
		this.configureServer(server);
	}
});

export default defineConfig(({ mode }) => {
	// hooks.server.js gets ENABLE_MPV_BACKEND from .env via $env/dynamic/private,
	// but this file runs before vite's env handling — process.env alone misses
	// .env, silently disabling the isolation headers in dev. Merge both.
	const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
	const mpvEnabled = env.ENABLE_MPV_BACKEND === '1' || env.ENABLE_MPV_BACKEND === 'true';

	return {
		plugins: [
			...(mpvEnabled ? [mpvIsolationPlugin(env.MPV_COEP || 'credentialless')] : []),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},

				adapter: adapter()
			})
		]
	};
});
