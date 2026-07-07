<script>
    import Row from '$lib/components/Row.svelte';
    import { imgUrl, formatRuntime, ticksToSeconds } from '$lib/img.js';

    let { data } = $props();

    const item = $derived(data.item);
    const backdrop = $derived(imgUrl(item, 'Backdrop', { maxWidth: 1600 }));
    const poster = $derived(imgUrl(item, 'Primary', { maxWidth: 500 }));
    const resumeTicks = $derived(item.UserData?.PlaybackPositionTicks ?? 0);

    // Watchlist membership is Jellyfin's favorite flag (docs/roadmap.md).
    let inWatchlist = $state(false);
    let watched = $state(false);
    let busy = $state(false);
    $effect(() => {
        inWatchlist = data.item.UserData?.IsFavorite ?? false;
        watched = data.item.UserData?.Played ?? false;
    });

    async function act(action) {
        if (busy) return false;
        busy = true;
        try {
            const res = await fetch('/api/item-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, itemId: item.Id }),
            });
            return res.ok;
        } catch {
            return false;
        } finally {
            busy = false;
        }
    }

    async function toggleWatchlist() {
        if (await act(inWatchlist ? 'watchlist-remove' : 'watchlist-add')) {
            inWatchlist = !inWatchlist;
        }
    }

    // For a series this marks/unmarks every episode (Jellyfin semantics).
    async function toggleWatched() {
        if (await act(watched ? 'mark-unplayed' : 'mark-played')) {
            watched = !watched;
        }
    }

    // For a series, "Play" targets the next-up episode when Jellyfin knows one;
    // otherwise the first episode of the selected season.
    const playTarget = $derived(item.Type === 'Series' ? (data.episodes[0]?.Id ?? null) : item.Id);

    const cast = $derived((item.People ?? []).filter((person) => person.Type === 'Actor').slice(0, 20));

    // People carry PrimaryImageTag (not ImageTags), so imgUrl() doesn't apply.
    function personImg(person) {
        if (!person.PrimaryImageTag) return null;
        return `/api/media/Items/${person.Id}/Images/Primary?tag=${encodeURIComponent(person.PrimaryImageTag)}&maxWidth=185&quality=90`;
    }

    function resumeLabel(ticks) {
        const seconds = ticksToSeconds(ticks);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return h ? `${h}:${String(m).padStart(2, '0')}` : `${m} min`;
    }
</script>

<svelte:head>
    <title>{item.Name}</title>
</svelte:head>

<div
    class="hero"
    style={backdrop ? `--backdrop: url("${backdrop}")` : ''}
