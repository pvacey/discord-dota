import { watch } from 'fs';
import fs from 'node:fs';
import path from 'node:path';

import { createClient as createClickHouseClient } from '@clickhouse/client';
import {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  VoiceConnectionStatus,
  type AudioPlayer,
  type PlayerSubscription,
  type VoiceConnection as DiscordVoiceConnection,
} from '@discordjs/voice';
import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Guild,
  type VoiceBasedChannel,
} from 'discord.js';
import { Hono } from 'hono';
import pino from 'pino';

// ─── Types ───────────────────────────────────────────────

interface MappingEntry {
  event: string;
  sound: string;
  condition: '*' | '>' | '<' | '===' | '!==';
  value: number | string;
}

interface GameEventContext {
  accountID: number;
  matchID: number;
  gameTime: number;
  timestamp: number;
}

interface Settings {
  channel?: string;
}

interface Command {
  data: { name: string; toJSON(): unknown };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

interface ClickHouseRow {
  account_id: number;
  match_id: number;
  timestamp: number;
  game_time: number;
  event_key: string;
  event_value: number;
}

// Extend the Discord.js Client to include our commands collection
interface BotClient extends Client {
  commands: Collection<string, Command>;
}

// ─── Logger ──────────────────────────────────────────────

const logger = pino({
  level: 'debug',
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
});

// ─── Voice Connection Wrapper ────────────────────────────

class VoiceConnection {
  player: AudioPlayer;
  guild: Guild;
  channel: VoiceBasedChannel;
  connection: DiscordVoiceConnection;
  subscription: PlayerSubscription | undefined;

  constructor(guildId: string, channelId: string, client: Client) {
    this.player = createAudioPlayer();
    this.guild = client.guilds.cache.get(guildId)!;
    this.channel = this.guild.channels.cache.get(channelId) as VoiceBasedChannel;

    this.connection = joinVoiceChannel({
      channelId: channelId,
      guildId: guildId,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.connection.on(VoiceConnectionStatus.Ready, () => {
      logger.info(`voice connection opened @${this.guild.name} -> ${this.channel.name}`);
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, () => {
      logger.info(`voice connection closed @${this.guild.name} -> ${this.channel.name}`);
    });
  }

  playSound(fileName: string): void {
    logger.info(`playing sound ${fileName} @${this.guild.name} -> ${this.channel.name}`);
    if (!this.subscription) {
      this.subscription = this.connection.subscribe(this.player);
    }
    const resource = createAudioResource(fileName);
    this.player.play(resource);
  }
}

///////////////////////////////////////////////////////////
// Discord Event Listeners                               //
///////////////////////////////////////////////////////////

const connections: Record<string, VoiceConnection> = {};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
}) as BotClient;

client.commands = new Collection();

const foldersPath = path.join(import.meta.dir, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

// Load every command in the commands directory
for (const folder of commandFolders) {
  const commandsPath = path.join(foldersPath, folder);
  const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.ts'));
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = (await import(filePath)) as Command;
    if ('data' in command && 'execute' in command) {
      client.commands.set(command.data.name, command);
    } else {
      logger.warn(`The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }
  const command = (interaction.client as BotClient).commands.get(interaction.commandName);

  if (!command) {
    logger.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    logger.error(error);
    await (interaction.replied || interaction.deferred
      ? interaction.followUp({
          content: 'There was an error while executing this command!',
          flags: MessageFlags.Ephemeral,
        })
      : interaction.reply({
          content: 'There was an error while executing this command!',
          flags: MessageFlags.Ephemeral,
        }));
  }
});

client.once(Events.ClientReady, () => {
  logger.info(`bot logged in as ${client.user?.tag}`);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  // user joined a channel and it's not the bot itself
  if (!oldState.channelId && newState.channelId && newState.member?.user.id !== client.user?.id) {
    logger.info(`${newState.member?.user.tag} joined ${newState.channel?.name}`);

    // if there isn't a connection, make one
    if (!connections[newState.channelId]) {
      connections[newState.channelId] = new VoiceConnection(newState.guild.id, newState.channelId, client);
    }
    // play sound
    connections[newState.channelId]!.playSound('https://www.myinstants.com/media/sounds/open-aim.mp3');
  }

  // user left a channel, cleanup
  if (oldState.channelId && !newState.channelId) {
    logger.info(`${oldState.member?.user.tag} left ${oldState.channel?.name}`);
    if (oldState.channel?.members.size === 1 && connections[oldState.channelId]) {
      connections[oldState.channelId]!.connection.destroy();
      delete connections[oldState.channelId];
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

///////////////////////////////////////////////////////////
// ClickHouse Client                                     //
///////////////////////////////////////////////////////////

const clickhouseClient = createClickHouseClient({
  url: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
  username: 'default',
  password: '',
  database: 'default',
});

const BATCH_SIZE_THRESHOLD = 5000;
const FLUSH_INTERVAL_MS = 10_000; // 10 seconds

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
    console.log(error)
    logger.error({ error }, 'ClickHouse raw_requests insert error');
  }
}

setInterval(flushToClickHouse, FLUSH_INTERVAL_MS);
setInterval(flushRawRequests, FLUSH_INTERVAL_MS);

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

export async function logRawRequest(payload: unknown): Promise<void> {
  // filter out the ticks that are just basic events, return early
  const requestKeys = new Set(getDeepKeys(payload.previously))
  const ignoreSet = new Set([
    "map", "map.game_time", "map.clock_time", "player", "player.gold", "player.gold_reliable", "player.gold_unreliable",
    "player.gold_from_income", "player.gpm", "player.xpm", "hero", "hero.health", "hero.mana", "hero.mana_percent",
    "items", "items.teleport0", "items.teleport0.cooldown"
  ])
  if (requestKeys.difference(ignoreSet).size === 0) return


  rawRequestBuffer.push({ timestamp: Date.now(), payload });

  if (rawRequestBuffer.length >= BATCH_SIZE_THRESHOLD) {
    await flushRawRequests();
  }
}

function getDeepKeys(obj: any, prefix = ''): string[] {
  return Object.keys(obj).reduce((res: string[], el) => {
    const name = prefix ? `${prefix}.${el}` : el;
    if (typeof obj[el] === 'object' && obj[el] !== null && !Array.isArray(obj[el])) {
      res.push(name); // Add the parent key
      res.push(...getDeepKeys(obj[el], name)); // Add children
    } else {
      res.push(name);
    }
    return res;
  }, []);
}

///////////////////////////////////////////////////////////
// DOTA2 GSI Server                                      //
///////////////////////////////////////////////////////////

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
      // exit the loop, only play a sound on the first match
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

const app = new Hono();

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
    
    // if it has interesting events, store the raw request
    await logRawRequest(payload);
  }
  return c.text('OK', 200);
});

export default app;
