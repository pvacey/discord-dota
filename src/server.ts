import { Hono } from "hono";

import { logRawRequest } from "@/clickhouse";
import { recursiveDiff } from "@/game-event";
import logger from "@/logger";
import discordRoutes from "@/routes/discord";
import mappingsRoutes from "@/routes/mappings";
import soundsRoutes from "@/routes/sounds";
import type { GameEventContext } from "@/types";

export const app = new Hono();

app.use("*", async (c, next) => {
  const start = performance.now();
  const { method, path: route } = c.req;

  try {
    await next();
  } finally {
    const duration = performance.now() - start;
    logger.debug({ method, route, status: c.res.status, duration: Math.round(duration) }, "request completed");
  }
});

app.route("/api", mappingsRoutes);
app.route("/api/discord", discordRoutes);
app.route("/api/sounds", soundsRoutes);

app.get("/favicon.png", async (c) => {
  const file = Bun.file("./public/favicon.png");
  return c.body(file.stream(), {
    headers: { "Content-Type": "image/png" },
  });
});

const DISCORD_EMBED_MAX_BYTES = 3000;

function baseUrl(host: string | undefined, proto: string | undefined): string {
  return `${proto ?? "https"}://${host ?? "localhost:3000"}`;
}

app.get("/discord-embed.json", async (c) => {
  const file = Bun.file("./public/discord-embed.json");
  const raw = await file.text();
  if (new TextEncoder().encode(raw).length > DISCORD_EMBED_MAX_BYTES) {
    logger.error("discord-embed.json exceeds Discord's 3000-byte component embed limit");
    return c.json({ error: "Discord embed payload exceeds 3000 bytes" }, 500);
  }
  const base = baseUrl(c.req.header("host"), c.req.header("x-forwarded-proto"));
  return c.body(raw.replaceAll("{{BASE_URL}}", base), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
});

app.get("/", async (c) => {
  const file = Bun.file("./public/index.html");
  const html = await file.text();
  const base = baseUrl(c.req.header("host"), c.req.header("x-forwarded-proto"));
  return c.html(html.replaceAll("{{BASE_URL}}", base));
});

app.post("/", async (c) => {
  const payload = await c.req.json();
  if (payload.previously) {
    const ctx: GameEventContext = {
      accountID: payload.player.accountid,
      matchID: payload.map.matchid,
      gameTime: payload.map.game_time,
      timestamp: payload.provider.timestamp * 1000,
    };

    recursiveDiff("", payload.previously, payload, ctx);

    await logRawRequest(payload);
  }
  return c.text("OK", 200);
});

export function startServer(port = 3000): void {
  logger.info(`Hono server starting on port ${port}`);
  Bun.serve({
    fetch: app.fetch,
    port,
  });
}
