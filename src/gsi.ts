import type { Client } from 'discord.js';
import { logger } from './logger';
import type { GameEventContext, MappingEntry, Settings, SoundPlayer } from './types';

export interface GsiDeps {
  getMapping(): MappingEntry[];
  getConnections(): Record<string, SoundPlayer>;
  getClient(): Client;
  logEvent(
    accountID: number,
    matchID: number,
    timestamp: number,
    gameTime: number,
    key: string,
    value: number,
  ): Promise<void>;
}

export function createGsiHandler(deps: GsiDeps) {
  let suppressReport = false;

  const gameSummary = async (matchID: number): Promise<void> => {
    suppressReport = true;
    setTimeout(() => {
      suppressReport = false;
    }, 5000);

    const f = Bun.file('settings.json');
    if (await f.exists()) {
      const settings = (await f.json()) as Settings;
      if (settings.channel) {
        const client = deps.getClient();
        const channel = await client.channels.fetch(settings.channel);
        if (channel?.isSendable()) {
          channel.send(`https://www.opendota.com/matches/${matchID}`);
          logger.info(`sent match details to channel ${settings.channel}`);
        }

        // request opendota parse after a delay
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

  const handleGameEvent = async (
    eventName: string,
    value: string | number,
    context: GameEventContext,
  ): Promise<void> => {
    if (!(eventName === 'map.game_time' || eventName === 'map.clock_time') && typeof value === 'number') {
      deps.logEvent(context.accountID, context.matchID, context.timestamp, context.gameTime, eventName, value);
    }

    if (eventName === 'map.game_state' && value === 'DOTA_GAMERULES_STATE_POST_GAME' && !suppressReport) {
      gameSummary(context.matchID);
    }

    const mapping = deps.getMapping();
    const connections = deps.getConnections();

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
        // exit the loop, only play a sound on the first match
        break;
      }
    }
  };

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

  return { recursiveDiff, handleGameEvent, gameSummary };
}
