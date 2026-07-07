# Architecture

## Goal

Jellyfin stays completely off the internet. Only SvelteFin (this SvelteKit app) is exposed
via a reverse proxy. The browser never talks to Jellyfin and never sees a Jellyfin token.

```
Internet ──HTTPS──> reverse proxy ──> SvelteFin (Bun, adapter-node build)
                                          │
                                     localhost only
                                          │
                                      Jellyfin (:8096)      Jellyseerr (optional)
```

## Trust boundary

- **Everything under `src/lib/server/` and `+page.server.js` / `+server.js` runs on the server.**
  SvelteKit enforces that `$lib/server` modules can never be imported into client code.
- The browser receives: rendered HTML, page data (item metadata), and media bytes via the
  proxy routes under `/api/`. Nothing else.

## Sessions (`src/lib/server/session.js`)

- Login posts credentials to a SvelteKit form action which calls
  `POST /Users/AuthenticateByName` on Jellyfin server-side.
- The returned `AccessToken` + user info is sealed with **AES-256-GCM** (key = SHA-256 of
  `SESSION_SECRET`) into the `sf_session` cookie: `httpOnly`, `secure` (prod), `SameSite=Lax`,
  30-day expiry (also embedded and checked inside the encrypted payload).
- Stateless by design: no server-side session store, survives restarts, scales horizontally.
  Trade-off: individual sessions can't be revoked server-side; rotate `SESSION_SECRET` to
  revoke everything (Jellyfin-side token revocation via its dashboard also works).
- `hooks.server.js` unseals the cookie on every request into `event.locals.session` and
  redirects to `/login` (pages) or 401s (`/api/*`) when absent.

## Media proxy (`src/routes/api/media/[...path]/+server.js`)

The only route that streams bytes. GET-only, session required, and the forwarded path must
match a whitelist:

- `Videos/**` – streams, HLS playlists/segments, subtitles, trickplay
- `Items/{id}/Images/**` – artwork

Details that matter:

- `api_key` / `ApiKey` / `X-Emby-Token` query params are stripped in **both** directions:
  from client requests before forwarding, and from `.m3u8` playlist bodies before they are
  sent to the browser (Jellyfin embeds the user token in segment URLs inside playlists).
  Auth is re-attached server-side via the `Authorization: MediaBrowser ..., Token=".."` header.
- `Range`, `If-None-Match`, `If-Modified-Since` request headers are forwarded so seeking and
  caching work; `Content-Range`/`ETag` etc. are forwarded back.
- Relative segment URLs inside HLS playlists resolve naturally under `/api/media/...`, so no
  URL rewriting is needed beyond the token strip.
- **Artwork is cached in nginx** (`deploy/nginx.conf`, `Items/{id}/Images/**` only, 30 days /
  1 GiB): the URL fully determines the bytes, so the cache is shared across sessions.
  Deliberate trade-off: a cache HIT skips the app's session check, so artwork can outlive a
  logout; the location requires the `sf_session` cookie to at least be *present* (blocks
  anonymous scraping), every MISS authenticates fully, and non-200s are never cached. Video
  paths are never cached (`proxy_buffering off` and `no-store` stay in force).

## Playback reporting (`src/routes/api/playing/+server.js`)

The player posts `{event: start|progress|stopped, itemId, positionTicks, ...}`; the server
builds the Jellyfin `PlaybackStartInfo`/`PlaybackProgressInfo` body from a fixed field set
(no client-controlled passthrough) and forwards to `/Sessions/Playing[/Progress|/Stopped]`.
This keeps resume points, watched state and Next Up in sync.

## Movies & shows only

`getViews()` filters `/UserViews` to `CollectionType` in `['movies', 'tvshows']`
(`SUPPORTED_COLLECTION_TYPES` in `src/lib/server/jellyfin.js`). The header renders these
views left-to-right in server order, then the optional Seerr "Requests" tab.

## Security headers

Set in `hooks.server.js`: `X-Content-Type-Options`, `X-Frame-Options: DENY`,
`Referrer-Policy: same-origin`, `Permissions-Policy`. CSP with nonces is a roadmap item
(SvelteKit supports it via `kit.csp`, needs testing with hls.js blob URLs and dev mode).

## Login throttling

In-memory 5 attempts/min/IP in `src/routes/login/+page.server.js`. Behind a reverse proxy,
make sure the proxy passes the real client IP (`X-Forwarded-For`) and adapter-node is
started with `ADDRESS_HEADER=x-forwarded-for` (see `docs/deploy.md` section in roadmap),
otherwise all clients share one bucket.

## Runtime

- Bun for package management and running the production build (`bun ./build/index.js`).
- `@sveltejs/adapter-node` output is plain Node-compatible JS; Bun runs it fine. Dev mode
  (`bun run dev`) runs Vite. No Bun-only APIs are used, deliberately, so everything also
  works under Node if ever needed.
