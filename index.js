const { Client, Events, GatewayIntentBits } = require('discord.js');
const { createAudioPlayer, createAudioResource, getVoiceConnections, joinVoiceChannel, VoiceConnectionStatus, AudioPlayerStatus } = require('@discordjs/voice');


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
  }

  playSound(fileName) {
    const subscription = this.connection.subscribe(this.player);
    const resource = createAudioResource(fileName);
    
    this.player.on(AudioPlayerStatus.Playing, (oldState, newState) => {
      console.log(`playing ${fileName} @${this.guild.name} -> ${this.channel.name}`);
    });

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
    connections[newState.channelId].playSound("holyshit-quake.mp3")
  }

  // user left a channel, cleanup
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

const d2gsi = require('dota2-gsi');
const server = new d2gsi();

const mapping = {
  "player:deaths": {
    sound: "stinks.mp3",
    condition: ">",
    value: 0
  },
  "hero:level": {
    sound: "stinks.mp3",
    condition: ">",
    value: 1
  }
}

const dotaClients = []

server.events.on('newclient', function(client) {
  
  for (const [eventName,v] of Object.entries(mapping)) {
    client.on(eventName, (v) => {
      let condition = false;
      switch(v.condition) {
        case "*":
          condition = true;
          break
        case ">":
          condition = v.condition + " > " + v.value;
          break;
        case "<":
          condition = v.condition + " < " + v.value;
          break;
        case "===":
          condition = v.condition + " === " + v.value;
          break;
        case "!==":
          condition = v.condition + " !== " + v.value;
          break;
        default:
          console.log(`failed to handle mapping ${eventName = {v}")
      }
      // this is just building a string, won't work but saving progress
      if (condition) {
        playSound(v.sound);
      }
    });
  }
});
