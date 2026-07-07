<script>
    import { playerComponentFor } from '$lib/player/index.js';

    let { data } = $props();

    /** @type {import('$lib/player/index.js').PlayerController | undefined} */
    let controller = $state();
    let started = false;
    let progressTimer = null;
    let subSelection = $state(-1);
    let activeSegment = $state(null);

    const Player = $derived(playerComponentFor(data.kind));

    $effect(() => {
        subSelection = data.currentSubtitle;
    });

    const backHref = $derived(
        data.item.Type === 'Episode'
            ? `/item/${data.item.SeriesId}?season=${data.item.SeasonId}`
            : `/item/${data.item.Id}`,
    );
    const title = $derived(
        data.item.Type === 'Episode'
            ? `${data.item.SeriesName} – S${data.item.ParentIndexNumber ?? '?'}E${data.item.IndexNumber ?? '?'} – ${data.item.Name}`
            : data.item.Name,
    );

    // Full document load (data-sveltekit-reload below): a new episode is a new
    // playback session either way, and the mpv engine only supports one mount
    // root per module instance (see mpv/README.md), so SPA remounts are risky.
    function episodeHref(episode) {
        return `/watch/${episode.id}${data.backendParam ? `?backend=${data.backendParam}` : ''}`;
    }

    function episodeTitle(episode) {
        return `S${episode.season ?? '?'}E${episode.episode ?? '?'} – ${episode.name}`;
    }

    function report(event, extra = {}) {
        const body = JSON.stringify({
            event,
            itemId: data.item.Id,
            mediaSourceId: data.mediaSourceId,
            playSessionId: data.playSessionId,
            playMethod: data.playMethod,
            positionTicks: (controller?.getCurrentTime() ?? 0) * 10_000_000,
            isPaused: controller?.isPaused() ?? false,
            ...extra,
        });
        // keepalive so the "stopped" report survives navigation/tab close
        fetch('/api/playing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            keepalive: true,
        }).catch(() => {});
    }

    function onPlay() {
        if (!started) {
            started = true;
            report('start');
            progressTimer = setInterval(() => report('progress'), 10_000);
        } else {
            report('progress');
        }
    }

    // Full reload with new stream indices — the transcode session has to be
    // renegotiated server-side anyway, and ?t= carries the position over.
    function reloadWith({ audio = data.audioParam, subtitle = null, backend = data.backendParam }) {
        const query = new URLSearchParams();
        if (audio !== null) query.set('audio', String(audio));
        if (subtitle !== null && subtitle >= 0) query.set('subtitle', String(subtitle));
        if (backend) query.set('backend', backend);
        const t = Math.floor(controller?.getCurrentTime() ?? 0);
        if (t > 0) query.set('t', String(t));
        if (started) report('progress');
        window.location.assign(`/watch/${data.item.Id}?${query}`);
    }

    function onAudioChange(event) {
        const value = Number(event.target.value);
        if (value === data.currentAudio) return;
        reloadWith({ audio: value, subtitle: data.burnedSubtitle >= 0 ? data.burnedSubtitle : null });
    }

    function onSubtitleChange(event) {
        const value = Number(event.target.value);
        subSelection = value;
        if (data.burnedSubtitle >= 0) {
            // Currently burning in — any change needs a new transcode (or none).
            reloadWith({ subtitle: value >= 0 ? value : null });
            return;
        }
        const track = data.subtitleTracks.find((candidate) => candidate.index === value);
        if (value === -1 || track?.external) {
            controller?.setTextTrack(value); // instant, no renegotiation
        } else {
            reloadWith({ subtitle: value }); // embedded/image sub → burn-in
        }
    }

    function onTimeUpdate(t) {
        activeSegment = data.segments.find((segment) => t >= segment.start && t < segment.end - 1) ?? null;
    }

    function skipSegment() {
        if (activeSegment && controller) {
            controller.seek(activeSegment.end);
            activeSegment = null;
        }
    }

    // Up-next autoplay: when an episode ends and Jellyfin knows a successor,
    // show a cancellable countdown, then do the same full-page navigation as
    // the Next button (new playback session; see episodeHref).
    let upNextCountdown = $state(-1); // -1 = hidden
    let upNextTimer = null;

    function onEnded() {
        if (started) report('stopped');
        if (data.nextEpisode && upNextCountdown < 0) {
            upNextCountdown = 8;
            upNextTimer = setInterval(() => {
                upNextCountdown -= 1;
                if (upNextCountdown <= 0) {
                    clearInterval(upNextTimer);
                    window.location.assign(episodeHref(data.nextEpisode));
                }
            }, 1000);
        }
    }

    function cancelUpNext() {
        clearInterval(upNextTimer);
        upNextCountdown = -1;
    }

    // Space toggles play/pause — but not when an interactive element should
    // get the key (header search input, track selects, focused buttons/links,
    // or the native <video>, whose own controls already handle space).
    function onKeydown(event) {
        if (event.key !== ' ' || event.repeat) return;
        const target = event.target;
        if (
            target instanceof HTMLElement &&
            (target.isContentEditable || target.closest('input, textarea, select, button, a, video'))
        ) {
            return;
        }
        event.preventDefault();
        controller?.togglePlay();
    }

    $effect(() => {
        // Cleanup for the whole playback session, whichever backend is active.
        return () => {
            if (started) report('stopped');
            clearInterval(progressTimer);
            clearInterval(upNextTimer);
        };
    });
</script>

<svelte:head>
    <title>{title}</title>
</svelte:head>

<svelte:window
    onbeforeunload={() => started && report('stopped')}
    onkeydown={onKeydown}
/>

