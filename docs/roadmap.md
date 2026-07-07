# Roadmap / open items

## Done (initial build, 2026-07)

- SvelteKit + Bun scaffold, plain JS (jsdoc types), no Tailwind; deps: hls.js only
  (+ dev tooling, @types/node for editor/check ergonomics).
- Encrypted stateless sessions (AES-256-GCM cookie), login/logout, brute-force throttle.
- Header nav: movie/show libraries left→right from `/UserViews`, Seerr "Requests" tab.
- Home (Continue Watching / Next Up / Latest per library), library grid with pagination,
  search, item pages (movie hero; series with season tabs + episode list), similar row.
- Watch page: PlaybackInfo negotiation, DirectPlay/DirectStream/HLS-transcode, hls.js
  fallback, external VTT subtitles, resume, progress reporting (start/progress/stopped).
- Hardened media proxy (`/api/media/**`): GET-only, path whitelist, api_key stripping incl.
  inside m3u8 bodies, Range/cache header passthrough.
- Seerr: trending, search, request (movies + all-season TV).

## Done (second pass, 2026-07)

- Fixed Seerr search 400 on spaces (manual `%20` encoding — see docs/seerr.md).
- Library infinite scroll (`/api/library/[id]` JSON pages + IntersectionObserver sentinel).
- Requests trending "Load more" button (`/api/seerr/discover?page=N`).
- Audio/subtitle track selectors on the watch page (docs/playback.md).
- Intro/outro skip button via Jellyfin media segments (Intro Skipper plugin compatible).
- Watchlist tab — backed by a personal Jellyfin playlist named "Watchlist", created on
  first add (`getWatchlistId({create:true})`). *(Superseded in the third pass — see below.)*
- Favorites tab (`filters=IsFavorite`). *(Merged into Watchlist in the third pass.)*
- Card hover actions: ♥ favorite toggle, +/− watchlist, ✕ remove-from-resume (home,
  Continue Watching); same buttons on the item page next to Play. All through
  `POST /api/item-action` (whitelisted action set).
- Home: Latest rows now load 24 items; Continue Watching cards have the ✕ button.
- User customizations to keep: `APP_NAME` env for branding, Inter font (@fontsource/inter),
  volume persistence in localStorage (`sf_volume`), fixed-header + absolute hero layout.

## Done (third pass, 2026-07)

- **Experimental libmpv-wasm direct-play backend** behind `ENABLE_MPV_BACKEND=1` +
  watch-page "mpv" toggle: sparse chunked LRU byte-range cache (OPFS sync access handles,
  slot-file design) between the `/api/media/` proxy and mpv's file reads, SAB rendezvous to
  a dedicated cache worker, sequential prefetch with seek cancellation, buffer-bar stats.
  Player-backend abstraction extracted (`src/lib/player/`): watch page → PlayerController
  contract → `HtmlPlayer.svelte` (old inline player) / `MpvPlayer.svelte`. No new npm deps —
  libmpv-wasm is vendored into gitignored `static/mpv/` (GPL-3.0, build steps in
  `src/lib/player/mpv/README.md`, incl. upstream-API assumptions still to verify against a
  real build). COOP/COEP headers via hooks + vite dev config + reverse proxy (README).
- **Watchlist now backed by Jellyfin favorites** (`filters=IsFavorite`): the playlist-based
  watchlist was scrapped (Jellyfin's playlist semantics for adding shows weren't what we
  wanted — added episode entries instead of the series). The separate Favorites tab and the
  ♥ buttons are gone; the single +/✓ watchlist button toggles `IsFavorite`
  (`/api/item-action`: `watchlist-add`/`watchlist-remove`; `favorite`/`unfavorite` actions
  removed). Membership shows instantly on cards via `UserData.IsFavorite`.

## Done (fourth pass, 2026-07)

