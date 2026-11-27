import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { Hono } from "hono";

import {
  AUTH_COOKIE_NAME,
  DEFAULT_ALLOWED_GUILD_ID,
  OAUTH_STATE_COOKIE_NAME,
  requireAuth,
  signUserJwt,
  verifyUserJwt,
} from "@/auth";
import type { AuthUser } from "@/types";

const logger = { info: mock(), debug: mock(), warn: mock(), error: mock() };
mock.module("@/logger", () => ({ default: logger }));

const { default: authRoutes } = await import("@/routes/auth");

const app = new Hono<{ Variables: { user: AuthUser } }>();
app.route("/auth", authRoutes);
app.use("/api/*", requireAuth);
app.get("/api/auth/me", (c) => c.json(c.get("user")));

const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [
    "DISCORD_CLIENT_ID",
    "DISCORD_CLIENT_SECRET",
    "DISCORD_REDIRECT_URI",
    "DISCORD_GUILD_ID",
    "JWT_SECRET",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.DISCORD_CLIENT_ID = "test-client-id";
  process.env.DISCORD_CLIENT_SECRET = "test-client-secret";
  process.env.DISCORD_REDIRECT_URI = "http://localhost:3000/auth/discord/callback";
  delete process.env.DISCORD_GUILD_ID;
  process.env.JWT_SECRET = "test-jwt-secret";
  mock.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

describe("auth routes and JWT verification", () => {
  describe("GET /auth/discord", () => {
    test("redirects to Discord OAuth2 authorize URL and sets state cookie", async () => {
      const res = await app.request("/auth/discord");
      expect(res.status).toBe(302);

      const location = res.headers.get("location")!;
      expect(location).toStartWith("https://discord.com/oauth2/authorize?");
      const url = new URL(location);
      expect(url.searchParams.get("client_id")).toBe("test-client-id");
      expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/auth/discord/callback");
      expect(url.searchParams.get("scope")).toBe("identify guilds");
      const state = url.searchParams.get("state");
      expect(state).toBeTruthy();

      const setCookieHeader = res.headers.get("set-cookie")!;
      expect(setCookieHeader).toContain(`${OAUTH_STATE_COOKIE_NAME}=${state}`);
    });

    test("redirects to /login?error=config when DISCORD_CLIENT_ID is missing", async () => {
      delete process.env.DISCORD_CLIENT_ID;
      const res = await app.request("/auth/discord");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login?error=config");
    });
  });

  describe("GET /auth/discord/callback", () => {
    test("redirects to /login?error=invalid_state when state does not match cookie", async () => {
      const res = await app.request("/auth/discord/callback?code=abc&state=wrong", {
        headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=expected` },
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login?error=invalid_state");
    });

    test("allows login and sets JWT cookie when user is in server 790021340509896704", async () => {
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/oauth2/token")) {
          return Response.json({ access_token: "discord-access-token", token_type: "Bearer" });
        }
        if (url.endsWith("/users/@me")) {
          return Response.json({ id: "user-123", username: "dota_enjoyer", avatar: "av_hash" });
        }
        if (url.endsWith("/users/@me/guilds")) {
          return Response.json([
            { id: "111111111111111111", name: "Other Server" },
            { id: DEFAULT_ALLOWED_GUILD_ID, name: "Test Server" },
          ]);
        }
        return new Response("Not Found", { status: 404 });
      }) as unknown as typeof fetch;

      const res = await app.request("/auth/discord/callback?code=valid-code&state=state-123", {
        headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=state-123` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");

      const setCookieHeader = res.headers.get("set-cookie")!;
      const tokenMatch = setCookieHeader.match(new RegExp(`${AUTH_COOKIE_NAME}=([^;]+)`));
      expect(tokenMatch).toBeTruthy();

      const user = await verifyUserJwt(tokenMatch![1]!);
      expect(user).toMatchObject({
        sub: "user-123",
        username: "dota_enjoyer",
        avatar: "av_hash",
      });
    });

    test("denies login when user is not in server 790021340509896704", async () => {
      globalThis.fetch = mock(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/oauth2/token")) {
          return Response.json({ access_token: "discord-access-token", token_type: "Bearer" });
        }
        if (url.endsWith("/users/@me")) {
          return Response.json({ id: "user-999", username: "outsider", avatar: null });
        }
        if (url.endsWith("/users/@me/guilds")) {
          return Response.json([{ id: "222222222222222222", name: "Some Other Server" }]);
        }
        return new Response("Not Found", { status: 404 });
      }) as unknown as typeof fetch;

      const res = await app.request("/auth/discord/callback?code=valid-code&state=state-123", {
        headers: { Cookie: `${OAUTH_STATE_COOKIE_NAME}=state-123` },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login?error=unauthorized");
      expect(res.headers.get("set-cookie")).not.toContain(`${AUTH_COOKIE_NAME}=`);
    });
  });

  describe("requireAuth middleware & /api/auth/me", () => {
    test("returns 401 when no token is provided", async () => {
      const res = await app.request("/api/auth/me");
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    });

    test("returns user info when valid JWT cookie is provided", async () => {
      const token = await signUserJwt({ id: "u1", username: "radiant_carry", avatar: null });
      const res = await app.request("/api/auth/me", {
        headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as AuthUser;
      expect(body.sub).toBe("u1");
      expect(body.username).toBe("radiant_carry");
    });

    test("returns user info when valid Bearer token header is provided", async () => {
      const token = await signUserJwt({ id: "u2", username: "dire_support", avatar: "abc" });
      const res = await app.request("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as AuthUser;
      expect(body.sub).toBe("u2");
      expect(body.username).toBe("dire_support");
    });
  });

  describe("logout", () => {
    test("GET /auth/logout clears cookie and redirects to /login", async () => {
      const res = await app.request("/auth/logout");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login");
      expect(res.headers.get("set-cookie")).toContain(`${AUTH_COOKIE_NAME}=;`);
    });
  });
});