<div class="player-page">
    <div class="bar">
        <a href={backHref}>← Back</a>
        <h1>{title}</h1>
        {#if data.previousEpisode || data.nextEpisode}
            <span class="epnav">
                {#if data.previousEpisode}
                    <a
                        href={episodeHref(data.previousEpisode)}
                        data-sveltekit-reload
                        title={episodeTitle(data.previousEpisode)}
                    >
                        ⏮ Prev
                    </a>
                {/if}
                {#if data.nextEpisode}
                    <a
                        href={episodeHref(data.nextEpisode)}
                        data-sveltekit-reload
                        title={episodeTitle(data.nextEpisode)}
                    >
                        Next ⏭
                    </a>
                {/if}
            </span>
        {/if}
        {#if data.kind !== 'mpv' && data.audioTracks.length > 1}
            <label class="track-select">
                Audio
                <select
                    value={data.currentAudio}
                    onchange={onAudioChange}
                >
                    {#each data.audioTracks as track (track.index)}
                        <option value={track.index}>{track.label}</option>
                    {/each}
                </select>
            </label>
        {/if}
        {#if data.kind !== 'mpv' && data.subtitleTracks.length}
            <label class="track-select">
                Subtitles
                <select
                    value={subSelection}
                    onchange={onSubtitleChange}
                >
                    <option value={-1}>Off</option>
                    {#each data.subtitleTracks as track (track.index)}
                        <option value={track.index}>{track.label}</option>
                    {/each}
                </select>
            </label>
        {/if}
        {#if data.mpvAvailable}
            <button
                type="button"
                class="backend-toggle"
                class:active={data.kind === 'mpv'}
                onclick={() => reloadWith({ backend: data.kind === 'mpv' ? 'html' : 'mpv' })}
                title="Direct-play the original file with the libmpv (WebAssembly) engine"
            >
                mpv
            </button>
        {/if}
        <span class="method">{data.playMethod}</span>
    </div>

    <div class="videowrap">
        <Player
            {data}
            bind:controller
            onplay={onPlay}
            onpause={() => started && report('progress')}
            onended={onEnded}
            ontimeupdate={onTimeUpdate}
        />
        {#if upNextCountdown >= 0 && data.nextEpisode}
            <div class="upnext">
                <span class="upnext-title">Up next: {episodeTitle(data.nextEpisode)}</span>
                <div class="upnext-actions">
                    <a
                        class="upnext-play"
                        href={episodeHref(data.nextEpisode)}
                        data-sveltekit-reload
                    >
                        Play now ({upNextCountdown})
                    </a>
                    <button
                        type="button"
                        class="upnext-cancel"
                        onclick={cancelUpNext}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        {/if}
        {#if activeSegment}
            <button
                type="button"
                class="skip"
                onclick={skipSegment}
            >
                {activeSegment.type === 'Outro' ? 'Skip Credits' : 'Skip Intro'} ⏭
            </button>
        {/if}
    </div>
</div>

<style>
    .player-page {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        padding: 1rem;
    }
    .bar {
        display: flex;
        align-items: baseline;
        gap: 1rem;
    }
    .bar a {
        color: var(--accent);
        white-space: nowrap;
    }
    h1 {
        font-size: 1.1rem;
        margin: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .epnav {
        display: flex;
        gap: 0.6rem;
        white-space: nowrap;
    }
    .epnav a {
        color: var(--text-dim);
        font-size: 0.85rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.1rem 0.5rem;
        text-decoration: none;
    }
    .epnav a:hover {
        color: var(--accent);
        border-color: var(--accent);
    }
    .track-select {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        color: var(--text-dim);
        font-size: 0.85rem;
        white-space: nowrap;
    }
    .track-select:first-of-type {
        margin-left: auto;
    }
    .track-select select {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text);
        padding: 0.2rem 0.4rem;
        font-size: 0.85rem;
        max-width: 14rem;
    }
    .backend-toggle {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text-dim);
        font-size: 0.8rem;
        padding: 0.1rem 0.5rem;
        cursor: pointer;
        white-space: nowrap;
    }
    .backend-toggle.active {
        color: var(--accent);
        border-color: var(--accent);
    }
    .backend-toggle:first-of-type,
    .backend-toggle:only-of-type {
        margin-left: auto;
    }
    .track-select + .backend-toggle,
    .track-select ~ .backend-toggle {
        margin-left: 0;
    }
    .videowrap {
        position: relative;
    }
    .upnext {
        position: absolute;
        right: 1.25rem;
        bottom: 4.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        background: rgb(0 0 0 / 85%);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 0.9rem 1.1rem;
        max-width: 24rem;
    }
    .upnext-title {
        color: #fff;
        font-weight: 600;
        font-size: 0.95rem;
    }
    .upnext-actions {
        display: flex;
        gap: 0.6rem;
    }
    .upnext-play {
        background: var(--accent);
        border-radius: 8px;
        color: #fff;
        padding: 0.4rem 1rem;
        font-weight: 600;
        text-decoration: none;
    }
    .upnext-cancel {
        background: none;
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text-dim);
        padding: 0.4rem 1rem;
        cursor: pointer;
    }
    .skip {
        position: absolute;
        right: 1.25rem;
        bottom: 4.5rem;
        background: rgb(0 0 0 / 75%);
        color: #fff;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.6rem 1.2rem;
        font-size: 0.95rem;
        font-weight: 600;
        cursor: pointer;
    }
    .skip:hover {
        background: var(--accent);
        border-color: var(--accent);
    }
    .method {
        color: var(--text-dim);
        font-size: 0.8rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.1rem 0.5rem;
        white-space: nowrap;
    }
</style>
