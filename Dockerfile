# Use the official Bun image as the base
FROM oven/bun:1.1 AS base
WORKDIR /usr/src/app

# Install dependencies into a temporary folder to cache them
# This speeds up future builds if your package.json hasn't changed
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# Copy dependencies and source code into the final image
FROM base AS release
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# Run the application
USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "index.js" ]
