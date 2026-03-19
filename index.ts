import { Hono } from 'hono';
import { Client, Collection, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { createAudioPlayer, createAudioResource, getVoiceConnections, joinVoiceChannel, VoiceConnectionStatus, AudioPlayerStatus } from '@discordjs/voice'
import { watch } from 'fs';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

const logger = pino({
  level: 'debug',
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
})

class VoiceConnection {
  constructor(guildId, channelId, client) {
    this.player = createAudioPlayer();
    this.guild = client.guilds.cache.get(guildId);
    this.channel = this.guild.channels.cache.get(channelId);

    this.connection = joinVoiceChannel({
      channelId: channelId,
      guildId: guildId,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.connection.on(VoiceConnectionStatus.Ready, (oldState, newState) => {
      logger.info(`voice connection opened @${this.guild.name} -> ${this.channel.name}`);
    });
    
    this.connection.on(VoiceConnectionStatus.Disconnected, (oldState, newState) => {
      logger.info(`voice connection closed @${this.guild.name} -> ${this.channel.name}`);
    });
  }

  playSound(fileName) {
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

const connections = {}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates, // Essential for voice!
  ],
});

client.commands = new Collection();

const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

// straight up copy past from the discord.js docs, this loads every command in the commands directory
for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		// Set a new item in the Collection with the key as the command name and the value as the exported module
		if ('data' in command && 'execute' in command) {
			client.commands.set(command.data.name, command);
		} else {
			logger.warn(`The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) {
		logger.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	try {
		await command.execute(interaction);
	} catch (error) {
		logger.error(error);
		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({
				content: 'There was an error while executing this command!',
				flags: MessageFlags.Ephemeral,
			});
		} else {
			await interaction.reply({
				content: 'There was an error while executing this command!',
				flags: MessageFlags.Ephemeral,
			});
		}
	}
});


client.once(Events.ClientReady, async () => {
  logger.info(`bot logged in as ${client.user.tag}`);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  // user joined a channel and it's not the bot itself
  if (!oldState.channelId && newState.channelId && newState.member.user.id != client.user.id) {
    logger.info(`${newState.member.user.tag} joined ${newState.channel.name}`);
    
    // if there isn't a connection, make one
    if (!connections[newState.channelId]) {
      connections[newState.channelId] = new VoiceConnection(newState.guild.id, newState.channelId, client)
    } 
    // play sound
    connections[newState.channelId].playSound("https://www.myinstants.com/media/sounds/open-aim.mp3")
  }

  // user left a channel, cleanup4
  if (oldState.channelId && !newState.channelId) {
    logger.info(`${oldState.member.user.tag} left ${oldState.channel.name}`);
    if (oldState.channel.members.size == 1 && connections[oldState.channelId]) {
      connections[oldState.channelId].connection.destroy()
      delete connections[oldState.channelId]
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

///////////////////////////////////////////////////////////
// clickhouse client
///////////////////////////////////////////////////////////

import { createClient } from '@clickhouse/client';

// 1. Initialize Client
const clickhouseClient = createClient({
  url: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
  username: 'default',
  password: '',
  database: 'default',
});

// 2. Batch Configuration
const BATCH_SIZE_THRESHOLD = 5000;
const FLUSH_INTERVAL_MS = 10000; // 10 seconds

let eventBuffer = [];

// 3. The Core Batching Function
async function flushToClickHouse() {
  if (eventBuffer.length === 0) return;

  const dataToInsert = [...eventBuffer];
  eventBuffer = []; // Clear buffer immediately to prevent race conditions

  try {
    await clickhouseClient.insert({
      table: 'dota_events',
      values: dataToInsert,
      format: 'JSONEachRow',
    });
    logger.info(`Successfully flushed ${dataToInsert.length} rows to ClickHouse.`);
  } catch (err) {
    logger.error('ClickHouse Insert Error:', err);
  }
}

// 4. Set the Timer
setInterval(flushToClickHouse, FLUSH_INTERVAL_MS);

/**
 * Public function to log GSI events
 */
export async function logEvent(accountID, matchID, timestamp, gameTime, key, value) {
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

///////////////////////////////////////////////////////////
// DOTA2 GSI Server                                      //
///////////////////////////////////////////////////////////

const recursiveDiff = (prefix, changed, body, context) => {
  for (const key of Object.keys(changed)) {
    if (typeof(changed[key]) == 'object') {
      if (body[key] != null) { // safety check
        recursiveDiff(prefix+key+".", changed[key], body[key], context);
      }
    } else {
      if (body[key] != null) {
        handleGameEvent(prefix+key, body[key], context);
      }
    }
  }
}

const gameSummary = async (matchID) => {
  suppressReport = true
  setTimeout(() => {
    suppressReport = false
  }, 5000);

  const f = Bun.file('settings.json');
  if (f.exists()) {
    let settings = await f.json()
    const channel = await client.channels.fetch(settings.channel);
    channel.send(`https://www.opendota.com/matches/${matchID}`);
    logger.info(`sent match details to ${channel.guild.name} -> ${channel.name}`);
    
    // this doesn't work without a sleep?
    setTimeout(async () => {
      suppressReport = false
      const response = await fetch(`http://api.opendota.com/api/request/${matchID}`, {
        method: "POST"
      });
      logger.info(`opendota parse request for matchID=${matchID} http_status=${response.status}`)
    }, 5000);
  }
}

const handleGameEvent = async (eventName, value, context) => {
  if (!(eventName === "map.game_time" || eventName === "map.clock_time" ) && typeof value === 'number' ) {
    logEvent(context.accountID, context.matchID, context.timestamp, context.gameTime, eventName, value)
  }

  if (eventName === "map.game_state" && value === "DOTA_GAMERULES_STATE_POST_GAME" && !suppressReport) {
    gameSummary(context.matchID);
  }

  for (const obj of mapping) {
    if (obj.event !== eventName) {
      continue;
    }

    let play = false;
    switch (obj.condition) {
      case "*":
        play = true;
        break;
      case ">":
        if (value > obj.value) play = true; 
        break;
      case "<":
        if (value < obj.value) play = true; 
        break;
      case "===":
        if (value === obj.value) play = true; 
        break;
      case "!==":
        if (value !== obj.value) play = true; 
        break;
    }
    if (play) {
      logger.debug(`${{context}} triggered ${{obj}}`)
      for (const conn of Object.values(connections)) {
        conn.playSound(obj.sound);
      }
      // exit the loop, only play a sound on the first match
      break
    }
  }
}

const configFile = "mapping.json";
let config = Bun.file(configFile);
let mapping = await config.json();
let suppressReport = false;

watch(configFile, async (event) => {
  if (event === "change") {
    mapping = await config.json();
    logger.info("reload config file!")
  }
});

const app = new Hono()

app.get('/api/mappings', async (c) => {
  const f = Bun.file("mapping.json");
  const data = await f.json();
  return c.json(data);
});

app.put('/api/mappings', async (c) => {
  const data = await c.req.json();
  await Bun.write("mapping.json", JSON.stringify(data, null, 2));
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
    const ctx = {
      accountID: payload.player.accountid,
      matchID: payload.map.matchid,
      gameTime: payload.map.game_time,
      timestamp: payload.provider.timestamp * 1000
    }
    recursiveDiff("",payload.previously, payload, ctx)
  }
  return c.text('OK', 200);
});

export default app
