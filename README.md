# SvelteFin

A secure, minimal web client for Jellyfin (movies & shows only), built with SvelteKit and
Bun in plain JavaScript. Designed so **Jellyfin never touches the internet**: only this app
is exposed (behind a reverse proxy) and it talks to Jellyfin on localhost, with the user's
Jellyfin token sealed inside an encrypted httpOnly cookie — never visible to the browser.

Optional Jellyseerr/Overseerr integration adds a "Requests" tab next to your libraries.

Documentation for design decisions lives in [docs/](docs/) — start with
[docs/architecture.md](docs/architecture.md) and [docs/roadmap.md](docs/roadmap.md).

## Setup

```sh
bun install
cp .env.example .env   # then edit:
#   JELLYFIN_URL    e.g. http://127.0.0.1:8096 (keep Jellyfin bound to localhost/LAN)
#   SESSION_SECRET  openssl rand -hex 32
#   SEERR_URL / SEERR_API_KEY   optional
```

## Develop

```sh
bun run dev
```

## Production

```sh
bun run build
ORIGIN=https://your-domain.example ADDRESS_HEADER=x-forwarded-for bun ./build/index.js
```

Put a reverse proxy (Caddy, nginx, ...) with TLS in front of port 3000. `ORIGIN` must match
the public URL or form posts (login) will be rejected; `ADDRESS_HEADER` makes the login
rate-limit see real client IPs.

## Dependencies

Runtime: `hls.js` (HLS playback in non-Safari browsers — loaded only on the watch page).
That's it, by design; see the conventions section in [docs/roadmap.md](docs/roadmap.md).
