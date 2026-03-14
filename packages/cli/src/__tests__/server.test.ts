import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { Store } from "../store/index.js";
import { startServer } from "../server/index.js";

const tmpDir = mkdtempSync(join(tmpdir(), "claude-stats-server-test-"));
const store = new Store(join(tmpDir, "test.db"));
let server: http.Server;
let baseUrl: string;

beforeAll(() => {
  server = startServer(0, store);
  // server.listen(0) is called inside startServer; wait for the listening event
  return new Promise<void>((resolve) => {
    if (server.listening) {
      const port = (server.address() as AddressInfo).port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    } else {
      server.once("listening", () => {
        const port = (server.address() as AddressInfo).port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    }
  });
});

afterAll(() => {
  store.close();
  return new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
});

describe("GET /api/dashboard", () => {
  it("returns 200 with valid JSON containing summary, byDay, byModel fields", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("summary");
    expect(body).toHaveProperty("byDay");
    expect(body).toHaveProperty("byModel");
  });

  it("response has period === 'week' when ?period=week", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard?period=week`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["period"]).toBe("week");
  });
});

describe("GET /api/status", () => {
  it("returns 200 with valid JSON containing sessionCount", async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("sessionCount");
  });
});

describe("GET /unknown", () => {
  it("returns 404 with JSON body {error: 'not found'}", async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ error: "not found" });
  });
});

describe("GET /", () => {
  it("returns 200 with content-type containing text/html", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("renders a Settings tab button", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain('data-tab="settings"');
    expect(html).toContain("Settings");
  });
});

describe("GET /api/config", () => {
  it("returns 200 with JSON config object", async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(typeof body).toBe("object");
  });
});

describe("POST /api/config", () => {
  it("accepts POST and returns ok with merged config", async () => {
    // Read current config first so we can restore it
    const before = await (await fetch(`${baseUrl}/api/config`)).json() as Record<string, unknown>;

    const res = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: { type: "pro", monthly_fee: 20 } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("ok", true);
    expect(body).toHaveProperty("config");

    // Restore original config
    await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(before),
    });
  });
});
