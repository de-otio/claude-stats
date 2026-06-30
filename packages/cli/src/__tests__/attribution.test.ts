/**
 * Attribution engine tests (Phase 2 A) — Unit A.
 *
 * Covers the PURE interval + assignment functions and the clock-injected
 * writer / reattribute orchestrator. Determinism: every timestamp comes from a
 * FIXED clock; no `Date.now()` anywhere. Confidentiality: all account/session
 * shapes come from `__tests__/fixtures/accounts.ts` (00000000- UUIDs,
 * @example.com), never real `~/.claude*` values.
 *
 * Property tests use a small seeded deterministic generator (a self-contained
 * LCG) instead of fast-check, which is not a project dependency (ASSUMPTIONS
 * #29). The generator is seeded so failures reproduce exactly.
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { buildCliIntervals, intervalAt } from "../attribution/intervals.js";
import { assignAccounts } from "../attribution/assign.js";
import type { ExternalAccountInfo } from "../attribution/assign.js";
import { writeObservation, hashEmail } from "../attribution/observer.js";
import { reattribute } from "../attribution/reattribute.js";
import { Store } from "../store/index.js";
import type { SessionRow } from "../store/index.js";
import type { AccountObservation } from "@claude-stats/core/types";
import {
  ACCOUNT_A_UUID,
  ACCOUNT_B_UUID,
  ORG_A_UUID,
  makeSessionRow,
} from "./fixtures/accounts.js";

// ── helpers ───────────────────────────────────────────────────────────────────

/** A fixed clock factory: returns the same epoch-ms on every call. */
function fixedClock(ms: number): () => number {
  return () => ms;
}

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function obs(
  accountUuid: string,
  observedAt: number,
  surface: string | null = "cli",
): AccountObservation {
  return {
    accountUuid,
    observedAt,
    source: "collect",
    surface,
    rateLimitTier: null,
    billingType: null,
  };
}

