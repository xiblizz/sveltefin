<script>
    import { onMount } from 'svelte';

    /**
     * Header dropdown showing active Jellyfin playback sessions (from
     * /api/streams). Opens on hover/focus, toggles on click for touch.
     * Polls in the background so the badge count stays current, faster
     * while the panel is open.
     */

    const POLL_CLOSED_MS = 30_000;
    const POLL_OPEN_MS = 10_000;

    let streams = $state([]);
    let open = $state(false);
    let updatedAt = $state('');
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;

    async function refresh() {
        try {
            const res = await fetch('/api/streams');
            if (!res.ok) return;
            streams = (await res.json()).streams;
            updatedAt = new Date().toLocaleTimeString();
        } catch {
            // Transient fetch errors just keep the previous list.
        } finally {
            clearTimeout(timer);
            timer = setTimeout(refresh, open ? POLL_OPEN_MS : POLL_CLOSED_MS);
        }
    }

    onMount(() => {
        refresh();
        return () => clearTimeout(timer);
    });

    function show() {
        if (!open) {
            open = true;
            refresh();
        }
    }

    function fmtTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const pad = (n) => String(n).padStart(2, '0');
        return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    function fmtBitrate(bps) {
        return `${(bps / 1_000_000).toFixed(1)} Mbps`;
    }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && (open = false)} />

<div
    class="streams"
    onmouseenter={show}
    onmouseleave={() => (open = false)}
    role="none"