>
    <div class="hero-inner">
        {#if poster}
            <img
                class="poster"
                src={poster}
                alt={item.Name}
            />
        {/if}
        <div class="info">
            <h1>{item.Name}</h1>
            <p class="facts">
                {#if item.ProductionYear}<span>{item.ProductionYear}</span>{/if}
                {#if item.RunTimeTicks}<span>{formatRuntime(item.RunTimeTicks)}</span>{/if}
                {#if item.OfficialRating}<span class="badge">{item.OfficialRating}</span>{/if}
                {#if item.CommunityRating}<span>★ {item.CommunityRating.toFixed(1)}</span>{/if}
                {#if data.mediaFacts?.resolution}<span class="badge">{data.mediaFacts.resolution}</span>{/if}
                {#if data.mediaFacts?.videoRange}<span class="badge">{data.mediaFacts.videoRange}</span>{/if}
                {#if data.mediaFacts?.videoCodec}<span class="badge">{data.mediaFacts.videoCodec}</span>{/if}
                {#if data.mediaFacts?.audioLanguages.length}
                    <span title="Audio languages">🔊 {data.mediaFacts.audioLanguages.join(', ')}</span>
                {/if}
            </p>
            {#if item.Genres?.length}
                <p class="genres">{item.Genres.join(' · ')}</p>
            {/if}
            {#if item.Overview}
                <p
                    class="overview"
                    title={item.Overview}
                >
                    {item.Overview}
                </p>
            {/if}
            <div class="actions">
                {#if playTarget}
                    {#if item.Type !== 'Series' && resumeTicks > 0}
                        <a
                            class="btn primary"
                            href="/watch/{playTarget}?resume=1"
                        >
                            Resume from {resumeLabel(resumeTicks)}
                        </a>
                        <a
                            class="btn"
                            href="/watch/{playTarget}">Play from start</a
                        >
                    {:else}
                        <a
                            class="btn primary"
                            href="/watch/{playTarget}">Play</a
                        >
                    {/if}
                {/if}
                <button
                    type="button"
                    class="btn icon"
                    class:on={inWatchlist}
                    title={inWatchlist ? 'Remove from watchlist' : 'Add to watchlist'}
                    onclick={toggleWatchlist}
                >
                    {inWatchlist ? '✓' : '+'}
                </button>
                <button
                    type="button"
                    class="btn icon"
                    class:on={watched}
                    title={watched ? 'Mark as unwatched' : 'Mark as watched'}
                    onclick={toggleWatched}
                >
                    {watched ? '✓ Watched' : 'Mark watched'}
                </button>
            </div>
        </div>
    </div>
</div>

{#if item.Type === 'Series' && data.seasons.length}
    <section class="seasons">
        <nav
            class="season-tabs"
            aria-label="Seasons"
        >
            {#each data.seasons as season (season.Id)}
                <a
                    href="?season={season.Id}"
                    class:active={season.Id === data.selectedSeason?.Id}
                    data-sveltekit-noscroll
                >
                    {season.Name}
                </a>
            {/each}
        </nav>
        <ol class="episodes">
            {#each data.episodes as episode (episode.Id)}
                <li>
                    <a
                        href="/watch/{episode.Id}"
                        class="episode"
                    >
                        <div class="thumb">
                            {#if imgUrl(episode, 'Primary', { maxWidth: 400, fallbackToSeries: false })}
                                <img
                                    src={imgUrl(episode, 'Primary', { maxWidth: 400, fallbackToSeries: false })}
                                    alt=""
                                    loading="lazy"
                                />
                            {/if}
                            {#if (episode.UserData?.PlayedPercentage ?? 0) > 0 && !episode.UserData?.Played}
                                <div class="progress">
                                    <div
                                        class="bar"
                                        style="width: {episode.UserData.PlayedPercentage}%"
                                    ></div>
                                </div>
                            {/if}
                        </div>
                        <div class="ep-info">
                            <strong>
                                {episode.IndexNumber != null ? `${episode.IndexNumber}. ` : ''}{episode.Name}
                                {#if episode.UserData?.Played}<span class="watched">✓</span>{/if}
                            </strong>
                            {#if episode.RunTimeTicks}<span class="ep-runtime"
                                    >{formatRuntime(episode.RunTimeTicks)}</span
                                >{/if}
                            {#if episode.Overview}<p>{episode.Overview}</p>{/if}
                        </div>
                    </a>
                </li>
            {/each}
        </ol>
    </section>
{/if}

{#if cast.length}
    <section class="castSection">
        <h2>Cast</h2>
        <ul class="cast">
            {#each cast as person (person.Id + (person.Role ?? ''))}
                <li>
                    {#if personImg(person)}
                        <img
                            src={personImg(person)}
                            alt={person.Name}
                            loading="lazy"
                        />
                    {:else}
                        <div class="no-photo"></div>
                    {/if}
                    <strong>{person.Name}</strong>
                    {#if person.Role}<span>{person.Role}</span>{/if}
                </li>
            {/each}
        </ul>
    </section>
{/if}

<section>
    <Row
        title="More Like This"
        items={data.similar}
    />
</section>

<style>
    .hero {
        position: relative;
        display: flex;
        justify-content: center;
        background:
            linear-gradient(to bottom, rgb(13 13 13 / 69%), var(--bg)),
            var(--backdrop, var(--bg)) center / cover;
        animation: fadeIn 0.3s ease-in-out;
    }
    @keyframes fadeIn {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }
    .hero-inner {
        display: flex;
        justify-content: center;
        gap: 1.75rem;
        width: 100rem;
        padding: 2rem;
    }
    .poster {
        height: 18rem;
        width: auto;
        border-radius: 10px;
        align-self: flex-start;
        flex-shrink: 0;
    }
    .info {
        padding-top: 1rem;
    }
    h1 {
        margin: 0 0 0.5rem;
        font-size: clamp(1.5rem, 3.5vw, 2.25rem);
    }
    .facts {
        display: flex;
        gap: 1rem;
        color: var(--text-dim);
        margin: 0 0 0.5rem;
        flex-wrap: wrap;
    }
    .badge {
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 0 0.4rem;
        font-size: 0.85rem;
    }
    .genres {
        color: var(--text-dim);
        margin: 0 0 0.75rem;
        font-size: 0.9rem;
    }
    .overview {
        margin: 0 0 1.25rem;
        height: 4.5rem;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
        line-clamp: 3;
    }
    .actions {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
    }
    .btn.icon {
        padding: 0.6rem 1rem;
        font-size: 1.05rem;
        line-height: 1.5;
        cursor: pointer;
        color: var(--text);
    }
    .btn.icon.on {
        color: var(--accent);
        border-color: var(--accent);
    }
    .btn {
        display: inline-block;
        padding: 0.6rem 1.4rem;
        border-radius: 8px;
        border: 1px solid var(--border);
        font-weight: 600;
        background: var(--surface);
    }
    .btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
    }
    .btn:hover {
        filter: brightness(1.1);
    }
    .seasons {
        margin-top: 1rem;
        padding: 1rem;
    }
    .season-tabs {
        display: flex;
        gap: 0.4rem;
        overflow-x: auto;
        margin-bottom: 1rem;
    }
    .season-tabs a {
        padding: 0.4rem 0.9rem;
        border-radius: 8px;
        color: var(--text-dim);
        white-space: nowrap;
        border: 1px solid var(--border);
    }
    .season-tabs a.active {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
    }
    .episodes {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }
    .episode {
        display: flex;
        gap: 1rem;
        padding: 0.6rem;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: var(--surface);
    }
    .episode:hover {
        background: var(--surface-hover);
    }
    .thumb {
        position: relative;
        width: clamp(8rem, 20vw, 13rem);
        aspect-ratio: 16 / 9;
        border-radius: 8px;
        overflow: hidden;
        background: var(--bg);
        flex-shrink: 0;
    }
    .thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .progress {
        position: absolute;
        inset: auto 0 0 0;
        height: 4px;
        background: rgb(0 0 0 / 55%);
    }
    .bar {
        height: 100%;
        background: var(--accent);
    }
    .ep-info {
        min-width: 0;
    }
    .ep-info strong {
        display: block;
    }
    .watched {
        color: var(--accent);
    }
    .ep-runtime {
        color: var(--text-dim);
        font-size: 0.85rem;
    }
    .ep-info p {
        color: var(--text-dim);
        font-size: 0.9rem;
        margin: 0.35rem 0 0;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }
    .castSection {
        padding: 1rem;
    }
    .castSection h2 {
        font-size: 1.15rem;
        margin: 0 0 0.75rem;
    }
    .cast {
        list-style: none;
        margin: 0;
        padding: 0 2%;
        padding-bottom: 0.5rem;
        display: flex;
        gap: 0.9rem;
        overflow-x: auto;
        mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%);
        -webkit-mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%);
    }
    .cast li {
        display: flex;
        flex-direction: column;
        width: 6.5rem;
        flex-shrink: 0;
        font-size: 0.8rem;
        gap: 0.1rem;
        text-align: center;
    }
    .cast img,
    .no-photo {
        width: 6.5rem;
        aspect-ratio: 1;
        object-fit: cover;
        border-radius: 50%;
        background: var(--surface);
        border: 1px solid var(--border);
        margin-bottom: 0.35rem;
    }
    .cast strong {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .cast li span {
        color: var(--text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    @media (max-width: 40rem) {
        .hero-inner {
            flex-direction: column;
        }
    }
</style>
