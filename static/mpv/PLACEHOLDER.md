# Vendored libmpv-wasm goes here

This directory is served at `/mpv/` and must contain the compiled libmpv-wasm artifacts
(`mpv-player.mjs`, `libmpv.js`, `libmpv.wasm`, `libmpv.data`, worker scripts) for the mpv
direct-play backend to work. They are gitignored (large GPL-3.0 binaries).

Build & copy instructions: `src/lib/player/mpv/README.md` → "Vendoring libmpv-wasm".
