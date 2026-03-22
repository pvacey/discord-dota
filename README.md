# DOTA2 Game State Discord Bot

A Discord bot that integrates with DOTA2 Game State Integration (GSI) to trigger soundboard clips, send post-game match details, and record stats in ClickHouse.

## Features

- **Soundboard Integration** - Play audio clips in Discord Voice channels triggered by in-game events (kills, deaths, kill streaks, etc.)
- **Event Mapping** - Configure which sounds play for which game states via `mapping.json`
- **Post-Game Match Details** - Automatically posts match links to Discord after games end
- **Stats Recording** - Records all game events to ClickHouse for analysis
- **Web UI** - Built-in web interface for editing event-to-sound mappings
- **Voice Channel Sounds** - Plays join/leave sounds for Discord voice channels

## Prerequisites

- [Bun](https://bun.sh/) v1.3.5+
- DOTA2 with Game State Integration enabled
- Discord Bot token
- ClickHouse (embedded, or external)

## Setup

### 1. Install Dependencies

```bash
bun install
```

### 2. Configure Environment

Create a `.env` file:

```env
DISCORD_TOKEN=your-discord-bot-token
```

In order to register Discord slash commands create `config.json`:

```json
{
  "token": "your-discord-bot-token",
  "clientId": "your-application-id",
  "guildId": "your-server-id"
}
```

### 3. Enable DOTA2 Game State Integration

Create `gameintegration.cfg` in `Steam/steamapps/common/dota 2 beta/game/dota/cfg/`:

```
"dota2-gsi Configuration"
{
    "uri"               "http://localhost:3000"
    "timeout"           "5.0"
    "buffer"            "0.5"
    "throttle"          "0.5"
    "heartbeat"         "30.0"
    "data"
    {
        "buildings"     "1"
        "provider"      "1"
        "map"           "1"
        "player"        "1"
        "hero"          "1"
        "abilities"     "1"
        "items"         "1"
        "draft"         "1"
        "wearables"     "1"
    }
}
```

### 4. Register Discord Commands

```bash
bun run registerCommands
```

### 5. Run the Bot

```bash
bun run dev
```

## Configuration

### Event-to-Sound Mappings (`mapping.json`)

```json
[
  {
    "event": "player.deaths",
    "sound": "https://example.com/fail.mp3",
    "condition": ">",
    "value": 0
  },
  {
    "event": "player.kills",
    "sound": "https://example.com/kill.mp3",
    "condition": "===",
    "value": 10
  }
]
```

**Supported Conditions:**
- `===` - Equal to
- `!==` - Not equal to
- `>` - Greater than
- `<` - Less than
- `*` - Wildcard (always triggers)

**Available Events:**
| Category | Events |
|----------|--------|
| Map | `map.game_state`, `map.match_id`, `map.clock_time`, `map.radiant_score`, `map.dire_score` |
| Player | `player.kills`, `player.deaths`, `player.assists`, `player.gold`, `player.gpm`, `player.xpm` |
| Hero | `hero.health`, `hero.max_health`, `hero.mana`, `hero.max_mana`, `hero.level` |
| Abilities | `abilities.*` (slot, level, cooldown) |
| Items | `items.*` (slot, name) |

### ClickHouse Schema

Events are recorded in the `dota_events` table:

```sql
CREATE TABLE dota_events (
    account_id UInt64,
    match_id UInt64,
    timestamp DateTime64(3),
    game_time UInt64,
    event_key String,
    event_value Float64,
    workflow_triggered UInt8 DEFAULT 0
)
ENGINE = ReplacingMergeTree()
ORDER BY (account_id, match_id, timestamp, game_time, event_key, event_value);
```

Raw GSI payloads are stored in the `raw_requests` table for debugging and advanced analysis:

```sql
CREATE TABLE raw_requests (
    timestamp DateTime64(3),
    payload JSON
)
ENGINE = MergeTree()
ORDER BY timestamp;
```

## Commands

| Command | Description |
|---------|-------------|
| `/set-game-summary-channel` | Set the Discord channel for post-game match links |

## Web UI

Access the built-in mapping editor at `http://localhost:3000/` to visually manage event-to-sound mappings.

## Scripts

```bash
bun run dev          # Run with .env file
bun run typecheck    # TypeScript type checking
bun run lint         # Lint code
bun run lint:fix     # Fix linting issues
bun run fmt          # Format code
```

## Architecture

- **Hono** - HTTP server for receiving DOTA2 GSI payloads
- **discord.js** - Discord API integration
- **@discordjs/voice** - Audio playback
- **ClickHouse** - Event storage and analytics
- **Pino** - Structured logging
