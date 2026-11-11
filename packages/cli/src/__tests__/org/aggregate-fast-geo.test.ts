/**
 * The org/team aggregate prices fast-mode and US-geo requests.
 *
 * A `sessions` row carries session totals and a model list, never a per-request
 * `speed` or `inference_geo`, so projecting the row alone prices every token at
 * the standard rate and the team total misses the fast (x2) and US (x1.1)
 * multipliers. `buildAggregatePayload` therefore prices each session from its
 * message rows (`Store.getCostBySession`) and hands the figure to
 * `projectUserAggregates` as `sessionCosts`.
 *
 * Rows go through the real write path (`upsertSession` + `upsertMessages` +
 * `recomputeSessionAggregates`) into a real store and out through the real read
 * path (`buildAggregatePayload`). Fixtures are synthetic. Hand figures, per MTok
 * (Fable 5.2: 8 in / 40 out, fast x2, US x1.1), 1M in + 1M out per request:
 *   standard 48    fast 96    US 52.8    fast + US 105.6
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateCost } from "@claude-stats/core/pricing";
import type { MessageRecord, SessionRecord } from "@claude-stats/core/types";
import { projectUserAggregates } from "../../org/aggregate.js";
import { Store, type SessionRow } from "../../store/index.js";
import { buildAccountMappings, buildAggregatePayload, type PersistedSyncConfig } from "../../sync/index.js";

const ACCOUNT = "acct-fast-geo-test";
const SALT = "c".repeat(64);
const DAY1 = Date.UTC(2026, 0, 15, 12, 0, 0);
const DAY2 = Date.UTC(2026, 0, 16, 12, 0, 0);
const M = 1_000_000;
const FABLE = "claude-fable-5-2";

interface Req {
  readonly session: string;
  readonly at: number;
  readonly speed: "standard" | "fast";
  readonly geo: "global" | "us";
}

/** day 1: session 1 standard + fast, session 2 US; day 2: session 3 fast + US. */
const REQUESTS: readonly Req[] = [
  { session: "sess-fastgeo-1", at: DAY1, speed: "standard", geo: "global" },
  { session: "sess-fastgeo-1", at: DAY1 + 1000, speed: "fast", geo: "global" },
  { session: "sess-fastgeo-2", at: DAY1 + 2000, speed: "standard", geo: "us" },
  { session: "sess-fastgeo-3", at: DAY2, speed: "fast", geo: "us" },
];

const DAY1_EXACT = 48 + 96 + 52.8;
const DAY2_EXACT = 105.6;
/** What the standard-only pricing of the same tokens gives: 3 requests, then 1. */
const DAY1_STANDARD = 3 * 48;
const DAY2_STANDARD = 48;

function makeSession(sessionId: string, at: number): SessionRecord {
  return {
    sessionId,
    projectPath: "/home/dev/repos/example-project",
    sourceFile: `/home/dev/.claude/projects/example/${sessionId}.jsonl`,
    firstTimestamp: at,
    lastTimestamp: at + 60_000,
    claudeVersion: "2.1.311",
    entrypoint: "claude",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 1,
    assistantMessageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: [],
    repoUrl: null,
    accountUuid: ACCOUNT,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: 60_000,
    medianResponseTimeMs: null,
  };
}

function makeMessage(uuid: string, r: Req): MessageRecord {
  return {
    uuid,
    sessionId: r.session,
    timestamp: r.at,
    claudeVersion: "2.1.311",
    model: FABLE,
    stopReason: "end_turn",
    inputTokens: M,
    outputTokens: M,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools: [],
    filePaths: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: r.geo,
    speed: r.speed,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: null,
    toolErrorCount: 0,
    isTurnStart: false,
  };
}

