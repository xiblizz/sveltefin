# Seerr integration (Jellyseerr/Overseerr)

Optional. Configured via `SEERR_URL` + `SEERR_API_KEY`; when unset the "Requests" tab is
hidden and `/requests` 404s. Code: `src/lib/server/seerr.js`, `src/routes/requests/`.

## What works

- "Requests" appears as the right-most tab in the header, styled like a library.
- Trending discover feed (`GET /api/v1/discover/trending`) with a "Load more" button that
  appends further pages client-side via `/api/seerr/discover?page=N`.
- Search (`GET /api/v1/search?query=`).
  **Gotcha:** Seerr's search 400s on `+`-encoded spaces — the query string is built with
  `encodeURIComponent` (→ `%20`) by hand in `seerr()`, NOT with `URLSearchParams`. Don't
  "simplify" that back.
- Requesting: `POST /api/v1/request` with `{mediaType, mediaId}`; for TV we first fetch
  `/api/v1/tv/{tmdbId}` and request all season numbers > 0.
- Availability badges from `mediaInfo.status` (2 Requested / 3 Processing / 4 Partly / 5 Available).
- "Requested by me" home row: `GET /api/v1/request?filter=available&sort=added&requestedBy={id}`
  (`id` from `/auth/me` — the API key's user, i.e. everything requested through this app),
  then the requests' `media.jellyfinMediaId`s are resolved to real library items via
  Jellyfin `GET /Items?ids=` (Seerr order kept — Jellyfin doesn't guarantee ids order).
  Row hidden when Seerr is off, unreachable, or nothing is available yet.
- Details dialog: clicking a poster in `SeerrGrid` opens a `<dialog>` with full info
  (tagline, genres, runtime/seasons, rating, cast, backdrop) from `GET /api/v1/movie/{id}`
  or `/api/v1/tv/{id}` (proxied through our `/api/seerr/details?type=&id=` route;
  `getMediaDetails()` in seerr.js maps the shape). TV note: `episodeRunTime` is often an
  empty array — runtime is optional in the UI.

## Caveats / future work

- **Single-user auth**: all requests are made with the admin API key, so they show up in
  Seerr as the key's user. Per-user attribution would need Jellyseerr's
  `POST /api/v1/auth/jellyfin` login flow reusing the user's Jellyfin credentials at login
  time, storing a per-user Seerr cookie in our session. Worth doing later.
- Poster images load directly from `image.tmdb.org` (public CDN, no auth). If we ever add a
  strict CSP or want zero third-party requests, proxy these too.
- No request management UI (approve/decline/list own requests) yet.
