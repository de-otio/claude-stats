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
let authToken: string;
let port: number;

beforeAll(() => {
  const result = startServer(0, store);
  server = result.server;
  authToken = result.token;
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      port = addr.port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
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

describe("Bind address", () => {
  it("listens on 127.0.0.1, not 0.0.0.0", () => {
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
  });
});

describe("Host header allowlist", () => {
  it("rejects requests with a non-loopback Host header", async () => {
    // Use a raw http request so we can spoof Host. fetch() always sets Host
    // to the connection target, so we bypass it.
    const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "GET", path: "/api/dashboard", headers: { Host: "evil.example.com" } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf-8") }));
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(body.status).toBe(403);
    expect(body.text).toContain("forbidden host");
  });

  it("accepts 127.0.0.1:<port>", async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
  });

  it("accepts localhost:<port>", async () => {
    const res = await fetch(`http://localhost:${port}/api/status`);
    expect(res.status).toBe(200);
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

  it("is readable without auth token (read-only endpoints are unauthenticated)", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard`);
    expect(res.status).toBe(200);
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

  it("sets an auth cookie with SameSite=Strict", async () => {
    const res = await fetch(`${baseUrl}/`);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("claude_stats_token=");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
  });
});

describe("GET /api/config", () => {
  it("returns 200 with JSON config object (no auth required for read)", async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(typeof body).toBe("object");
  });
});

describe("POST /api/config", () => {
  it("returns 401 without a token", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: { type: "pro", monthly_fee: 20 } }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("error", "unauthorized");
  });

  it("returns 401 with a wrong token (timing-safe compare)", async () => {
    const wrong = "0".repeat(authToken.length);
    const res = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${wrong}` },
      body: JSON.stringify({ plan: { type: "pro", monthly_fee: 20 } }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with a token of different length (length mismatch handled)", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer short" },
      body: JSON.stringify({ plan: { type: "pro", monthly_fee: 20 } }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts POST with correct Bearer token and returns ok with merged config", async () => {
    const before = await (await fetch(`${baseUrl}/api/config`)).json() as Record<string, unknown>;

    const res = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ plan: { type: "pro", monthly_fee: 20 } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("ok", true);
    expect(body).toHaveProperty("config");

    // Restore original config
    await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(before),
    });
  });

  it("accepts POST with correct X-Claude-Stats-Token header", async () => {
    const before = await (await fetch(`${baseUrl}/api/config`)).json() as Record<string, unknown>;

    const res = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Claude-Stats-Token": authToken },
      body: JSON.stringify({ plan: { type: "pro", monthly_fee: 20 } }),
    });
    expect(res.status).toBe(200);

    await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(before),
    });
  });

  it("accepts POST with the auth cookie", async () => {
    const before = await (await fetch(`${baseUrl}/api/config`)).json() as Record<string, unknown>;

    const res = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `claude_stats_token=${authToken}`,
      },
      body: JSON.stringify({ plan: { type: "pro", monthly_fee: 20 } }),
    });
    expect(res.status).toBe(200);

    await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(before),
    });
  });
});
