<script>
    import Card from './Card.svelte';

    let { items = [], watchlistRemove = false } = $props();
</script>

<div class="grid">
    {#each items as item (item.Id)}
        <Card
            {item}
            {watchlistRemove}
        />
    {/each}
</div>

<style>
    .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
        gap: 1rem;
        padding: 2rem 1rem;
    }
    @media (min-width: 60rem) {
        .grid {
            grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr));
        }
    }
</style>
