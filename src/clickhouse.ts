import { createClient as createClickHouseClient } from '@clickhouse/client';
import { trace, SpanStatusCode } from '@opentelemetry/api';

import logger from './logger.js';
import { clickhouseRowsFlushed } from './metrics.js';
import type { ClickHouseRow, GameEvent } from './types.js';

const tracer = trace.getTracer('discord-dota', '1.0.0');

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

  const dataToInsert = tracer.startActiveSpan('clickhouse.event.buffer.snapshot', (snapshotSpan) => {
    const snapshot = [...eventBuffer];
    eventBuffer = [];
    snapshotSpan.setAttribute('buffer.snapshot_size', snapshot.length);
    snapshotSpan.end();
    return snapshot;
  });

  return tracer.startActiveSpan('clickhouse.insert.events', async (span) => {
    span.setAttribute('db.system', 'clickhouse');
    span.setAttribute('db.operation', 'insert');
    span.setAttribute('db.table', 'dota_events');
    span.setAttribute('db.rows_affected', dataToInsert.length);

    try {
      await tracer.startActiveSpan('clickhouse.event.insert', async (insertSpan) => {
        insertSpan.setAttribute('db.system', 'clickhouse');
        insertSpan.setAttribute('db.table', 'dota_events');
        insertSpan.setAttribute('db.rows_affected', dataToInsert.length);
        try {
          await clickhouseClient.insert({
            table: 'dota_events',
            values: dataToInsert,
            format: 'JSONEachRow',
          });
          insertSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          insertSpan.setStatus({ code: SpanStatusCode.ERROR });
          insertSpan.recordException(error as Error);
          throw error;
        } finally {
          insertSpan.end();
        }
      });
      logger.info(`Successfully flushed ${dataToInsert.length} rows to ClickHouse.`);
      clickhouseRowsFlushed.add(dataToInsert.length, { table: 'dota_events' });
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      logger.error({ error }, 'ClickHouse Insert Error');
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error as Error);
    } finally {
      span.end();
    }
  });
}

async function flushRawRequests(): Promise<void> {
  if (rawRequestBuffer.length === 0) {
    return;
  }

  const dataToInsert = tracer.startActiveSpan('clickhouse.raw_request.buffer.snapshot', (snapshotSpan) => {
    const snapshot = [...rawRequestBuffer];
    rawRequestBuffer = [];
    snapshotSpan.setAttribute('buffer.snapshot_size', snapshot.length);
    snapshotSpan.end();
    return snapshot;
  });

  return tracer.startActiveSpan('clickhouse.insert.raw_requests', async (span) => {
    span.setAttribute('db.system', 'clickhouse');
    span.setAttribute('db.operation', 'insert');
    span.setAttribute('db.table', 'raw_requests');
    span.setAttribute('db.rows_affected', dataToInsert.length);

    try {
      await tracer.startActiveSpan('clickhouse.raw_request.insert', async (insertSpan) => {
        insertSpan.setAttribute('db.system', 'clickhouse');
        insertSpan.setAttribute('db.table', 'raw_requests');
        insertSpan.setAttribute('db.rows_affected', dataToInsert.length);
        try {
          await clickhouseClient.insert({
            table: 'raw_requests',
            values: dataToInsert,
            format: 'JSONEachRow',
          });
          insertSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          insertSpan.setStatus({ code: SpanStatusCode.ERROR });
          insertSpan.recordException(error as Error);
          throw error;
        } finally {
          insertSpan.end();
        }
      });
      logger.info(`Flushed ${dataToInsert.length} raw requests to ClickHouse.`);
      clickhouseRowsFlushed.add(dataToInsert.length, { table: 'raw_requests' });
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      logger.error({ error }, 'ClickHouse raw_requests insert error');
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error as Error);
    } finally {
      span.end();
    }
  });
}

export async function logEvent(e: GameEvent): Promise<void> {
  return tracer.startActiveSpan('clickhouse.event.buffer', async (span) => {
    span.setAttribute('event.name', e.name);
    span.setAttribute('event.key', e.context.accountID);
    try {
      eventBuffer.push({
        account_id: e.context.accountID,
        match_id: e.context.matchID,
        timestamp: e.context.timestamp,
        game_time: e.context.gameTime,
        event_key: e.name,
        event_value: e.value as number,
      });
      span.setAttribute('buffer.size', eventBuffer.length);

      if (eventBuffer.length >= BATCH_SIZE_THRESHOLD) {
        span.setAttribute('buffer.flush_triggered', true);
        await flushToClickHouse();
      } else {
        span.setAttribute('buffer.flush_triggered', false);
      }
    } finally {
      span.end();
    }
  });
}

export async function logRawRequest(payload: { previously?: Record<string, unknown> }): Promise<void> {
  return tracer.startActiveSpan('clickhouse.raw_request.buffer', async (span) => {
    try {
      const requestKeys = tracer.startActiveSpan('clickhouse.raw_request.keys', (keysSpan) => {
        const keys = new Set(getDeepKeys(payload.previously));
        keysSpan.setAttribute('keys.count', keys.size);
        keysSpan.end();
        return keys;
      });

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
        span.setAttribute('request.filtered', true);
        return;
      }
      span.setAttribute('request.filtered', false);
      span.setAttribute('request.keys_count', requestKeys.size);

      rawRequestBuffer.push({ timestamp: Date.now(), payload });
      span.setAttribute('buffer.size', rawRequestBuffer.length);

      if (rawRequestBuffer.length >= BATCH_SIZE_THRESHOLD) {
        span.setAttribute('buffer.flush_triggered', true);
        await flushRawRequests();
      } else {
        span.setAttribute('buffer.flush_triggered', false);
      }
    } finally {
      span.end();
    }
  });
}

function getDeepKeys(obj: unknown, prefix = ''): string[] {
  return Object.keys(obj as object).reduce((res: string[], el) => {
    const name = prefix ? `${prefix}.${el}` : el;
    if (
      typeof (obj as Record<string, unknown>)[el] === 'object' &&
      (obj as Record<string, unknown>)[el] !== null &&
      !Array.isArray((obj as Record<string, unknown>)[el])
    ) {
      res.push(name);
      res.push(...getDeepKeys((obj as Record<string, unknown>)[el], name));
    } else {
      res.push(name);
    }
    return res;
  }, []);
}

export function startClickHouse(): void {
  tracer.startActiveSpan('clickhouse.init', (span) => {
    span.setAttribute('db.system', 'clickhouse');
    span.setAttribute('clickhouse.batch_size', BATCH_SIZE_THRESHOLD);
    span.setAttribute('clickhouse.flush_interval_ms', FLUSH_INTERVAL_MS);
    logger.info('ClickHouse client initialized');
    setInterval(flushToClickHouse, FLUSH_INTERVAL_MS);
    setInterval(flushRawRequests, FLUSH_INTERVAL_MS);
    span.end();
  });
}
