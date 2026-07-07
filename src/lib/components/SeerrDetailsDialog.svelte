<script>
    import { enhance } from '$app/forms';

    /**
     * Modal (native <dialog>) with full movie/show details, opened from a
     * SeerrGrid card. Shows the card's data immediately and enriches it with
     * /api/seerr/details. `form` is the hosting page's form prop so a request
     * submitted inside the dialog flips to "Requested ✓".
     */
    let { form } = $props();

    /** @type {HTMLDialogElement} */
    let dialog;
    let card = $state(null);
    let details = $state(null);
    let failed = $state(false);

    /** Card shape from seerr.js toCard. */
    export async function open(nextCard) {
        card = nextCard;
        details = null;
        failed = false;
        dialog.showModal();
        try {
            const res = await fetch(`/api/seerr/details?type=${nextCard.mediaType}&id=${nextCard.tmdbId}`);
            if (!res.ok) throw new Error(`details returned ${res.status}`);
            const data = await res.json();
            // Ignore stale responses if another card was opened meanwhile.
            if (card?.tmdbId === nextCard.tmdbId && card?.mediaType === nextCard.mediaType) {
                details = data;
            }
        } catch {
            failed = true;
        }
    }

    const merged = $derived(details ?? card);
    const status = $derived(details ? details.status : card?.status);
    const meta = $derived.by(() => {
        if (!merged) return [];
        const parts = [];
        if (merged.year) parts.push(merged.year);
        if (details?.runtime) parts.push(`${details.runtime} min`);
        if (details?.numberOfSeasons) {
            parts.push(`${details.numberOfSeasons} season${details.numberOfSeasons === 1 ? '' : 's'}`);
        }
        if (details?.contentStatus) parts.push(details.contentStatus);
        if (details?.voteAverage) parts.push(`★ ${details.voteAverage}`);
        return parts;
    });
</script>

<dialog
    bind:this={dialog}
    onclick={(e) => e.target === dialog && dialog.close()}
    onclose={() => (card = null)}
