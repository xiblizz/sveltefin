# mpv direct-play backend (libmpv-wasm + sparse HTTP chunk cache)

Direct-plays the *original* file (mkv, HEVC, AC3, DTS, ASS subs, …) in the browser using
[libmpv-wasm](https://github.com/brianhvo02/libmpv-wasm), fed through a sparse, chunked,
LRU-evicted byte-range cache instead of Jellyfin transcoding. With `ENABLE_MPV_BACKEND=1`
this is the **default** watch-page backend; `?backend=html` (the watch-bar toggle) opts out,
and boot failures (no COOP/COEP, no OPFS, Firefox) auto-fall back to the html player unless
mpv was explicitly requested via `?backend=mpv`.

## Architecture

```
 mpv pthread            main thread                          cache worker (ours)
┌────────────┐ proxied ┌───────────────────────┐  postMessage ┌──────────────────────┐
│ demux/     │ FS call │ externalfs backend:   │  {read,      │ cache-worker.js      │
│ decode     │────────▶│ blob.slice()          │   offset,    │  ├ chunk-cache.js    │──OPFS slot file
│ (blocks in │         │   .arrayBuffer() ─────┼─────────────▶│  ├ prefetch-scheduler│
│  proxy)    │◀────────│ mpv-fs-bridge.js      │◀─transferred─│  └ range-client.js   │──fetch /api/media/…
└────────────┘  bytes  │ virtual Blob          │   buffer     └──────────────────────┘   (cookie auth,
                       └───────────────────────┘                                          Range: bytes=…)
```

The mpv pthread blocks inside Emscripten's own FS-proxying machinery (that is how the
compiled externalfs backend works for *real* local files too); the main thread and the
cache worker stay fully async. A SAB/Atomics rendezvous path also exists but is only used
by the legacy-FS fallback adapter (below).

- **`range-client.js`** — Range requests against the existing `/api/media/` proxy. There is
  deliberately *no* Jellyfin URL or token handling here: the proxy route
  (`src/routes/api/media/[...path]/+server.js`) is the single centralized auth point (trust
  boundary, docs/architecture.md), and same-origin cookies ride along automatically. Handles
  206, and 200-fallback (accepted only at offset 0, prefix-read then abort; otherwise
  `RangeUnsupportedError`). Includes a sync-XHR variant as the documented fallback transport
  (worker-only — browsers forbid binary sync XHR on the main thread).
- **`chunk-cache.js`** — fixed-size chunks (default 2 MiB) in a single pre-sized OPFS "slot
  file" via a `FileSystemSyncAccessHandle` (worker-only API). LRU = slot reuse, so eviction
  is an index operation on the cold (network) path, never in the hit path. Never evicts the
  first 4 MiB (mkv EBML/SeekHead) or ±32 MiB around the read head. Index is mirrored to
  `meta.json` (debounced 5 s) so it survives a worker restart; the format validates
  fileSize/chunkSize, which is the hook for cross-session persistence later.
- **`prefetch-scheduler.js`** — warms N chunks (default 6) ahead of sequential reads,
  concurrency-capped; a position jump aborts in-flight prefetches and re-centers. Shares one
  in-flight table with demand reads (a prefetch a demand read is waiting on is promoted and
  becomes non-abortable).
- **`cache-worker.js`** — owns all of the above and serves two read protocols: an async
  postMessage protocol (`{type:'read', id, offset, length}` → transferred ArrayBuffer; the
  primary path) and the SAB rendezvous (`sab-protocol.js`; legacy fallback only). Misses
  are async fetches — the worker never blocks, so prefetch/stats/eviction keep running
  during a network stall.
- **`mpv-fs-bridge.js`** — the mpv-facing side: `mountVirtualFile()` (primary; see
  "Integration, verified" below) and `attachLegacyFsNode()` + `createSyncReader()` (the
  classic `stream_ops` node backed by blocking SAB reads, for non-WASMFS rebuilds). File
  size is probed up-front (`Range: bytes=0-0`) so mpv can seek anywhere immediately without
  hitting fake EOFs.
- **`MpvPlayer.svelte` / `player-state.svelte.js`** — backend component (canvas, minimal
  controls, buffer bar fed by cached-range stats) and the runes-based reactive surface.
  The watch page talks to it only through the `PlayerController` contract in
  `src/lib/player/index.js`; the HLS/native path lives unchanged in `HtmlPlayer.svelte`.

## Why the design deviates from the original brief

