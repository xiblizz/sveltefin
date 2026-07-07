<script>
    import { enhance } from '$app/forms';
    import SeerrDetailsDialog from '$lib/components/SeerrDetailsDialog.svelte';

    /**
     * Grid of Seerr result cards (shape from seerr.js toCard) with a Request
     * button. The hosting page must expose the shared `request` form action
     * (`requestAction` in $lib/server/seerr.js) and pass its `form` prop
     * through so "Requested ✓" shows up after submitting.
     *
     * Clicking a poster opens a details dialog (Seerr-style modal).
     */
    let { results, form } = $props();

    /** @type {SeerrDetailsDialog} */
    let dialog;
</script>

<SeerrDetailsDialog
    bind:this={dialog}
    {form}
/>

<div class="grid">
    {#each results as result (result.mediaType + result.tmdbId)}
        <article class="cell">
            <button
                type="button"
                class="poster"
                onclick={() => dialog.open(result)}
                aria-label="Details for {result.title}"
            >
                {#if result.poster}
                    <img
                        src={result.poster}
                        alt={result.title}
                        loading="lazy"
                    />
                {:else}
                    <div class="placeholder">{result.title}</div>
                {/if}
                <span class="type">{result.mediaType === 'movie' ? 'Movie' : 'Show'}</span>
            </button>
            <strong class="title">{result.title}</strong>
            <span class="year">{result.year}</span>
            {#if result.status}
                <span class="status">{result.status}</span>
            {:else if form?.requested === result.tmdbId}
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
                        value={result.mediaType}
                    />
                    <input
                        type="hidden"
                        name="tmdbId"
                        value={result.tmdbId}
                    />
                    <button type="submit">Request</button>
                </form>
            {/if}
        </article>
    {/each}
</div>

<style>
    .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
        gap: 1rem;
        padding: 2rem 1rem;
    }
    .cell {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }
    .poster {
        position: relative;
        display: block;
        width: 100%;
        aspect-ratio: 2 / 3;
        border-radius: 10px;
        overflow: hidden;
        background: var(--surface);
        border: 1px solid var(--border);
        padding: 0;
        cursor: pointer;
        color: inherit;
        font: inherit;
        text-align: inherit;
        transition: border-color 0.2s ease;
    }
    .poster:hover,
    .poster:focus-visible {
        border-color: var(--accent);
    }
    .poster img {
        width: 100%;
        height: 100%;
        object-fit: cover;
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
    .type {
        position: absolute;
        top: 0.4rem;
        left: 0.4rem;
        background: rgb(0 0 0 / 70%);
        border-radius: 6px;
        padding: 0.05rem 0.45rem;
        font-size: 0.75rem;
    }
    .title {
        font-size: 0.9rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .year {
        color: var(--text-dim);
        font-size: 0.8rem;
    }
    .status {
        color: var(--accent);
        font-size: 0.85rem;
        font-weight: 600;
    }
    button {
        background: var(--accent);
        border: none;
        border-radius: 8px;
        color: #fff;
        padding: 0.35rem 0.75rem;
        cursor: pointer;
        font-weight: 600;
        width: fit-content;
    }
    button:hover {
        filter: brightness(1.1);
    }
</style>
