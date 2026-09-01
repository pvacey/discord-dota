import { startClickHouse } from "@/clickhouse";
import { startDiscord } from "@/discord";
import env from "@/env";
import logger from "@/logger";
import { startServer } from "@/server";

if (env.ENABLE_CLICKHOUSE) {
  startClickHouse();
}

if (env.ENABLE_DISCORD) {
  startDiscord();
}

if (env.ENABLE_SERVER) {
  startServer(env.PORT);
  logger.info(`Server running at http://localhost:${env.PORT}`);
}
