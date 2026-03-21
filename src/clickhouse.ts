import { createClient as createClickHouseClient } from '@clickhouse/client';
import { logger } from './logger';
import type { ClickHouseRow } from './types';

const BATCH_SIZE_THRESHOLD = 5000;
const FLUSH_INTERVAL_MS = 10_000; // 10 seconds

let eventBuffer: ClickHouseRow[] = [];

const clickhouseClient = createClickHouseClient({
  url: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
  username: 'default',
  password: '',
  database: 'default',
});

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

setInterval(flushToClickHouse, FLUSH_INTERVAL_MS);

export async function logEvent(
  accountID: number,
  matchID: number,
  timestamp: number,
  gameTime: number,
  key: string,
  value: number,
): Promise<void> {
  eventBuffer.push({
    account_id: accountID,
    match_id: matchID,
    timestamp: timestamp,
    game_time: gameTime,
    event_key: key,
    event_value: value,
  });

  if (eventBuffer.length >= BATCH_SIZE_THRESHOLD) {
    await flushToClickHouse();
  }
}
