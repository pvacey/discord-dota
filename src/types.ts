import type { Client, Collection, ChatInputCommandInteraction } from 'discord.js';

export interface MappingEntry {
  event: string;
  sound: string;
  condition: '*' | '>' | '<' | '===' | '!==';
  value: number | string;
}

export interface GameEvent {
  name: string;
  value: string | number;
  context: GameEventContext;
}

export interface GameEventContext {
  accountID: number;
  matchID: number;
  gameTime: number;
  timestamp: number;
}

export interface Settings {
  channel?: string;
}

export interface Command {
  data: { name: string; toJSON(): unknown };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

export interface ClickHouseRow {
  account_id: number;
  match_id: number;
  timestamp: number;
  game_time: number;
  event_key: string;
  event_value: number;
}

export interface BotClient extends Client {
  commands: Collection<string, Command>;
}
