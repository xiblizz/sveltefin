<script>
    import SeerrGrid from '$lib/components/SeerrGrid.svelte';

    let { data, form } = $props();

    let results = $state([]);
    let page = $state(1);
    let exhausted = $state(false);
    let loading = $state(false);

    // Reset accumulated trending pages when the underlying data changes (e.g. new search).
    $effect(() => {
        results = [...data.results];
        page = 1;
        exhausted = false;
    });

    async function loadMore() {
        if (loading || exhausted) return;
        loading = true;
        try {
            const res = await fetch(`/api/seerr/discover?page=${page + 1}`);
            if (!res.ok) return;
            const next = await res.json();
            if (!next.results.length) {
                exhausted = true;
                return;
            }
            page += 1;
            const seen = new Set(results.map((r) => r.mediaType + r.tmdbId));
            results = [...results, ...next.results.filter((r) => !seen.has(r.mediaType + r.tmdbId))];
        } finally {
            loading = false;
        }
    }
</script>

<svelte:head>
    <title>Requests</title>
</svelte:head>

<div class="head">
    <h1>{data.query ? `Results for “${data.query}”` : 'Trending'}</h1>
    <form
        method="GET"
        class="seerr-search"
    >
        <input
            type="search"
            name="q"
            placeholder="Search to request…"
            value={data.query}
        />
    </form>
</div>

{#if form?.error}
    <p
        class="error"
        role="alert"
    >
        {form.error}
    </p>
{/if}

<SeerrGrid
    {results}
    {form}
/>

{#if !results.length}
    <p class="empty">Nothing found.</p>
{/if}

{#if !data.query && results.length && !exhausted}
    <div class="more">
        <button
            type="button"
            onclick={loadMore}
            disabled={loading}
        >
            {loading ? 'Loading…' : 'Load more'}
        </button>
    </div>
{/if}

<style>
    .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
    }
    h1 {
        font-size: 1.5rem;
        padding-left: 1rem;
    }
    .seerr-search input {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.5rem 0.75rem;
        margin: 1rem;
        color: var(--text);
        width: clamp(12rem, 30vw, 20rem);
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
    .error {
        color: var(--danger);
    }
    .more {
        display: flex;
        justify-content: center;
        margin-top: 2rem;
    }
    .more button {
        padding: 0.6rem 2rem;
    }
    .more button:disabled {
        opacity: 0.6;
        cursor: default;
    }
    .empty {
        color: var(--text-dim);
        text-align: center;
        margin-top: 4rem;
    }
</style>
