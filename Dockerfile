# Use the official Bun image — latest 1.x for security patches
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# Install dependencies (production only)
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile --production

# Build the final image
FROM base AS release

# Install runtime system dependencies (cache mount preserves .deb across builds)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Copy production node_modules
COPY --link --from=install /temp/dev/node_modules node_modules

# Copy source files
COPY --link src/ commands/ utils/ public/ ./

# Ensure the non-root bun user can write to the app directory
RUN chown -R bun:bun /usr/src/app

USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "src/index.ts" ]