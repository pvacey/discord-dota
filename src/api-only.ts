import { watch } from 'fs';

import { createApp } from './api';
import { logger } from './logger';
import type { MappingEntry } from './types';

// ─── Shared mutable state ────────────────────────────────

const configFile = 'mapping.json';
const config = Bun.file(configFile);
let mapping: MappingEntry[] = await config.json();

watch(configFile, async (event) => {
  if (event === 'change') {
    mapping = await config.json();
    logger.info('reload config file!');
  }
});

// ─── API-only app (no Discord bot, no ClickHouse) ────────

const app = createApp({
  getMapping: () => mapping,
  setMapping: (data) => {
    mapping = data;
  },
  handleGsiPayload: (payload) => {
    logger.info({ payload }, 'GSI payload received (stub - bot not running)');
  },
});

logger.info('API-only mode: Discord bot and ClickHouse are not connected');

export default app;