>
    {#if merged}
        <article>
            <div
                class="backdrop"
                class:has-image={details?.backdrop}
            >
                {#if details?.backdrop}
                    <img
                        src={details.backdrop}
                        alt=""
                    />
                {/if}
                <button
                    type="button"
                    class="close"
                    aria-label="Close"
                    onclick={() => dialog.close()}>✕</button
                >
            </div>

            <div class="body">
                <div class="head">
                    {#if merged.poster}
                        <img
                            class="poster"
                            src={merged.poster}
                            alt={merged.title}
                        />
                    {/if}
                    <div class="headline">
                        <span class="type">{merged.mediaType === 'movie' ? 'Movie' : 'Show'}</span>
                        <h2>{merged.title}</h2>
                        {#if meta.length}
                            <p class="meta">{meta.join(' · ')}</p>
                        {/if}
                        {#if details?.genres.length}
                            <div class="genres">
                                {#each details.genres as genre (genre)}
                                    <span>{genre}</span>
                                {/each}
                            </div>
                        {/if}
                        {#if status}
                            <span class="status">{status}</span>
                        {:else if form?.requested === merged.tmdbId}
                            <span class="status">Requested ✓</span>
                        {:else}
                            <form
                                method="POST"
                                action="?/request"
                                use:enhance
                            >
                                <input
                                    type="hidden"
                                    name="mediaType"
                                    value={merged.mediaType}
                                />
                                <input
                                    type="hidden"
                                    name="tmdbId"
                                    value={merged.tmdbId}
                                />
                                <button type="submit">Request</button>
                            </form>
                        {/if}
                    </div>
                </div>

                {#if details?.tagline}
                    <p class="tagline">{details.tagline}</p>
                {/if}
                {#if merged.overview}
                    <p class="overview">{merged.overview}</p>
                {/if}

                {#if details?.cast.length}
                    <h3>Cast</h3>
                    <ul class="cast">
                        {#each details.cast as member (member.name)}
                            <li>
                                {#if member.photo}
                                    <img
                                        src={member.photo}
                                        alt={member.name}
                                        loading="lazy"
                                    />
                                {:else}
                                    <div class="no-photo"></div>
                                {/if}
                                <strong>{member.name}</strong>
                                <span>{member.character}</span>
                            </li>
                        {/each}
                    </ul>
                {/if}

                {#if !details && !failed}
                    <p class="loading">Loading details…</p>
                {:else if failed}
                    <p class="loading">Couldn't load further details.</p>
                {/if}
            </div>
        </article>
    {/if}
</dialog>

<style>
    dialog {
        width: min(42rem, calc(100vw - 2rem));
        max-height: calc(100dvh - 4rem);
        background: var(--surface);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 0;
        overflow: hidden auto;
    }
    dialog::backdrop {
        background: rgb(0 0 0 / 60%);
        backdrop-filter: blur(3px);
    }
    .backdrop {
        position: relative;
        height: 6rem;
    }
    .backdrop.has-image {
        height: 12rem;
    }
    .backdrop img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        mask-image: linear-gradient(to bottom, black 40%, transparent);
    }
    .close {
        position: absolute;
        top: 0.75rem;
        right: 0.75rem;
        background: rgb(0 0 0 / 55%);
        border: none;
        border-radius: 8px;
        color: var(--text);
        padding: 0.3rem 0.6rem;
        cursor: pointer;
    }
    .close:hover {
        background: rgb(0 0 0 / 80%);
    }
    .body {
        padding: 0 1.5rem 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }
    .head {
        display: flex;
        gap: 1.25rem;
        margin-top: -3.5rem;
    }
    .poster {
        width: 9rem;
        aspect-ratio: 2 / 3;
        object-fit: cover;
        border-radius: 10px;
        border: 1px solid var(--border);
        box-shadow: 0 8px 24px rgb(0 0 0 / 50%);
        flex-shrink: 0;
    }
    .headline {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.4rem;
        margin-top: 3.5rem;
        min-width: 0;
    }
    .type {
        background: rgb(0 0 0 / 70%);
        border-radius: 6px;
        padding: 0.05rem 0.45rem;
        font-size: 0.75rem;
    }
    h2 {
        margin: 0;
        font-size: 1.4rem;
    }
    .meta {
        margin: 0;
        color: var(--text-dim);
        font-size: 0.85rem;
    }
    .genres {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
    }
    .genres span {
        background: var(--surface-hover);
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 0.05rem 0.6rem;
        font-size: 0.75rem;
        color: var(--text-dim);
    }
    .status {
        color: var(--accent);
        font-size: 0.9rem;
        font-weight: 600;
    }
    .headline button {
        background: var(--accent);
        border: none;
        border-radius: 8px;
        color: #fff;
        padding: 0.4rem 1rem;
        cursor: pointer;
        font-weight: 600;
    }
    .headline button:hover {
        filter: brightness(1.1);
    }
    .tagline {
        margin: 0;
        color: var(--text-dim);
        font-style: italic;
    }
    .overview {
        margin: 0;
        font-size: 0.95rem;
    }
    h3 {
        margin: 0.5rem 0 0;
        font-size: 1rem;
    }
    .cast {
        list-style: none;
        margin: 0;
        padding: 0 0 0.5rem;
        display: flex;
        gap: 0.75rem;
        overflow-x: auto;
    }
    .cast li {
        display: flex;
        flex-direction: column;
        width: 5.5rem;
        flex-shrink: 0;
        font-size: 0.75rem;
        gap: 0.1rem;
    }
    .cast img,
    .no-photo {
        width: 5.5rem;
        aspect-ratio: 1;
        object-fit: cover;
        border-radius: 50%;
        background: var(--surface-hover);
        margin-bottom: 0.25rem;
    }
    .cast strong {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .cast span {
        color: var(--text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .loading {
        margin: 0;
        color: var(--text-dim);
        font-size: 0.85rem;
    }
    @media (max-width: 32rem) {
        .head {
            margin-top: -2.5rem;
        }
        .poster {
            width: 6rem;
        }
        .headline {
            margin-top: 2.5rem;
        }
    }
</style>