- **mpv backend PLAYS now** (first real end-to-end playback 2026-07-06). The debugging
  chain, each stage verified live in the browser (full details in
  src/lib/player/mpv/README.md):
  1. `locateFile` injected into the `libmpvLoader` global (file-packager resolved
     `libmpv.data` against the *page* URL → `/watch/libmpv.data` 502).
  2. `id="canvas"` on the player canvas (OffscreenCanvas transfer to the mpv pthread and
     SDL's input handlers are keyed by element id; no id → no GL context, silent).
  3. COEP split (below) — Firefox hard-blocks `credentialless` on worker scripts.
  4. **SDL DOM input handlers refused** (addEventListener interception): they
     `emscripten_proxy_sync` main → mpv thread on every mousemove, which deadlocks against
     the engine's file I/O proxying the other way. We drive mpv via embind only.
  5. **The externalfs backend runs its JS on the engine's pthread workers, not the main
     thread** (upstream proxies opens to a C++ side thread). The virtual-file getFile()
     interception is injected into every pthread worker via a `mainScriptUrlOrBlob` Blob
     wrapper (`pthread-patch.js`); reads reach the cache worker over a BroadcastChannel.
  6. **Read results go over per-requester channels** — broadcasting payloads queues clones
     in every `Atomics.wait`-parked worker (unbounded → renderer OOM crash within seconds).
  7. AudioContext resumed on first in-player gesture (autoplay policy freezes mpv's
     audio-slaved clock); canvas `object-fit: contain` (SDL sizes the bitmap to the
     *screen*, not the element).
- **Docker deployment** (`docker compose up -d --build`): bun-built adapter-node app +
  nginx front (`deploy/nginx.conf`) that owns COOP/COEP. Key gotcha: Firefox rejects COEP
  `credentialless` on dedicated **worker scripts** (hard-blocks the load), so worker paths
  (`/mpv/`, `/_app/immutable/workers/`) get `require-corp` while documents stay
  `credentialless`; nginx `proxy_hide_header`s the app's own copies to avoid duplicate COEP
  (parses invalid → isolation silently off). Same split in vite.config.js for dev/preview,
  which now reads `ENABLE_MPV_BACKEND` from `.env` via `loadEnv` (process.env alone missed
  it, so dev headers were silently off). `ORIGIN` added to `.env` (form actions/CSRF behind
  pangolin, which terminates TLS in front of nginx's port 8080).

## Done (fifth pass, 2026-07)

- **mpv canvas layout fixed**: SDL stamps screen-pixel inline styles onto the canvas
  element (`emscripten_set_element_css_size` proxied from the mpv pthread), which clobbered
  `width: 100%` — the canvas rendered screen-sized inside the player box, off-center and
  cropped. Stylesheet `width/height … !important` now beats the inline styles (engine keeps
  the drawing buffer, CSS keeps layout; see mpv/README.md "Also load-bearing").
- **Fullscreen**: `:fullscreen` styles were missing entirely (the wrap went fullscreen but
  the canvas kept its windowed `max-height` and the broken inline sizing). Canvas now
  flexes into all space above the controls; `requestFullscreen()` rejections are logged.
- **mpv-native audio/subtitle selectors** in the player controls bar: wrapper
  `audioTracks`/`subtitleTracks`/`audioStream`/`subtitleStream` props → `MpvPlayerState`,
  switching via embind `setAudioTrack`/`setSubtitleTrack(BigInt)`; `0n` = subtitles off
  (needs live verification). The transcode-based watch-bar selectors remain hidden for mpv.
- **Next/previous episode buttons** on the watch page (`/Shows/{seriesId}/Episodes?adjacentTo=`,
  crosses season boundaries). Full-page loads (`data-sveltekit-reload`): new playback
  session anyway, and the mpv engine allows one ExternalFS mount root per module instance.
- Removed the `console.debug` diagnostics + the console.error stack-tap from the mpv path
  (roadmap item 0 cleanup); warnings/errors stay.
- **mpv picture placement**: element CSS alone wasn't enough — the image inside the buffer
  sat bottom-anchored/letterboxed for a wrong window size (SDL window created before the
  screen size is known). Fixed with embind `matchWindowScreenSize()` on first playback.
- **mpv is now the default backend** when `ENABLE_MPV_BACKEND=1`; `?backend=html` opts out
  (watch-bar toggle). Boot failures auto-fall back to the html player unless mpv was
  explicitly requested (`?backend=mpv` keeps the error visible); the mpv error overlay got
  a "Use the standard player" link either way.
- **HLS/transcode audio track switching fixed**: `AudioStreamIndex` without `MediaSourceId`
  is not reliably applied by Jellyfin — stream selection now renegotiates PlaybackInfo with
  the concrete `MediaSourceId` (like jellyfin-web). Also guarded the DirectStream fallback
  from silently serving default audio / dropping a burned subtitle after a forced
  renegotiation (hard 502 instead).
- **mpv picture placement, take two** (`matchWindowScreenSize()` alone wasn't enough): the
  engine mixes `screen.*`, `window.innerWidth/innerHeight` (upstream EM_ASM) and
  `devicePixelRatio` when sizing its window vs. buffer, so they disagreed. All of those
  reads are now spoofed to a fixed **1920×1080 render size** while the player is mounted
  (restored on teardown); window == buffer == 1080p and CSS object-fit scales the frame.
- **mpv initial volume fixed**: setVolume before loadFile doesn't survive the file load —
  the saved `sf_volume` is re-applied on first observed playback.
- **Seerr results on the library search page** as a second "Request it" row: seerr card
  grid extracted to `SeerrGrid.svelte`, `request` form action shared via `requestAction()`
  in `$lib/server/seerr.js` (used by /requests and /search). Fully "Available" titles are
  filtered out of the search row (they're already in the Jellyfin results above).
- **Skip-intro works in mpv fullscreen**: mpv now fullscreens its *parent* (the page's
  `.videowrap`) instead of itself, so the page-level skip button stays visible; windowed
  skip already worked through the PlayerController contract.
- **nginx artwork cache** (`Items/{id}/Images/**`, 30 d / 1 GiB, shared across sessions;
  trade-off + cookie-presence gate documented in docs/architecture.md). Video paths stay
  uncached/unbuffered.
- **Up-next autoplay**: when an episode ends and a next episode exists, a cancellable 8 s
  countdown overlay (inside `.videowrap`, so visible in mpv fullscreen too) navigates to it
  — same full-page load as the Next button.
- **Item hero media facts**: resolution (4K/1080p/…), HDR type (when not SDR), video codec
  and audio languages (Jellyfin's `LocalizedLanguage`, de-duped) from
  `MediaSources[0].MediaStreams`; hidden when the item has no media (e.g. series).
- **Trickplay seek previews on the mpv seekbar** (unblocked by the custom mpv controls;
  native `<video>` stays without): hover → thumbnail from Jellyfin's tile sheets
  (`/Videos/{id}/Trickplay/{width}/{n}.jpg` via the media proxy; widest set ≤ 320px).
- **Watched toggles**: `mark-played`/`mark-unplayed` in `/api/item-action`
  (`/UserPlayedItems/{id}`), ✔/↺ hover button on all cards (home rows + library/search
  grids), "Mark watched / ✓ Watched" button on the item page (series = whole series).
- **Remove from Next Up** ✕ on Next Up cards — the v12 spec has **no** hide-from-next-up
  endpoint, so it marks the whole series played (button title says so). Caveat: marking a
  partially-watched series *unplayed* later loses per-episode watched state.
- **21:9 off-center fixed for real**: third piece of the sizing saga — mpv resizes its
  window to the *video's* aspect at load (breaking window == buffer == 1080p);
  `auto-window-resize=no` in the loadFile options pins it (mpv ≥ 0.38, verified present in
  the build). Also: the `elapsed`-based autoplay detection now clears `paused`, so the
  play button no longer shows ▶ during autoplay.
- **Aspect-adaptive render buffer** (fourth sizing piece): buffer height now follows the
  video's aspect (`videoTracks` demuxW/demuxH → spoof height → `matchWindowScreenSize()`),
  so mpv no longer bakes letterbox bars into the buffer — 21:9 media fills a 21:9 monitor
  in fullscreen.
- **Fullscreen UI polish**: controls are a fading overlay in fullscreen (playback owns the
  whole screen); they fade out after 2.5 s without pointer movement or when the pointer
  leaves, fade back on movement, cursor hidden while idle.
- **Saved volume applied at load**: `volume=` as a file-local loadFile option — a
  `setVolume()` before loadFile is reset by the file load, and re-applying after playback
  starts still let the first moments play at 100%. Scale gotcha: mpv's 0–100 volume runs
  through a *cubic* gain curve (50 ≈ −18 dB), unlike the html player's linear
  `video.volume` — the shared `sf_volume` fraction is cbrt-mapped for mpv (`toMpvVolume`)
  so both players sound the same at the same slider position.
- **Click on the picture toggles play/pause** (embind inline — safe; only SDL's own
  proxied DOM handlers were the deadlock hazard).

## Done (sixth pass, 2026-07)

- **Active-streams widget** in the header (between search and username): hover/click
  dropdown listing current playback sessions — poster, title (S..E.. for episodes),
  progress bar + position/runtime, Direct Play/Transcode + codec + bitrate tags, user ·
  client · device, remote IP. `GET /Sessions?activeWithinSeconds=` via new
  `/api/streams` route (trimmed DTO only — no tokens/URLs leave the server); Jellyfin
  scopes visibility itself (admins see all sessions, users their own). Polls every 30 s,
  10 s while open.
- **Seerr details dialog**: clicking a poster in `SeerrGrid` (on /requests and /search)
  opens a native `<dialog>` with backdrop/poster art, tagline, overview, genres, runtime
  or season count, TMDB rating, cast strip, and the same Request button / availability
  status. Data from Seerr's `/movie/{id}` / `/tv/{id}` via new `/api/seerr/details`
  route (docs/seerr.md).
- **"Requested by me" home row** (below Next Up, Seerr only): available Seerr requests by
  the API key's user resolved to Jellyfin library items via `media.jellyfinMediaId` +
  `GET /Items?ids=`, most recently added first. Fails soft (row hidden) if Seerr is down.
- **Cast strip on the item page** (above More Like This): `item.People` filtered to
  `Type === 'Actor'` (first 20), round photos via the media proxy — note People carry
  `PrimaryImageTag`, not `ImageTags`, so `imgUrl()` doesn't apply there.
- **Volume slider NaN fix**: `parseFloat(localStorage.getItem('sf_volume')) ?? 0.5`
  never fell back (`parseFloat(null)` is NaN, and `NaN ?? x` is NaN) — on browser
  profiles where `sf_volume` was never seeded the mpv slider glitched. Both backends now
  share `$lib/player/volume.js` (`savedVolumeFraction`/`saveVolumeFraction`, clamped +
  NaN-guarded).
- **Space = play/pause on the watch page** via `PlayerController.togglePlay()` (both
  backends); skipped when the event targets an interactive element (inputs incl. header
  search, selects, buttons, links, the native `<video>` whose controls handle space
  themselves) and on key repeat.
- **Expired session → login redirect**: logging in from a second browser/device revokes
  the first token (same per-user `deviceIdFor` — deliberate), which surfaced as a raw
  "401 Jellyfin session expired" error page. `hooks.server.js` now converts a 401 page
  response (when a session cookie was present) into a 303 to `/login` and clears the
  cookie — built by hand, since after `resolve()` neither `cookies.delete()` nor thrown
  `redirect()` is allowed in `handle`. API routes keep returning plain 401s. True
  concurrent sessions would need a per-login (not per-user) device id — roadmap.

## Next up (roughly prioritized)

0. **mpv backend polish, remaining**: verify live — track selectors (incl. `0n` = subs
   off), fullscreen, Jellyfin progress reporting/mark-played from the mpv path.
1. **Verify against a real Jellyfin 12 server** — `TranscodingUrl` shape (DynamicHls is out
   of the spec), subtitle `DeliveryUrl`s, media segments, playlist create/remove flows.
2. Custom player controls for the html backend → trickplay there too (done for mpv);
   quality selector.
4. CSP with nonces via `kit.csp` (test hls.js blob: URLs, tmdb images on /requests).
5. Library filters/sort UI (genre, year, unwatched; `sortBy` options).
6. Deployment leftovers (compose + nginx + `ORIGIN` done, fourth pass):
   `ADDRESS_HEADER=x-forwarded-for` for real client IPs in logs, `BODY_SIZE_LIMIT` if
   uploads ever appear.
7. Per-user Seerr auth (docs/seerr.md), request management UI.
8. QuickConnect login option; "server offline" error page polish.
9. Revisit libmpv-wasm when it can stream from URLs (docs/playback.md).

## Conventions

- Plain JavaScript only — no TypeScript files, no Tailwind, keep dependencies minimal and
  justify any addition here.
- All Jellyfin/Seerr traffic goes through `src/lib/server/`; never call them from client code.
- Anything the browser fetches must go through an authenticated, whitelisted `/api/` route.
- 4-space indentation and trailing commas in routes/components (owner's prettier style);
  `src/lib/server/` still uses tabs — match whichever the file you're editing uses.
