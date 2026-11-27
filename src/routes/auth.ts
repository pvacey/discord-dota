import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
  AUTH_COOKIE_NAME,
  getAllowedGuildId,
  getDiscordConfig,
  JWT_MAX_AGE_SECONDS,
  OAUTH_STATE_COOKIE_NAME,
  signUserJwt,
} from "@/auth";
import logger from "@/logger";

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
}

interface DiscordUser {
  id: string;
  username: string;
  avatar: string | null;
}

interface DiscordGuild {
  id: string;
  name: string;
}

const DISCORD_API_BASE = "https://discord.com/api/v10";

const authRoutes = new Hono();

authRoutes.get("/discord", (c) => {
  const { clientId, redirectUri } = getDiscordConfig();
  if (!clientId) {
    logger.error("DISCORD_CLIENT_ID is not configured");
    return c.redirect("/login?error=config");
  }

  const state = crypto.randomUUID();
  setCookie(c, OAUTH_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    path: "/",
    maxAge: 300,
    sameSite: "Lax",
  });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify guilds",
    state,
  });

  return c.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

authRoutes.get("/discord/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const storedState = getCookie(c, OAUTH_STATE_COOKIE_NAME);
  deleteCookie(c, OAUTH_STATE_COOKIE_NAME, { path: "/" });

  if (!code || !state || !storedState || state !== storedState) {
    return c.redirect("/login?error=invalid_state");
  }

  const { clientId, clientSecret, redirectUri } = getDiscordConfig();
  if (!clientId || !clientSecret) {
    logger.error("Discord OAuth credentials are not configured");
    return c.redirect("/login?error=config");
  }

  try {
    const tokenRes = await fetch(`${DISCORD_API_BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      logger.error({ status: tokenRes.status }, "Discord token exchange failed");
      return c.redirect("/login?error=oauth_failed");
    }

    const tokenData = (await tokenRes.json()) as DiscordTokenResponse;
    const authHeaders = { Authorization: `Bearer ${tokenData.access_token}` };

    const [userRes, guildsRes] = await Promise.all([
      fetch(`${DISCORD_API_BASE}/users/@me`, { headers: authHeaders }),
      fetch(`${DISCORD_API_BASE}/users/@me/guilds`, { headers: authHeaders }),
    ]);

    if (!userRes.ok || !guildsRes.ok) {
      logger.error(
        { userStatus: userRes.status, guildsStatus: guildsRes.status },
        "Failed to fetch Discord user or guilds",
      );
      return c.redirect("/login?error=oauth_failed");
    }

    const user = (await userRes.json()) as DiscordUser;
    const guilds = (await guildsRes.json()) as DiscordGuild[];
    const allowedGuildId = getAllowedGuildId();

    const isMember = guilds.some((g) => g.id === allowedGuildId);
    if (!isMember) {
      logger.warn(
        { userId: user.id, username: user.username, allowedGuildId },
        "User is not a member of the allowed Discord server",
      );
      return c.redirect("/login?error=unauthorized");
    }

    const token = await signUserJwt(user);
    setCookie(c, AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      path: "/",
      maxAge: JWT_MAX_AGE_SECONDS,
      sameSite: "Lax",
    });

    logger.info({ userId: user.id, username: user.username }, "User logged in via Discord");
    return c.redirect("/");
  } catch (error) {
    logger.error(error, "Error during Discord OAuth callback");
    return c.redirect("/login?error=oauth_failed");
  }
});

authRoutes.post("/logout", (c) => {
  deleteCookie(c, AUTH_COOKIE_NAME, { path: "/" });
  return c.redirect("/login");
});

authRoutes.get("/logout", (c) => {
  deleteCookie(c, AUTH_COOKIE_NAME, { path: "/" });
  return c.redirect("/login");
});

export default authRoutes;
