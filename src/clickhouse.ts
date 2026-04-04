import { createClient as createClickHouseClient } from '@clickhouse/client';

import type { ClickHouseRow, GameEvent } from './types.js';
import { logger } from './logger.js';

const clickhouseClient = createClickHouseClient({
  url: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
  username: 'default',
  password: '',
  database: 'default',
});

const BATCH_SIZE_THRESHOLD = 5000;
const FLUSH_INTERVAL_MS = 10_000;

let eventBuffer: ClickHouseRow[] = [];
let rawRequestBuffer: { timestamp: number; payload: unknown }[] = [];

async function flushToClickHouse(): Promise<void> {
  if (eventBuffer.length === 0) {
    return;
  }

  const dataToInsert = [...eventBuffer];
  eventBuffer = [];

  try {
    await clickhouseClient.insert({
      table: 'dota_events',
      values: dataToInsert,
      format: 'JSONEachRow',
    });
    logger.info(`Successfully flushed ${dataToInsert.length} rows to ClickHouse.`);
  } catch (error) {
    logger.error({ error }, 'ClickHouse Insert Error');
  }
}

async function flushRawRequests(): Promise<void> {
  if (rawRequestBuffer.length === 0) {
    return;
  }

  const dataToInsert = [...rawRequestBuffer];
  rawRequestBuffer = [];

  try {
    await clickhouseClient.insert({
      table: 'raw_requests',
      values: dataToInsert,
      format: 'JSONEachRow',
    });
    logger.info(`Flushed ${dataToInsert.length} raw requests to ClickHouse.`);
  } catch (error) {
    console.log(error);
    logger.error({ error }, 'ClickHouse raw_requests insert error');
  }
}


export async function logEvent(e: GameEvent): Promise<void> {
  eventBuffer.push({
    account_id: e.context.accountID,
    match_id: e.context.matchID,
    timestamp: e.context.timestamp,
    game_time: e.context.gameTime,
    event_key: e.name,
    event_value: e.value as number,
  });

  if (eventBuffer.length >= BATCH_SIZE_THRESHOLD) {
    await flushToClickHouse();
  }
}

export async function logRawRequest(payload: { previously?: Record<string, unknown> }): Promise<void> {
  const requestKeys = new Set(getDeepKeys(payload.previously));
  const ignoreSet = new Set([
    'map',
    'map.game_time',
    'map.clock_time',
    'player',
    'player.gold',
    'player.gold_reliable',
    'player.gold_unreliable',
    'player.gold_from_income',
    'player.gpm',
    'player.xpm',
    'hero',
    'hero.health',
    'hero.mana',
    'hero.mana_percent',
    'items',
    'items.teleport0',
    'items.teleport0.cooldown',
  ]);
  if (requestKeys.difference(ignoreSet).size === 0) {
    return;
  }

  rawRequestBuffer.push({ timestamp: Date.now(), payload });

  if (rawRequestBuffer.length >= BATCH_SIZE_THRESHOLD) {
    await flushRawRequests();
  }
}

function getDeepKeys(obj: unknown, prefix = ''): string[] {
  return Object.keys(obj as object).reduce((res: string[], el) => {
    const name = prefix ? `${prefix}.${el}` : el;
    if (typeof (obj as Record<string, unknown>)[el] === 'object' && (obj as Record<string, unknown>)[el] !== null && !Array.isArray((obj as Record<string, unknown>)[el])) {
      res.push(name);
      res.push(...getDeepKeys((obj as Record<string, unknown>)[el], name));
    } else {
      res.push(name);
    }
    return res;
  }, []);
}

export function startClickHouse(): void {
  logger.info('ClickHouse client initialized');
  setInterval(flushToClickHouse, FLUSH_INTERVAL_MS);
  setInterval(flushRawRequests, FLUSH_INTERVAL_MS);
}
