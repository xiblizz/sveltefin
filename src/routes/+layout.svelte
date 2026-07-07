<script>
    // @ts-ignore
    import '@fontsource/inter';
    import '../app.css';
    import favicon from '$lib/assets/lizard.png';
    import { page } from '$app/state';
    import StreamsWidget from '$lib/components/StreamsWidget.svelte';

    let { children, data } = $props();

    const current = $derived(page.url.pathname);

    function isActive(href) {
        return href === '/' ? current === '/' : current.startsWith(href);
    }
</script>

<svelte:head>
    <link
        rel="icon"
        href={favicon}
    />
</svelte:head>

{#if data.user}
    <header class="topbar">
        <a
            href="/"
            class="brand">{data.appName}</a
        >
        <nav aria-label="Libraries">
            <a
                href="/"
                class:active={isActive('/')}>Home</a
            >
            <a
                href="/watchlist"
                class:active={isActive('/watchlist')}>Watchlist</a
            >
            {#each data.views as view (view.id)}
                <a
                    href="/library/{view.id}"
                    class:active={isActive(`/library/${view.id}`)}>{view.name}</a
                >
            {/each}
            {#if data.seerr}
                <a
                    href="/requests"
                    class:active={isActive('/requests')}>Requests</a
                >
            {/if}
        </nav>
        <form
            class="search"
            action="/search"
            method="GET"
        >
            <input
                type="search"
                name="q"
                placeholder="Search…"
                aria-label="Search movies and shows"
            />
        </form>
        <StreamsWidget />
        <div class="user">
            <span class="username">{data.user.name}</span>
            <form
                method="POST"
                action="/logout"
            >
                <button type="submit">Sign out</button>
            </form>
        </div>
    </header>
{/if}

<main class:full={!data.user}>
    {@render children()}
</main>

<style>
    .topbar {
        position: fixed;
        top: 0;
        z-index: 10;
        width: 100%;
        display: flex;
        align-items: center;
        gap: 1.25rem;
        padding: 0 1.25rem;
        height: 3.5rem;
        background: color-mix(in srgb, var(--surface) 88%, transparent);
        backdrop-filter: blur(8px);
        border-bottom: 1px solid var(--border);
    }
    .brand {
        font-weight: 700;
        font-size: 1.1rem;
        color: var(--accent);
        white-space: nowrap;
    }
    nav {
        display: flex;
        gap: 0.25rem;
        overflow-x: auto;
        scrollbar-width: none;
    }
    nav a {
        padding: 0.35rem 0.75rem;
        border-radius: 8px;
        border: 1px solid transparent;
        color: var(--text-dim);
        white-space: nowrap;
        font-weight: 500;
        transition: all 0.2s ease;
    }
    nav a:hover {
        color: var(--text);
        border: 1px solid var(--border);
        background: var(--surface-hover);
    }
    nav a.active {
        color: var(--text);
        border: 1px solid var(--border);
        background: var(--surface-hover);
    }
    .search {
        margin-left: auto;
    }
    .search input {
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.4rem 0.75rem;
        color: var(--text);
        width: clamp(8rem, 18vw, 16rem);
    }
    .search input:focus {
        outline: 2px solid var(--accent);
        outline-offset: -1px;
    }
    .user {
        display: flex;
        align-items: center;
        gap: 0.75rem;
    }
    .username {
        color: var(--text-dim);
        font-size: 0.9rem;
        white-space: nowrap;
    }
    .user button {
        background: none;
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text-dim);
        padding: 0.35rem 0.75rem;
        cursor: pointer;
        font-size: 0.85rem;
    }
    .user button:hover {
        color: var(--text);
        border-color: var(--text-dim);
    }
    main {
        margin: 0 auto;
        margin-top: 3.5rem;
    }
    main.full {
        padding: 0;
        max-width: none;
    }
    @media (max-width: 40rem) {
        .username {
            display: none;
        }
    }
</style>
