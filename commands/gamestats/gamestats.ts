import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';

interface Settings {
  channel?: string;
}

const subscribeChannel = async (channelID: string): Promise<void> => {
  let content: Settings = {};
  const f = Bun.file('settings.json');

  if (await f.exists()) {
    content = (await f.json()) as Settings;
  }
  content.channel = channelID;
  await Bun.write('settings.json', JSON.stringify(content));
};

export const data = new SlashCommandBuilder()
  .setName('set-game-summary-channel')
  .setDescription('Designates a single channel in a server as the target for post-game DOTA2 stats.');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await subscribeChannel(interaction.channelId);
  await interaction.reply('ack');
}
