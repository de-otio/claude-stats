/**
 * Per-task cost by (model, effort): `DailyDigestItem.costByModelEffort`.
 *
 * The digest splits each task's cost by the effort tier recorded on the message
 * rows that make it up, including folded-in subagent rows, with `null` (no
 * effort recorded) as its own bucket. The cost-per-task report reads that split
 * to key its breakdown by (model, effort).
 *
 * Determinism: fixed timestamps, UTC, injected cache and project-activity deps.
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
import { buildCostPerTaskReport } from '../../cost-per-task/index.js';
import type { CacheClient } from '../../recap/cache.js';
import type { ProjectGitActivity } from '../../recap/types.js';

const BASE_TS = 1705305600000; // 2024-01-15T08:00:00.000Z (Monday, UTC)
const DATE = '2024-01-15';

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-cbe-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
  effort?: string | null;
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
    effort: o.effort ?? null,
  };
}

const cost = (model: string, input: number, output: number): number =>
  estimateCost(model, input, output, 0, 0).cost;

describe('digest items carry the (model, effort) cost split', () => {
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

  it('splits one task by model and effort, keeps null as its own entry, and sums to estimatedCost', async () => {
    store.upsertSession(session({ sessionId: 's1' }));
    store.upsertMessages([
      message({ uuid: 'a', sessionId: 's1', timestamp: BASE_TS, model: 'claude-fable-5-2', input: 100, output: 50, filePaths: ['/app/a.ts'], promptText: 'build the thing', effort: 'medium' }),
      message({ uuid: 'b', sessionId: 's1', timestamp: BASE_TS + 60_000, model: 'claude-fable-5-2', input: 200, output: 80, filePaths: ['/app/a.ts'], effort: 'medium' }),
      message({ uuid: 'c', sessionId: 's1', timestamp: BASE_TS + 120_000, model: 'claude-fable-5-2', input: 300, output: 90, filePaths: ['/app/a.ts'], effort: 'high' }),
      message({ uuid: 'd', sessionId: 's1', timestamp: BASE_TS + 180_000, model: 'claude-opus-5-5', input: 400, output: 70, filePaths: ['/app/a.ts'], effort: null }),
    ]);

    const digest = await buildDailyDigest(store, { date: DATE }, deps());
    expect(digest.items).toHaveLength(1);
    const item = digest.items[0]!;
    const split = item.costByModelEffort!;

    // Sorted by model, then effort order (null last): the order is deterministic.
    expect(split.map((e) => `${e.model}/${e.effort}`)).toEqual([
      'claude-fable-5-2/medium',
      'claude-fable-5-2/high',
      'claude-opus-5-5/null',
    ]);
    const get = (model: string, effort: string | null) => split.find((e) => e.model === model && e.effort === effort)!.cost;
    expect(get('claude-fable-5-2', 'medium')).toBeCloseTo(cost('claude-fable-5-2', 100, 50) + cost('claude-fable-5-2', 200, 80), 10);
    expect(get('claude-fable-5-2', 'high')).toBeCloseTo(cost('claude-fable-5-2', 300, 90), 10);
    expect(get('claude-opus-5-5', null)).toBeCloseTo(cost('claude-opus-5-5', 400, 70), 10);
    expect(split.reduce((s, e) => s + e.cost, 0)).toBeCloseTo(item.estimatedCost, 10);
    // And it agrees with the per-model split it refines.
    expect(split.filter((e) => e.model === 'claude-fable-5-2').reduce((s, e) => s + e.cost, 0)).toBeCloseTo(item.costByModel['claude-fable-5-2']!, 10);
  });

  it('attributes folded-in subagent rows to their own effort tier', async () => {
    store.upsertSession(session({ sessionId: 'parent' }));
    store.upsertSession(session({ sessionId: 'sub', isSubagent: true, parentSessionId: 'parent', firstTimestamp: BASE_TS + 5 * 60_000 }));
    store.upsertMessages([
      message({ uuid: 'p1', sessionId: 'parent', timestamp: BASE_TS, model: 'claude-fable-5-2', input: 100, output: 50, filePaths: ['/app/main.ts'], promptText: 'build the feature', effort: 'high' }),
      message({ uuid: 's1', sessionId: 'sub', timestamp: BASE_TS + 5 * 60_000, model: 'claude-fable-5-2', input: 300, output: 150, filePaths: ['/app/util.ts'], promptText: 'search', effort: 'low' }),
    ]);
    const digest = await buildDailyDigest(store, { date: DATE }, deps());
    const split = digest.items[0]!.costByModelEffort!;
    expect(split.map((e) => e.effort).sort()).toEqual(['high', 'low']);
  });

  it('feeds buildCostPerTaskReport({ groupBy: "model_effort" }) end to end, and leaves the default report alone', async () => {
    store.upsertSession(session({ sessionId: 's1' }));
    store.upsertMessages([
      message({ uuid: 'a', sessionId: 's1', timestamp: BASE_TS, model: 'claude-fable-5-2', input: 100, output: 50, filePaths: ['/app/a.ts'], promptText: 'build the thing', effort: 'medium' }),
    ]);
    const common = { period: 'day' as const, nowMs: BASE_TS + 2 * 3_600_000, tz: 'UTC', correctionsClient: null, digestDeps: deps() };

    const plain = await buildCostPerTaskReport(store, common);
    expect('byModelEffort' in plain).toBe(false);

    const grouped = await buildCostPerTaskReport(store, { ...common, groupBy: 'model_effort' });
    // The only task has no git signal, so it is unobservable: held out of every rate.
    expect(grouped.tasksTotal).toBe(1);
    expect(grouped.observable).toBe(0);
    expect(grouped.byModelEffort).toEqual({ cells: [], minObservable: 10, effortTaggedShare: 0 });
  });
});
