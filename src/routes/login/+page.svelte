<script>
    let { data, form } = $props();
</script>

<svelte:head>
    <title>Login</title>
</svelte:head>

<div class="login-wrap">
    <form
        method="POST"
        class="login-card"
    >
        <h1>{data.appName}</h1>

        {#if form?.error}
            <p
                class="error"
                role="alert"
            >
                {form.error}
            </p>
        {/if}

        <label>
            Username
            <input
                name="username"
                autocomplete="username"
                required
                value={form?.username ?? ''}
            />
        </label>
        <label>
            Password
            <input
                name="password"
                type="password"
                autocomplete="current-password"
            />
        </label>
        <button type="submit">Sign in</button>
    </form>
</div>

<style>
    .login-wrap {
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: 1rem;
    }
    .login-card {
        width: min(24rem, 100%);
        display: flex;
        flex-direction: column;
        gap: 1rem;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 2rem;
    }
    h1 {
        margin: 0;
        font-size: 1.75rem;
        text-align: center;
    }
    label {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        font-size: 0.9rem;
        color: var(--text-dim);
    }
    input {
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.6rem 0.75rem;
        color: var(--text);
        font-size: 1rem;
    }
    input:focus {
        outline: 2px solid var(--accent);
        outline-offset: -1px;
    }
    button {
        background: var(--accent);
        color: #fff;
        border: none;
        border-radius: 8px;
        padding: 0.7rem;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
    }
    button:hover {
        filter: brightness(1.1);
    }
    .error {
        margin: 0;
        color: var(--danger);
        text-align: center;
    }
</style>
