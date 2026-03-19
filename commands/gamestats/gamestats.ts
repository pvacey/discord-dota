const { SlashCommandBuilder } = require('discord.js');

const subscribeChannel = async (channelID) => {
  let content = {}
  const f = Bun.file('settings.json');
  
  if (await f.exists()) {
    content = await f.json()
  }
  content.channel = channelID
  f.write(JSON.stringify(content))
}

module.exports = {
  data: new SlashCommandBuilder().
    setName('set-game-summary-channel').
    setDescription('Designates a single channel in a server as the target for post-game DOTA2 stats.'),
  async execute(interaction) {
    subscribeChannel(interaction.channelId)
    await interaction.reply('ack');
  },
};
