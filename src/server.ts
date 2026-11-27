import { Hono } from "hono";

import { extractToken, requireAuth, verifyUserJwt } from "@/auth";
import { logRawRequest } from "@/clickhouse";
import { recursiveDiff } from "@/game-event";
import logger from "@/logger";
import authRoutes from "@/routes/auth";
import discordRoutes from "@/routes/discord";
import mappingsRoutes from "@/routes/mappings";
import soundsRoutes from "@/routes/sounds";
import type { AuthUser, GameEventContext } from "@/types";

export const app = new Hono<{ Variables: { user: AuthUser } }>();

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

app.route("/auth", authRoutes);

app.get("/login", async (c) => {
  if (!c.req.query("error")) {
    const token = extractToken(c);
    if (token && (await verifyUserJwt(token))) {
      return c.redirect("/");
    }
  }
  const file = Bun.file("./public/login.html");
  return c.html(await file.text());
});

app.use("/api/*", requireAuth);

app.get("/api/auth/me", (c) => c.json(c.get("user")));

app.route("/api", mappingsRoutes);
app.route("/api/discord", discordRoutes);
app.route("/api/sounds", soundsRoutes);

app.get("/favicon.png", async (c) => {
  const file = Bun.file("./public/favicon.png");
  return c.body(file.stream(), {
    headers: { "Content-Type": "image/png" },
  });
});

app.get("/", async (c) => {
  const token = extractToken(c);
  if (!token || !(await verifyUserJwt(token))) {
    return c.redirect("/login");
  }
  const file = Bun.file("./public/index.html");
  return c.html(await file.text());
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
