import { readdir } from 'fs/promises';

import { trace, SpanStatusCode } from '@opentelemetry/api';
import { Hono } from 'hono';

import { logEvent, logRawRequest } from './clickhouse.js';
import { connections } from './discord.js';
import logger from './logger.js';
import { httpRequestsTotal, httpRequestDuration, gameEventsTotal, soundsPlayedTotal } from './metrics.js';
import type { GameEvent, GameEventContext, MappingEntry, Settings } from './types.js';

const tracer = trace.getTracer('discord-dota', '1.0.0');

const SOUNDS_DIR = 'sounds/';
const MAX_FILE_SIZE = 10 * 1024 * 1024;

async function getSoundFiles(): Promise<string[]> {
  try {
    const entries = await readdir(SOUNDS_DIR);
    return entries.filter((f) => f.endsWith('.mp3') && !f.startsWith('.')).toSorted();
  } catch {
    return [];
  }
}

const recursiveDiff = (
  prefix: string,
  changed: Record<string, unknown>,
  body: Record<string, unknown>,
  context: GameEventContext,
): void => {
  tracer.startActiveSpan('game.event.diff', (span) => {
    span.setAttribute('diff.prefix', prefix);
    span.setAttribute('diff.keys_count', Object.keys(changed).length);
    try {
      for (const key of Object.keys(changed)) {
        if (typeof changed[key] === 'object' && changed[key] !== null) {
          if (body[key] != null) {
            recursiveDiff(
              `${prefix}${key}.`,
              changed[key] as Record<string, unknown>,
              body[key] as Record<string, unknown>,
              context,
            );
          }
        } else {
          if (body[key] != null) {
            handleGameEvent({
              name: `${prefix}${key}`,
              value: body[key] as string | number,
              context: context,
            });
          }
        }
      }
    } finally {
      span.end();
    }
  });
};

const gameSummary = async (matchID: number): Promise<void> => {
  suppressReport = true;
  setTimeout(() => {
    suppressReport = false;
  }, 5000);

  const f = Bun.file('settings.json');
  if (await f.exists()) {
    const settings = (await f.json()) as Settings;
    if (settings.channel) {
      const channelId = settings.channel;
      const { client } = await import('./discord.js');
      await tracer.startActiveSpan('game.summary.discord.send', async (discordSpan) => {
        discordSpan.setAttribute('channel.id', channelId);
        discordSpan.setAttribute('match_id', matchID);
        try {
          const channel = await client.channels.fetch(channelId);
          if (channel?.isSendable()) {
            await channel.send(`https://www.opendota.com/matches/${matchID}`);
            logger.info(`sent match details to channel ${channelId}`);
          }
        } catch (error) {
          discordSpan.setStatus({ code: SpanStatusCode.ERROR });
          discordSpan.recordException(error as Error);
          throw error;
        } finally {
          discordSpan.end();
        }
      });

      setTimeout(async () => {
        suppressReport = false;
        await tracer.startActiveSpan('game.summary.opendota.request', async (opendotaSpan) => {
          opendotaSpan.setAttribute('match_id', matchID);
          try {
            const response = await fetch(`http://api.opendota.com/api/request/${matchID}`, {
              method: 'POST',
            });
            opendotaSpan.setAttribute('http.status_code', response.status);
            if (response.status >= 400) {
              opendotaSpan.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
            }
            logger.info(`opendota parse request for matchID=${matchID} http_status=${response.status}`);
          } catch (error) {
            opendotaSpan.setStatus({ code: SpanStatusCode.ERROR });
            opendotaSpan.recordException(error as Error);
            throw error;
          } finally {
            opendotaSpan.end();
          }
        });
      }, 5000);
    }
  }
};

let suppressEvents: GameEvent[] = [];
const suppressedEvents = new Set<string>();

// this will only compare event name and part of the context
const isSuppressedEvent = (a: GameEvent, b: GameEvent): boolean =>
  a.name === b.name &&
  a.context.accountID === b.context.accountID &&
  a.context.matchID === b.context.matchID &&
  a.context.gameTime === b.context.gameTime;

const shouldSuppression = (e: GameEvent): boolean => {
  // checks all of the suppressEvents for a match
  for (const [idx, s] of suppressEvents.entries()) {
    if (isSuppressedEvent(e, s)) {
      // drop this element from the array stop looping
      suppressEvents.splice(idx, 1);
      return true;
    }
  }
  return false;
};

const playSoundForAll = (sound: string): void => {
  tracer.startActiveSpan('sound.broadcast', (span) => {
    span.setAttribute('sound.name', sound);
    span.setAttribute('connections.count', Object.keys(connections).length);
    try {
      for (const conn of Object.values(connections)) {
        conn.playSound(sound);
        soundsPlayedTotal.add(1, { sound });
      }
    } finally {
      span.end();
    }
  });
};

