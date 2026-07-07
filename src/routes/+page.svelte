<script>
    import Row from '$lib/components/Row.svelte';

    let { data } = $props();
</script>

<svelte:head>
    <title>Home</title>
</svelte:head>

<Row
    title="Continue Watching"
    items={data.resume}
    wide
    removeResume
/>
<Row
    title="Next Up"
    items={data.nextUp}
    wide
    removeNextUp
/>
<Row
    title="Requested by me"
    items={data.requested}
/>

{#each data.latest as section (section.view.id)}
    <Row
        title="Latest in {section.view.name}"
        items={section.items}
    />
{/each}

{#if !data.resume.length && !data.nextUp.length && !data.requested.length && data.latest.every((s) => !s.items.length)}
    <p class="empty">Nothing here yet. Check that your Jellyfin libraries contain movies or shows.</p>
{/if}

<style>
    .empty {
        color: var(--text-dim);
        text-align: center;
        margin-top: 4rem;
    }
</style>