function persistedConfig(): PersistedSyncConfig {
  return {
    endpoint: "https://example.invalid/graphql",
    userPoolId: "us-east-1_test",
    clientId: "test-client",
    region: "us-east-1",
    userSalt: SALT,
    accountMappings: buildAccountMappings([{ accountUuid: ACCOUNT, label: "test" }], SALT),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function withStore<T>(fn: (store: Store) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cs-agg-fast-geo-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  try {
    const ids = [...new Set(REQUESTS.map((r) => r.session))];
    for (const id of ids) {
      store.upsertSession(makeSession(id, REQUESTS.find((r) => r.session === id)!.at));
    }
    store.upsertMessages(REQUESTS.map((r, i) => makeMessage(`m-${i}`, r)));
    store.recomputeSessionAggregates(ids);
    return fn(store);
  } finally {
    store.close();
  }
}

/** The sum of the per-request prices, each priced with its own speed and geo. */
function sumOfRequestPrices(reqs: readonly Req[]): number {
  return reqs.reduce(
    (t, r) =>
      t +
      estimateCost(FABLE, M, M, 0, 0, undefined, undefined, {
        speed: r.speed,
        inferenceGeo: r.geo === "us" ? "us" : null,
      }).cost,
    0,
  );
}

describe("org aggregate prices fast mode and US geo", () => {
  it("the hand figures agree with the pricing module (fixture sanity)", () => {
    expect(sumOfRequestPrices(REQUESTS.filter((r) => r.at < DAY2))).toBeCloseTo(DAY1_EXACT, 6);
    expect(sumOfRequestPrices(REQUESTS.filter((r) => r.at >= DAY2))).toBeCloseTo(DAY2_EXACT, 6);
  });

  it("each day's estimatedCost equals the sum of its per-request prices", () => {
    const payload = withStore((store) => buildAggregatePayload(store, persistedConfig(), "day"));
    expect(payload.map((p) => p.period)).toEqual(["2026-01-15", "2026-01-16"]);
    expect(payload[0]!.estimatedCost).toBeCloseTo(DAY1_EXACT, 2);
    expect(payload[1]!.estimatedCost).toBeCloseTo(DAY2_EXACT, 2);
    const total = payload.reduce((t, p) => t + (p.estimatedCost ?? 0), 0);
    expect(total).toBeCloseTo(sumOfRequestPrices(REQUESTS), 2);
  });

  it("is NOT the standard-rate figure (fails if the speed and geo options are dropped)", () => {
    const payload = withStore((store) => buildAggregatePayload(store, persistedConfig(), "day"));
    expect(payload[0]!.estimatedCost).not.toBeCloseTo(DAY1_STANDARD, 2);
    expect(payload[1]!.estimatedCost).not.toBeCloseTo(DAY2_STANDARD, 2);
    // 196.8 vs 144 and 105.6 vs 48: the gap is the multipliers, in full.
    expect(payload[0]!.estimatedCost! - DAY1_STANDARD).toBeCloseTo(DAY1_EXACT - DAY1_STANDARD, 2);
  });

  it("no session id reaches the payload (the id is only a lookup key for the cost)", () => {
    const payload = withStore((store) => buildAggregatePayload(store, persistedConfig(), "day"));
    expect(JSON.stringify(payload)).not.toContain("sess-fastgeo");
  });

  it("session tokens are unchanged: only the cost reads the per-request rows", () => {
    const payload = withStore((store) => buildAggregatePayload(store, persistedConfig(), "day"));
    expect(payload[0]!.inputTokens).toBe(3 * M);
    expect(payload[1]!.inputTokens).toBe(M);
  });
});

describe("projectUserAggregates with sessionCosts", () => {
  function row(sessionId: string): SessionRow {
    return {
      session_id: sessionId,
      project_path: "/home/dev/repos/example-project",
      source_file: `/home/dev/.claude/projects/example/${sessionId}.jsonl`,
      first_timestamp: DAY1,
      last_timestamp: DAY1 + 60_000,
      claude_version: "2.1.311",
      entrypoint: "cli",
      git_branch: "main",
      is_interactive: 1,
      prompt_count: 1,
      assistant_message_count: 1,
      input_tokens: M,
      output_tokens: M,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      web_search_requests: 0,
      web_fetch_requests: 0,
      tool_use_counts: "[]",
      models: JSON.stringify([FABLE]),
      repo_url: null,
      account_uuid: ACCOUNT,
      organization_uuid: null,
      subscription_type: null,
      thinking_blocks: 0,
      parent_session_id: null,
      is_subagent: 0,
      source_deleted: 0,
      throttle_events: 0,
      active_duration_ms: 60_000,
      median_response_time_ms: null,
    };
  }
  const OPTS = { accountId: "acct-hash" } as const;

  it("uses the supplied exact cost for a session that has one", () => {
    const out = projectUserAggregates([row("a")], { ...OPTS, sessionCosts: new Map([["a", 96]]) });
    expect(out[0]!.estimatedCost).toBe(96);
  });

  it("falls back to the row-level standard estimate for a session without one", () => {
    const out = projectUserAggregates([row("a"), row("b")], { ...OPTS, sessionCosts: new Map([["a", 96]]) });
    expect(out[0]!.estimatedCost).toBe(144); // 96 exact + 48 standard
  });

  it("is unchanged when no sessionCosts are supplied", () => {
    expect(projectUserAggregates([row("a")], OPTS)[0]!.estimatedCost).toBe(48);
  });

  it("an exact cost of zero (an unpriced session) is kept, not replaced by the fallback", () => {
    const out = projectUserAggregates([row("a")], { ...OPTS, sessionCosts: new Map([["a", 0]]) });
    expect(out[0]!.estimatedCost).toBe(0);
  });
});
