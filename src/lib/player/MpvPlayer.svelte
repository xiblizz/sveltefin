<script>
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import { imgUrl, ticksToSeconds } from '$lib/img.js';
    import { MpvPlayerState } from './mpv/player-state.svelte.js';
    import { createProtocolBuffer } from './mpv/sab-protocol.js';
    import { createSyncReader, mountVirtualFile, attachLegacyFsNode, MpvBridgeError } from './mpv/mpv-fs-bridge.js';
    import {
        MPV_CACHE_DEFAULTS,
        MPV_WRAPPER_URL,
        MPV_LOADER_URL,
        MPV_ASSET_BASE,
        MPV_BROADCAST_CHANNEL,
    } from './mpv/config.js';
    import { installPthreadVirtualFile } from './mpv/pthread-patch.js';
    import { savedVolumeFraction, saveVolumeFraction } from './volume.js';

    /**
     * libmpv-wasm backend: direct-plays the original file (mkv/HEVC/AC3/...)
     * through the sparse HTTP-backed chunk cache. See mpv/README.md for the
     * deployment prerequisites (COOP/COEP, vendored wasm build) and for which
     * parts of the upstream API this component had to guess at.
     */
    let { data, controller = $bindable(), onplay, onpause, onended, ontimeupdate } = $props();

    const mpvState = new MpvPlayerState();

    let canvas;
    let wrap;
    let worker = null;
    let player = null;
    let api = null;
    let disposeMount = null;
    /** @type {(() => void) | null} */
    let resumeAudioContext = null;
    let resumeApplied = false;
    let windowSynced = false;
    let started = false;
    let scrubbing = false;
    let scrubValue = $state(0);
    let showStats = $state(false);
    let volume = $state(browser ? savedVolumeFraction() : 0.5);

    controller = {
        getCurrentTime: () => mpvState.position,
        isPaused: () => mpvState.paused,
        seek: (seconds) => api?.seek(seconds),
        setTextTrack: () => {}, // subtitles render inside mpv itself
        togglePlay: () => {
            if (mpvState.phase !== 'playing') return;
            resumeAudioContext?.();
            api?.togglePlay();
        },
    };

    /**
     * Embind playback API, verified against the build's emitted libmpv.d.ts:
     * loadFile(path, options), togglePlay(), setPlaybackTime(s), setVolume(v),
     * stop(). Note loadFile takes TWO strings — embind throws on wrong arity.
     * (setAudioTrack/setSubtitleTrack(bigint) also exist for future selectors.)
     */
    function resolveApi(playerInstance) {
        const module = playerInstance.module ?? playerInstance;
        const wrap = (name) =>
            typeof module?.[name] === 'function'
                ? module[name].bind(module)
                : () => console.warn(`[mpv] module.${name}() missing — API changed upstream?`);
        return {
            module,
            loadFile: wrap('loadFile'),
            togglePlay: wrap('togglePlay'),
            seek: wrap('setPlaybackTime'),
            setVolume: wrap('setVolume'),
            setAudioTrack: wrap('setAudioTrack'),
            setSubtitleTrack: wrap('setSubtitleTrack'),
            matchWindowScreenSize: wrap('matchWindowScreenSize'),
            stop: wrap('stop'),
        };
    }

    /**
     * Controlled render size. The engine derives its window/buffer sizes from
     * a mix of sources — `screen.width/height` (emscripten_get_screen_size),
     * `window.innerWidth/innerHeight` (upstream EM_ASM snippets in the
     * preamble) and `devicePixelRatio` — and they disagree with each other and
     * with the canvas, so mpv lays the video out for a box that isn't the
     * drawing buffer (picture bottom-anchored/letterboxed wrong). Instead of
     * chasing every read, ALL of them are spoofed to one size we control
     * while the player is mounted: SDL's window, mpv's layout and the canvas
     * bitmap then all agree, and CSS object-fit scales the finished frame
     * into the page (and into fullscreen). Restored on teardown.
     *
     * The size starts at 1920×1080 and is re-derived from the video's aspect
     * once the track list arrives (adaptRenderSize): if the buffer aspect
     * doesn't match the video, mpv bakes letterbox bars INTO the buffer and
     * e.g. 21:9 media can never fill a 21:9 screen in fullscreen.
     */
    const RENDER_WIDTH = 1920;
    const RENDER_HEIGHT = 1080;
    let spoofWidth = RENDER_WIDTH;
    let spoofHeight = RENDER_HEIGHT;
    /** @type {(() => void) | null} */
    let restoreSizeSpoof = null;
    function spoofRenderSize() {
        if (restoreSizeSpoof) return;
        /** @type {Record<string, () => number>} */
        const screenGetters = {
            width: () => spoofWidth,
            height: () => spoofHeight,
            availWidth: () => spoofWidth,
            availHeight: () => spoofHeight,
        };
        /** @type {Record<string, PropertyDescriptor | undefined>} */
        const screenDescriptors = {};
        for (const [prop, get] of Object.entries(screenGetters)) {
            screenDescriptors[prop] = Object.getOwnPropertyDescriptor(Screen.prototype, prop);
            Object.defineProperty(Screen.prototype, prop, { configurable: true, get });
        }
        // Own properties shadow the getters window inherits; delete restores.
        /** @type {Record<string, () => number>} */
        const windowGetters = {
            innerWidth: () => spoofWidth,
            innerHeight: () => spoofHeight,
            devicePixelRatio: () => 1,
        };
        for (const [prop, get] of Object.entries(windowGetters)) {
            Object.defineProperty(window, prop, { configurable: true, get });
        }
        restoreSizeSpoof = () => {
            for (const [prop, descriptor] of Object.entries(screenDescriptors)) {
                if (descriptor) Object.defineProperty(Screen.prototype, prop, descriptor);
            }
            for (const prop of Object.keys(windowGetters)) {
                delete window[prop];
            }
            restoreSizeSpoof = null;
        };
    }

    /**
     * Match the render size to the video's aspect (width stays 1920) and
     * re-sync the SDL window/buffer through the spoofed "screen size".
     * auto-window-resize=no keeps mpv from fighting this with its own
     * video-aspect window resize.
     */
    function adaptRenderSize(width, height) {
        if (!(width > 0) || !(height > 0)) return;
        const target = Math.min(2160, Math.max(240, Math.round((RENDER_WIDTH * height) / width / 2) * 2));
        if (target === spoofHeight) return;
        spoofHeight = target;
        api?.matchWindowScreenSize();
    }

    /**
     * One-shot fixups on first observed playback:
     * - re-sync the SDL window (and with it the buffer) — with the spoof
     *   above, "screen size" is the fixed 1920×1080, so this pins
     *   window == buffer == 1080p even if the engine sized the window before
     *   the spoof's values were read;
     * - re-apply the saved volume as a backstop — the primary application is
     *   the file-local `volume=` option in loadFile (a setVolume before
     *   loadFile is reset by the file load).
     */
    function onFirstPlayback() {
        if (windowSynced) return;
        windowSynced = true;
        api?.matchWindowScreenSize();
        api?.setVolume(toMpvVolume(savedVolumeFraction()));
    }

    /**
     * Slider fraction (0–1, the sf_volume value shared with the html player)
     * → mpv volume. mpv runs its 0–100 volume through a *cubic* gain curve,
     * so a naive fraction*100 sounds far quieter than the html player's
     * linear video.volume (50 → (0.5)³ ≈ −18 dB) — invert with cbrt so both
     * players sound the same at the same slider position.
     */
    function toMpvVolume(fraction) {
        return Math.round(100 * Math.cbrt(Math.min(1, Math.max(0, fraction))));
    }

    /** Click on the picture toggles play/pause (drives embind inline — safe;
     * only SDL's own proxied DOM handlers are the deadlock hazard). */
    function onCanvasClick() {
        if (mpvState.phase !== 'playing') return;
        resumeAudioContext?.();
        api?.togglePlay();
    }

    /**
     * Property-change callbacks for MpvPlayer.load(). The wrapper's Proxy
     * invokes same-named callbacks when mpv worker events update player
     * properties; names verified in the compiled wrapper's setupMpvWorker:
     * elapsed (seconds), duration, isPlaying, idle, fileEnd.
     */
    function propCallbacks() {
        return {
            isPlaying: (value) => {
                mpvState.paused = !value;
                if (value) {
                    mpvState.phase = 'playing';
                    started = true;
                    onFirstPlayback();
                    resumeAudioContext?.();
                    onplay?.();
                } else if (started) {
                    onpause?.();
                }
            },
            idle: (value) => {
                mpvState.idle = Boolean(value);
            },
            fileEnd: (value) => {
                if (value && started) onended?.();
            },
            duration: (value) => {
                if (typeof value !== 'number' || value <= 0) return;
                mpvState.duration = value; // refines the metadata fallback set at loadFile
            },
            elapsed: (value) => {
                if (typeof value !== 'number') return;
                // isPlaying doesn't reliably fire in this build — visible
                // progress is just as authoritative for leaving the overlay.
                if (value > 0 && mpvState.phase !== 'playing') {
                    mpvState.phase = 'playing';
                    // Advancing playback time == playing: the isPlaying event
                    // that would clear this is exactly what didn't fire here,
                    // so the play button would show ▶ during autoplay.
                    mpvState.paused = false;
                    started = true;
                    onFirstPlayback();
                    resumeAudioContext?.();
                    onplay?.();
                    // Resume position is applied on first *observed* progress:
                    // the wrapper's duration event is racy (see boot), so it
                    // can't be the trigger.
                    if (data.startSeconds > 0 && !resumeApplied) {
                        resumeApplied = true;
                        api?.seek(data.startSeconds);
                    }
                }
                mpvState.position = value;
                if (!scrubbing) scrubValue = value;
                ontimeupdate?.(value);
            },
            // Track lists arrive via the wrapper's "track-list" event (mpv
            // property observation); ids are BigInt (embind uint64).
            videoTracks: (value) => {
                if (!Array.isArray(value) || !value.length) return;
                // Selected track when known (player.videoStream mirrors vid),
                // else the first — single-video files are the normal case.
                const track =
                    value.find((candidate) => Number(candidate.id) === Number(player?.videoStream)) ??
                    value[0];
                adaptRenderSize(Number(track.demuxW ?? 0), Number(track.demuxH ?? 0));
            },
            audioTracks: (value) => {
                mpvState.audioTracks = Array.isArray(value) ? value : [];
            },
            subtitleTracks: (value) => {
                mpvState.subtitleTracks = Array.isArray(value) ? value : [];
            },
            // Current aid/sid. The wrapper does parseInt(payload.value), so a
            // disabled track ("no"/false) comes through as NaN → normalize to 0.
            audioStream: (value) => {
                mpvState.audioStream = Number(value) || 0;
            },
            subtitleStream: (value) => {
                mpvState.subtitleStream = Number(value) || 0;
            },
        };
    }

    /** URL of this playback with the standard <video> backend instead. */
    function htmlBackendUrl() {
        const query = new URLSearchParams(location.search);
        query.set('backend', 'html');
        if (data.startSeconds > 0) query.set('t', String(Math.floor(data.startSeconds)));
        return `/watch/${data.item.Id}?${query}`;
    }

    /**
     * mpv is the default backend, so a browser that can't run it (no COOP/COEP,
     * no OPFS, Firefox's missing queryPermission, …) must not dead-end: boot
     * failures fall back to the html player unless the user explicitly picked
     * mpv (?backend=mpv) — then the error stays visible for debugging.
     */
    function failOrFallback(message) {
        if (!data.backendExplicit) {
            console.error('[mpv] boot failed, falling back to the standard player:', message);
            location.replace(htmlBackendUrl());
            return;
        }
        mpvState.fail(message);
    }

    async function boot() {
        // Preflight — each failure gets an actionable message.
        if (!window.crossOriginIsolated) {
            return failOrFallback(
                'Page is not cross-origin isolated: SharedArrayBuffer is unavailable. ' +
                    'Set ENABLE_MPV_BACKEND=1 (dev) or the COOP/COEP headers in your reverse ' +
                    'proxy (prod) — see src/lib/player/mpv/README.md.',
            );
        }
        if (!navigator.storage?.getDirectory) {
            return failOrFallback('OPFS (navigator.storage.getDirectory) is unavailable in this browser.');
        }

        mpvState.phase = 'cache';
        const sab = createProtocolBuffer(MPV_CACHE_DEFAULTS.payloadBytes);
        worker = new Worker(new URL('./mpv/cache-worker.js', import.meta.url), { type: 'module' });

        const fileSize = await new Promise((resolve, reject) => {
            worker.onmessage = ({ data: msg }) => {
                if (msg.type === 'ready') resolve(msg.fileSize);
                else if (msg.type === 'fatal') reject(new Error(msg.message));
                else if (msg.type === 'stats') mpvState.applyStats(msg);
            };
            worker.onerror = (event) =>
                reject(
                    new Error(
                        event.message
                            ? `cache worker failed to start: ${event.message} (${event.filename}:${event.lineno})`
                            : 'cache worker script failed to load — check the Network tab for the ' +
                              'cache-worker.js request; in dev a stale Vite graph clears after a ' +
                              'dev-server restart + hard reload',
                    ),
                );
            worker.postMessage({
                type: 'init',
                sab,
                config: {
                    streamUrl: data.src,
                    cacheId: data.mpv.cacheId,
                    filename: data.mpv.filename, // announced on the BroadcastChannel for pthread-patch.js
                    chunkSize: MPV_CACHE_DEFAULTS.chunkSize,
                    capacityBytes: MPV_CACHE_DEFAULTS.capacityBytes,
                    protectHeadBytes: MPV_CACHE_DEFAULTS.protectHeadBytes,
                    protectWindowBytes: MPV_CACHE_DEFAULTS.protectWindowBytes,
                    prefetchAheadChunks: MPV_CACHE_DEFAULTS.prefetchAheadChunks,
                    prefetchConcurrency: MPV_CACHE_DEFAULTS.prefetchConcurrency,
                },
            });
        });
        worker.onmessage = ({ data: msg }) => {
            if (msg.type === 'stats') mpvState.applyStats(msg);
            else if (msg.type === 'fatal') mpvState.fail(msg.message);
        };

        mpvState.phase = 'engine';
        spoofRenderSize(); // before the engine's first size read
        let MpvPlayerLib;
        try {
            // libmpv.js is Emscripten MODULARIZE output *without* EXPORT_ES6 —
            // a classic script defining the global `libmpvLoader`. It must be
            // loaded before the wrapper bundle, whose ./libmpv.js import is
            // shimmed to that global (README, "Vendoring libmpv-wasm").
            await loadClassicScript(MPV_LOADER_URL, 'libmpvLoader');
            // The file-packager preamble in libmpv.js resolves libmpv.data
            // relative to the *page* URL unless Module.locateFile is set, and
            // the wrapper's static load() never sets it — so /watch/<id> would
            // request /watch/libmpv.data. Wrap the loader global (before the
            // wrapper captures it on import) to pin every asset to /mpv/.
            if (!globalThis.libmpvLoader.sfLocateFilePatched) {
                const rawLoader = globalThis.libmpvLoader;
                globalThis.libmpvLoader = (moduleArg = {}) =>
                    rawLoader({ locateFile: (path) => `${MPV_ASSET_BASE}/${path}`, ...moduleArg });
                globalThis.libmpvLoader.sfLocateFilePatched = true;
            }
            const mod = await import(/* @vite-ignore */ MPV_WRAPPER_URL);
            // esbuild ESM bundle of the CJS wrapper: default is the exports
            // object ({ default: MpvPlayer }); unwrap whichever shape we got.
            MpvPlayerLib = mod.default?.default ?? mod.default ?? mod.MpvPlayer;
            if (typeof MpvPlayerLib?.load !== 'function') {
                throw new Error('bundle loaded, but no MpvPlayer class with a static load() was exported');
            }
        } catch (err) {
            return failOrFallback(
                `Failed to load the libmpv-wasm build from ${MPV_ASSET_BASE}/: ` +
                    `${err?.message ?? err} — check static/mpv/ against the vendoring steps in ` +
                    'src/lib/player/mpv/README.md.',
            );
        }
        // Every pthread worker boots from mainScriptUrlOrBlob (libmpv.js:1734
        // accepts a Blob). The externalfs backend runs its file JS on the
        // engine's own pthread workers — never the main thread — so the
        // virtual-file getFile() interception must be injected there, before
        // libmpv.js evaluates. See pthread-patch.js for the whole story.
        const loaderAbsoluteUrl = new URL(MPV_LOADER_URL, location.href).href;
        const workerBoot = new Blob(
            [
                `(${installPthreadVirtualFile.toString()})(${JSON.stringify(MPV_BROADCAST_CHANNEL)});\n` +
                    `importScripts(${JSON.stringify(loaderAbsoluteUrl)});`,
            ],
            { type: 'text/javascript' },
        );
        player = await MpvPlayerLib.load(canvas, workerBoot, propCallbacks());
        api = resolveApi(player);

        // The wrapper attaches its mpv-event listener by POLLING getMpvThread()
        // every 100ms (setupMpvWorker); events mpv fires before that listener
        // lands are lost — duration, track list and play state randomly missing
        // depending on timing. Wait for the listener before loading the file.
        for (let i = 0; i < 100 && !player.mpvWorker; i++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!player.mpvWorker) {
            console.warn('[mpv] wrapper event listener never attached — player props may be unreliable');
        }

        // Primary: virtual-Blob mount against the real externalfs backend
        // (async reads via the cache worker's message protocol). Fallback:
        // legacy-FS node + blocking SAB reader, for non-WASMFS rebuilds.
        let mpvPath;
        try {
            const mount = await mountVirtualFile(api.module, {
                worker,
                filename: data.mpv.filename,
                fileSize,
            });
            mpvPath = mount.path;
            disposeMount = mount.dispose;
        } catch (err) {
            if (!(err instanceof MpvBridgeError)) throw err;
            console.warn('[mpv] virtual-blob mount failed, trying legacy FS node:', err.message);
            const reader = createSyncReader({ sab, fileSize });
            mpvPath = attachLegacyFsNode(api.module, { path: `/stream/${data.mpv.filename}`, reader });
        }

        // File-local mpv options. vd-lavc-threads: ffmpeg's auto mode spawns
        // one decode thread per logical core, which can exhaust the engine's
        // pthread pool (20) once the audio pipeline has claimed its share —
        // observed as audio-only playback with a permanently black canvas.
        // auto-window-resize=no (mpv ≥ 0.38, present in this build's option
        // table): mpv otherwise resizes its window to the VIDEO's aspect at
        // load, breaking the window == buffer == 1080p agreement the size
        // spoof establishes — observed as non-16:9 media (21:9) rendering
        // off-center inside the canvas.
        // volume: setVolume() before loadFile is reset by the file load, and
        // re-applying after playback starts still lets the first moments blast
        // at 100% — a file-local option applies exactly at load (cbrt-mapped,
        // see toMpvVolume).
        // ?mpvopts=... overrides for experiments (e.g. ?mpvopts=aid=no).
        const fileOpts =
            new URLSearchParams(location.search).get('mpvopts') ??
            `vd-lavc-threads=4,auto-window-resize=no,volume=${toMpvVolume(savedVolumeFraction())}`;
        api.loadFile(mpvPath, fileOpts);
        console.info(`[mpv] loadFile issued with options '${fileOpts}'`);

        // Seekbar safety net: mpv's duration event is best-effort (see the
        // listener race above) — Jellyfin's metadata keeps the timeline usable
        // either way; the mpv value overwrites it when it does arrive.
        if (mpvState.duration === 0) {
            const metaSeconds = ticksToSeconds(data.item?.RunTimeTicks) || 0;
            if (metaSeconds > 0) mpvState.duration = metaSeconds;
        }

        // Autoplay policy: SDL's AudioContext starts 'suspended' without a
        // user gesture, and mpv's playback clock is slaved to audio — a
        // suspended context can freeze the clock. Resume it on the first
        // gesture inside the player (the wrap div is not a suppressed
        // target), plus opportunistically whenever playback starts.
        resumeAudioContext = () => {
            const ctx =
                /** @type {any} */ (api?.module)?.SDL3?.audioContext ??
                /** @type {any} */ (api?.module)?.SDL2?.audioContext;
            if (ctx?.state === 'suspended') {
                ctx.resume().catch(() => {}); // no gesture yet — the next pointerdown retries
            }
        };
        wrap.addEventListener('pointerdown', resumeAudioContext);
    }

    function teardown() {
        try {
            api?.stop();
            api?.module?.PThread?.terminateAllThreads?.();
        } catch {
            // engine may never have come up
        }
        clearTimeout(idleTimer);
        restoreSizeSpoof?.();
        disposeMount?.();
        worker?.postMessage({ type: 'close' });
        const w = worker;
        setTimeout(() => w?.terminate(), 500); // backstop if the worker never got 'close'
        worker = null;
    }

    // Trickplay seek previews (data.trickplay from the watch load, null when
    // Jellyfin has no tiles). Hover position → thumbnail index → tile-sheet
    // URL + background offset; sheets are plain <img> loads through the
    // /api/media/ proxy, so the browser caches them.
    let previewFrac = $state(-1); // -1 = hidden
    let previewLeft = $state(0);

    const preview = $derived.by(() => {
        const tp = data.trickplay;
        if (!tp || previewFrac < 0 || !mpvState.duration) return null;
        const seconds = previewFrac * mpvState.duration;
        const last = Math.max(0, (tp.thumbnailCount || Infinity) - 1);
        const index = Math.min(Math.floor((seconds * 1000) / tp.intervalMs), last);
        const perSheet = tp.tileWidth * tp.tileHeight;
        const sheet = Math.floor(index / perSheet);
        const cell = index % perSheet;
        return {
            seconds,
            url: `${tp.urlBase}/${sheet}.jpg?mediaSourceId=${tp.mediaSourceId}`,
            x: (cell % tp.tileWidth) * tp.width,
            y: Math.floor(cell / tp.tileWidth) * tp.height,
        };
    });

    function onSeekHover(event) {
        const rect = event.currentTarget.getBoundingClientRect();
        previewFrac = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        // Clamp so the popup never overflows the player edges.
        const half = data.trickplay ? data.trickplay.width / 2 : 0;
        previewLeft = Math.min(rect.width - half, Math.max(half, event.clientX - rect.left));
    }

    function onSeekLeave() {
        previewFrac = -1;
    }

    function onScrubInput(event) {
        scrubbing = true;
        scrubValue = Number(event.target.value);
    }

    function onScrubCommit(event) {
        scrubbing = false;
        api?.seek(Number(event.target.value));
    }

    function onVolume(event) {
        volume = Number(event.target.value);
        saveVolumeFraction(volume);
        api?.setVolume(toMpvVolume(volume));
    }

    // Fullscreen UI auto-hide: controls fade out after 2.5 s without pointer
    // movement (or when the pointer leaves the player) and fade back in on
    // movement. Styled only under :fullscreen, so windowed mode is unaffected.
    let uiIdle = $state(false);
    let idleTimer = null;

    function wakeUi() {
        uiIdle = false;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => (uiIdle = true), 2500);
    }

    function sleepUi() {
        clearTimeout(idleTimer);
        uiIdle = true;
    }

    function toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            // Fullscreen our parent (the page's .videowrap), not .mpv itself:
            // page-level overlays like the skip-intro button live there and
            // must stay visible in fullscreen.
            const target = wrap?.parentElement ?? wrap;
            target?.requestFullscreen?.()?.catch((err) =>
                console.warn('[mpv] fullscreen request refused:', err?.message ?? err),
            );
        }
    }

    /** mpv track-list entry → human label (fields camelCased by the wrapper). */
    function trackLabel(track) {
        const parts = [track.lang, track.title].filter(Boolean);
        return parts.length ? parts.join(' · ') : `Track ${track.id}`;
    }

    function onAudioTrack(event) {
        api?.setAudioTrack(BigInt(event.target.value));
    }

    function onSubtitleTrack(event) {
        // id 0 = disable (mpv sid=no) — matches upstream's "off" handling.
        api?.setSubtitleTrack(BigInt(event.target.value));
    }

    /** Load a non-module script once; resolves when `globalName` exists. */
    function loadClassicScript(src, globalName) {
        if (globalThis[globalName]) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = () =>
                globalThis[globalName]
                    ? resolve()
                    : reject(new Error(`${src} loaded but did not define ${globalName}`));
            script.onerror = () => reject(new Error(`could not load ${src} (missing file?)`));
            document.head.appendChild(script);
        });
    }

    function formatTime(seconds) {
        if (!Number.isFinite(seconds)) return '0:00';
        const s = Math.max(0, Math.floor(seconds));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const rest = `${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
        return h ? `${h}:${rest}` : rest;
    }

    // The engine's externalfs backend runs unawaited async JS (IndexedDB,
    // permissions, getFile) — a rejection there disappears without this.
    function onUnhandledRejection(/** @type {PromiseRejectionEvent} */ event) {
        console.error('[mpv] unhandled rejection during playback:', event.reason);
    }

    /**
     * SDL (inside the engine) registers DOM input handlers with the mpv
     * pthread as the target thread: every mouse/key/resize event then makes
     * the MAIN thread emscripten_proxy_sync into the mpv thread. But the mpv
     * thread's file I/O (externalfs) sync-proxies the other way — onto the
     * main thread — so an input event during any open/read deadlocks both
     * threads and playback freezes (verified: mouseEventHandlerFunc →
     * emscripten_proxy_sync → pthread_cond_timedwait, engine silent after).
     * We drive mpv exclusively through embind (runs inline on the caller), so
     * the engine's DOM input handlers are pure liability: refuse to register
     * them. Only engine-plausible targets (window/document/canvas) are
     * filtered, and only for input/UI event types — app listeners like
     * beforeunload and unhandledrejection pass through untouched.
     */
    const SDL_INPUT_EVENTS = new Set([
        'mousemove',
        'mousedown',
        'mouseup',
        'mouseenter',
        'mouseleave',
        'mouseover',
        'mouseout',
        'wheel',
        'mousewheel',
        'contextmenu',
        'dblclick',
        'click',
        'keydown',
        'keyup',
        'keypress',
        'touchstart',
        'touchend',
        'touchmove',
        'touchcancel',
        'pointerdown',
        'pointerup',
        'pointermove',
        'pointercancel',
        'pointerlockchange',
        'pointerlockerror',
        'fullscreenchange',
        'fullscreenerror',
        'resize',
        'scroll',
        'focus',
        'blur',
        'focusin',
        'focusout',
        'visibilitychange',
        'orientationchange',
        'gamepadconnected',
        'gamepaddisconnected',
        'devicemotion',
        'deviceorientation',
    ]);
    /** @type {(() => void) | null} */
    let restoreAddEventListener = null;
    function suppressEngineDomInput() {
        if (restoreAddEventListener) return;
        const original = EventTarget.prototype.addEventListener;
        /** @type {any} */ (EventTarget.prototype).addEventListener = function (
            /** @type {string} */ type,
            /** @type {any} */ listener,
            /** @type {any} */ options,
        ) {
            const engineTarget = this === window || this === document || this instanceof HTMLCanvasElement;
            if (engineTarget && SDL_INPUT_EVENTS.has(type)) {
                return;
            }
            return original.call(this, type, listener, options);
        };
        restoreAddEventListener = () => {
            EventTarget.prototype.addEventListener = original;
            restoreAddEventListener = null;
        };
    }

    onMount(() => {
        window.addEventListener('unhandledrejection', onUnhandledRejection);
        suppressEngineDomInput(); // must precede engine load — SDL registers at init
        wakeUi(); // arm the idle timer even before the first pointer movement
        boot().catch((err) => failOrFallback(err?.message ?? String(err)));
        return () => {
            restoreAddEventListener?.();
            window.removeEventListener('unhandledrejection', onUnhandledRejection);
            teardown();
        };
    });
</script>

<div
    class="mpv"
    class:idle={uiIdle}
    role="presentation"
    bind:this={wrap}
    onpointermove={wakeUi}
    onpointerdown={wakeUi}
    onpointerleave={sleepUi}
>
    <!-- id="canvas" is load-bearing: the Emscripten build transfers the canvas to
     the mpv pthread by element id, and SDL registers its input handlers via
     document.querySelector('#canvas'). No id → no GL context, no input. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <canvas
        id="canvas"
        width={RENDER_WIDTH}
        height={RENDER_HEIGHT}
        bind:this={canvas}
        onclick={onCanvasClick}
        style:background-image={mpvState.phase !== 'playing'
            ? `url(${imgUrl(data.item, 'Backdrop', { maxWidth: 1600 }) ?? ''})`
            : undefined}
    ></canvas>

    {#if mpvState.phase === 'error'}
        <div class="overlay error">
            <strong>mpv playback failed</strong>
            <p>{mpvState.errorMessage}</p>
            <a
                class="fallback"
                href={htmlBackendUrl()}
                data-sveltekit-reload>Use the standard player</a
            >
        </div>
    {:else if mpvState.phase !== 'playing'}
        <div class="overlay">
            {mpvState.phase === 'boot'
                ? 'Checking environment…'
                : mpvState.phase === 'cache'
                  ? 'Probing stream & opening cache…'
                  : 'Loading mpv engine…'}
        </div>
    {/if}

    <div class="controls">
        <button
            type="button"
            class="play"
            onclick={() => {
                resumeAudioContext?.(); // guaranteed user gesture — safe no-op when running
                api?.togglePlay();
            }}
            disabled={mpvState.phase !== 'playing'}
        >
            {mpvState.paused ? '▶' : '⏸'}
        </button>
        <span class="time">{formatTime(mpvState.position)}</span>
        <!-- hover preview only; the <input type=range> inside stays the interactive element -->
        <div
            class="seekwrap"
            role="presentation"
            onpointermove={onSeekHover}
            onpointerleave={onSeekLeave}
        >
            {#if preview}
                <div
                    class="preview"
                    style:left="{previewLeft}px"
                >
                    <div
                        class="preview-img"
                        style:width="{data.trickplay.width}px"
                        style:height="{data.trickplay.height}px"
                        style:background-image="url({preview.url})"
                        style:background-position="-{preview.x}px -{preview.y}px"
                    ></div>
                    <span class="preview-time">{formatTime(preview.seconds)}</span>
                </div>
            {/if}
            <div class="bufferbar">
                {#each mpvState.ranges as [start, end] (start)}
                    <div
                        class="segment"
                        style:left="{mpvState.fileSize ? (start / mpvState.fileSize) * 100 : 0}%"
                        style:width="{mpvState.fileSize ? ((end - start) / mpvState.fileSize) * 100 : 0}%"
                    ></div>
                {/each}
            </div>
            <input
                type="range"
                min="0"
                max={mpvState.duration || 1}
                step="0.1"
                value={scrubValue}
                oninput={onScrubInput}
                onchange={onScrubCommit}
                disabled={!mpvState.duration}
            />
        </div>
        <span class="time">{formatTime(mpvState.duration)}</span>
        {#if mpvState.audioTracks.length > 1}
            <select
                class="track"
                title="Audio track"
                value={mpvState.audioStream}
                onchange={onAudioTrack}
            >
                {#each mpvState.audioTracks as track (track.id)}
                    <option value={Number(track.id)}>♪ {trackLabel(track)}</option>
                {/each}
            </select>
        {/if}
        {#if mpvState.subtitleTracks.length}
            <select
                class="track"
                title="Subtitles"
                value={mpvState.subtitleStream}
                onchange={onSubtitleTrack}
            >
                <option value={0}>No subtitles</option>
                {#each mpvState.subtitleTracks as track (track.id)}
                    <option value={Number(track.id)}>💬 {trackLabel(track)}</option>
                {/each}
            </select>
        {/if}
        <input
            class="volume"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            oninput={onVolume}
        />
        <button
            type="button"
            class="minor"
            onclick={() => (showStats = !showStats)}>cache</button
        >
        <button
            type="button"
            class="minor"
            onclick={toggleFullscreen}>⛶</button
        >
    </div>

    {#if showStats}
        <div class="stats">
            {(mpvState.cachedBytes / 1024 / 1024).toFixed(0)} / {(mpvState.capacityBytes / 1024 / 1024).toFixed(0)} MiB cached
            · hit rate {(mpvState.hitRate * 100).toFixed(1)}% · {mpvState.ranges.length} range{mpvState.ranges
                .length === 1
                ? ''
                : 's'}
        </div>
    {/if}
</div>

<style>
    .mpv {
        display: flex;
        flex-direction: column;
        background: #000;
        border-radius: 12px;
        overflow: hidden;
        position: relative;
    }
    canvas {
        display: block;
        /* !important is load-bearing: SDL sizes its window to the *screen*
           (emscripten_get_screen_size) and stamps that size onto this element
           as inline px styles (emscripten_set_element_css_size, proxied from
           the mpv pthread to the main thread) — a plain `width: 100%` loses to
           the inline style and the canvas renders screen-sized inside this
           box, off-center and cropped by the wrap's overflow:hidden. */
        width: 100% !important;
        height: auto !important;
        aspect-ratio: 16 / 9;
        max-height: calc(100dvh - 12rem);
        background: #000 center / contain no-repeat;
        /* The drawing buffer stays screen-sized regardless of the element box —
           without object-fit the browser stretches it and distorts the picture. */
        object-fit: contain;
    }
    /* Fullscreen: the *parent* wrapper is the fullscreen element (so the
       page's skip-intro overlay stays visible); fill it and let the canvas
       flex into all space above the controls. */
    :global(:fullscreen) > .mpv {
        height: 100%;
        border-radius: 0;
    }
    :global(:fullscreen) > .mpv canvas {
        flex: 1;
        min-height: 0;
        aspect-ratio: auto;
        max-height: none;
    }
    /* Fullscreen: controls become a fading overlay so playback owns the whole
       screen; .idle (no pointer movement for a while / pointer left) fades
       them out and hides the cursor. Windowed layout is untouched. */
    :global(:fullscreen) > .mpv .controls {
        position: absolute;
        inset: auto 0 0 0;
        background: linear-gradient(transparent, rgb(0 0 0 / 85%));
        border-top: none;
        padding: 1rem 1.25rem 0.9rem;
        opacity: 1;
        transition: opacity 0.25s ease;
    }
    :global(:fullscreen) > .mpv.idle .controls {
        opacity: 0;
        pointer-events: none;
    }
    :global(:fullscreen) > .mpv.idle {
        cursor: none;
    }
    :global(:fullscreen) > .mpv .stats {
        top: 1rem;
        right: 1rem;
    }
    .overlay {
        position: absolute;
        inset: 0 0 3rem;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        color: #fff;
        background: rgb(0 0 0 / 55%);
        text-align: center;
        padding: 1rem 2rem;
    }
    .overlay.error p {
        max-width: 42rem;
        color: var(--text-dim);
        font-size: 0.9rem;
    }
    .overlay.error .fallback {
        color: var(--accent);
        border: 1px solid var(--accent);
        border-radius: 6px;
        padding: 0.3rem 0.8rem;
        text-decoration: none;
    }
    .controls {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.5rem 0.75rem;
        background: var(--surface);
        border-top: 1px solid var(--border);
    }
    .play {
        background: none;
        border: none;
        color: var(--text);
        font-size: 1.1rem;
        cursor: pointer;
        width: 2rem;
    }
    .minor {
        background: none;
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text-dim);
        font-size: 0.75rem;
        padding: 0.15rem 0.4rem;
        cursor: pointer;
    }
    .time {
        color: var(--text-dim);
        font-size: 0.8rem;
        font-variant-numeric: tabular-nums;
        min-width: 3rem;
        text-align: center;
    }
    .seekwrap {
        position: relative;
        flex: 1;
        display: flex;
        align-items: center;
    }
    .seekwrap input[type='range'] {
        position: relative;
        width: 100%;
        z-index: 1;
    }
    .preview {
        position: absolute;
        bottom: 1.9rem;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.2rem;
        background: rgb(0 0 0 / 85%);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.3rem;
        pointer-events: none;
        z-index: 2;
    }
    .preview-img {
        border-radius: 5px;
        background-color: #000;
        background-repeat: no-repeat;
    }
    .preview-time {
        color: #fff;
        font-size: 0.75rem;
        font-variant-numeric: tabular-nums;
    }
    .bufferbar {
        position: absolute;
        left: 0;
        right: 0;
        top: 50%;
        height: 4px;
        transform: translateY(-50%);
        border-radius: 2px;
        background: rgb(255 255 255 / 8%);
        overflow: hidden;
    }
    .segment {
        position: absolute;
        top: 0;
        bottom: 0;
        background: var(--accent);
        opacity: 0.45;
    }
    .track {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text-dim);
        font-size: 0.75rem;
        padding: 0.15rem 0.3rem;
        max-width: 11rem;
    }
    .volume {
        width: 6rem;
    }
    .stats {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
        background: rgb(0 0 0 / 75%);
        color: var(--text-dim);
        font-size: 0.75rem;
        border-radius: 6px;
        padding: 0.3rem 0.6rem;
    }
</style>