The brief assumed the classic Emscripten JS FS and suggested sync XHR (or Asyncify) inside
mpv's read callback. Inspecting upstream's build settings
([CMakeLists.txt](https://github.com/brianhvo02/libmpv-wasm/blob/main/CMakeLists.txt)) shows:

- `-sWASMFS` — the legacy JS `FS` object with `stream_ops` **does not exist** in this build.
- `-sUSE_PTHREADS -sPROXY_TO_PTHREAD` — mpv runs in pthread workers; **we don't control the
  thread mpv's read lands on**, and if it lands on the browser main thread, sync XHR is
  spec-forbidden there.
- **No `-sASYNCIFY`** — the Asyncify option from the brief is unavailable, period.

Hence neither sync XHR nor Asyncify appears on the primary path. Reading the compiled
backend (section below) showed reads surface as *async* `Blob.arrayBuffer()` calls on the
main thread while the mpv pthread blocks in Emscripten's proxy queue — so the primary
transport is plain async postMessage to the cache worker. The SAB/Atomics rendezvous was
built before that discovery and is kept for the legacy-FS fallback adapter, where the read
callback genuinely must return synchronously.

## Vendoring libmpv-wasm (required, not on npm)

Upstream is GPL-3.0-or-later, not published to npm, and needs Emscripten + mpv-build to
compile (see its README). Two format traps make the naive bundle fail:

- `build/*.js` is **CommonJS** (tsc), so `--external:./libmpv.js` becomes a `__require()`
  shim that throws "Dynamic require is not supported" the moment the module evaluates.
- `build/libmpv.js` is Emscripten MODULARIZE output **without** EXPORT_ES6 — a classic
  script defining the global `libmpvLoader`, not an importable ES module.

So: shim the wrapper's `./libmpv.js` import to that global and bundle from inside the
checkout (lodash must resolve). `MpvPlayer.svelte` loads `/mpv/libmpv.js` via a `<script>`
tag first, then imports the bundle:

```sh
# in your libmpv-wasm checkout, after its npm run build
B=.sveltefin-bundle && mkdir -p $B
cp build/index.js build/MpvPlayer.js build/utils.js $B/
printf 'module.exports = globalThis.libmpvLoader;\n' > $B/libmpv.js
(cd $B && bun x esbuild index.js --bundle --format=esm \
    --outfile=$SVELTEFIN/static/mpv/mpv-player.mjs)
cp build/libmpv.js build/libmpv.wasm build/libmpv.data build/libmpv.worker.js \
    $SVELTEFIN/static/mpv/
```

> Emscripten pthread workers re-load `/mpv/libmpv.js` themselves (that's what
> `mainScriptUrlOrBlob` is for). Loader failures surface in the player overlay with the
> underlying error message, not just "not found".

Licensing note: the vendored artifacts are GPL-3.0; keep them out of git (they're
runtime-served assets in `static/mpv/`, ignored via `.gitignore`) and mind the license if you
ever distribute SvelteFin bundled with them.

## COOP/COEP (SharedArrayBuffer) — deployment checklist

`crossOriginIsolated` must be true on the watch page **and** on every worker script, or the
backend refuses to start (clear error in the player):

- **Dev**: `ENABLE_MPV_BACKEND=1 bun run dev` — vite.config.js adds the headers to all dev
  responses.
- **Worker scripts are special.** Firefox accepts COEP `credentialless` on documents but
  **not on dedicated worker scripts** — the worker load is hard-blocked
  (NS_ERROR_DOM_COEP_FAILED, "blocked due to misconfigured response headers" in the Network
  tab). Worker script responses must be `require-corp`, which every engine accepts alongside
  a `credentialless` document. vite.config.js already does this split in dev/preview; in
  prod the affected paths are `/mpv/*` (libmpv pthread workers boot from `/mpv/libmpv.js`)
  and `/_app/immutable/workers/*` (the cache-worker chunk).
- **Prod**: `docker compose up -d --build` (repo root) builds the app (adapter-node, run by
  bun) and fronts it with nginx, which owns the headers — see `deploy/nginx.conf` for the
  split (`require-corp` for worker scripts via a `map $uri`, `credentialless` otherwise) and
  the `proxy_hide_header` lines that drop the app's own copies so COEP never duplicates
  (a duplicated value parses as invalid and silently breaks `crossOriginIsolated`).
  hooks.server.js alone is not enough in prod: adapter-node serves `static/` and `_app/`
  assets *before* the SvelteKit handle runs. TLS terminates at the outer proxy (pangolin)
  pointing at nginx's published port (8080); set `ORIGIN` in `.env` to the public URL.

- `credentialless` (on non-worker responses) keeps cross-origin `<img>` (TMDB posters on
  /requests) working without CORP headers. Chromium ≥ 96 and recent Firefox support it for
  documents; **Safari does not** — for Safari you'd need `require-corp` plus `crossorigin`
  attributes/CORP on every cross-origin subresource. Set `MPV_COEP=require-corp` to switch
  the document policy too.
- COOP `same-origin` breaks `window.opener` relationships with cross-origin popups; SvelteFin
  doesn't use any.

## Integration, verified against the vendored build (2026-07-04)

The original integration plan had to guess at `externalfs.js` (its source lives in the
author's patched Emscripten, not the repo). With a compiled build vendored into
`static/mpv/`, the guesses were replaced by reading the actual code inside `libmpv.js` and
the emitted `libmpv.d.ts`:

**How the externalfs backend really reads files** (all verified in `libmpv.js`):

- `ExternalFS.addDirectory(handle)` **requires a genuine `FileSystemDirectoryHandle`**
  (`instanceof` check returns null for fakes) and stores it in IndexedDB
  (`externalfs_db`) — a duck-typed object would `DataCloneError`. Duck-typing is a dead
  end for this build.
- The mount root is loaded back from IndexedDB (`init_root_directory`), permission-checked
  via `handle.queryPermission({mode:'read'})`, and **only one root can initialize per
  module instance**.
- Files resolve via `parentHandle.getFileHandle(name)`; sizes via `(await
  fileHandle.getFile()).size`; reads via `blob.slice(pos, pos+len)` →
  `await slice.arrayBuffer()` → copy into the wasm heap.
- **CORRECTED after live debugging (2026-07-06)**: that backend JS does **NOT** run on the
  main thread. Upstream's `load_file()` proxies every open onto its C++ *side thread*
  (`emscripten_proxy_async` in libmpv.cpp), and the externalfs JS imports execute on the
  **calling pthread's worker**. A main-thread-only `getFile` patch never fires for real
  playback — the engine opens the real (empty) placeholder and mpv idles silently, with
  zero errors anywhere.

**Therefore the working integration is** (see `pthread-patch.js`):
`mountVirtualFile()` creates the real OPFS dir (`sveltefin-mount/`) + empty placeholder
and registers it via `addDirectory(realHandle)`, while `MpvPlayer.svelte` passes
`mainScriptUrlOrBlob` as a **Blob wrapper** — `(<patch fn>)('<channel>');
importScripts('/mpv/libmpv.js')` — so every pthread worker gets the
`FileSystemFileHandle.prototype.getFile` interception before the engine evaluates. The
virtual Blob's `slice().arrayBuffer()` round-trips to the cache worker over a
**BroadcastChannel** (the only same-origin bus that reaches workers we didn't create).
Read *requests* go on the shared channel; read *results* return on a per-requester channel
(`<channel>:<tag>`) — broadcasting payloads queues clones in every `Atomics.wait`-parked
pthread worker, which grows unboundedly and killed the renderer within seconds of playback.

**Also load-bearing (found the hard way):**

- **SDL's DOM input handlers must be refused** (see `suppressEngineDomInput()` in
  `MpvPlayer.svelte`): SDL registers them with the mpv pthread as target thread, so every
  mousemove `emscripten_proxy_sync`s the main thread into the mpv thread — deadlocking
  against file I/O proxied the other way. mpv is driven exclusively through embind.
- **AudioContext autoplay**: SDL's context starts `suspended` without a gesture and mpv's
  clock is audio-slaved; the player resumes it on the first in-player pointerdown and on
  playback start.
- `bdOpen()` (libbluray) crashes this build with an unaligned-atomics wasm trap
  (`bd_mutex_lock` → `a_cas`) — don't call it, not even as a side-thread probe.
- The canvas bitmap is sized by SDL to the *screen* (`emscripten_get_screen_size`), not
  the element — the canvas needs CSS `object-fit: contain` or the picture distorts.
- SDL also stamps that screen size onto the canvas **element** as inline px styles
  (`emscripten_set_element_css_size`, proxied from the mpv pthread to the main thread) —
  plain `width: 100%` CSS loses to the inline style and the canvas renders screen-sized
  inside the player box, off-center and cropped. The component's stylesheet uses
  `width/height … !important` (stylesheet-important beats non-important inline) to stay in
  charge of layout; the engine keeps control of the drawing-buffer size only.
- Even with the element fixed, the *picture inside the buffer* sat off-center: the engine
  derives window/buffer sizes from a mix of `screen.width/height`
  (`emscripten_get_screen_size`), `window.innerWidth/innerHeight` (upstream EM_ASM snippets
  in the preamble) and `devicePixelRatio`, and they disagree — mpv lays the video out for a
  box that isn't the drawing buffer (image anchored bottom-left, GL origin). Fix: while the
  player is mounted, ALL of those reads are spoofed to a fixed **1920×1080**
  (`spoofRenderSize()` in `MpvPlayer.svelte`, before the engine loads; pthread workers
  proxy these reads to the main thread, so the main-thread patch covers them). The embind
  `matchWindowScreenSize()` is additionally called on first playback to re-sync a window
  sized before the spoof was read. Everything then agrees on 1080p and CSS object-fit
  scales the finished frame into the page/fullscreen. Third piece: mpv **resizes its
  window to the video's aspect at load** (so non-16:9 media broke the agreement again) —
  `auto-window-resize=no` in the loadFile options pins it (mpv ≥ 0.38; this build is
  v0.38.0-500 and the option is in its table). Fourth piece: the buffer's aspect must
  **match the video's** (`adaptRenderSize()`, fed by the wrapper's `videoTracks`
  `demuxW/demuxH`), otherwise mpv bakes letterbox bars *into* the buffer and e.g. 21:9
  media can never fill a 21:9 screen in fullscreen — the spoofed height is re-derived from
  the video aspect and `matchWindowScreenSize()` re-syncs.
- mpv resets the volume when a file loads — `setVolume()` issued before `loadFile()` is
  lost; re-apply the saved volume on first observed playback.

**Embind API** (verified in the build's emitted `libmpv.d.ts`): `loadFile(path, options)`
— two `EmbindString` args, arity enforced — `togglePlay()`, `stop()`,
`setPlaybackTime(seconds)`, `setVolume(0–100)`, `getMpvThread()`, and (unused so far)
`setAudioTrack/setSubtitleTrack/setVideoTrack(bigint)`, `skipForward/skipBackward()`,
`getTracks()/getChapters()`. Wrapper property callbacks (verified in the compiled
`setupMpvWorker`): `isPlaying` (from mpv `pause`), `duration`, `elapsed` (from
`playback-time`), `idle`, `fileEnd`, plus track ids `videoStream/audioStream/subtitleStream`.

**Remaining caveats to watch at runtime:**

1. `queryPermission()` on OPFS handles: fine in Chromium; **Firefox doesn't implement
   `FileSystemHandle.queryPermission`**, so `init_root_directory` would throw there.
   Upstream's whole ExternalFS flow is Chromium-oriented (`showDirectoryPicker`); treat the
   mpv backend as Chromium-first for now.
2. One mount root per module instance (see above) — fits the current
   one-file-per-page-load lifecycle; a future in-place "play next episode" would need a
   module reload or an upstream change.
3. `fileEnd` → "ended" mapping and the exact first-`duration` timing (used to apply
   `?t=`/resume seeks) are wired from code reading, not yet observed in a live session.
4. **`attachLegacyFsNode()`** (the classic `stream_ops` node the original brief asked for)
   remains as automatic fallback, but only applies to a custom build **without**
   `-sWASMFS`; on upstream builds `Module.FS` is absent and it reports exactly that.

## Known limitations

- **CPU decode**: ~1 core per stream, no hardware acceleration (WASM). 4K HEVC may not keep
  up; the HLS path remains the fallback (untouched, one click away).
- **Audio/subtitle selectors**: the transcode-based watch-bar selectors stay hidden for
  mpv; the player's own controls bar has native selectors instead, fed by the wrapper's
  `audioTracks`/`subtitleTracks` props (mpv `track-list`, BigInt ids) and switched via
  embind `setAudioTrack`/`setSubtitleTrack(bigint)`. Passing `0n` to `setSubtitleTrack`
  is used as "off" (mirrors upstream's UI); flagged for live verification.
- **No cross-session persistence** (by design, v1): the OPFS cache survives worker restarts
  within a session and is reused across reloads only while fileSize/chunkSize match; other
  files' caches are purged on open, bounding disk to one `capacityBytes`.
- **Memory**: the module reserves 2 GB shared memory up-front (`INITIAL_MEMORY`), plus the
  cache (default 768 MiB) in OPFS — not RAM. Leaving the watch page calls
  `PThread.terminateAllThreads()` + closes the worker; verify no leaks across repeated
  SPA navigations.
- **Sync-XHR fallback** (`fetchRangeSync`): kept for a single-worker/legacy-FS scenario. If
  you end up there, misses block that worker's event loop for the full network RTT and
  prefetch stalls behind them — it is strictly worse than the rendezvous path, which is why
  it is not the default anywhere.
- Seeking into never-cached regions costs one network round trip (~chunk fetch) before mpv
  gets bytes — that's inherent; the protect window + prefetch only hide latency for
  restart-seeks and sequential play.
