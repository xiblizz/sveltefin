<script>
    import Grid from '$lib/components/Grid.svelte';
    import SeerrGrid from '$lib/components/SeerrGrid.svelte';

    let { data, form } = $props();
</script>

<svelte:head>
    <title>Search</title>
</svelte:head>

{#if data.query}
    <h1>Results for “{data.query}”</h1>
    {#if data.items.length}
        <Grid items={data.items} />
    {:else}
        <p class="empty">No movies or shows found.</p>
    {/if}
    {#if data.seerr.length}
        <h2>Not in the library? Request it</h2>
        {#if form?.error}
            <p
                class="error"
                role="alert"
            >
                {form.error}
            </p>
        {/if}
        <SeerrGrid
            results={data.seerr}
            {form}
        />
    {/if}
{:else}
    <p class="empty">Type something in the search box above.</p>
{/if}

<style>
    h1 {
        font-size: 1.5rem;
        padding: 1rem;
    }
    h2 {
        font-size: 1.15rem;
        padding: 1rem;
        color: var(--text-dim);
    }
    .empty {
        color: var(--text-dim);
        text-align: center;
        padding: 1rem;
    }
    .error {
        color: var(--danger);
        padding: 1rem;
    }
</style>
