/**
 * Tests for packages/core/src/parser/telemetry.ts
 *
 * Fixtures use 00000000- UUIDs and @example.com addresses per plan §7 sec#5.
 * All account UUIDs are imported from the canonical fixture module or use
 * the same `00000000-` prefix inline.
 *
 * Clock: no Date.now() usage here — the parser is pure/stateless.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { collectAccountMap } from "@claude-stats/core/parser/telemetry";
import {
  ACCOUNT_A_UUID,
  ACCOUNT_B_UUID,
  ORG_A_UUID,
  ORG_B_UUID,
} from "./fixtures/accounts.js";

// ─── Temp dir + paths override ───────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-telemetry-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Override paths.claudeDir for the duration of a test. */
async function withClaudeDir<T>(dir: string, fn: () => T): Promise<T> {
  const { paths } = await import("@claude-stats/core/paths");
  const orig = paths.claudeDir;
  // @ts-expect-error — temporarily override for test
  paths.claudeDir = dir;
  try {
    return fn();
  } finally {
    // @ts-expect-error — restore
    paths.claudeDir = orig;
  }
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function telemetryDir(base: string): string {
  return path.join(base, "telemetry");
}

function ensureTelemetryDir(base: string): string {
  const dir = telemetryDir(base);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a JSONL telemetry file — one event per line (the real format).
 */
function writeJsonlFile(
  base: string,
  filename: string,
  events: unknown[],
): void {
  const dir = ensureTelemetryDir(base);
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(path.join(dir, filename), lines, "utf-8");
}

/**
 * Write a legacy single-array telemetry file (back-compat format).
 */
function writeArrayFile(
  base: string,
  filename: string,
  events: unknown[],
): void {
  const dir = ensureTelemetryDir(base);
  fs.writeFileSync(
    path.join(dir, filename),
    JSON.stringify(events),
    "utf-8",
  );
}

/**
 * Build a GrowthbookExperimentEvent with the given session and account.
 * Uses 00000000- prefixed UUIDs from fixtures or inline.
 */
function makeGrowthbookEvent(
  sessionId: string,
  accountUUID: string,
  opts: {
    organizationUUID?: string | null;
    subscriptionType?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    event_type: "GrowthbookExperimentEvent",
    event_data: {
      session_id: sessionId,
      device_id: "00000000-device-1",
      user_attributes: JSON.stringify({
        id: "00000000-device-1",
        sessionId,
        deviceID: "00000000-device-1",
        accountUUID,
        organizationUUID: opts.organizationUUID ?? ORG_A_UUID,
        subscriptionType: opts.subscriptionType ?? "team_premium",
        userType: "external",
      }),
    },
  };
}

function makeInternalEvent(sessionId: string): Record<string, unknown> {
  return {
    event_type: "ClaudeCodeInternalEvent",
    event_data: { session_id: sessionId, message: "some internal event" },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("collectAccountMap", () => {
  // ── Basic cases ────────────────────────────────────────────────────────────

  it("returns empty map when telemetry dir does not exist", async () => {
    const nonExistent = path.join(tmpDir, "no-such-dir");
    const map = await withClaudeDir(nonExistent, () => collectAccountMap());
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it("returns empty map when telemetry dir is empty", async () => {
    ensureTelemetryDir(tmpDir);
    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(0);
  });

  // ── JSONL format (primary) ─────────────────────────────────────────────────

  it("reads a JSONL file and extracts GrowthbookExperimentEvent data", async () => {
    writeJsonlFile(tmpDir, "1p_failed_events.s1.d1.json", [
      makeGrowthbookEvent("sess-jsonl-1", ACCOUNT_A_UUID, {
        organizationUUID: ORG_A_UUID,
        subscriptionType: "team_premium",
      }),
    ]);

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(1);
    expect(map.get("sess-jsonl-1")).toEqual({
      accountUuid: ACCOUNT_A_UUID,
      organizationUuid: ORG_A_UUID,
      subscriptionType: "team_premium",
    });
  });

  it("reads multi-event JSONL file (multiple lines)", async () => {
    writeJsonlFile(tmpDir, "1p_failed_events.multi.d1.json", [
      makeGrowthbookEvent("sess-multi-1", ACCOUNT_A_UUID, {
        organizationUUID: ORG_A_UUID,
        subscriptionType: "team_premium",
      }),
      makeGrowthbookEvent("sess-multi-2", ACCOUNT_B_UUID, {
        organizationUUID: ORG_B_UUID,
        subscriptionType: "team_standard",
      }),
    ]);

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(2);
    expect(map.get("sess-multi-1")!.accountUuid).toBe(ACCOUNT_A_UUID);
    expect(map.get("sess-multi-2")!.accountUuid).toBe(ACCOUNT_B_UUID);
    expect(map.get("sess-multi-2")!.subscriptionType).toBe("team_standard");
  });

  it("tolerates garbage lines in JSONL without throwing", async () => {
    const dir = ensureTelemetryDir(tmpDir);
    // Mix a valid event line with garbage lines.
    const content = [
      "not-valid-json-at-all",
      JSON.stringify(
        makeGrowthbookEvent("sess-garbage-tol", ACCOUNT_A_UUID, {
          subscriptionType: "team_premium",
        }),
      ),
      "{broken",
      "",
      JSON.stringify(makeInternalEvent("sess-internal")),
    ].join("\n");
    fs.writeFileSync(
      path.join(dir, "1p_failed_events.garbage.d1.json"),
      content,
      "utf-8",
    );

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    // Only the valid GrowthbookExperimentEvent line should produce a result.
    expect(map.size).toBe(1);
    expect(map.get("sess-garbage-tol")!.accountUuid).toBe(ACCOUNT_A_UUID);
  });

  // ── Legacy array format (back-compat) ─────────────────────────────────────

  it("reads a legacy single-array JSON file (back-compat)", async () => {
    writeArrayFile(tmpDir, "1p_failed_events.legacy.d1.json", [
      makeGrowthbookEvent("sess-array-1", ACCOUNT_A_UUID, {
        organizationUUID: ORG_A_UUID,
        subscriptionType: "team_premium",
      }),
      makeGrowthbookEvent("sess-array-2", ACCOUNT_B_UUID, {
        organizationUUID: ORG_B_UUID,
        subscriptionType: "team_standard",
      }),
    ]);

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(2);
    expect(map.get("sess-array-1")!.accountUuid).toBe(ACCOUNT_A_UUID);
    expect(map.get("sess-array-2")!.organizationUuid).toBe(ORG_B_UUID);
  });

  it("reads both JSONL and legacy array files in the same directory", async () => {
    writeJsonlFile(tmpDir, "1p_failed_events.jsonl.d1.json", [
      makeGrowthbookEvent("sess-j", ACCOUNT_A_UUID, {
        subscriptionType: "team_premium",
      }),
    ]);
    writeArrayFile(tmpDir, "1p_failed_events.arr.d1.json", [
      makeGrowthbookEvent("sess-a", ACCOUNT_B_UUID, {
        subscriptionType: "team_standard",
      }),
    ]);

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(2);
    expect(map.get("sess-j")!.accountUuid).toBe(ACCOUNT_A_UUID);
    expect(map.get("sess-a")!.accountUuid).toBe(ACCOUNT_B_UUID);
  });

  // ── Filtering: event type ──────────────────────────────────────────────────

  it("ClaudeCodeInternalEvent-only file produces empty map", async () => {
    writeJsonlFile(tmpDir, "1p_failed_events.internal.d1.json", [
      makeInternalEvent("sess-int-1"),
      makeInternalEvent("sess-int-2"),
    ]);

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(0);
  });

  it("ignores non-GrowthbookExperimentEvent types mixed with valid events", async () => {
    writeJsonlFile(tmpDir, "1p_failed_events.mixed-types.d1.json", [
      makeInternalEvent("sess-internal-skip"),
      { event_type: "SomeOtherEvent", event_data: { session_id: "sess-other" } },
      makeGrowthbookEvent("sess-gb-only", ACCOUNT_A_UUID, {
        subscriptionType: "team_premium",
      }),
    ]);

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(1);
    expect(map.has("sess-gb-only")).toBe(true);
    expect(map.has("sess-internal-skip")).toBe(false);
    expect(map.has("sess-other")).toBe(false);
  });

  // ── Field extraction edge cases ───────────────────────────────────────────

  it("skips events with missing accountUUID", async () => {
    const dir = ensureTelemetryDir(tmpDir);
    const event = {
      event_type: "GrowthbookExperimentEvent",
      event_data: {
        session_id: "sess-no-account",
        user_attributes: JSON.stringify({
          id: "device-1",
          organizationUUID: ORG_A_UUID,
          subscriptionType: "team_premium",
          // accountUUID deliberately absent
        }),
      },
    };
    fs.writeFileSync(
      path.join(dir, "1p_failed_events.no-account.d1.json"),
      JSON.stringify(event),
      "utf-8",
    );

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(0);
  });

  it("stores null for optional fields when absent", async () => {
    const dir = ensureTelemetryDir(tmpDir);
    const event = {
      event_type: "GrowthbookExperimentEvent",
      event_data: {
        session_id: "sess-no-opt",
        user_attributes: JSON.stringify({
          accountUUID: ACCOUNT_A_UUID,
          // no organizationUUID, no subscriptionType
        }),
      },
    };
    fs.writeFileSync(
      path.join(dir, "1p_failed_events.no-opt.d1.json"),
      JSON.stringify(event),
      "utf-8",
    );

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(1);
    const info = map.get("sess-no-opt")!;
    expect(info.accountUuid).toBe(ACCOUNT_A_UUID);
    expect(info.organizationUuid).toBeNull();
    expect(info.subscriptionType).toBeNull();
  });

  it("skips events without a session_id", async () => {
    const dir = ensureTelemetryDir(tmpDir);
    const event = {
      event_type: "GrowthbookExperimentEvent",
      event_data: {
        // no session_id
        user_attributes: JSON.stringify({ accountUUID: ACCOUNT_A_UUID }),
      },
    };
    fs.writeFileSync(
      path.join(dir, "1p_failed_events.no-session.d1.json"),
      JSON.stringify(event),
      "utf-8",
    );

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(0);
  });

  // ── File-name filtering ────────────────────────────────────────────────────

  it("ignores files that do not match the expected name prefix/suffix", async () => {
    const dir = ensureTelemetryDir(tmpDir);
    // Write a valid event to a file with a wrong name — should be skipped.
    fs.writeFileSync(
      path.join(dir, "other_events.json"),
      JSON.stringify(
        makeGrowthbookEvent("sess-wrong-name", ACCOUNT_A_UUID),
      ),
      "utf-8",
    );
    // Write one properly named file.
    writeJsonlFile(tmpDir, "1p_failed_events.ok.d1.json", [
      makeGrowthbookEvent("sess-right-name", ACCOUNT_B_UUID, {
        subscriptionType: "team_standard",
      }),
    ]);

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(1);
    expect(map.has("sess-right-name")).toBe(true);
    expect(map.has("sess-wrong-name")).toBe(false);
  });

  // ── Hardening: non-regular files and symlinks ─────────────────────────────

  it("skips symlinks", async () => {
    const dir = ensureTelemetryDir(tmpDir);

    // Create a real file elsewhere and a symlink pointing to it.
    const realFile = path.join(tmpDir, "real_events.json");
    fs.writeFileSync(
      realFile,
      JSON.stringify(
        makeGrowthbookEvent("sess-symlink-target", ACCOUNT_A_UUID),
      ),
      "utf-8",
    );
    const symlink = path.join(dir, "1p_failed_events.symlink.json");
    try {
      fs.symlinkSync(realFile, symlink);
    } catch {
      // Symlink creation may fail in restricted environments — skip test.
      return;
    }

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    // The symlink should be skipped; no events extracted.
    expect(map.has("sess-symlink-target")).toBe(false);
  });

  it("skips files that exceed the 50 MB size cap", async () => {
    const dir = ensureTelemetryDir(tmpDir);
    const oversizeFile = path.join(dir, "1p_failed_events.oversize.json");

    // Write a file header and then pad to just over 50 MB.
    // We don't need to write a valid JSON file — lstat check happens first.
    const fiftyMbPlusOne = 50 * 1024 * 1024 + 1;
    const fd = fs.openSync(oversizeFile, "w");
    // Write the first byte of content then seek to the target size.
    fs.writeSync(fd, Buffer.from("x"));
    fs.ftruncateSync(fd, fiftyMbPlusOne);
    fs.closeSync(fd);

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    // Oversize file is skipped — no events extracted.
    expect(map.size).toBe(0);
  });

  // ── Malformed files ────────────────────────────────────────────────────────

  it("skips completely malformed files and processes valid ones", async () => {
    const dir = ensureTelemetryDir(tmpDir);
    // A file that is not valid JSON on any line.
    fs.writeFileSync(
      path.join(dir, "1p_failed_events.bad.d1.json"),
      "not json at all\n{broken",
      "utf-8",
    );
    // A valid JSONL file.
    writeJsonlFile(tmpDir, "1p_failed_events.good.d1.json", [
      makeGrowthbookEvent("sess-ok", ACCOUNT_A_UUID, {
        subscriptionType: "team_premium",
      }),
    ]);

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(1);
    expect(map.get("sess-ok")!.accountUuid).toBe(ACCOUNT_A_UUID);
  });

  it("handles empty file without throwing", async () => {
    const dir = ensureTelemetryDir(tmpDir);
    fs.writeFileSync(
      path.join(dir, "1p_failed_events.empty.d1.json"),
      "",
      "utf-8",
    );

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(0);
  });

  // ── Multi-file aggregation ─────────────────────────────────────────────────

  it("aggregates sessions from multiple files", async () => {
    writeJsonlFile(tmpDir, "1p_failed_events.f1.d1.json", [
      makeGrowthbookEvent("sess-f1", ACCOUNT_A_UUID, {
        organizationUUID: ORG_A_UUID,
        subscriptionType: "team_premium",
      }),
    ]);
    writeJsonlFile(tmpDir, "1p_failed_events.f2.d1.json", [
      makeGrowthbookEvent("sess-f2", ACCOUNT_B_UUID, {
        organizationUUID: ORG_B_UUID,
        subscriptionType: "team_standard",
      }),
    ]);

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    expect(map.size).toBe(2);
    expect(map.get("sess-f1")!.organizationUuid).toBe(ORG_A_UUID);
    expect(map.get("sess-f2")!.subscriptionType).toBe("team_standard");
  });

  it("last-write wins when the same sessionId appears in multiple files", async () => {
    // Both files have the same sessionId but different accountUUIDs.
    // The map.set call overwrites the previous value.
    writeJsonlFile(tmpDir, "1p_failed_events.dup-a.d1.json", [
      makeGrowthbookEvent("sess-dup", ACCOUNT_A_UUID, {
        subscriptionType: "team_premium",
      }),
    ]);
    writeJsonlFile(tmpDir, "1p_failed_events.dup-b.d1.json", [
      makeGrowthbookEvent("sess-dup", ACCOUNT_B_UUID, {
        subscriptionType: "team_standard",
      }),
    ]);

    const map = await withClaudeDir(tmpDir, () => collectAccountMap());
    // One entry for the session; whichever file was processed last wins.
    expect(map.size).toBe(1);
    expect(map.has("sess-dup")).toBe(true);
  });
});