>
    <button
        type="button"
        class="trigger"
        aria-expanded={open}
        aria-label="{streams.length} active {streams.length === 1 ? 'stream' : 'streams'}"
        onclick={() => (open ? (open = false) : show())}
        onfocus={show}
    >
        <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
        >
            <rect
                x="2"
                y="4"
                width="20"
                height="14"
                rx="2"
            />
            <path d="M8 21h8" />
            <path d="m10 8 5 3-5 3z" />
        </svg>
        {#if streams.length}
            <span class="badge">{streams.length}</span>
        {/if}
    </button>

    {#if open}
        <div class="panel">
            <header>
                <strong>{streams.length} active {streams.length === 1 ? 'stream' : 'streams'}</strong>
                <span class="actions">
                    <button
                        type="button"
                        aria-label="Refresh"
                        onclick={refresh}>⟳</button
                    >
                    <button
                        type="button"
                        aria-label="Close"
                        onclick={() => (open = false)}>✕</button
                    >
                </span>
            </header>

            {#each streams as stream (stream.id)}
                <article class="stream">
                    {#if stream.poster}
                        <img
                            src={stream.poster}
                            alt=""
                        />
                    {:else}
                        <div class="no-poster"></div>
                    {/if}
                    <div class="info">
                        <div class="row">
                            <strong class="title">{stream.title}</strong>
                            <span
                                class="state"
                                class:paused={stream.isPaused}
                            >
                                {stream.isPaused ? 'Paused' : 'Playing'}
                            </span>
                        </div>
                        {#if stream.subtitle}
                            <span class="dim">{stream.subtitle}</span>
                        {/if}
                        {#if stream.runtimeSeconds}
                            <div class="progress">
                                <div class="bar">
                                    <div
                                        class="fill"
                                        style:width="{(stream.positionSeconds / stream.runtimeSeconds) * 100}%"
                                    ></div>
                                </div>
                                <span class="dim time"
                                    >{fmtTime(stream.positionSeconds)} / {fmtTime(stream.runtimeSeconds)}</span
                                >
                            </div>
                        {/if}
                        <div class="tags">
                            {#if stream.playMethod}
                                <span class="tag accent">{stream.playMethod}</span>
                            {/if}
                            {#if stream.videoCodec}
                                <span class="tag">{stream.videoCodec}</span>
                            {/if}
                            {#if stream.bitrate}
                                <span class="tag">{fmtBitrate(stream.bitrate)}</span>
                            {/if}
                        </div>
                        <span class="dim">
                            {[stream.userName, stream.client, stream.device].filter(Boolean).join(' · ')}
                        </span>
                        <!-- {#if stream.remoteEndPoint}
                            <span class="dim">{stream.remoteEndPoint}</span>
                        {/if} -->
                    </div>
                </article>
            {:else}
                <p class="empty">No active streams.</p>
            {/each}

            {#if updatedAt}
                <footer class="dim">Updated {updatedAt}</footer>
            {/if}
        </div>
    {/if}
</div>

<style>
    .streams {
        position: relative;
        display: flex;
        align-items: center;
    }
    .trigger {
        position: relative;
        display: grid;
        place-items: center;
        background: none;
        border: 1px solid transparent;
        border-radius: 8px;
        color: var(--text-dim);
        padding: 0.35rem;
        cursor: pointer;
    }
    .trigger:hover,
    .trigger[aria-expanded='true'] {
        color: var(--text);
        border-color: var(--border);
        background: var(--surface-hover);
    }
    .badge {
        position: absolute;
        top: -0.3rem;
        right: -0.3rem;
        background: var(--accent);
        color: #fff;
        border-radius: 999px;
        font-size: 0.65rem;
        font-weight: 700;
        line-height: 1;
        padding: 0.15rem 0.35rem;
    }
    .panel {
        position: absolute;
        top: calc(100% + 0.5rem);
        right: 0;
        width: min(22rem, calc(100vw - 2rem));
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 0.75rem;
        box-shadow: 0 12px 32px rgb(0 0 0 / 50%);
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }
    /* Bridges the gap between trigger and panel so hover doesn't drop out. */
    .panel::before {
        content: '';
        position: absolute;
        top: -0.5rem;
        right: 0;
        width: 100%;
        height: 0.5rem;
    }
    header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
    }
    .actions {
        display: flex;
        gap: 0.25rem;
    }
    .actions button {
        background: none;
        border: none;
        color: var(--text-dim);
        cursor: pointer;
        font-size: 0.9rem;
        padding: 0.15rem 0.35rem;
        border-radius: 6px;
    }
    .actions button:hover {
        color: var(--text);
        background: var(--surface-hover);
    }
    .stream {
        display: flex;
        gap: 0.75rem;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 0.6rem;
    }
    .stream img,
    .no-poster {
        width: 3.5rem;
        aspect-ratio: 2 / 3;
        object-fit: cover;
        border-radius: 6px;
        background: var(--surface-hover);
        flex-shrink: 0;
        align-self: flex-start;
    }
    .info {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        min-width: 0;
        flex: 1;
        font-size: 0.8rem;
    }
    .row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.5rem;
    }
    .title {
        font-size: 0.9rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .state {
        color: var(--accent);
        font-size: 0.7rem;
        font-weight: 700;
        text-transform: uppercase;
        white-space: nowrap;
    }
    .state.paused {
        color: var(--text-dim);
    }
    .dim {
        color: var(--text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .progress {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin: 0.15rem 0;
    }
    .bar {
        flex: 1;
        height: 4px;
        border-radius: 999px;
        background: var(--surface-hover);
        overflow: hidden;
    }
    .fill {
        height: 100%;
        background: var(--accent);
        border-radius: 999px;
    }
    .time {
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
    }
    .tags {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
        margin: 0.1rem 0;
    }
    .tag {
        background: var(--surface-hover);
        border-radius: 6px;
        padding: 0.05rem 0.45rem;
        font-size: 0.7rem;
        font-weight: 600;
    }
    .tag.accent {
        background: color-mix(in srgb, var(--accent) 22%, transparent);
        color: var(--accent);
    }
    .empty {
        color: var(--text-dim);
        text-align: center;
        margin: 0.5rem 0;
        font-size: 0.85rem;
    }
    footer {
        text-align: right;
        font-size: 0.7rem;
    }
</style>