function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `cs-attr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

// ── intervals: disjoint cover ─────────────────────────────────────────────────

describe("buildCliIntervals", () => {
  it("returns [] for no CLI observations", () => {
    expect(buildCliIntervals([])).toEqual([]);
    // non-CLI surfaces are filtered out → still empty
    expect(
      buildCliIntervals([obs(ACCOUNT_A_UUID, T0, "claude-vscode")]),
    ).toEqual([]);
  });

  it("produces disjoint, time-sorted, gap-free intervals with final end=Infinity", () => {
    const ivs = buildCliIntervals([
      obs(ACCOUNT_A_UUID, T0),
      obs(ACCOUNT_B_UUID, T0 + 2 * HOUR),
      obs(ACCOUNT_A_UUID, T0 + 5 * HOUR),
    ]);
    expect(ivs).toEqual([
      { start: T0, end: T0 + 2 * HOUR, accountUuid: ACCOUNT_A_UUID },
      { start: T0 + 2 * HOUR, end: T0 + 5 * HOUR, accountUuid: ACCOUNT_B_UUID },
      { start: T0 + 5 * HOUR, end: Infinity, accountUuid: ACCOUNT_A_UUID },
    ]);
    // disjoint + contiguous: each interval's end == next interval's start
    for (let i = 0; i < ivs.length - 1; i++) {
      expect(ivs[i]!.end).toBe(ivs[i + 1]!.start);
      expect(ivs[i]!.start).toBeLessThan(ivs[i]!.end);
    }
  });

  it("dedupes consecutive same-account observations into one interval", () => {
    const ivs = buildCliIntervals([
      obs(ACCOUNT_A_UUID, T0),
      obs(ACCOUNT_A_UUID, T0 + HOUR),
      obs(ACCOUNT_A_UUID, T0 + 2 * HOUR),
      obs(ACCOUNT_B_UUID, T0 + 3 * HOUR),
    ]);
    expect(ivs).toEqual([
      { start: T0, end: T0 + 3 * HOUR, accountUuid: ACCOUNT_A_UUID },
      { start: T0 + 3 * HOUR, end: Infinity, accountUuid: ACCOUNT_B_UUID },
    ]);
  });

  it("only considers CLI surfaces (cli, claude); ignores others", () => {
    const ivs = buildCliIntervals([
      obs(ACCOUNT_A_UUID, T0, "claude"),
      obs(ACCOUNT_B_UUID, T0 + HOUR, "claude-vscode"), // ignored
      obs(ACCOUNT_B_UUID, T0 + 2 * HOUR, "vscode"), // ignored
    ]);
    expect(ivs).toEqual([
      { start: T0, end: Infinity, accountUuid: ACCOUNT_A_UUID },
    ]);
  });

  it("sorts unsorted observations before building", () => {
    const ivs = buildCliIntervals([
      obs(ACCOUNT_B_UUID, T0 + 2 * HOUR),
      obs(ACCOUNT_A_UUID, T0),
    ]);
    expect(ivs[0]!.accountUuid).toBe(ACCOUNT_A_UUID);
    expect(ivs[1]!.accountUuid).toBe(ACCOUNT_B_UUID);
  });
});

describe("intervalAt", () => {
  const ivs = buildCliIntervals([
    obs(ACCOUNT_A_UUID, T0),
    obs(ACCOUNT_B_UUID, T0 + 2 * HOUR),
  ]);

  it("finds the covering interval (start inclusive, end exclusive)", () => {
    expect(intervalAt(ivs, T0)!.accountUuid).toBe(ACCOUNT_A_UUID);
    expect(intervalAt(ivs, T0 + HOUR)!.accountUuid).toBe(ACCOUNT_A_UUID);
    // boundary is exclusive on the left interval, inclusive on the right
    expect(intervalAt(ivs, T0 + 2 * HOUR)!.accountUuid).toBe(ACCOUNT_B_UUID);
    expect(intervalAt(ivs, T0 + 100 * HOUR)!.accountUuid).toBe(ACCOUNT_B_UUID);
  });

  it("returns null before the first interval", () => {
    expect(intervalAt(ivs, T0 - 1)).toBeNull();
  });
});

// ── assign: precedence ────────────────────────────────────────────────────────

describe("assignAccounts — precedence", () => {
  const ivs = buildCliIntervals([obs(ACCOUNT_A_UUID, T0)]);

  function tel(accountUuid: string): Map<string, ExternalAccountInfo> {
    return new Map([
      ["s1", { accountUuid, organizationUuid: null, subscriptionType: "team_standard" }],
    ]);
  }
  function otel(accountUuid: string): Map<string, ExternalAccountInfo> {
    return new Map([
      ["s1", { accountUuid, organizationUuid: ORG_A_UUID, subscriptionType: "team_premium" }],
    ]);
  }

  it("otel beats telemetry beats observation", () => {
    const cli = makeSessionRow({ session_id: "s1", entrypoint: "cli", first_timestamp: T0 + HOUR });

    // observation only
    let r = assignAccounts({ sessions: [cli], intervals: ivs, telemetryMap: new Map() });
    expect(r.assignments.get("s1")).toMatchObject({ source: "observation", confidence: "high", accountUuid: ACCOUNT_A_UUID });

    // telemetry beats observation
    r = assignAccounts({ sessions: [cli], intervals: ivs, telemetryMap: tel(ACCOUNT_B_UUID) });
    expect(r.assignments.get("s1")).toMatchObject({ source: "telemetry", confidence: "high", accountUuid: ACCOUNT_B_UUID });

    // otel beats telemetry
    r = assignAccounts({ sessions: [cli], intervals: ivs, telemetryMap: tel(ACCOUNT_B_UUID), otelMap: otel(ACCOUNT_A_UUID) });
    expect(r.assignments.get("s1")).toMatchObject({ source: "otel", confidence: "authoritative", accountUuid: ACCOUNT_A_UUID });
  });
});

// ── assign: SURFACE ALLOWLIST ─────────────────────────────────────────────────

describe("assignAccounts — surface allowlist", () => {
  const ivs = buildCliIntervals([obs(ACCOUNT_A_UUID, T0)]);

  it("CLI surfaces (cli, claude) get the interval (observation/high)", () => {
    for (const entrypoint of ["cli", "claude"]) {
      const s = makeSessionRow({ session_id: "x", entrypoint, first_timestamp: T0 + HOUR });
      const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
      expect(r.assignments.get("x")).toMatchObject({
        source: "observation",
        confidence: "high",
        accountUuid: ACCOUNT_A_UUID,
      });
    }
  });

  it("non-CLI surfaces NEVER get the interval → unknown/none", () => {
    for (const entrypoint of ["claude-vscode", "vscode", "claude-desktop", "some-unknown-entry"]) {
      const s = makeSessionRow({ session_id: "x", entrypoint, first_timestamp: T0 + HOUR });
      const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
      expect(r.assignments.get("x")).toMatchObject({
        source: "unknown",
        confidence: "none",
        accountUuid: "",
      });
    }
  });

  it("non-CLI surface still gets otel/telemetry when present", () => {
    const s = makeSessionRow({ session_id: "x", entrypoint: "claude-vscode", first_timestamp: T0 + HOUR });
    const tmap = new Map<string, ExternalAccountInfo>([
      ["x", { accountUuid: ACCOUNT_B_UUID, organizationUuid: null, subscriptionType: null }],
    ]);
    const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: tmap });
    expect(r.assignments.get("x")).toMatchObject({ source: "telemetry", accountUuid: ACCOUNT_B_UUID });
  });

  it("null entrypoint → unknown", () => {
    const s = makeSessionRow({ session_id: "x", entrypoint: null, first_timestamp: T0 + HOUR });
    const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
    expect(r.assignments.get("x")).toMatchObject({ source: "unknown", confidence: "none" });
  });

  it("CLI surface but session precedes first interval → unknown", () => {
    const s = makeSessionRow({ session_id: "x", entrypoint: "cli", first_timestamp: T0 - HOUR });
    const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
    expect(r.assignments.get("x")).toMatchObject({ source: "unknown", confidence: "none" });
  });
});

// ── assign: straddle ──────────────────────────────────────────────────────────

describe("assignAccounts — straddle", () => {
  // A active [T0, T0+2h), B active [T0+2h, ∞)
  const ivs = buildCliIntervals([
    obs(ACCOUNT_A_UUID, T0),
    obs(ACCOUNT_B_UUID, T0 + 2 * HOUR),
  ]);

  it("attributes the session to the interval covering first_timestamp", () => {
    const s = makeSessionRow({
      session_id: "straddle",
      entrypoint: "cli",
      first_timestamp: T0 + HOUR, // in A's interval
      last_timestamp: T0 + 3 * HOUR, // extends into B's interval
    });
    const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
    expect(r.assignments.get("straddle")).toMatchObject({
      source: "observation",
      confidence: "high",
      accountUuid: ACCOUNT_A_UUID,
    });
  });

  it("emits a per-message override for the crossed boundary", () => {
    const s = makeSessionRow({
      session_id: "straddle",
      entrypoint: "cli",
      first_timestamp: T0 + HOUR,
      last_timestamp: T0 + 3 * HOUR,
    });
    const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
    expect(r.messageOverrides).toEqual([
      { sessionId: "straddle", boundaryFrom: T0 + 2 * HOUR, accountUuid: ACCOUNT_B_UUID },
    ]);
  });

  it("no override when the session stays within one interval", () => {
    const s = makeSessionRow({
      session_id: "single",
      entrypoint: "cli",
      first_timestamp: T0 + HOUR,
      last_timestamp: T0 + 90 * 60 * 1000, // still < T0+2h
    });
    const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
    expect(r.messageOverrides).toEqual([]);
  });

  it("no override when straddle re-enters the SAME account", () => {
    // A [T0,T0+2h), B [T0+2h,T0+4h), A [T0+4h,∞)
    const ivs2 = buildCliIntervals([
      obs(ACCOUNT_A_UUID, T0),
      obs(ACCOUNT_B_UUID, T0 + 2 * HOUR),
      obs(ACCOUNT_A_UUID, T0 + 4 * HOUR),
    ]);
    const s = makeSessionRow({
      session_id: "x",
      entrypoint: "cli",
      first_timestamp: T0 + HOUR, // A
      last_timestamp: T0 + 5 * HOUR, // crosses into B then back to A
    });
    const r = assignAccounts({ sessions: [s], intervals: ivs2, telemetryMap: new Map() });
    // boundary into B is a different account → one override; the later A
    // boundary matches the start account so it is not emitted.
    expect(r.messageOverrides).toEqual([
      { sessionId: "x", boundaryFrom: T0 + 2 * HOUR, accountUuid: ACCOUNT_B_UUID },
    ]);
  });
});

// ── monotonic: re-apply never lowers/overwrites strong sources ────────────────

describe("applyAttribution monotonicity (store guard)", () => {
  function freshStore(): { store: Store; dbPath: string } {
    const dbPath = tmpDbPath();
    return { store: new Store(dbPath), dbPath };
  }

  function insertSession(store: Store, row: Partial<SessionRow>): void {
    // Use the public upsertSession path via a minimal SessionRecord-shaped obj.
    const r = makeSessionRow(row);
    store.upsertSession({
      sessionId: r.session_id,
      projectPath: r.project_path,
      sourceFile: r.source_file,
      firstTimestamp: r.first_timestamp,
      lastTimestamp: r.last_timestamp,
      claudeVersion: r.claude_version,
      entrypoint: r.entrypoint,
      gitBranch: r.git_branch,
      permissionMode: null,
      isInteractive: r.is_interactive === 1,
      promptCount: r.prompt_count,
      assistantMessageCount: r.assistant_message_count,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheCreationTokens: r.cache_creation_tokens,
      cacheReadTokens: r.cache_read_tokens,
      webSearchRequests: r.web_search_requests,
      webFetchRequests: r.web_fetch_requests,
      toolUseCounts: [],
      models: [],
      repoUrl: r.repo_url,
      accountUuid: r.account_uuid,
      organizationUuid: r.organization_uuid,
      subscriptionType: r.subscription_type,
      thinkingBlocks: r.thinking_blocks,
      parentSessionId: r.parent_session_id,
      isSubagent: r.is_subagent === 1,
      sourceDeleted: r.source_deleted === 1,
      throttleEvents: r.throttle_events,
      activeDurationMs: r.active_duration_ms,
      medianResponseTimeMs: r.median_response_time_ms,
    });
  }

  it("does not overwrite an otel-attributed row with a weaker observation", () => {
    const { store, dbPath } = freshStore();
    try {
      insertSession(store, { session_id: "s1", entrypoint: "cli", first_timestamp: T0 });

      // First: otel/authoritative for ACCOUNT_B
      store.applyAttribution(
        new Map([
          ["s1", { accountUuid: ACCOUNT_B_UUID, organizationUuid: null, subscriptionType: null, source: "otel", confidence: "authoritative" }],
        ]),
        fixedClock(T0),
      );

      // Then: weaker observation for ACCOUNT_A — must NOT overwrite
      const changed = store.applyAttribution(
        new Map([
          ["s1", { accountUuid: ACCOUNT_A_UUID, organizationUuid: null, subscriptionType: null, source: "observation", confidence: "high" }],
        ]),
        fixedClock(T0 + HOUR),
      );
      expect(changed).toBe(0);

      const row = store.getSessions({ includeCI: true, includeDeleted: true })
        .find((s) => s.session_id === "s1")!;
      expect(row.account_uuid).toBe(ACCOUNT_B_UUID);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("re-applying the same observation is idempotent (no further change)", () => {
    const { store, dbPath } = freshStore();
    try {
      insertSession(store, { session_id: "s1", entrypoint: "cli", first_timestamp: T0 });
      const m = new Map([
        ["s1", { accountUuid: ACCOUNT_A_UUID, organizationUuid: null, subscriptionType: null, source: "observation", confidence: "high" }],
      ]);
      expect(store.applyAttribution(m, fixedClock(T0))).toBe(1);
      // high-confidence observation is no longer in the (low|medium) updatable
      // set, so a re-apply changes nothing.
      expect(store.applyAttribution(m, fixedClock(T0 + HOUR))).toBe(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── reset predicate ───────────────────────────────────────────────────────────

describe("resetAttributableSessions predicate", () => {
  it("resets NULL-source + weak rows, preserves strong sources", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      const mk = (id: string, ep: string): void => {
        const r = makeSessionRow({ session_id: id, entrypoint: ep, first_timestamp: T0 });
        store.upsertSession({
          sessionId: r.session_id, projectPath: r.project_path, sourceFile: r.source_file,
          firstTimestamp: r.first_timestamp, lastTimestamp: r.last_timestamp,
          claudeVersion: r.claude_version, entrypoint: r.entrypoint, gitBranch: r.git_branch,
          permissionMode: null, isInteractive: true, promptCount: 0, assistantMessageCount: 0,
          inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
          webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: [], repoUrl: null,
          accountUuid: null, organizationUuid: null, subscriptionType: null, thinkingBlocks: 0,
          parentSessionId: null, isSubagent: false, sourceDeleted: false, throttleEvents: 0,
          activeDurationMs: null, medianResponseTimeMs: null,
        });
      };
      mk("nullsrc", "cli"); // account_source NULL → reset-eligible
      mk("obs", "cli");
      mk("otel", "cli");

      // Strong: otel — preserved. Weak: observation high — also reset-eligible
      // per the predicate (source NOT IN strong set).
      store.applyAttribution(new Map([
        ["otel", { accountUuid: ACCOUNT_B_UUID, organizationUuid: null, subscriptionType: null, source: "otel", confidence: "authoritative" }],
        ["obs", { accountUuid: ACCOUNT_A_UUID, organizationUuid: null, subscriptionType: null, source: "observation", confidence: "high" }],
      ]), fixedClock(T0));

      const reset = store.resetAttributableSessions();
      // nullsrc (1) + obs (1) reset; otel preserved.
      expect(reset).toBe(2);

      const rows = store.getSessions({ includeCI: true, includeDeleted: true });
      const otel = rows.find((s) => s.session_id === "otel")!;
      const obsRow = rows.find((s) => s.session_id === "obs")!;
      expect(otel.account_uuid).toBe(ACCOUNT_B_UUID);
      expect(obsRow.account_uuid).toBeNull();
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── writeObservation ──────────────────────────────────────────────────────────

describe("writeObservation", () => {
  const account = {
    accountUuid: ACCOUNT_A_UUID,
    emailAddress: "a@example.com",
    organizationUuid: ORG_A_UUID,
    organizationType: "team",
    organizationRateLimitTier: "default_team",
    userRateLimitTier: "default_team",
    seatTier: "team_premium",
    billingType: "team",
    hasExtraUsageEnabled: false,
  };

  it("no-ops on null account", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      expect(writeObservation(store, null, fixedClock(T0))).toBe(false);
      expect(store.getAccountObservations("cli")).toEqual([]);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("records on first sighting and dedupes unchanged account", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      expect(writeObservation(store, account, fixedClock(T0))).toBe(true);
      let obsRows = store.getAccountObservations("cli");
      expect(obsRows).toHaveLength(1);
      expect(obsRows[0]).toMatchObject({ accountUuid: ACCOUNT_A_UUID, surface: "cli", observedAt: T0 });

      // same account again → deduped, no new observation row
      expect(writeObservation(store, account, fixedClock(T0 + HOUR))).toBe(false);
      obsRows = store.getAccountObservations("cli");
      expect(obsRows).toHaveLength(1);

      // accounts metadata row exists with email hashed (not raw)
      const known = store.listAccountsFull();
      expect(known).toHaveLength(1);
      expect(known[0]!.emailHash).toBe(hashEmail("a@example.com"));
      expect(known[0]!.emailLabel).toBe("a@example.com");
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("records a new observation when the account changes", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      writeObservation(store, account, fixedClock(T0));
      const accountB = { ...account, accountUuid: ACCOUNT_B_UUID, emailAddress: "b@example.com" };
      expect(writeObservation(store, accountB, fixedClock(T0 + HOUR))).toBe(true);
      const obsRows = store.getAccountObservations("cli");
      expect(obsRows.map((o) => o.accountUuid)).toEqual([ACCOUNT_A_UUID, ACCOUNT_B_UUID]);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

describe("hashEmail", () => {
  it("is case/whitespace-insensitive and stable", () => {
    expect(hashEmail("A@Example.com")).toBe(hashEmail("  a@example.com "));
    expect(hashEmail("a@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── reattribute (dry-run vs real) ─────────────────────────────────────────────

describe("reattribute", () => {
  function seedSession(store: Store, id: string, ep: string, ts: number): void {
    const r = makeSessionRow({ session_id: id, entrypoint: ep, first_timestamp: ts, last_timestamp: ts + 1000 });
    store.upsertSession({
      sessionId: r.session_id, projectPath: r.project_path, sourceFile: r.source_file,
      firstTimestamp: r.first_timestamp, lastTimestamp: r.last_timestamp,
      claudeVersion: r.claude_version, entrypoint: r.entrypoint, gitBranch: r.git_branch,
      permissionMode: null, isInteractive: true, promptCount: 1, assistantMessageCount: 1,
      inputTokens: 10, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0,
      webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: [], repoUrl: null,
      accountUuid: null, organizationUuid: null, subscriptionType: null, thinkingBlocks: 0,
      parentSessionId: null, isSubagent: false, sourceDeleted: false, throttleEvents: 0,
      activeDurationMs: null, medianResponseTimeMs: null,
    });
  }

  it("dry-run computes counts WITHOUT writing or backing up", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      seedSession(store, "c1", "cli", T0 + HOUR);
      seedSession(store, "v1", "claude-vscode", T0 + HOUR);
      store.recordAccountObservation(obs(ACCOUNT_A_UUID, T0));

      const summary = reattribute(store, { dryRun: true, dbPath }, fixedClock(T0 + 2 * HOUR));
      expect(summary.dryRun).toBe(true);
      expect(summary.backupPath).toBeNull();
      expect(summary.resetCount).toBe(0); // not executed
      // cli session → observation; vscode → unknown (not applied)
      expect(summary.bySource.observation).toBe(1);
      expect(summary.bySource.unknown).toBe(1);
      expect(summary.changed).toBe(1);

      // nothing written
      const c1 = store.getSessions({ includeCI: true, includeDeleted: true }).find((s) => s.session_id === "c1")!;
      expect(c1.account_uuid).toBeNull();

      // no backup file created
      expect(fs.existsSync(`${dbPath}.pre-reattribute-${T0 + 2 * HOUR}`)).toBe(false);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("real run backs up, applies, and recomputes windows", () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    const backupTs = T0 + 5 * HOUR;
    try {
      seedSession(store, "c1", "cli", T0 + HOUR);
      seedSession(store, "v1", "claude-vscode", T0 + HOUR);
      store.recordAccountObservation(obs(ACCOUNT_A_UUID, T0));

      const summary = reattribute(store, { dryRun: false, dbPath }, fixedClock(backupTs));
      expect(summary.dryRun).toBe(false);
      expect(summary.backupPath).toBe(`${dbPath}.pre-reattribute-${backupTs}`);
      expect(fs.existsSync(summary.backupPath!)).toBe(true);
      expect(summary.changed).toBe(1); // only the cli session

      const rows = store.getSessions({ includeCI: true, includeDeleted: true });
      expect(rows.find((s) => s.session_id === "c1")!.account_uuid).toBe(ACCOUNT_A_UUID);
      expect(rows.find((s) => s.session_id === "v1")!.account_uuid).toBeNull();

      // backup cleanup
      fs.rmSync(summary.backupPath!, { force: true });
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });
});

// ── property tests (seeded deterministic generator; no fast-check) ────────────

/** Tiny seeded LCG → deterministic pseudo-random in [0,1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("property: disjoint cover", () => {
  it("intervals are sorted, non-overlapping, contiguous, final end=Infinity", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rng = lcg(seed);
      const n = 1 + Math.floor(rng() * 8);
      const observations: AccountObservation[] = [];
      let t = T0;
      for (let i = 0; i < n; i++) {
        t += Math.floor(rng() * 5 * HOUR);
        const acct = rng() < 0.5 ? ACCOUNT_A_UUID : ACCOUNT_B_UUID;
        observations.push(obs(acct, t));
      }
      const ivs = buildCliIntervals(observations);
      if (ivs.length === 0) continue;
      for (let i = 0; i < ivs.length; i++) {
        expect(ivs[i]!.start).toBeLessThan(ivs[i]!.end);
        if (i < ivs.length - 1) {
          expect(ivs[i]!.end).toBe(ivs[i + 1]!.start);
          // consecutive intervals are different accounts (deduped)
          expect(ivs[i]!.accountUuid).not.toBe(ivs[i + 1]!.accountUuid);
        } else {
          expect(ivs[i]!.end).toBe(Infinity);
        }
      }
    }
  });
});

describe("property: idempotent assignment", () => {
  it("assignAccounts is a pure function of its inputs", () => {
    const ivs = buildCliIntervals([obs(ACCOUNT_A_UUID, T0), obs(ACCOUNT_B_UUID, T0 + 2 * HOUR)]);
    for (let seed = 1; seed <= 50; seed++) {
      const rng = lcg(seed);
      const surfaces = ["cli", "claude", "claude-vscode", "vscode", "claude-desktop", "weird"];
      const sessions: SessionRow[] = [];
      const n = 1 + Math.floor(rng() * 6);
      for (let i = 0; i < n; i++) {
        sessions.push(makeSessionRow({
          session_id: `p${seed}-${i}`,
          entrypoint: surfaces[Math.floor(rng() * surfaces.length)]!,
          first_timestamp: T0 + Math.floor(rng() * 5 * HOUR),
        }));
      }
      const r1 = assignAccounts({ sessions, intervals: ivs, telemetryMap: new Map() });
      const r2 = assignAccounts({ sessions, intervals: ivs, telemetryMap: new Map() });
      expect([...r2.assignments.entries()]).toEqual([...r1.assignments.entries()]);
    }
  });
});

describe("property: surface-invariance (non-CLI always unknown without otel/telemetry)", () => {
  it("any non-CLI surface yields unknown when no external map matches", () => {
    const ivs = buildCliIntervals([obs(ACCOUNT_A_UUID, T0)]);
    const nonCli = ["claude-vscode", "vscode", "claude-desktop", "x", "y-z", ""];
    for (let seed = 1; seed <= 50; seed++) {
      const rng = lcg(seed);
      const entrypoint = nonCli[Math.floor(rng() * nonCli.length)]!;
      const s = makeSessionRow({
        session_id: "x",
        entrypoint,
        first_timestamp: T0 + Math.floor(rng() * 10 * HOUR),
      });
      const r = assignAccounts({ sessions: [s], intervals: ivs, telemetryMap: new Map() });
      expect(r.assignments.get("x")).toMatchObject({ source: "unknown", confidence: "none" });
    }
  });
});
