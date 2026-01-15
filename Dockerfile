# Use the official Bun image as the base
FROM oven/bun:1.3.5 AS base
WORKDIR /usr/src/app

# --- New Step: Install ffmpeg ---
# We do this in a separate layer to keep things organized
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*
# -------------------------------

# Install dependencies
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# Copy everything into final image
FROM base AS release
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "index.js" ]
