import { readdir } from 'fs/promises';

import { Hono } from 'hono';

import { logEvent, logRawRequest } from './clickhouse.js';
import { connections } from './discord.js';
import { logger } from './logger.js';
import type { GameEvent, GameEventContext, MappingEntry, Settings } from './types.js';

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
      const { client } = await import('./discord.js');
      const channel = await client.channels.fetch(settings.channel);
      if (channel?.isSendable()) {
        channel.send(`https://www.opendota.com/matches/${matchID}`);
        logger.info(`sent match details to channel ${settings.channel}`);
      }

      setTimeout(async () => {
        suppressReport = false;
        const response = await fetch(`http://api.opendota.com/api/request/${matchID}`, {
          method: 'POST',
        });
        logger.info(`opendota parse request for matchID=${matchID} http_status=${response.status}`);
      }, 5000);
    }
  }
};

let suppressEvents: GameEvent[] = [];
const suppressedEvents = new Set<string>();

const isSuppressedEvent = (a: GameEvent, b: GameEvent): Boolean => {
  // this will only compare event name and part of the context
  return (
    a.name === b.name &&
    a.context.accountID === b.context.accountID &&
    a.context.matchID === b.context.matchID &&
    a.context.gameTime === b.context.gameTime
  );
};

const shouldSuppression = (e: GameEvent): Boolean => {
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

const handleGameEvent = async (event: GameEvent): Promise<void> => {
  // check if this event should be suppressed
  if (shouldSuppression(event)) {
    logger.info({ event }, 'suppressing event');
    return;
  }

  logger.debug({ event }, 'handling event');

  if (!(event.name === 'map.game_time' || event.name === 'map.clock_time') && typeof event.value === 'number') {
    logEvent(event);
  }

  if (event.name === 'map.game_state' && event.value === 'DOTA_GAMERULES_STATE_POST_GAME' && !suppressReport) {
    gameSummary(event.context.matchID);
    // lazy - cleanup any leftovers in suppressEvents at match end
    suppressEvents = [];
  }

  for (const obj of mapping) {
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
      case '% === 0': {
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
      for (const conn of Object.values(connections)) {
        conn.playSound(obj.sound);
      }
      break;
    }
  }
};

const configFile = 'mapping.json';
const config = Bun.file(configFile);
let mapping: MappingEntry[];

if (await config.exists()) {
  mapping = await config.json();
} else {
  await Bun.write(configFile, '[]');
  mapping = [];
}
let suppressReport = false;

export const app = new Hono();

app.get('/api/mappings', async (c) => {
  const f = Bun.file('mapping.json');
  const data = await f.json();
  return c.json(data);
});

app.put('/api/mappings', async (c) => {
  const data = (await c.req.json()) as MappingEntry[];
  await Bun.write('mapping.json', JSON.stringify(data, null, 2));
  mapping = data;
  return c.json({ success: true });
});

app.get('/api/sounds', async (c) => {
  const sounds = await getSoundFiles();
  return c.json(sounds);
});

app.get('/api/sounds/:name', async (c) => {
  const name = c.req.param('name');
  const allowed = await getSoundFiles();
  if (!allowed.includes(name)) {
    return c.text('Not found', 404);
  }
  const file = Bun.file(SOUNDS_DIR + name);
  return c.body(file.stream(), {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Disposition': `inline; filename="${name}"`,
    },
  });
});

app.post('/api/sounds', async (c) => {
  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file || !(file instanceof File)) {
    return c.text('No file provided', 400);
  }
  if (!file.name.toLowerCase().endsWith('.mp3')) {
    return c.text('Only MP3 files allowed', 400);
  }
  if (file.size > MAX_FILE_SIZE) {
    return c.text('File too large (max 10MB)', 400);
  }
  const name = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (name.startsWith('.')) {
    return c.text('Hidden files not allowed', 400);
  }
  const dest = Bun.file(SOUNDS_DIR + name);
  await Bun.write(dest, file);
  return c.json({ success: true, name });
});

app.delete('/api/sounds/:name', async (c) => {
  const name = c.req.param('name');
  const allowed = await getSoundFiles();
  if (!allowed.includes(name)) {
    return c.text('Not found', 404);
  }
  const file = Bun.file(SOUNDS_DIR + name);
  await file.delete();
  return c.json({ success: true });
});

app.get('/', async (c) => {
  const file = Bun.file('./public/index.html');
  return c.html(await file.text());
});

app.post('/', async (c) => {
  const payload = await c.req.json();
  if (payload.previously) {
    const ctx: GameEventContext = {
      accountID: payload.player.accountid,
      matchID: payload.map.matchid,
      gameTime: payload.map.game_time,
      timestamp: payload.provider.timestamp * 1000,
    };
    recursiveDiff('', payload.previously, payload, ctx);

    await logRawRequest(payload);
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
