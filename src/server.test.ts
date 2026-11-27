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

const { app } = await import("@/server");

let originalCwd = "",
  tmpDir = "";

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "dota-test-"));
  process.chdir(tmpDir);
  mkdirSync("public", { recursive: true });
  writeFileSync("public/index.html", "<html>{{BASE_URL}}</html>");
  writeFileSync("public/favicon.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync("public/discord-embed.json", JSON.stringify({ component: { type: 17, openUrl: "{{BASE_URL}}/" } }));
  writeFileSync("mapping.json", JSON.stringify({ dota: {}, discord: { userSounds: {} } }));
  mkdirSync("sounds", { recursive: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
  mock.clearAllMocks();
});

describe("server routes", () => {
  test("GET / returns 200 with HTML content", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("<html>https://localhost:3000</html>");
  });

  test("GET / injects base URL from Host and x-forwarded-proto headers", async () => {
    const res = await app.request("/", {
      headers: { Host: "ward.example.com", "x-forwarded-proto": "http" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("<html>http://ward.example.com</html>");
  });

  test("GET /discord-embed.json returns substituted JSON with content-type", async () => {
    const res = await app.request("/discord-embed.json", {
      headers: { Host: "ward.example.com", "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = (await res.json()) as { component: { type: number; openUrl: string } };
    expect(body.component.type).toBe(17);
    expect(body.component.openUrl).toBe("https://ward.example.com/");
  });

  test("GET /discord-embed.json returns 500 when payload exceeds 3000 bytes", async () => {
    const big = { component: { type: 17, pad: "x".repeat(3001) } };
    writeFileSync("public/discord-embed.json", JSON.stringify(big));
    const res = await app.request("/discord-embed.json");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Discord embed payload exceeds 3000 bytes" });
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
