<script>
    import Card from './Card.svelte';

    let { title, items = [], wide = false, removeResume = false, removeNextUp = false } = $props();
</script>

{#if items.length}
    <section class="rowSection">
        <h2>{title}</h2>
        <div
            class="row"
            class:wide
        >
            {#each items as item (item.Id)}
                <Card
                    {item}
                    {wide}
                    {removeResume}
                    {removeNextUp}
                />
            {/each}
        </div>
    </section>
{/if}

<style>
    section {
        padding: 1rem;
    }
    h2 {
        font-size: 1.15rem;
        margin: 0 0 0.75rem;
    }
    .row {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: clamp(8rem, 12vw, 11rem);
        gap: 0.9rem;
        overflow-x: auto;
        padding: 0 2%;
        padding-bottom: 0.5rem;
        /* scrollbar-width: thin; */
        mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%);
        -webkit-mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%);
    }
    .row.wide {
        grid-auto-columns: clamp(14rem, 20vw, 19rem);
    }
</style>
