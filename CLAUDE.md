# SvelteFin — notes for Claude

Secure SvelteKit + Bun web client for Jellyfin (movies/shows only). Jellyfin is private;
this app is the only exposed surface and proxies everything server-side.

**Read `docs/` before making changes** — it captures decisions and gotchas:

- `docs/architecture.md` — trust boundary, encrypted cookie sessions, media proxy rules
- `docs/jellyfin-api.md` — endpoints used + Jellyfin 12 spec gotchas (no DynamicHls paths!)
- `docs/playback.md` — playback negotiation, libmpv-wasm verdict (rejected for now)
- `docs/seerr.md` — Requests tab integration
- `docs/roadmap.md` — done / next up / conventions

Hard rules:

- Plain JavaScript only (JSDoc for types). No TypeScript files, no Tailwind.
- No new dependencies without strong justification; record any addition in docs/roadmap.md.
- Browser code must never receive a Jellyfin token or URL — all upstream traffic goes
  through `src/lib/server/` and the whitelisted `/api/media/` proxy.
- The Jellyfin OpenAPI spec is `jellyfin-openapi-stable.json` (v12.0.0) in the repo root;
  verify endpoints against it with jq before using them.
- Commands: `bun run dev`, `bun run check`, `bun run build`.
