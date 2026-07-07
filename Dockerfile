# SvelteFin — build + runtime image (run behind the bundled nginx, see
# docker-compose.yml: nginx owns the COOP/COEP headers the mpv backend needs).
#
# The vendored libmpv-wasm build (static/mpv/, gitignored) must exist in the
# build context — vite copies it into build/client/mpv at build time.

FROM oven/bun:1-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production
# adapter-node externalizes package.json "dependencies" instead of bundling
# them, so the runtime image needs a production install.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/build ./build
EXPOSE 3000
CMD ["bun", "build/index.js"]
