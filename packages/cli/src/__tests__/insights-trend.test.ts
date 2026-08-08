/**
 * The cost card's trend arrow.
 *
 * `previousCost` was hardcoded null for the whole of Phase 3, so the card's
 * trend was permanently `unknown` — an honest state, but a permanent one, and
 * a comparison the formatter was built for that nothing ever fed. It is now
 * one extra aggregate read over the preceding window of equal length.
 *
 * What these tests defend is not "an arrow appears" but the choice of
 * BASELINE. A wrong baseline produces a confident arrow pointing the wrong
 * way, which is worse than no arrow: it is the I1 failure exactly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../store/index.js";
import { buildDashboard, attachInsights } from "../dashboard/index.js";
import { buildInsightAnswers } from "../server/insights.js";
import type { Config } from "../config.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import { t } from "../i18n.js";
import os from "os";
import path from "path";
import fs from "fs";

// `since`/`until` are inclusive YYYY-MM-DD days, so this pair is the window
// [Mar 13 00:00Z, Mar 15 00:00Z) — two days. Its equal-length predecessor is
// [Mar 11 00:00Z, Mar 13 00:00Z). Both are in the past relative to any real
// clock, so `periodRange`'s future-clamp never moves them and the arithmetic
// is the same on every run.
const RANGE = { since: "2026-03-13", until: "2026-03-14" } as const;
const AT_CURRENT = Date.parse("2026-03-13T12:00:00.000Z");
const AT_PREVIOUS = Date.parse("2026-03-12T12:00:00.000Z");
const AT_ANCIENT = Date.parse("2026-03-05T12:00:00.000Z");

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-trend-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function session(id: string, at: number, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id,
    projectPath: "/w/project-x",
    sourceFile: `/w/${id}.jsonl`,
    firstTimestamp: at,
    lastTimestamp: at + 1000,
    claudeVersion: "2.1.70",
    entrypoint: "claude",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 1,
    assistantMessageCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-sonnet-4"],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: null,
    medianResponseTimeMs: null,
    ...over,
  } as SessionRecord;
}

function message(uuid: string, sessionId: string, at: number, outputTokens: number, over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid,
    sessionId,
    timestamp: at,
    claudeVersion: "2.1.70",
    model: "claude-sonnet-4",
    stopReason: "end_turn",
    inputTokens: 0,
    outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: null,
    ...over,
  };
}

const CONFIG: Config = {};

describe("cost card trend — the preceding window of equal length", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  });

  /** Seed one message at `at` with `outputTokens` worth of cost. */
  function seed(id: string, at: number, outputTokens: number): void {
    store.upsertSession(session(id, at));
    store.upsertMessages([message(`${id}-m`, id, at, outputTokens)]);
  }

  function insightsFor(extra: Record<string, unknown> = {}) {
    const opts = { timezone: "UTC", ...RANGE, ...extra };
    const data = attachInsights(store, buildDashboard(store, opts), opts, CONFIG);
    return data.insights!;
  }

  function costAnswer(extra: Record<string, unknown> = {}) {
    const opts = { timezone: "UTC", ...RANGE, ...extra };
    const data = attachInsights(store, buildDashboard(store, opts), opts, CONFIG);
    return buildInsightAnswers(data, {
      t,
      vocabulary: "metered",
      currency: "USD",
      hourlyRate: null,
      verdictSentence: null,
    })[0]!;
  }

  it("compares against the equal-length window immediately before, not the same calendar period", () => {
    // Current window: the 2 days ending NOW. Previous: the 2 days before that.
    // The day BEFORE the previous window is deliberately huge — a baseline
    // that reached back further, or snapped to a calendar month, would pick
    // it up and invert the arrow.
    seed("cur", AT_CURRENT, 1_000_000);
    seed("prev", AT_PREVIOUS, 500_000);
    seed("ancient", AT_ANCIENT, 90_000_000);

    const ins = insightsFor();
    expect(ins.previousCost).not.toBeNull();
    // The previous window saw HALF the current window's output tokens, so the
    // baseline is about half the headline — and nowhere near the ancient spike,
    // which a wider or calendar-snapped baseline would have swept in.
    expect(ins.previousCost!).toBeCloseTo(500_000 * 15 / 1_000_000, 4);
  });

  it("feeds the cost card, turning a permanently-unknown trend into a real direction", () => {
    seed("cur", AT_CURRENT, 2_000_000);
    seed("prev", AT_PREVIOUS, 200_000);
    expect(costAnswer().trend).toBe("up");
  });

  it("reports 'down' when the preceding window cost more", () => {
    seed("cur", AT_CURRENT, 200_000);
    seed("prev", AT_PREVIOUS, 2_000_000);
    expect(costAnswer().trend).toBe("down");
  });

  it("leaves the baseline null — not zero — when nothing preceded this window", () => {
    // A zero baseline would make any spend at all an infinite increase.
    // `trendOf` already treats 0 as unknown; keeping it null means the CARD
    // and any JSON consumer see "no comparison" rather than "we compared
    // against nothing".
    seed("cur", AT_CURRENT, 1_000_000);

    expect(insightsFor().previousCost).toBeNull();
    expect(costAnswer().trend).toBe("unknown");
  });

  it("computes no baseline for an all-time window, which has nothing before it", () => {
    seed("a", AT_ANCIENT, 500_000);
    seed("b", AT_CURRENT, 500_000);

    const opts = { timezone: "UTC", period: "all" as const };
    const data = attachInsights(store, buildDashboard(store, opts), opts, CONFIG);
    expect(data.insights!.previousCost).toBeNull();
  });

  it("applies the SAME filters to the baseline as to the headline", () => {
    // The whole point of re-deriving the filter rather than querying unscoped:
    // a project-filtered dashboard compared against unfiltered history would
    // report a collapse that is really just the filter.
    store.upsertSession(session("cur", AT_CURRENT, { projectPath: "/w/mine" }));
    store.upsertMessages([message("cur-m", "cur", AT_CURRENT, 1_000_000)]);
    store.upsertSession(session("prev-mine", AT_PREVIOUS, { projectPath: "/w/mine" }));
    store.upsertMessages([message("prev-mine-m", "prev-mine", AT_PREVIOUS, 500_000)]);
    // A much larger spend in the previous window belonging to ANOTHER project.
    store.upsertSession(session("prev-other", AT_PREVIOUS, { projectPath: "/w/other" }));
    store.upsertMessages([message("prev-other-m", "prev-other", AT_PREVIOUS, 50_000_000)]);

    const scoped = insightsFor({ projectPath: "/w/mine" }).previousCost!;
    const unscoped = insightsFor().previousCost!;

    expect(scoped).toBeGreaterThan(0);
    // The other project's spend is 100× larger; if the baseline ignored the
    // filter the two would be equal.
    expect(unscoped).toBeGreaterThan(scoped * 10);
  });
});
