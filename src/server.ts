import { watch } from 'fs';
import { readdir } from 'fs/promises';

import { Hono } from 'hono';
import pino from 'pino';

import type { GameEventContext, MappingEntry, Settings } from './types.js';
import { logger, connections } from './discord.js';
import { logEvent, logRawRequest } from './clickhouse.js';

const SOUNDS_DIR = 'sounds/';
const MAX_FILE_SIZE = 10 * 1024 * 1024;

async function getSoundFiles(): Promise<string[]> {
  try {
    const entries = await readdir(SOUNDS_DIR);
    return entries
      .filter(f => f.endsWith('.mp3') && !f.startsWith('.'))
      .toSorted();
  } catch {
    return [];
  }
}

export const loggerServer = pino({
  level: 'debug',
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
});

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
        handleGameEvent(`${prefix}${key}`, body[key] as string | number, context);
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

const handleGameEvent = async (eventName: string, value: string | number, context: GameEventContext): Promise<void> => {
  if (!(eventName === 'map.game_time' || eventName === 'map.clock_time') && typeof value === 'number') {
    logEvent(context.accountID, context.matchID, context.timestamp, context.gameTime, eventName, value);
  }

  if (eventName === 'map.game_state' && value === 'DOTA_GAMERULES_STATE_POST_GAME' && !suppressReport) {
    gameSummary(context.matchID);
  }

  for (const obj of mapping) {
    if (obj.event !== eventName) {
      continue;
    }

    let play = false;
    switch (obj.condition) {
      case '*': {
        play = true;
        break;
      }
      case '>': {
        if (value > obj.value) {
          play = true;
        }
        break;
      }
      case '<': {
        if (value < obj.value) {
          play = true;
        }
        break;
      }
      case '===': {
        if (value === obj.value) {
          play = true;
        }
        break;
      }
      case '!==': {
        if (value !== obj.value) {
          play = true;
        }
        break;
      }
    }
    if (play) {
      logger.debug({ context, obj }, 'triggered mapping');
      for (const conn of Object.values(connections)) {
        conn.playSound(obj.sound);
      }
      break;
    }
  }
};

const configFile = 'mapping.json';
const config = Bun.file(configFile);
let mapping: MappingEntry[] = await config.json();
let suppressReport = false;

watch(configFile, async (event) => {
  if (event === 'change') {
    mapping = await config.json();
    logger.info('reload config file!');
  }
});

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