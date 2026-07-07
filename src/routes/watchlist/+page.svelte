<script>
    import Grid from '$lib/components/Grid.svelte';

    let { data } = $props();
</script>

<svelte:head>
    <title>Watchlist</title>
</svelte:head>

<Grid
    items={data.items}
    watchlistRemove
/>

{#if !data.items.length}
    <p class="empty">
        Your watchlist is empty. Use the + button on any movie or show to add it — it is stored as a Jellyfin favorite,
        so it stays in sync with other clients.
    </p>
{/if}

<style>
    .empty {
        color: var(--text-dim);
        text-align: center;
        margin-top: 4rem;
    }
</style>
