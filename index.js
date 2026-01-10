const { Client, Events, GatewayIntentBits } = require('discord.js');
const { createAudioPlayer, createAudioResource, joinVoiceChannel, VoiceConnectionStatus, AudioPlayerStatus } = require('@discordjs/voice');

const GUILD_ID = '790021340509896704';
const CHANNEL_ID = '790021340509896708';
let guild = null;
let channel = null;
let connection = null;
const player = createAudioPlayer();

const addBotToVoice = () => {
  try {
      connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: true, 
          selfMute: false,
      });

      connection.on(VoiceConnectionStatus.Ready, (oldState, newState) => {
      	console.log('Connection is in the Ready state!');
      });
      
      
      console.log(`Successfully joined ${channel.name}`);
  } catch (error) {
      console.error("Error joining voice channel:", error);
  }
};


const playSound = (fileName) => {
  const subscription = connection.subscribe(player);
  const resource = createAudioResource(fileName);

  player.play(resource);
  player.on(AudioPlayerStatus.Playing, (oldState, newState) => {
  	console.log('Audio player is in the Playing state!');
  });

  if (subscription) {
  	setTimeout(() => { subscription.unsubscribe() }, 5_000);
  }
}

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.GuildVoiceStates, // Essential for voice!
	],
});


client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return console.error("Guild not found.");

    channel = guild.channels.cache.get(CHANNEL_ID);
    if (!channel) return console.error("Channel not found.");

});


client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    // 1. User Joined a channel (wasn't in one, now is)
    if (!oldState.channelId && newState.channelId) {
      console.log(`${newState.member.user.tag} joined ${newState.channel.name}`);
      if (!connection) {
        addBotToVoice()
      }
      else {
        playSound("holyshit-quake.mp3");
      }
    }

    // 2. User Left a channel (was in one, now isn't)
    if (oldState.channelId && !newState.channelId) {
      if (oldState.channel.members.size == 1 && connection != null) {
        connection.destroy()
        connection = null;
      }
      console.log(`${oldState.member.user.tag} left ${oldState.channel.name}`);
    }

    // 3. User Switched channels
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      if (oldState.channel.members.size == 1 && connection != null) {
        connection.destroy()
        connection = null;
      }
      console.log(`${newState.member.user.tag} moved from ${oldState.channel.name} to ${newState.channel.name}`);
    }
});


client.login(process.env.DISCORD_TOKEN);

// client.on('messageCreate', (message) => {
//   console.log(message)
// });
