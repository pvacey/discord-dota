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
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type Guild,
  type VoiceBasedChannel,
} from 'discord.js';

import logger from './logger.js';
import { discordCommandsTotal, discordVoiceConnections } from './metrics.js';
import type { BotClient, Command } from './types.js';

const tracer = trace.getTracer('discord-dota', '1.0.0');

export const connections: Record<string, VoiceConnection> = {};

const SOUNDS_DIR = 'sounds/';

export class VoiceConnection {
  player: AudioPlayer;
  guild: Guild;
  channel: VoiceBasedChannel;
  connection!: DiscordVoiceConnection;
  subscription: PlayerSubscription | undefined;

  constructor(guildId: string, channelId: string, client: BotClient) {
    this.player = createAudioPlayer();
    this.guild = client.guilds.cache.get(guildId)!;
    this.channel = this.guild.channels.cache.get(channelId) as VoiceBasedChannel;

    tracer.startActiveSpan('discord.voice.connect', (span) => {
      span.setAttribute('guild.id', guildId);
      span.setAttribute('guild.name', this.guild.name);
      span.setAttribute('channel.id', channelId);
      span.setAttribute('channel.name', this.channel.name);

      this.connection = joinVoiceChannel({
        channelId: channelId,
        guildId: guildId,
        adapterCreator: this.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
      });

      this.connection.on(VoiceConnectionStatus.Ready, () => {
        logger.info(`voice connection opened @${this.guild.name} -> ${this.channel.name}`);
        span.addEvent('voice.connected');
        discordVoiceConnections.add(1);
        span.end();
      });

      this.connection.on(VoiceConnectionStatus.Disconnected, () => {
        logger.info(`voice connection closed @${this.guild.name} -> ${this.channel.name}`);
        tracer.startActiveSpan('discord.voice.disconnect', (disconnectSpan) => {
          disconnectSpan.setAttribute('guild.id', guildId);
          disconnectSpan.setAttribute('guild.name', this.guild.name);
          disconnectSpan.setAttribute('channel.id', channelId);
          disconnectSpan.setAttribute('channel.name', this.channel.name);
          discordVoiceConnections.add(-1);
          disconnectSpan.end();
        });
      });
    });
  }

  playSound(fileName: string): void {
    tracer.startActiveSpan('discord.voice.play', (span) => {
      span.setAttribute('sound.file', fileName);
      span.setAttribute('guild.name', this.guild.name);
      span.setAttribute('channel.name', this.channel.name);

      try {
        logger.info(`playing sound ${fileName} @${this.guild.name} -> ${this.channel.name}`);
        if (!this.subscription) {
          tracer.startActiveSpan('discord.voice.subscribe', (subscribeSpan) => {
            subscribeSpan.setAttribute('guild.name', this.guild.name);
            try {
              this.subscription = this.connection.subscribe(this.player);
            } catch (error) {
              subscribeSpan.setStatus({ code: SpanStatusCode.ERROR });
              subscribeSpan.recordException(error as Error);
              throw error;
            } finally {
              subscribeSpan.end();
            }
          });
        }

        const resource = tracer.startActiveSpan('discord.voice.resource.create', (resourceSpan) => {
          resourceSpan.setAttribute('sound.file', fileName);
          resourceSpan.setAttribute('resource.path', SOUNDS_DIR + fileName);
          try {
            const res = createAudioResource(SOUNDS_DIR + fileName);
            return res;
          } catch (error) {
            resourceSpan.setStatus({ code: SpanStatusCode.ERROR });
            resourceSpan.recordException(error as Error);
            throw error;
          } finally {
            resourceSpan.end();
          }
        });

        this.player.play(resource);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    });
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

tracer.startActiveSpan('discord.commands.load', async (span) => {
  const loadedCommands: string[] = [];
  try {
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
          loadedCommands.push(command.data.name);
        } else {
          logger.warn(`The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
      }
    }
    span.setAttribute('commands.count', loadedCommands.length);
    span.setAttribute('commands.names', loadedCommands.join(','));
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.recordException(error as Error);
    throw error;
  } finally {
    span.end();
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }
  const command = (interaction.client as BotClient).commands.get(interaction.commandName);

  if (!command) {
    logger.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }

  discordCommandsTotal.add(1, { command: interaction.commandName });

  tracer.startActiveSpan(`discord.command.${interaction.commandName}`, async (span) => {
    span.setAttribute('command.name', interaction.commandName);
    span.setAttribute('guild.id', interaction.guildId ?? 'dm');
    span.setAttribute('user.id', interaction.user.id);
    span.setAttribute('user.tag', interaction.user.tag);

    try {
      await command.execute(interaction);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.recordException(error as Error);
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
    } finally {
      span.end();
    }
  });
});

client.once(Events.ClientReady, () => {
  tracer.startActiveSpan('discord.ready', (span) => {
    span.setAttribute('user.tag', client.user?.tag ?? 'unknown');
    span.setAttribute('user.id', client.user?.id ?? 'unknown');
    logger.info(`bot logged in as ${client.user?.tag}`);
    span.end();
  });
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (!oldState.channelId && newState.channelId && newState.member?.user.id !== client.user?.id) {
    const joinChannelId = newState.channelId;
    tracer.startActiveSpan('discord.voice_state.join', (span) => {
      span.setAttribute('user.id', newState.member?.user.id ?? 'unknown');
      span.setAttribute('user.tag', newState.member?.user.tag ?? 'unknown');
      span.setAttribute('channel.id', joinChannelId);
      span.setAttribute('channel.name', newState.channel?.name ?? 'unknown');
      span.setAttribute('guild.id', newState.guild.id);
      try {
        logger.info(`${newState.member?.user.tag} joined ${newState.channel?.name}`);

        if (!connections[joinChannelId]) {
          connections[joinChannelId] = new VoiceConnection(newState.guild.id, joinChannelId, client);
        }
        connections[joinChannelId]!.playSound('open-aim.mp3');
      } finally {
        span.end();
      }
    });
  }

  if (oldState.channelId && !newState.channelId) {
    const leaveChannelId = oldState.channelId;
    tracer.startActiveSpan('discord.voice_state.leave', (span) => {
      span.setAttribute('user.id', oldState.member?.user.id ?? 'unknown');
      span.setAttribute('user.tag', oldState.member?.user.tag ?? 'unknown');
      span.setAttribute('channel.id', leaveChannelId);
      span.setAttribute('channel.name', oldState.channel?.name ?? 'unknown');
      span.setAttribute('guild.id', oldState.guild.id);
      try {
        logger.info(`${oldState.member?.user.tag} left ${oldState.channel?.name}`);
        if (oldState.channel?.members.size === 1 && connections[leaveChannelId]) {
          tracer.startActiveSpan('discord.voice.destroy', (destroySpan) => {
            destroySpan.setAttribute('channel.id', leaveChannelId);
            destroySpan.setAttribute('guild.id', oldState.guild.id);
            try {
              connections[leaveChannelId]!.connection.destroy();
              delete connections[leaveChannelId];
            } catch (error) {
              destroySpan.setStatus({ code: SpanStatusCode.ERROR });
              destroySpan.recordException(error as Error);
              throw error;
            } finally {
              destroySpan.end();
            }
          });
        }
      } finally {
        span.end();
      }
    });
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
