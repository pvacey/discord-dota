import { logEvent } from '@/clickhouse.js';
import logger from '@/logger.js';
import { playSoundForAll } from '@/sounds.js';
import type { GameEvent, GameEventContext, MappingConfig, Settings } from '@/types.js';

const configFile = 'mapping.json';
const config = Bun.file(configFile);
let mapping: MappingConfig = { dota: {}, discord: { userSounds: {} } };

if (await config.exists()) {
  mapping = await config.json();
} else {
  await Bun.write(configFile, JSON.stringify({ dota: {}, discord: { userSounds: {} } }, null, 2));
  mapping = { dota: {}, discord: { userSounds: {} } };
}

let suppressReport = false;

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
      const channelId = settings.channel;
      const { client } = await import('@/discord.js');
      const channel = await client.channels.fetch(channelId);
      if (channel?.isSendable()) {
        await channel.send(`https://www.opendota.com/matches/${matchID}`);
        logger.info(`sent match details to channel ${channelId}`);
      }

      setTimeout(async () => {
        suppressReport = false;
        let response = await fetch(`http://api.opendota.com/api/request/${matchID}`, {
          method: 'POST',
        });
        logger.info(`opendota parse request for matchID=${matchID} http_status=${response.status}`);
        response = await fetch('https://fortune.explosivejuice.com/dota/match-result', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            match_id: matchID
          })
        });
        logger.info(`sent receipt print request for matchID=${matchID} http_status=${response.status}`);
      }, 5000);
    }
  }
};

let suppressEvents: GameEvent[] = [];
const suppressedEvents = new Set<string>();

const isSuppressedEvent = (a: GameEvent, b: GameEvent): boolean =>
  a.name === b.name &&
  a.context.accountID === b.context.accountID &&
  a.context.matchID === b.context.matchID &&
  a.context.gameTime === b.context.gameTime;

const shouldSuppression = (e: GameEvent): boolean => {
  for (const [idx, s] of suppressEvents.entries()) {
    if (isSuppressedEvent(e, s)) {
      suppressEvents.splice(idx, 1);
      return true;
    }
  }
  return false;
};

const handleGameEvent = async (event: GameEvent): Promise<void> => {
  const suppressed = shouldSuppression(event);
  if (suppressed) {
    logger.info({ event }, 'suppressing event');
    return;
  }

  logger.debug({ event }, 'handling event');

  if (!(event.name === 'map.game_time' || event.name === 'map.clock_time') && typeof event.value === 'number') {
    logEvent(event);
  }

  if (event.name === 'map.game_state' && event.value === 'DOTA_GAMERULES_STATE_POST_GAME' && !suppressReport) {
    gameSummary(event.context.matchID);
    suppressEvents = [];
  }

  const entries = mapping.dota[event.name] ?? [];
  for (const [_idx, obj] of entries.entries()) {
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
      if (event.name === 'player.kill_streak') {
        suppressEvents.push({
          name: 'player.kills',
          value: 0,
          context: event.context,
        });
      }
      logger.info({ event, obj }, 'triggered mapping');
      playSoundForAll(obj.sound);
      break;
    }
  }
};

export const setMapping = (m: MappingConfig): void => {
  mapping = m;
};

export { handleGameEvent, recursiveDiff };
