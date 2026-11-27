import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logRawRequest = mock();
const logEvent = mock();
const recursiveDiff = mock();
const setMapping = mock();
const handleGameEvent = mock();
const getGuildMembers = mock();
const logger = { info: mock(), debug: mock(), error: mock(), warn: mock() };

mock.module("@/clickhouse", () => ({ logRawRequest, logEvent }));
mock.module("@/game-event", () => ({ recursiveDiff, setMapping, handleGameEvent }));
mock.module("@/discord", () => ({ getGuildMembers, connections: {}, client: {} }));
mock.module("@/logger", () => ({ default: logger }));

const { AUTH_COOKIE_NAME, signUserJwt } = await import("@/auth");
const { app } = await import("@/server");

let originalCwd = "",
  tmpDir = "";

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "dota-test-"));
  process.chdir(tmpDir);
  mkdirSync("public", { recursive: true });
  writeFileSync("public/index.html", "<html></html>");
  writeFileSync("public/login.html", "<html>login</html>");
  writeFileSync("public/favicon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync("mapping.json", JSON.stringify({ dota: {}, discord: { userSounds: {} } }));
  mkdirSync("sounds", { recursive: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
  mock.clearAllMocks();
});

describe("server routes", () => {
  test("GET / redirects to /login when unauthenticated", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("GET / returns 200 with HTML content when authenticated", async () => {
    const token = await signUserJwt({ id: "123", username: "tester", avatar: null });
    const res = await app.request("/", {
      headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("<html></html>");
  });

  test("GET /login returns 200 with login HTML content", async () => {
    const res = await app.request("/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>login</html>");
  });

  test("GET /api/mappings returns 401 when unauthenticated", async () => {
    const res = await app.request("/api/mappings");
    expect(res.status).toBe(401);
  });

  test("GET /api/mappings returns 200 when authenticated", async () => {
    const token = await signUserJwt({ id: "123", username: "tester", avatar: null });
    const res = await app.request("/api/mappings", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  test("GET /favicon.png returns 200 with image/png content-type", async () => {
    const res = await app.request("/favicon.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  describe("POST / (GSI webhook)", () => {
    test("processes payload when previously is present", async () => {
      const payload = {
        previously: { map: { game_time: 100 } },
        player: { accountid: 123 },
        map: { matchid: 456, game_time: 200 },
        provider: { timestamp: 1000 },
      };
      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(recursiveDiff).toHaveBeenCalledWith("", payload.previously, payload, {
        accountID: 123,
        matchID: 456,
        gameTime: 200,
        timestamp: 1_000_000,
      });
    });

    test("calls logRawRequest with full payload when previously is present", async () => {
      const payload = {
        previously: { map: { game_time: 100 } },
        player: { accountid: 123 },
        map: { matchid: 456, game_time: 200 },
        provider: { timestamp: 1000 },
      };
      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(logRawRequest).toHaveBeenCalledWith(payload);
    });

    test("does not call recursiveDiff when previously is absent", async () => {
      const payload = { player: { accountid: 123 }, map: {} };
      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(recursiveDiff).not.toHaveBeenCalled();
    });

    test("does not call logRawRequest when previously is absent", async () => {
      const payload = { player: { accountid: 123 }, map: {} };
      await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(logRawRequest).not.toHaveBeenCalled();
    });

    test("returns 200 with OK body when previously is present", async () => {
      const payload = {
        previously: { map: { game_time: 100 } },
        player: { accountid: 123 },
        map: { matchid: 456, game_time: 200 },
        provider: { timestamp: 1000 },
      };
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("OK");
    });

    test("returns 200 with OK body when previously is absent", async () => {
      const payload = { player: { accountid: 123 }, map: {} };
      const res = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("OK");
    });
  });
});
