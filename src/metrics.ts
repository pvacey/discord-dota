import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('discord-dota');

export const httpRequestsTotal = meter.createCounter('http.requests.total', {
  description: 'Total number of HTTP requests',
});

export const httpRequestDuration = meter.createHistogram('http.request.duration', {
  description: 'Duration of HTTP requests in milliseconds',
  unit: 'ms',
});

export const gameEventsTotal = meter.createCounter('game.events.total', {
  description: 'Total number of game events processed',
});

export const soundsPlayedTotal = meter.createCounter('sounds.played.total', {
  description: 'Total number of sounds played',
});

export const clickhouseRowsFlushed = meter.createCounter('clickhouse.rows.flushed', {
  description: 'Total number of rows flushed to ClickHouse',
});

export const discordCommandsTotal = meter.createCounter('discord.commands.total', {
  description: 'Total number of Discord commands executed',
});

export const discordVoiceConnections = meter.createUpDownCounter('discord.voice.connections', {
  description: 'Current number of active Discord voice connections',
});
