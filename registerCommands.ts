import fs from 'node:fs';
import path from 'node:path';

import { REST, Routes } from 'discord.js';

interface Config {
  clientId: string;
  guildId: string;
  token: string;
}

interface Command {
  data: { name: string; toJSON(): unknown };
  execute(interaction: unknown): Promise<void>;
}

const configFile = Bun.file('./config.json');
const { clientId, guildId, token } = (await configFile.json()) as Config;

const commands: unknown[] = [];
const foldersPath = path.join(import.meta.dir, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
  const commandsPath = path.join(foldersPath, folder);
  const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.ts'));
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = (await import(filePath)) as Command;
    if ('data' in command && 'execute' in command) {
      commands.push(command.data.toJSON());
    } else {
      console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
    }
  }
}

const rest = new REST().setToken(token);

try {
  console.log(`Started refreshing ${commands.length} application (/) commands.`);

  const data = (await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  })) as unknown[];

  console.log(`Successfully reloaded ${data.length} application (/) commands.`);
} catch (error) {
  console.error(error);
}
