<script>
    import { imgUrl } from '$lib/img.js';
    import { invalidateAll } from '$app/navigation';

    let {
        item,
        wide = false,
        showActions = true,
        removeResume = false,
        watchlistRemove = false,
        removeNextUp = false,
    } = $props();

    // The watchlist is Jellyfin favorites under the hood, so membership is
    // known up front via UserData.IsFavorite (docs/roadmap.md).
    let watchlisted = $state(false);
    let played = $state(false);
    let busy = $state(false);

    // Sync from the item whenever it changes (cards are reused across invalidations).
    $effect(() => {
        watchlisted = item.UserData?.IsFavorite ?? false;
        played = item.UserData?.Played ?? false;
    });

    // Episodes link to their own detail-less watch flow via the item page of the series;
    // playing directly from cards resumes where you left off.
    const href = $derived(item.Type === 'Episode' && item.SeriesId ? `/watch/${item.Id}` : `/item/${item.Id}`);
    const image = $derived(
        wide
            ? (imgUrl(item, 'Thumb', { maxWidth: 500 }) ??
                  imgUrl(item, 'Backdrop', { maxWidth: 500 }) ??
                  imgUrl(item, 'Primary', { maxWidth: 500 }))
            : imgUrl(item, 'Primary', { maxWidth: 400 }),
    );
    const label = $derived(
        item.Type === 'Episode'
            ? `${item.SeriesName} · S${item.ParentIndexNumber ?? '?'}E${item.IndexNumber ?? '?'}`
            : (item.ProductionYear ?? ''),
    );
    const progress = $derived(item.UserData?.PlayedPercentage ?? 0);

    // Watchlist entries are the series/movie itself; for episode cards (resume,
    // next up) the watchlist target is the parent series.
    const actionTargetId = $derived(item.Type === 'Episode' ? (item.SeriesId ?? item.Id) : item.Id);

    async function act(action, itemId, { refresh = false } = {}) {
        if (busy) return false;
        busy = true;
        try {
            const res = await fetch('/api/item-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, itemId }),
            });
            if (!res.ok) return false;
            if (refresh) await invalidateAll();
            return true;
        } catch {
            return false;
        } finally {
            busy = false;
        }
    }

    async function toggleWatchlist(event) {
        event.preventDefault();
        const next = !watchlisted;
        // Removing should drop the card from the watchlist page's listing.
        if (
            await act(next ? 'watchlist-add' : 'watchlist-remove', actionTargetId, {
                refresh: !next && watchlistRemove,
            })
        ) {
            watchlisted = next;
        }
    }

    async function removeFromResume(event) {
        event.preventDefault();
        await act('remove-resume', item.Id, { refresh: true });
    }

    // Watched targets the item itself (episode cards → that episode); the
    // refresh lets home rows and grids re-rank (Continue Watching / Next Up
    // drop or advance, played badges update).
    async function togglePlayed(event) {
        event.preventDefault();
        const next = !played;
        if (await act(next ? 'mark-played' : 'mark-unplayed', item.Id, { refresh: true })) {
            played = next;
        }
    }

    // No hide-from-next-up endpoint in the Jellyfin 12 spec — removing a
    // series from Next Up means marking the whole series played.
    async function removeFromNextUp(event) {
        event.preventDefault();
        await act('mark-played', item.SeriesId ?? item.Id, { refresh: true });
    }
</script>

<a
    {href}
    class="card"
    class:wide
    title={item.Name}
>
    <div class="poster">
        {#if image}
            <img
                src={image}
                alt={item.Name}
                loading="lazy"
            />
        {:else}
            <div class="placeholder">{item.Name}</div>
        {/if}
        {#if progress > 0 && progress < 100}
            <div class="progress">
                <div
                    class="bar"
                    style="width: {progress}%"
                ></div>
            </div>
        {/if}
        {#if item.UserData?.Played}
            <div
                class="played"
                aria-label="Watched"
            >
                ✓
            </div>
        {/if}
        {#if showActions}
            <div class="actions">
                <button
                    type="button"
                    class:on={played}
                    title={played ? 'Mark as unwatched' : 'Mark as watched'}
                    onclick={togglePlayed}
                >
                    {played ? '↺' : '✔'}
                </button>
                <button
                    type="button"
                    class:on={watchlisted}
                    title={watchlisted ? 'Remove from watchlist' : 'Add to watchlist'}
                    onclick={toggleWatchlist}
                >
                    {watchlistRemove ? '−' : watchlisted ? '✓' : '+'}
                </button>
                {#if removeResume}
                    <button
                        type="button"
                        title="Remove from Continue Watching"
                        onclick={removeFromResume}
                    >
                        ✕
                    </button>
                {/if}
                {#if removeNextUp}
                    <button
                        type="button"
                        title="Remove from Next Up (marks the whole series as watched)"
                        onclick={removeFromNextUp}
                    >
                        ✕
                    </button>
                {/if}
            </div>
        {/if}
    </div>
    <div class="meta">
        <span class="name">{item.Name}</span>
        {#if label}<span class="sub">{label}</span>{/if}
    </div>
</a>

<style>
    .card {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        width: 100%;
    }
    .poster {
        position: relative;
        aspect-ratio: 2 / 3;
        border-radius: 10px;
        overflow: hidden;
        background: var(--surface);
        border: 1px solid var(--border);
    }
    .card.wide .poster {
        aspect-ratio: 16 / 9;
    }
    .poster img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        transition: transform 0.15s ease;
    }
    .card:hover .poster img {
        transform: scale(1.04);
    }
    .placeholder {
        height: 100%;
        display: grid;
        place-items: center;
        padding: 0.5rem;
        text-align: center;
        color: var(--text-dim);
        font-size: 0.85rem;
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
    .played {
        position: absolute;
        top: 0.4rem;
        right: 0.4rem;
        background: var(--accent);
        color: #fff;
        border-radius: 50%;
        width: 1.4rem;
        height: 1.4rem;
        display: grid;
        place-items: center;
        font-size: 0.8rem;
    }
    .actions {
        position: absolute;
        top: 0.4rem;
        right: 0.4rem;
        display: flex;
        gap: 0.3rem;
        opacity: 0;
        transition: opacity 0.15s ease;
    }
    .card:hover .actions,
    .actions:focus-within {
        opacity: 1;
    }
    .actions button {
        width: 1.7rem;
        height: 1.7rem;
        border-radius: 50%;
        border: 1px solid var(--border);
        background: rgb(0 0 0 / 70%);
        color: #fff;
        cursor: pointer;
        display: grid;
        place-items: center;
        font-size: 0.9rem;
        line-height: 1;
    }
    .actions button:hover {
        background: var(--accent);
        border-color: var(--accent);
    }
    .actions button.on {
        color: var(--accent);
    }
    .actions button.on:hover {
        color: #fff;
    }
    .meta {
        display: flex;
        flex-direction: column;
        min-width: 0;
    }
    .name {
        font-size: 0.9rem;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .sub {
        font-size: 0.8rem;
        color: var(--text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
</style>
