<script>
    import Grid from '$lib/components/Grid.svelte';

    let { data } = $props();

    let items = $state([]);
    let total = $state(0);
    let loading = $state(false);
    let sentinel = $state(null);

    // Reset the accumulated list whenever the library (or its first page) changes.
    $effect(() => {
        items = [...data.items];
        total = data.total;
    });

    async function loadMore() {
        if (loading || items.length >= total) return;
        loading = true;
        try {
            const res = await fetch(`/api/library/${data.view.id}?startIndex=${items.length}`);
            if (res.ok) {
                const page = await res.json();
                items = [...items, ...page.items];
                total = page.total;
            }
        } finally {
            loading = false;
        }
    }

    $effect(() => {
        if (!sentinel) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) loadMore();
            },
            { rootMargin: '600px' },
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    });
</script>

<svelte:head>
    <title>{data.view.name}</title>
</svelte:head>

<!-- <h1>{data.view.name}</h1> -->

<Grid {items} />

{#if !items.length && !loading}
    <p class="empty">This library is empty.</p>
{/if}

{#if items.length < total}
    <div
        class="sentinel"
        bind:this={sentinel}
    >
        {loading ? 'Loading…' : ''}
    </div>
{/if}

<style>
    /* h1 {
        font-size: 1.5rem;
        padding: 2rem1rem;
    } */
    .empty {
        color: var(--text-dim);
        text-align: center;
        margin-top: 4rem;
    }
    .sentinel {
        min-height: 3rem;
        display: grid;
        place-items: center;
        color: var(--text-dim);
        margin-top: 1.5rem;
    }
</style>
