import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { decodeHtmlEntities, sanitizePromptText } from "@claude-stats/core/sanitize";

// The dashboard reads the *current* account from ~/.claude.json via
// readClaudeAccount(); mock it so "current-acct" is current and every other
// account must fall back to its persisted emailLabel.
vi.mock("../account.js", () => ({
  readClaudeAccount: () => ({ accountUuid: "current-acct", emailAddress: "current@example.com" }),
}));

import { Store } from "../store/index.js";
import { buildDashboard } from "../dashboard/index.js";
import type { SessionRecord } from "@claude-stats/core/types";

// ── Bug #1: prompt previews leaked stored HTML entities (&lt;/&gt;) ──────────
describe("decodeHtmlEntities — display-boundary inverse of sanitizePromptText", () => {
  it("round-trips a sanitized string back to its literal form", () => {
    const raw = "run <task-notification> & <task-id>abc</task-id>";
    const escaped = sanitizePromptText(raw);
    expect(escaped).toContain("&lt;task-notification&gt;");
    expect(decodeHtmlEntities(escaped)).toBe(raw);
  });

  it("strips a full <task-notification> system block so it is not a 'task' label", () => {
    const raw =
      "Fix the parser bug\n<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>";
    expect(sanitizePromptText(raw)).toBe("Fix the parser bug");
  });

  it("decodes entities first and &amp; last so a literal &lt; survives", () => {
    // A user who literally typed the five characters "&lt;" gets it stored as
    // "&amp;lt;"; decoding must yield "&lt;", not collapse to "<".
    expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
  });

  it("handles the three escaped characters and only those", () => {
    expect(decodeHtmlEntities("a &lt; b &gt; c &amp; d")).toBe("a < b > c & d");
    // Quotes are never escaped by sanitizePromptText, so they pass through.
    expect(decodeHtmlEntities('say "hi"')).toBe('say "hi"');
  });

  it("returns an empty string for null/undefined/empty", () => {
    expect(decodeHtmlEntities(null)).toBe("");
    expect(decodeHtmlEntities(undefined)).toBe("");
    expect(decodeHtmlEntities("")).toBe("");
  });
});

// ── Bug #2: non-current accounts showed a truncated UUID instead of email ────
describe("buildDashboard — account email falls back to stored emailLabel", () => {
  let store: Store;
  let dbPath: string;
  const T0 = 1_700_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  function makeSession(over: Partial<SessionRecord>): SessionRecord {
    return {
      sessionId: "s", projectPath: "/Users/alice/repos/p",
      sourceFile: "/Users/alice/.claude/projects/p/s.jsonl",
      firstTimestamp: T0 + DAY, lastTimestamp: T0 + DAY + 3_600_000,
      claudeVersion: "2.1.70", entrypoint: "claude", gitBranch: "main",
      permissionMode: "default", isInteractive: true, promptCount: 3,
      assistantMessageCount: 3, inputTokens: 1000, outputTokens: 200,
      cacheCreationTokens: 0, cacheReadTokens: 0, webSearchRequests: 0,
      webFetchRequests: 0, toolUseCounts: [], models: ["claude-sonnet-4"],
      repoUrl: null, accountUuid: null, organizationUuid: null,
      subscriptionType: null, thinkingBlocks: 0, parentSessionId: null,
      isSubagent: false, sourceDeleted: false, throttleEvents: 0,
      activeDurationMs: null, medianResponseTimeMs: null, ...over,
    };
  }

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-emailfix-${process.pid}-${T0}.db`);
    fs.rmSync(dbPath, { force: true });
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
  });

  function ymd(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  it("shows the persisted emailLabel for an account that is not the current one", () => {
    store.upsertSession(makeSession({ sessionId: "s-current", accountUuid: "current-acct" }));
    store.upsertSession(makeSession({ sessionId: "s-other", accountUuid: "other-acct" }));
    // "other-acct" was current at some point in the past → its email was persisted.
    store.upsertAccount({
      accountUuid: "other-acct", organizationUuid: null,
      emailHash: null, emailLabel: "other@example.com",
      organizationType: null, rateLimitTier: null, userRateLimitTier: null,
      seatTier: null, billingType: null, subscriptionType: "team_premium",
      firstObservedAt: T0, lastObservedAt: T0 + DAY,
    });

    const data = buildDashboard(store, { since: ymd(T0), until: ymd(T0 + 2 * DAY), timezone: "UTC" });

    const byUuid = new Map(data.availableAccounts.map((a) => [a.accountUuid, a]));
    // The bug: this used to be null → the template rendered the truncated UUID.
    expect(byUuid.get("other-acct")?.emailAddress).toBe("other@example.com");
    // The current account still resolves from the live ~/.claude.json value.
    expect(byUuid.get("current-acct")?.emailAddress).toBe("current@example.com");
  });
});
