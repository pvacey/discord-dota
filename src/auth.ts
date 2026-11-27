import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";

import type { AuthUser } from "@/types";

export const DEFAULT_ALLOWED_GUILD_ID = "790021340509896704";
export const AUTH_COOKIE_NAME = "auth_token";
export const OAUTH_STATE_COOKIE_NAME = "oauth_state";
export const JWT_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function getAllowedGuildId(): string {
  return process.env.DISCORD_GUILD_ID || DEFAULT_ALLOWED_GUILD_ID;
}

export function getJwtSecret(): string {
  return process.env.JWT_SECRET || "dev-jwt-secret";
}

export function getDiscordConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  return {
    clientId: process.env.DISCORD_CLIENT_ID || "",
    clientSecret: process.env.DISCORD_CLIENT_SECRET || "",
    redirectUri: process.env.DISCORD_REDIRECT_URI || "http://localhost:3000/auth/discord/callback",
  };
}

export async function signUserJwt(user: { id: string; username: string; avatar: string | null }): Promise<string> {
  const payload = {
    sub: user.id,
    username: user.username,
    avatar: user.avatar,
    exp: Math.floor(Date.now() / 1000) + JWT_MAX_AGE_SECONDS,
  };
  return sign(payload, getJwtSecret(), "HS256");
}

export async function verifyUserJwt(token: string): Promise<AuthUser | null> {
  try {
    const payload = await verify(token, getJwtSecret(), "HS256");
    if (typeof payload.sub !== "string" || typeof payload.username !== "string") {
      return null;
    }
    return {
      sub: payload.sub,
      username: payload.username,
      avatar: typeof payload.avatar === "string" ? payload.avatar : null,
      exp: typeof payload.exp === "number" ? payload.exp : 0,
    };
  } catch {
    return null;
  }
}

export function extractToken(c: Context): string | undefined {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return getCookie(c, AUTH_COOKIE_NAME);
}

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const token = extractToken(c);
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const user = await verifyUserJwt(token);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("user", user);
  await next();
}
