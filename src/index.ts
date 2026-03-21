import { watch } from 'fs';

import { createApp } from './api';
import { connections, createBot } from './bot';
import { logEvent } from './clickhouse';
import { createGsiHandler } from './gsi';
import type { GameEventContext, MappingEntry } from './types';

// ─── Shared mutable state ────────────────────────────────

const configFile = 'mapping.json';
const config = Bun.file(configFile);
let mapping: MappingEntry[] = await config.json();

watch(configFile, async (event) => {
  if (event === 'change') {
    mapping = await config.json();
  }
});

// ─── Boot Discord bot ────────────────────────────────────

const client = await createBot();

// ─── Wire up GSI handler ─────────────────────────────────

const gsi = createGsiHandler({
  getMapping: () => mapping,
  getConnections: () => connections,
  getClient: () => client,
  logEvent,
});

// ─── Create and export Hono app ──────────────────────────

const app = createApp({
  getMapping: () => mapping,
  setMapping: (data) => {
    mapping = data;
  },
  handleGsiPayload: (payload) => {
    if (payload.previously) {
      // biome-ignore lint: GSI payload structure is well-known
      const p = payload as any;
      const ctx: GameEventContext = {
        accountID: p.player.accountid,
        matchID: p.map.matchid,
        gameTime: p.map.game_time,
        timestamp: p.provider.timestamp * 1000,
      };
      gsi.recursiveDiff('', p.previously, p, ctx);
    }
  },
});

export default app;
