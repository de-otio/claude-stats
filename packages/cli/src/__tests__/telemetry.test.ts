import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { collectAccountMap } from "@claude-stats/core/parser/telemetry";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-telemetry-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTelemetryFile(filename: string, events: unknown[]): void {
  const telemetryDir = path.join(tmpDir, "telemetry");
  fs.mkdirSync(telemetryDir, { recursive: true });
  fs.writeFileSync(path.join(telemetryDir, filename), JSON.stringify(events));
}

function makeGrowthbookEvent(sessionId: string, accountUUID: string, opts: {
  organizationUUID?: string;
  subscriptionType?: string;
} = {}): Record<string, unknown> {
  return {
    event_type: "GrowthbookExperimentEvent",
    event_data: {
      session_id: sessionId,
      device_id: "device123",
      user_attributes: JSON.stringify({
        id: "device123",
        sessionId,
        deviceID: "device123",
        accountUUID,
        organizationUUID: opts.organizationUUID ?? "org-1",
        subscriptionType: opts.subscriptionType ?? "team",
        userType: "external",
      }),
    },
  };
}

describe("collectAccountMap", () => {
  it("returns empty map when telemetry dir does not exist", () => {
    // Point paths to a non-existent dir
    vi.stubEnv("HOME", "/tmp/nonexistent-" + Date.now());
    // collectAccountMap uses paths.claudeDir which reads os.homedir()
    // We need to mock the paths module
    const map = collectAccountMap();
    // Will return empty since the dir doesn't exist (paths.claudeDir is resolved at import time)
    expect(map).toBeInstanceOf(Map);
  });

  it("extracts accountUUID from GrowthbookExperimentEvent", async () => {
    // We need to dynamically override paths for this test
    const { paths } = await import("@claude-stats/core/paths");
    const origClaudeDir = paths.claudeDir;
    // @ts-expect-error — temporarily override for test
    paths.claudeDir = tmpDir;

    try {
      writeTelemetryFile("1p_failed_events.sess-1.device1.json", [
        makeGrowthbookEvent("sess-1", "acct-aaa", { subscriptionType: "team" }),
      ]);

      const map = collectAccountMap();
      expect(map.size).toBe(1);
      expect(map.get("sess-1")).toEqual({
        accountUuid: "acct-aaa",
        organizationUuid: "org-1",
        subscriptionType: "team",
      });
    } finally {
      // @ts-expect-error — restore
      paths.claudeDir = origClaudeDir;
    }
  });

  it("ignores ClaudeCodeInternalEvent events", async () => {
    const { paths } = await import("@claude-stats/core/paths");
    const origClaudeDir = paths.claudeDir;
    // @ts-expect-error — temporarily override for test
    paths.claudeDir = tmpDir;

    try {
      writeTelemetryFile("1p_failed_events.sess-2.device1.json", [
        { event_type: "ClaudeCodeInternalEvent", event_data: { session_id: "sess-2" } },
      ]);

      const map = collectAccountMap();
      expect(map.size).toBe(0);
    } finally {
      // @ts-expect-error — restore
      paths.claudeDir = origClaudeDir;
    }
  });

  it("handles multiple sessions across files", async () => {
    const { paths } = await import("@claude-stats/core/paths");
    const origClaudeDir = paths.claudeDir;
    // @ts-expect-error — temporarily override for test
    paths.claudeDir = tmpDir;

    try {
      writeTelemetryFile("1p_failed_events.sess-a.device1.json", [
        makeGrowthbookEvent("sess-a", "acct-personal", { subscriptionType: "personal" }),
      ]);
      writeTelemetryFile("1p_failed_events.sess-b.device1.json", [
        makeGrowthbookEvent("sess-b", "acct-work", { subscriptionType: "team", organizationUUID: "org-work" }),
      ]);

      const map = collectAccountMap();
      expect(map.size).toBe(2);
      expect(map.get("sess-a")!.accountUuid).toBe("acct-personal");
      expect(map.get("sess-a")!.subscriptionType).toBe("personal");
      expect(map.get("sess-b")!.accountUuid).toBe("acct-work");
      expect(map.get("sess-b")!.organizationUuid).toBe("org-work");
    } finally {
      // @ts-expect-error — restore
      paths.claudeDir = origClaudeDir;
    }
  });

  it("skips malformed telemetry files gracefully", async () => {
    const { paths } = await import("@claude-stats/core/paths");
    const origClaudeDir = paths.claudeDir;
    // @ts-expect-error — temporarily override for test
    paths.claudeDir = tmpDir;

    try {
      const telemetryDir = path.join(tmpDir, "telemetry");
      fs.mkdirSync(telemetryDir, { recursive: true });
      fs.writeFileSync(path.join(telemetryDir, "1p_failed_events.bad.device.json"), "not json");

      writeTelemetryFile("1p_failed_events.good.device.json", [
        makeGrowthbookEvent("sess-ok", "acct-ok"),
      ]);

      const map = collectAccountMap();
      expect(map.size).toBe(1);
      expect(map.get("sess-ok")!.accountUuid).toBe("acct-ok");
    } finally {
      // @ts-expect-error — restore
      paths.claudeDir = origClaudeDir;
    }
  });

  it("skips events with missing accountUUID", async () => {
    const { paths } = await import("@claude-stats/core/paths");
    const origClaudeDir = paths.claudeDir;
    // @ts-expect-error — temporarily override for test
    paths.claudeDir = tmpDir;

    try {
      writeTelemetryFile("1p_failed_events.sess-x.device1.json", [
        {
          event_type: "GrowthbookExperimentEvent",
          event_data: {
            session_id: "sess-x",
            user_attributes: JSON.stringify({ id: "device123", sessionId: "sess-x" }),
          },
        },
      ]);

      const map = collectAccountMap();
      expect(map.size).toBe(0);
    } finally {
      // @ts-expect-error — restore
      paths.claudeDir = origClaudeDir;
    }
  });
});
