# AGENTS.md

## Quick reference

```bash
bun install                    # install deps (bun.lock is the lockfile)
bun run dev                    # run locally with .env + file watch
bun run typecheck              # tsc --noEmit
bun run lint                   # oxlint
bun run lint:fix               # oxlint --fix
bun run fmt                    # oxfmt
bun run fmt:check              # oxfmt --check (CI-friendly, no writes)
bun run registerCommands       # register Discord slash commands (needs config.json)
```

No tests exist. `bun run test` exits with error.

## Project structure

Single-package Bun app. No monorepo, no workspaces.

```
src/
  index.ts          # entrypoint — telemetry must be imported first (line 2)
  telemetry.ts      # OTel SDK setup (traces, metrics, logs via OTLP/proto)
  server.ts         # Hono HTTP server — receives DOTA2 GSI payloads, serves Web UI
  discord.ts        # discord.js bot + voice channel audio playback
  clickhouse.ts     # ClickHouse client — event logging + raw request storage
  logger.ts         # pino logger with OTel trace/span injection
  metrics.ts        # custom OTel meters (http, game events, discord, clickhouse)
  types.ts          # shared TypeScript interfaces
commands/           # Discord slash commands (subdirs per command)
public/             # static Web UI (index.html)
utils/              # Python helper scripts (ClickHouse utilities, separate from main app)
registerCommands.ts # standalone script — reads config.json, registers slash commands with Discord API
mapping.json        # event-to-sound mapping config (gitignored, auto-created at runtime)
```

## Architecture

- **Entrypoint**: `src/index.ts` — conditionally starts three subsystems controlled by env vars (`ENABLE_DISCORD`, `ENABLE_CLICKHOUSE`, `ENABLE_SERVER`, all default to `true`)
- **HTTP**: Hono server on port 3000 (configurable via `PORT`). Receives DOTA2 Game State Integration POSTs at `/`, serves static Web UI for mapping editor
- **Discord**: discord.js v14 + @discordjs/voice for audio. Slash commands live in `commands/<name>/<file>.ts`
- **ClickHouse**: Event + raw payload storage. Connection defaults to `http://localhost:8123`
- **OTel**: Full three-signal setup (traces, metrics, logs) via `@opentelemetry/sdk-node`. `telemetry.ts` MUST be imported before any other modules. Deployment environment resolved from `NODE_ENV` (production/staging/development)

## Key conventions

- **Module system**: ESM (`"type": "module"` in package.json). All local imports use `.js` extensions (e.g. `'./logger.js'`) even though source is `.ts` — this is required by Bun's TS resolver with `verbatimModuleSyntax`
- **Formatting**: Single quotes, 120 char print width, trailing commas, semicolons, 2-space indent (see `.oxfmtrc.json`)
- **Linting**: oxlint with typescript/unicorn/import/oxc plugins. Unused vars with `_` prefix are allowed. `public/` and `dist/` are ignored
- **Type imports**: Use `import type` for type-only imports (enforced by lint rule `@typescript-eslint/consistent-type-imports`)
- **Switch cases**: Must use braces (enforced by `unicorn/switch-case-braces`)

## Environment

`.env` is gitignored. Required at runtime via `bun run --env-file=.env`. Key vars:

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | — | Required for Discord bot |
| `ENABLE_DISCORD` | `true` | Set `false` to skip Discord |
| `ENABLE_CLICKHOUSE` | `true` | Set `false` to skip ClickHouse |
| `ENABLE_SERVER` | `true` | Set `false` to skip HTTP server |
| `PORT` | `3000` | HTTP server port |
| `CLICKHOUSE_HOST` | `http://localhost:8123` | ClickHouse URL |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP collector URL |
| `OTEL_LOG_LEVEL` | `none` | SDK diag level (debug/info/warn/error/none) |
| `NODE_ENV` | — | Maps to `deployment.environment.name` (production/test/staging/development) |

## Docker

Dockerfile uses `oven/bun:1.3.5`, installs `ffmpeg` (required for audio), sets `NODE_ENV=production`. Multi-stage build. Exposes port 3000.

## Discord command registration

Requires a `config.json` file (gitignored) with `token`, `clientId`, `guildId`. Run `bun run registerCommands` to push slash commands to Discord.
