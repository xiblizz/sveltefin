# Playback

## libmpv-wasm (revisited 2026-07): experimental direct-play backend

The 2026-07 verdict ("not viable — local files only") is now worked around rather than
waited out: instead of libmpv gaining URL loading, we feed it a **virtual file** backed by a
sparse, chunked, LRU-evicted HTTP range cache (OPFS chunk store in a dedicated worker that
fetches `/api/media/Videos/{id}/stream?static=true` with `Range` headers; mpv's reads reach
it as async virtual-Blob reads through the build's own externalfs backend).
Full design, upstream-API assumptions and deployment requirements:
`src/lib/player/mpv/README.md`.

Still true and accepted as trade-offs: software decode (~1 core/stream), 4 GB file limit,
GPL-3.0 (vendored into gitignored `static/mpv/`, not npm), COOP/COEP required
(`ENABLE_MPV_BACKEND=1` turns the headers on; COEP `credentialless` keeps TMDB posters
working, Safari unsupported).

Status: **default backend** when `ENABLE_MPV_BACKEND=1` (fifth pass; without the env var
nothing changes). `?backend=html` — the watch-bar toggle — opts out; boot failures
(no COOP/COEP, no OPFS, Firefox's missing `queryPermission`) auto-fall back to the
HLS/native player below, unless mpv was explicitly requested via `?backend=mpv`, which
keeps the error overlay visible (it links to the standard player either way).

## Player backend abstraction (added 2026-07)

`src/lib/player/index.js` maps `data.kind` → component: `HtmlPlayer.svelte` (native
`<video>`, DirectPlay + hls.js — the previous inline watch-page player, extracted verbatim)
or `MpvPlayer.svelte`. The watch page owns session concerns (progress reporting, skip
segments, track selectors, backend toggle) and reaches the active backend only through the
`PlayerController` contract (`getCurrentTime/isPaused/seek/setTextTrack`) plus
`onplay/onpause/onended/ontimeupdate` callbacks — no backend if/else in page logic beyond
hiding the transcode-based track selectors for mpv. mpv has its own selectors in the player
controls bar (fifth pass): they list mpv's live `track-list` and switch via embind
`setAudioTrack`/`setSubtitleTrack(bigint)` — instant, no renegotiation, id `0` = subtitles
off.

## Current strategy (src/routes/watch/[id]/)

1. Server-side `POST /Items/{id}/PlaybackInfo` with our browser `DeviceProfile`
   (`src/lib/server/deviceProfile.js`).
2. Pick from the first `MediaSource`:
   - `SupportsDirectPlay` and container mp4/m4v/webm → `/Videos/{id}/stream.{container}?static=true`
     (`PlayMethod: DirectPlay`) — plain progressive file, `<video>` plays it, Range seeking.
   - else `TranscodingUrl` (HLS) → proxied via `/api/media` (`PlayMethod: Transcode`).
   - else `SupportsDirectStream` → remuxed `/Videos/{id}/stream` (`DirectStream`).
3. HLS playback: Safari plays it natively (`canPlayType('application/vnd.apple.mpegurl')`);
   other browsers use **hls.js**, dynamically imported only on the watch page.
4. External subtitles: `MediaStreams` with `DeliveryMethod === 'External'` become `<track>`
   elements (VTT, proxied). Burned-in subs happen automatically when Jellyfin decides to.
5. Resume: `?resume=1` seeks client-side to `UserData.PlaybackPositionTicks`. We deliberately
   do NOT pass `StartTimeTicks` to PlaybackInfo — Jellyfin's HLS playlist spans the full
   duration, so absolute positions stay correct and progress reporting needs no offset math.
6. Progress: `start` on first play, `progress` every 10 s and on pause, `stopped` on
   ended/unmount/beforeunload (fetch with `keepalive: true`).

## Ticks

Jellyfin measures time in ticks: **1 tick = 100 ns, 10,000,000 ticks = 1 s**
(helpers in `src/lib/img.js`).

## Track selection (added 2026-07)

Selectors in the watch-page bar, driven by `?audio=` / `?subtitle=` stream indices:

- Any explicit stream choice is a **renegotiation**: a plain PlaybackInfo first, then a
  second one with the concrete `MediaSourceId` + the forced indices (fifth pass; matches
  jellyfin-web). `AudioStreamIndex` without `MediaSourceId` is not reliably applied —
  Jellyfin kept serving the default audio.
- **Audio**: any explicit choice reloads with `EnableDirectPlay/DirectStream: false` +
  `AudioStreamIndex` — browsers can't switch embedded audio, so it always transcodes.
- **Subtitles**: external text subs toggle instantly client-side (`textTracks` modes, no
  renegotiation). Embedded/image subs (PGS etc.) reload with `SubtitleStreamIndex` +
  `AlwaysBurnInSubtitleWhenTranscoding` + forced transcode. The server probes the first
  PlaybackInfo response to see whether the chosen index is external before deciding.
- Position carries over via `?t=<seconds>`; a full page reload keeps the hls.js/session
  teardown trivial. Note: some browsers may block un-gestured autoplay after the reload.

## Intro/outro skipping (added 2026-07)

`GET /MediaSegments/{itemId}` (Jellyfin's native media segments API — populated by plugins
such as Intro Skipper ≥ v0.2) filtered to `Intro`/`Outro` in `getSkippableSegments()`.
The player polls `timeupdate` and overlays a "Skip Intro"/"Skip Credits" button while inside
a segment. No plugin installed → empty list → no UI. Errors are swallowed deliberately.

## Known gaps / ideas

- **Trickplay scrub previews: blocked on custom player controls.** The native `<video controls>`
  UI exposes no seek-bar hover events, so there's nowhere to render preview tiles. The data
  side is ready (`/Videos/{id}/Trickplay/...` is whitelisted in the proxy; item field
  `Trickplay` lists widths/intervals). Do this together with a custom control bar.
- MKV with browser-friendly codecs (h264+aac) currently transcodes; a smarter profile could
  ask Jellyfin to remux only (DirectStream to fmp4/ts) — check `TranscodingProfiles` tuning.
- No quality/bitrate selector yet (`MaxStreamingBitrate` is fixed at 20 Mbps).
