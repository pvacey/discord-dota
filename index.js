import { Hono } from 'hono'
import { Client, Events, GatewayIntentBits } from 'discord.js'
import { createAudioPlayer, createAudioResource, getVoiceConnections, joinVoiceChannel, VoiceConnectionStatus, AudioPlayerStatus } from '@discordjs/voice'
import { watch } from 'fs';


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
    const subscription = this.connection.subscribe(this.player);
    const resource = createAudioResource(fileName);

    this.player.play(resource);

    if (subscription) {
      setTimeout(() => {
        subscription.unsubscribe()
      }, 5_000);
    }
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
    connections[newState.channelId].playSound("https://www.myinstants.com/media/sounds/hello-your-computer-has-virus-sound-effect.mp3")
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


const recursiveDiff = (prefix, changed, body) => {
  for (const key of Object.keys(changed)) {
    if (typeof(changed[key]) == 'object') {
      if (body[key] != null) { // safety check
        recursiveDiff(prefix+key+".", changed[key], body[key]);
      }
    } else {
      if (body[key] != null) {
        handleGameEvent(prefix+key, body[key]);
      }
    }
  }
}

const handleGameEvent = (eventName, value) => {
  console.log(`checking mapping to handle ${eventName}=${value}`)
  
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
    }
  }
}

const configURL = 'http://localhost:4566/test/mapping.json';
let response = await fetch(configURL);
let mapping = await response.json();

const app = new Hono()

app.post('/', async (c) => {
  const payload = await c.req.json();
  response = await fetch(configURL);
  mapping = await response.json();
  console.log('...............')
  if (payload.previously) {
    recursiveDiff("",payload.previously, payload)
  }
  return c.text('OK', 200);
});

export default app
