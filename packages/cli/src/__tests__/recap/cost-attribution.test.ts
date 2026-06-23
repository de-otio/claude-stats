/**
 * Phase 0 — per-task cost attribution + subagent handling.
 *
 * Verifies the cost-attribution fix in buildDigestItem:
 *   1. Cost is summed over a task's OWN segment messages, not every message in
 *      a contributing session — so a session split across two clusters is not
 *      double-counted (behavior comparison vs the old whole-session roll-up).
 *   2. costByModel sums to estimatedCost (per-model breakdown is exact).
 *   3. Subagent sessions are excluded from the task set and their cost is folded
 *      into the parent task exactly once.
 *
 * Determinism: fixed timestamps, UTC, injected git/cache deps — no wall-clock,
 * no shell-out, no embeddings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Store } from '../../store/index.js';
import type { SessionRecord, MessageRecord } from '@claude-stats/core/types';
import { estimateCost } from '@claude-stats/core/pricing';
import { buildDailyDigest } from '../../recap/index.js';
import type { BuildDailyDigestDeps } from '../../recap/index.js';
import type { CacheClient } from '../../recap/cache.js';
import type { ProjectGitActivity } from '../../recap/types.js';

const BASE_TS = 1705305600000; // 2024-01-15T08:00:00.000Z (Monday, UTC)
const DATE = '2024-01-15';

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-cpt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function noopCache(): CacheClient {
  return { read: vi.fn(() => null), readWithInputs: vi.fn(() => null), readMostRecentForDate: vi.fn(() => null), write: vi.fn() };
}

function deps(): BuildDailyDigestDeps {
  return {
    getProjectGitActivity: vi.fn((): ProjectGitActivity | null => null),
    getAuthorEmail: vi.fn(() => 'test@example.com'),
    cache: noopCache(),
    now: () => BASE_TS + 2 * 3_600_000,
    intlTz: () => 'UTC',
    embeddingProvider: null,
  };
}

function session(overrides: Partial<SessionRecord> & { sessionId: string }): SessionRecord {
  return {
    projectPath: '/home/user/projects/app',
    sourceFile: '/home/user/.claude/projects/app/s.jsonl',
    firstTimestamp: BASE_TS,
    lastTimestamp: BASE_TS + 600_000,
    claudeVersion: '2.1.70',
    entrypoint: null,
    gitBranch: 'main',
    permissionMode: 'default',
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
    models: [],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: 600_000,
    medianResponseTimeMs: null,
    ...overrides,
  };
}

function message(o: {
  uuid: string; sessionId: string; timestamp: number; model: string;
  input: number; output: number; filePaths?: string[]; promptText?: string | null;
}): MessageRecord {
  return {
    uuid: o.uuid,
    sessionId: o.sessionId,
    timestamp: o.timestamp,
    claudeVersion: null,
    model: o.model,
    stopReason: 'end_turn',
    inputTokens: o.input,
    outputTokens: o.output,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools: ['Edit'],
    filePaths: o.filePaths ?? [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: o.promptText ?? null,
  };
}

const cost = (model: string, input: number, output: number): number =>
  estimateCost(model, input, output, 0, 0).cost;

const sumValues = (r: Readonly<Record<string, number>>): number =>
  Object.values(r).reduce((a, b) => a + b, 0);

describe('Phase 0 — per-task cost attribution', () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it('does not double-count a session that splits into two tasks (behavior comparison)', async () => {
    // One session, two messages 30 min apart touching disjoint files →
    // segmenter splits (gap 0.4 + path 0.25 = 0.65 ≥ 0.5), clusterer keeps two
    // separate tasks (disjoint paths, no time overlap).
    store.upsertSession(session({ sessionId: 's1', lastTimestamp: BASE_TS + 31 * 60_000 }));
    store.upsertMessages([
      message({ uuid: 'a', sessionId: 's1', timestamp: BASE_TS, model: 'claude-sonnet-4-6', input: 100, output: 50, filePaths: ['/app/a.ts'], promptText: 'fix the database layer' }),
      message({ uuid: 'b', sessionId: 's1', timestamp: BASE_TS + 31 * 60_000, model: 'claude-opus-4-6', input: 200, output: 80, filePaths: ['/app/b.ts'], promptText: 'rewrite the documentation' }),
    ]);

    const costA = cost('claude-sonnet-4-6', 100, 50);
    const costB = cost('claude-opus-4-6', 200, 80);

    const digest = await buildDailyDigest(store, { date: DATE }, deps());

    // Two distinct tasks.
    expect(digest.items).toHaveLength(2);

    // Each message's cost is counted exactly once across the two tasks. The OLD
    // whole-session roll-up would have charged every contributing session's FULL
    // cost to BOTH items → total = 2*(costA+costB). The fix gives costA+costB.
    expect(digest.totals.estimatedCost).toBeCloseTo(costA + costB, 10);
    expect(digest.totals.estimatedCost).not.toBeCloseTo(2 * (costA + costB), 10);

    // And each item carries only its own segment's cost.
    const itemCosts = digest.items.map((i) => i.estimatedCost).sort((x, y) => x - y);
    expect(itemCosts[0]!).toBeCloseTo(Math.min(costA, costB), 10);
    expect(itemCosts[1]!).toBeCloseTo(Math.max(costA, costB), 10);
  });

  it('costByModel sums to estimatedCost for every item', async () => {
    store.upsertSession(session({ sessionId: 's1', lastTimestamp: BASE_TS + 31 * 60_000 }));
    store.upsertMessages([
      message({ uuid: 'a', sessionId: 's1', timestamp: BASE_TS, model: 'claude-sonnet-4-6', input: 100, output: 50, filePaths: ['/app/a.ts'], promptText: 'fix the database layer' }),
      message({ uuid: 'b', sessionId: 's1', timestamp: BASE_TS + 31 * 60_000, model: 'claude-opus-4-6', input: 200, output: 80, filePaths: ['/app/b.ts'], promptText: 'rewrite the documentation' }),
    ]);

    const digest = await buildDailyDigest(store, { date: DATE }, deps());

    for (const item of digest.items) {
      expect(sumValues(item.costByModel)).toBeCloseTo(item.estimatedCost, 10);
    }
    // The two single-model tasks carry exactly one model each.
    const models = digest.items.flatMap((i) => Object.keys(i.costByModel)).sort();
    expect(models).toEqual(['claude-opus-4-6', 'claude-sonnet-4-6']);
  });
});

describe('Phase 0 — subagent handling', () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
  });
  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it('excludes the subagent as its own task and folds its cost into the parent once', async () => {
    store.upsertSession(session({ sessionId: 'parent' }));
    store.upsertSession(session({ sessionId: 'subagent', isSubagent: true, parentSessionId: 'parent', firstTimestamp: BASE_TS + 5 * 60_000 }));
    store.upsertMessages([
      message({ uuid: 'p1', sessionId: 'parent', timestamp: BASE_TS, model: 'claude-sonnet-4-6', input: 100, output: 50, filePaths: ['/app/main.ts'], promptText: 'build the feature' }),
      message({ uuid: 'sa1', sessionId: 'subagent', timestamp: BASE_TS + 5 * 60_000, model: 'claude-haiku-4-5', input: 300, output: 150, filePaths: ['/app/util.ts'], promptText: 'search the codebase' }),
    ]);

    const costParent = cost('claude-sonnet-4-6', 100, 50);
    const costSub = cost('claude-haiku-4-5', 300, 150);

    const digest = await buildDailyDigest(store, { date: DATE }, deps());

    // Exactly one task — the parent. The subagent is not a standalone item.
    expect(digest.items).toHaveLength(1);
    const item = digest.items[0]!;
    expect(item.sessionIds).toEqual(['parent']);
    expect(item.sessionIds).not.toContain('subagent');

    // Subagent cost is folded into the parent task, exactly once, attributed to
    // the model that produced it.
    expect(item.estimatedCost).toBeCloseTo(costParent + costSub, 10);
    expect(item.costByModel['claude-haiku-4-5']).toBeCloseTo(costSub, 10);
    expect(item.costByModel['claude-sonnet-4-6']).toBeCloseTo(costParent, 10);
    expect(sumValues(item.costByModel)).toBeCloseTo(item.estimatedCost, 10);
  });
});
