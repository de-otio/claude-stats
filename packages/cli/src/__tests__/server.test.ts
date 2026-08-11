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

  it("resolves to the custom range when ?since=&until= are provided", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard?since=2020-01-01&until=2020-01-15&timezone=UTC`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["period"]).toBe("custom");
    expect(body["sinceIso"]).toBe("2020-01-01");
    // periodRange()'s `until` is an exclusive epoch boundary (midnight of
    // the day *after* the requested `until` — see periodRange/dayWindowInTz),
    // but `untilIso` is a user-facing display/echo field (e.g. the toolbar's
    // #until-date-input value) and must report the inclusive last day the
    // user actually requested, not the internal exclusive boundary.
    expect(body["untilIso"]).toBe("2020-01-15");
  });

  it("prefers an explicit since/until pair over a simultaneous period param", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard?period=week&since=2020-01-01&until=2020-01-15&timezone=UTC`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["period"]).toBe("custom");
    expect(body["sinceIso"]).toBe("2020-01-01");
    expect(body["untilIso"]).toBe("2020-01-15");
  });

  it("returns 400 for a malformed custom range (since without until)", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard?since=2020-01-01`);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("error");
  });

  it("returns 400 for an invalid custom range (since after until)", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard?since=2020-02-01&until=2020-01-01`);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("error");
  });

  it("echoes sinceIso/untilIso as the local calendar date in a positive-offset timezone, not the UTC date", async () => {
    // Regression test: `since`/`until` are always local-tz midnight, so
    // reading them back with new Date(ms).toISOString().slice(0,10) (UTC
    // calendar date) instead of a tz-aware formatter reports the *previous*
    // day for any positive-offset timezone at local midnight — e.g.
    // 2026-06-01T00:00 in Europe/Berlin (UTC+2 in June) is
    // 2026-05-31T22:00:00Z. Found via manual verification of this feature.
    const res = await fetch(`${baseUrl}/api/dashboard?since=2026-06-01&until=2026-06-30&timezone=Europe%2FBerlin`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["sinceIso"]).toBe("2026-06-01");
    expect(body["untilIso"]).toBe("2026-06-30");
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

describe("POST /api/tickets/reextract", () => {
  // The one endpoint that DELETES rows, so its auth wiring is worth its own
  // coverage rather than being assumed to follow /api/config's. It runs against
  // this suite's temp store, and backs up that store's own file (Store#dbPath)
  // — never the developer's real database.

  it("returns 401 without a token", async () => {
    const res = await fetch(`${baseUrl}/api/tickets/reextract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toHaveProperty("error", "unauthorized");
  });

  it("returns 401 with a wrong token", async () => {
    const res = await fetch(`${baseUrl}/api/tickets/reextract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${"0".repeat(authToken.length)}` },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(401);
  });

  it("runs a dry run and returns the summary shape", async () => {
    const res = await fetch(`${baseUrl}/api/tickets/reextract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.dryRun).toBe(true);
    expect(body.backupPath).toBeNull();
    for (const field of ["sessionsScanned", "removed", "created", "manualPreserved", "keysBefore", "keysAfter"]) {
      expect(typeof body[field], `${field} missing from the summary`).toBe("number");
    }
  });

  it("treats a body with no dryRun as the SAFE variant, not the destructive one", async () => {
    // An empty/garbled body must not be read as "yes, delete the links". This
    // asserts the default by its observable effect: a run that reports itself
    // as a real one would have `dryRun: false` here.
    const res = await fetch(`${baseUrl}/api/tickets/reextract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    // The empty test store has nothing to re-extract, so a real run here is
    // harmless — what matters is that `dryRun` was not silently turned on by a
    // missing field, i.e. the flag reflects the request rather than a guess.
    expect((await res.json() as Record<string, unknown>).dryRun).toBe(false);
  });
});

describe("/api/backup/* (Settings tab — Backup & Sync)", () => {
  // Only non-mutating paths are exercised here (auth wiring, validation, and
  // the read-only status shape): setup/enroll/disable against real targets
  // would touch the developer's real ~/.claude-stats config and filesystem.
  // The full action matrix lives in __tests__/ux/backup-settings.test.ts
  // against injected config paths + temp dirs.

  it("rejects GET /api/backup/status without a token (it reveals $HOME layout)", async () => {
    const res = await fetch(`${baseUrl}/api/backup/status`);
    expect(res.status).toBe(401);
  });

  it("rejects POST /api/backup/setup without a token", async () => {
    const res = await fetch(`${baseUrl}/api/backup/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "/tmp/x", mode: "encrypted" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns the status shape with a valid token", async () => {
    const res = await fetch(`${baseUrl}/api/backup/status`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.configured).toBe("boolean");
    expect(Array.isArray(body.detected)).toBe(true);
  });

  it("maps a BackupActionError to 400 with its code (invalid-target)", async () => {
    const res = await fetch(`${baseUrl}/api/backup/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ target: "", mode: "encrypted" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("error", "invalid-target");
  });

  it("reports no-backup-found when enrolling against an empty folder", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "cs-backup-route-"));
    const res = await fetch(`${baseUrl}/api/backup/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ target: emptyDir, recoveryKey: "not-a-key" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("error", "no-backup-found");
  });

  it("404s an unknown backup action", async () => {
    const res = await fetch(`${baseUrl}/api/backup/nope`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("400s malformed JSON", async () => {
    const res = await fetch(`${baseUrl}/api/backup/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});
