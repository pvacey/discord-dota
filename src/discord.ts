import fs from 'node:fs';
import path from 'node:path';

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
  type Guild,
  type VoiceBasedChannel,
} from 'discord.js';
import pino from 'pino';

import type { BotClient, Command } from './types.js';
import { logger } from './logger.js';
import { lookup } from 'node:dns';

export const connections: Record<string, VoiceConnection> = {};

const SOUNDS_DIR = 'sounds/';

export class VoiceConnection {
  player: AudioPlayer;
  guild: Guild;
  channel: VoiceBasedChannel;
  connection: DiscordVoiceConnection;
  subscription: PlayerSubscription | undefined;

  constructor(guildId: string, channelId: string, client: BotClient) {
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
    const resource = createAudioResource(SOUNDS_DIR + fileName);
    this.player.play(resource);
  }
}

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
}) as BotClient;

client.commands = new Collection();

const foldersPath = path.join(import.meta.dir, '..', 'commands');
const commandFolders = fs.readdirSync(foldersPath);

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
  if (!oldState.channelId && newState.channelId && newState.member?.user.id !== client.user?.id) {
    logger.info(`${newState.member?.user.tag} joined ${newState.channel?.name}`);

    if (!connections[newState.channelId]) {
      connections[newState.channelId] = new VoiceConnection(newState.guild.id, newState.channelId, client);
    }
    connections[newState.channelId]!.playSound('open-aim.mp3');
  }

  if (oldState.channelId && !newState.channelId) {
    logger.info(`${oldState.member?.user.tag} left ${oldState.channel?.name}`);
    if (oldState.channel?.members.size === 1 && connections[oldState.channelId]) {
      connections[oldState.channelId]!.connection.destroy();
      delete connections[oldState.channelId];
    }
  }
});

export function startDiscord(): void {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    logger.error('DISCORD_TOKEN not set, skipping Discord bot startup');
    return;
  }
  client.login(token);
}
