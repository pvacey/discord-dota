import { Hono } from 'hono';
import { Client, Collection, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { createAudioPlayer, createAudioResource, getVoiceConnections, joinVoiceChannel, VoiceConnectionStatus, AudioPlayerStatus } from '@discordjs/voice'
import { watch } from 'fs';
import fs from 'node:fs';
import path from 'node:path';

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
      console.log(`voice connection opened @${this.guild.name} -> ${this.channel.name}`);
    });
    
    this.connection.on(VoiceConnectionStatus.Disconnected, (oldState, newState) => {
      console.log(`voice connection closed @${this.guild.name} -> ${this.channel.name}`);
    });
    
    this.player.on(AudioPlayerStatus.Playing, (oldState, newState) => {
      console.log(`playing sound @${this.guild.name} -> ${this.channel.name}`);
    });
  }

  playSound(fileName) {
    console.log('invoked once')
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
			console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) {
		console.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	try {
		await command.execute(interaction);
	} catch (error) {
		console.error(error);
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
  console.log(`bot logged in as ${client.user.tag}`);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  // user joined a channel and it's not the bot itself
  if (!oldState.channelId && newState.channelId && newState.member.user.id != client.user.id) {
    console.log(`${newState.member.user.tag} joined ${newState.channel.name}`);
    
    // if there isn't a connection, make one
    if (!connections[newState.channelId]) {
      connections[newState.channelId] = new VoiceConnection(newState.guild.id, newState.channelId, client)
    } 
    // play sound
    connections[newState.channelId].playSound("https://www.myinstants.com/media/sounds/open-aim.mp3")
  }

  // user left a channel, cleanup4
  if (oldState.channelId && !newState.channelId) {
    console.log(`${oldState.member.user.tag} left ${oldState.channel.name}`);
    if (oldState.channel.members.size == 1 && connections[oldState.channelId]) {
      connections[oldState.channelId].connection.destroy()
      delete connections[oldState.channelId]
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

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

const handleGameEvent = async (eventName, value, context) => {
  console.log(`checking mapping to handle ${eventName}=${value}`)

  if (eventName === "map.game_state" && value === "DOTA_GAMERULES_STATE_POST_GAME" && !suppressReport) {
    
    suppressReport = true
    setTimeout(() => {
      suppressReport = false
    }, 5000);

    const f = Bun.file('settings.json');
    if (f.exists()) {
      let settings = await f.json()
      const channel = await client.channels.fetch(settings.channel);
      channel.send(`https://www.opendota.com/matches/${context.matchID}`);
    }
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
      console.log({obj})
      for (const conn of Object.values(connections)) {
        conn.playSound(obj.sound);
      }
      // exit the loop, only play a sound on the first match
      break
    }
  }
}

let config = Bun.file("mapping.json");
let mapping = await config.json();
let suppressReport = false;

const app = new Hono()

app.post('/', async (c) => {
  const payload = await c.req.json();
  config = Bun.file("mapping.json");
  mapping = await config.json();
  console.log('...............')
  if (payload.previously) {
    const ctx = {
      playerID: payload.player.steamid,
      matchID: payload.map.matchid
    }
    recursiveDiff("",payload.previously, payload, ctx)
  }
  return c.text('OK', 200);
});

export default app