const handleGameEvent = async (event: GameEvent): Promise<void> =>
  tracer.startActiveSpan('game.event.handle', async (span) => {
    span.setAttribute('event.name', event.name);
    span.setAttribute('event.value', String(event.value));
    span.setAttribute('event.context.account_id', event.context.accountID);
    span.setAttribute('event.context.match_id', event.context.matchID);

    gameEventsTotal.add(1, { event: event.name });

    try {
      // check if this event should be suppressed
      const suppressed = tracer.startActiveSpan('game.event.suppress.check', (suppressSpan) => {
        const result = shouldSuppression(event);
        suppressSpan.setAttribute('suppressed', result);
        suppressSpan.end();
        return result;
      });
      if (suppressed) {
        logger.info({ event }, 'suppressing event');
        span.addEvent('event.suppressed');
        return;
      }

      logger.debug({ event }, 'handling event');

      if (!(event.name === 'map.game_time' || event.name === 'map.clock_time') && typeof event.value === 'number') {
        tracer.startActiveSpan('game.event.log', (logSpan) => {
          logSpan.setAttribute('event.name', event.name);
          logEvent(event);
          logSpan.end();
        });
      }

      if (event.name === 'map.game_state' && event.value === 'DOTA_GAMERULES_STATE_POST_GAME' && !suppressReport) {
        tracer.startActiveSpan('game.event.summary', (summarySpan) => {
          summarySpan.setAttribute('match_id', event.context.matchID);
          gameSummary(event.context.matchID);
          summarySpan.end();
        });
        // lazy - cleanup any leftovers in suppressEvents at match end
        suppressEvents = [];
      }

      let matchedIndex = -1;
      tracer.startActiveSpan('game.event.mapping.evaluate', (mappingSpan) => {
        mappingSpan.setAttribute('mapping.entries_count', mapping.length);
        mappingSpan.setAttribute('event.name', event.name);
        try {
          for (const [idx, obj] of mapping.entries()) {
            if (obj.event !== event.name) {
              continue;
            }

            let play = false;
            switch (obj.condition) {
              case '*': {
                play = true;
                break;
              }
              case '>': {
                if (event.value > obj.value) {
                  play = true;
                }
                break;
              }
              case '<': {
                if (event.value < obj.value) {
                  play = true;
                }
                break;
              }
              case '===': {
                if (event.value === obj.value) {
                  play = true;
                }
                break;
              }
              case '!==': {
                if (event.value !== obj.value) {
                  play = true;
                }
                break;
              }
              case '%': {
                if (typeof event.value === 'number' && typeof obj.value === 'number') {
                  if (event.value % obj.value === 0) {
                    play = true;
                  }
                }
                break;
              }
            }
            if (play) {
              if (obj.suppress) {
                if (suppressedEvents.has(event.name)) {
                  logger.info({ event, obj }, 'supressing event');
                  continue;
                }
                suppressedEvents.add(event.name);
                setTimeout(() => suppressedEvents.delete(event.name), 5000);
              }
              // player.kills and player.kill_streak will always be seen together in the same payload
              // if you get an event for player.kill_streak, suppress the player.kills with the matching context
              // be careful reusing this pattern for other events there is nothing purging stale events in the suppressEvents array
              if (event.name === 'player.kill_streak') {
                suppressEvents.push({
                  name: 'player.kills',
                  value: 0, //value is required for the GameEvent type at the moment but not checked in the suppression logic
                  context: event.context,
                });
              }
              logger.info({ event, obj }, 'triggered mapping');
              matchedIndex = idx;
              span.addEvent('sound.triggered', { sound: obj.sound });
              tracer.startActiveSpan('game.event.sound.play', (soundSpan) => {
                soundSpan.setAttribute('sound.name', obj.sound);
                soundSpan.setAttribute('connections.count', Object.keys(connections).length);
                try {
                  playSoundForAll(obj.sound);
                } finally {
                  soundSpan.end();
                }
              });
              break;
            }
          }
        } finally {
          mappingSpan.setAttribute('mapping.matched', matchedIndex >= 0);
          mappingSpan.setAttribute('mapping.matched_index', matchedIndex);
          mappingSpan.end();
        }
      });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  });

const configFile = 'mapping.json';
const config = Bun.file(configFile);
let mapping: MappingEntry[] = [];

if (await config.exists()) {
  mapping = await config.json();
} else {
  await Bun.write(configFile, '[]');
  mapping = [];
}
let suppressReport = false;

export const app = new Hono();

app.use('*', async (c, next) => {
  const start = performance.now();
  const { method, path: route } = c.req;

  httpRequestsTotal.add(1, { method, route });

  return tracer.startActiveSpan(`${method} ${route}`, async (span) => {
    span.setAttribute('http.method', method);
    span.setAttribute('http.route', route);

    try {
      await next();
      span.setAttribute('http.status_code', c.res.status);
      if (c.res.status >= 400) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${c.res.status}` });
      }
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error as Error);
      throw error;
    } finally {
      const duration = performance.now() - start;
      httpRequestDuration.record(duration, { method, route, status: String(c.res.status) });
      span.end();
    }
  });
});

app.get('/api/mappings', async (c) =>
  tracer.startActiveSpan('api.mappings.read', async (span) => {
    try {
      const f = Bun.file('mapping.json');
      const data = await f.json();
      span.setAttribute('file', 'mapping.json');
      return c.json(data);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }),
);

app.put('/api/mappings', async (c) =>
  tracer.startActiveSpan('api.mappings.write', async (span) => {
    try {
      const data = (await c.req.json()) as MappingEntry[];
      await Bun.write('mapping.json', JSON.stringify(data, null, 2));
      mapping = data;
      span.setAttribute('mappings.count', data.length);
      return c.json({ success: true });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }),
);

app.get('/api/sounds', async (c) =>
  tracer.startActiveSpan('api.sounds.list', async (span) => {
    try {
      const sounds = await getSoundFiles();
      span.setAttribute('sounds.count', sounds.length);
      return c.json(sounds);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }),
);

app.get('/api/sounds/:name', async (c) =>
  tracer.startActiveSpan('api.sound.serve', async (span) => {
    const name = c.req.param('name');
    span.setAttribute('sound.name', name);
    try {
      const allowed = await getSoundFiles();
      if (!allowed.includes(name)) {
        span.setAttribute('sound.found', false);
        return c.text('Not found', 404);
      }
      span.setAttribute('sound.found', true);
      const file = Bun.file(SOUNDS_DIR + name);
      return c.body(file.stream(), {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Disposition': `inline; filename="${name}"`,
        },
      });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }),
);

app.post('/api/sounds/:name/play', async (c) =>
  tracer.startActiveSpan('api.sound.play', async (span) => {
    const name = c.req.param('name');
    span.setAttribute('sound.name', name);
    try {
      const allowed = await getSoundFiles();
      if (!allowed.includes(name)) {
        span.setAttribute('sound.found', false);
        return c.text('Sound not found', 404);
      }
      span.setAttribute('sound.found', true);
      playSoundForAll(name);
      return c.json({ success: true });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }),
);

app.post('/api/sounds', async (c) =>
  tracer.startActiveSpan('api.sound.upload', async (span) => {
    try {
      const formData = await c.req.formData();
      const file = formData.get('file') as File | null;
      if (!file || !(file instanceof File)) {
        span.setAttribute('upload.rejected', 'no_file');
        return c.text('No file provided', 400);
      }
      if (!file.name.toLowerCase().endsWith('.mp3')) {
        span.setAttribute('upload.rejected', 'invalid_type');
        return c.text('Only MP3 files allowed', 400);
      }
      if (file.size > MAX_FILE_SIZE) {
        span.setAttribute('upload.rejected', 'too_large');
        return c.text('File too large (max 10MB)', 400);
      }
      const name = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      if (name.startsWith('.')) {
        span.setAttribute('upload.rejected', 'hidden_file');
        return c.text('Hidden files not allowed', 400);
      }
      span.setAttribute('sound.name', name);
      span.setAttribute('file.size', file.size);
      const dest = Bun.file(SOUNDS_DIR + name);
      await Bun.write(dest, file);
      return c.json({ success: true, name });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }),
);

app.delete('/api/sounds/:name', async (c) =>
  tracer.startActiveSpan('api.sound.delete', async (span) => {
    const name = c.req.param('name');
    span.setAttribute('sound.name', name);
    try {
      const allowed = await getSoundFiles();
      if (!allowed.includes(name)) {
        span.setAttribute('sound.found', false);
        return c.text('Not found', 404);
      }
      span.setAttribute('sound.found', true);
      const file = Bun.file(SOUNDS_DIR + name);
      await file.delete();
      return c.json({ success: true });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }),
);

app.get('/', async (c) => {
  const file = Bun.file('./public/index.html');
  return c.html(await file.text());
});

app.post('/', async (c) => {
  const payload = await c.req.json();
  if (payload.previously) {
    const ctx: GameEventContext = await tracer.startActiveSpan('webhook.payload.parse', (span) => {
      const context: GameEventContext = {
        accountID: payload.player.accountid,
        matchID: payload.map.matchid,
        gameTime: payload.map.game_time,
        timestamp: payload.provider.timestamp * 1000,
      };
      span.setAttribute('account_id', context.accountID);
      span.setAttribute('match_id', context.matchID);
      span.setAttribute('game_time', context.gameTime);
      span.setAttribute('diff.keys_count', Object.keys(payload.previously).length);
      span.end();
      return context;
    });

    tracer.startActiveSpan('webhook.diff.process', (diffSpan) => {
      diffSpan.setAttribute('diff.top_level_keys', Object.keys(payload.previously).length);
      try {
        recursiveDiff('', payload.previously, payload, ctx);
      } finally {
        diffSpan.end();
      }
    });

    tracer.startActiveSpan('webhook.request.log', async (logSpan) => {
      try {
        await logRawRequest(payload);
      } finally {
        logSpan.end();
      }
    });
  }
  return c.text('OK', 200);
});

export function startServer(port = 3000): void {
  logger.info(`Hono server starting on port ${port}`);
  Bun.serve({
    fetch: app.fetch,
    port,
  });
}
