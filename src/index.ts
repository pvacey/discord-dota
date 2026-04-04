import { startDiscord, logger } from './discord.js';
import { startClickHouse } from './clickhouse.js';
import { startServer } from './server.js';

const ENABLE_DISCORD = process.env.ENABLE_DISCORD !== 'false';
const ENABLE_CLICKHOUSE = process.env.ENABLE_CLICKHOUSE !== 'false';
const ENABLE_SERVER = process.env.ENABLE_SERVER !== 'false';
const SERVER_PORT = parseInt(process.env.PORT || '3000', 10);

if (ENABLE_CLICKHOUSE) {
  startClickHouse();
}

if (ENABLE_DISCORD) {
  startDiscord();
}

if (ENABLE_SERVER) {
  startServer(SERVER_PORT);
  logger.info(`Server running at http://localhost:${SERVER_PORT}`);
}
