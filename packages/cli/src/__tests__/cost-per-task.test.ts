/**
 * Wave 1 Lane A — cost per successful task (metric core).
 *
 * Pure-function coverage (classifyOutcome / aggregate / datesForPeriod /
 * dominantModel) plus integration through buildCostPerTaskReport with injected
 * git/cache/clock and a temp corrections DB. Deterministic: fixed timestamps,
 * UTC, no shell-out, no embeddings, seeded RNG for the property checks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Store } from '../store/index.js';
import type { SessionRecord, MessageRecord } from '@claude-stats/core/types';
import { estimateCost } from '@claude-stats/core/pricing';
import type { BuildDailyDigestDeps } from '../recap/index.js';
import type { ProjectGitActivity } from '../recap/types.js';
import { openCorrections, computeSignature } from '../recap/corrections.js';
import { buildDashboard, attachCostPerTask } from '../dashboard/index.js';
import type { CacheClient } from '../recap/cache.js';
import {
  classifyOutcome,
  dominantModel,
  datesForPeriod,
  aggregate,
  buildCostPerTaskReport,
  buildCalibrationReport,
  MIN_OBSERVABLE_FOR_MODEL_RATE,
  type TaskRecord,
  type TaskOutcome,
} from '../cost-per-task/index.js';

const BASE_TS = 1705305600000; // 2024-01-15T08:00:00.000Z
const NOW_TS = BASE_TS + 2 * 3_600_000;
const DATE = '2024-01-15';

function tmp(ext: string): string {
  return path.join(os.tmpdir(), `cs-cpt-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

const git = (o: Partial<ProjectGitActivity>): ProjectGitActivity => ({
  commitsToday: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0, subjects: [], pushed: false, prMerged: null, ...o,
});

// ─── classifyOutcome (pure truth table) ─────────────────────────────────────

describe('classifyOutcome', () => {
  const base = { confidence: 'low' as const, git: null, hidden: false, hasMutatingWork: false };

  it('explicit labels override every proxy', () => {
    expect(classifyOutcome({ ...base, confidence: 'high', git: git({ commitsToday: 1, pushed: true }) }, 'fail'))
      .toEqual({ outcome: 'failed', labelled: true });
    expect(classifyOutcome(base, 'success')).toEqual({ outcome: 'success', labelled: true });
    expect(classifyOutcome(base, 'partial')).toEqual({ outcome: 'in_flight', labelled: true });
  });

  it('hidden is an asserted negative', () => {
    expect(classifyOutcome({ ...base, confidence: 'high', git: git({ commitsToday: 1, pushed: true }), hidden: true }))
      .toEqual({ outcome: 'failed', labelled: true });
  });

  it('high confidence → success (proxy)', () => {
    expect(classifyOutcome({ ...base, confidence: 'high' })).toEqual({ outcome: 'success', labelled: false });
  });

  it('medium + a local (unpushed) commit → success (committing is a completion signal)', () => {
    expect(classifyOutcome({ ...base, confidence: 'medium', git: git({ commitsToday: 2, pushed: false }) }))
      .toEqual({ outcome: 'success', labelled: false });
  });

  it('medium from edit volume but nothing committed → in_flight', () => {
    // git observable, but commitsToday === 0 → genuinely unfinished work.
    expect(classifyOutcome({ ...base, confidence: 'medium', git: git({ commitsToday: 0, linesAdded: 80 }) }))
      .toEqual({ outcome: 'in_flight', labelled: false });
  });

  it('medium with no git signal → in_flight (long session, nothing committed)', () => {
    expect(classifyOutcome({ ...base, confidence: 'medium' })).toEqual({ outcome: 'in_flight', labelled: false });
  });

  it('low + git observable + mutating work → failed', () => {
    expect(classifyOutcome({ ...base, git: git({ commitsToday: 0 }), hasMutatingWork: true }))
      .toEqual({ outcome: 'failed', labelled: false });
  });

  it('low + no git → unobservable (absence is not failure)', () => {
    expect(classifyOutcome({ ...base, git: null, hasMutatingWork: true }))
      .toEqual({ outcome: 'unobservable', labelled: false });
  });

  it('low + git but no mutating work → unobservable (cannot judge a read/Q&A)', () => {
    expect(classifyOutcome({ ...base, git: git({}), hasMutatingWork: false }))
      .toEqual({ outcome: 'unobservable', labelled: false });
  });
});

// ─── dominantModel + datesForPeriod (pure) ──────────────────────────────────

describe('dominantModel', () => {
  it('returns the largest-cost model, null on empty', () => {
    expect(dominantModel({ a: 1, b: 5, c: 2 })).toBe('b');
    expect(dominantModel({})).toBeNull();
  });
});

describe('datesForPeriod', () => {
  it('day → just today', () => {
    expect(datesForPeriod('day', 'UTC', NOW_TS, null)).toEqual([DATE]);
  });
  it('week → 7 consecutive days ending today', () => {
    const days = datesForPeriod('week', 'UTC', NOW_TS, null);
    expect(days).toHaveLength(7);
    expect(days[days.length - 1]).toBe(DATE);
    expect(days[0]).toBe('2024-01-09');
  });
  it('month → only same-calendar-month days up to today', () => {
    const days = datesForPeriod('month', 'UTC', NOW_TS, null);
    expect(days[0]).toBe('2024-01-01');
    expect(days[days.length - 1]).toBe(DATE);
    expect(days.every((d) => d.startsWith('2024-01-'))).toBe(true);
  });
  it('all → bounded by earliest session, never the epoch', () => {
    const earliest = BASE_TS - 2 * 86_400_000; // 2024-01-13
    const days = datesForPeriod('all', 'UTC', NOW_TS, earliest);
    expect(days[0]).toBe('2024-01-13');
    expect(days[days.length - 1]).toBe(DATE);
    // With no earliest (empty store) it collapses to today.
    expect(datesForPeriod('all', 'UTC', NOW_TS, null)).toEqual([DATE]);
  });
});

// ─── aggregate (pure) ───────────────────────────────────────────────────────

function rec(o: Partial<TaskRecord> & { outcome: TaskOutcome; cost: number }): TaskRecord {
  return {
    id: Math.random().toString(36).slice(2),
    project: '/p',
    costByModel: { 'claude-sonnet-4-6': o.cost },
    dominantModel: 'claude-sonnet-4-6',
    labelled: false,
    confidence: 'low',
    ...o,
  };
}

describe('aggregate', () => {
  it('computes the headline over observable tasks only, with coverage', () => {
    const records = [
      rec({ outcome: 'success', cost: 2 }),
      rec({ outcome: 'success', cost: 4 }),
      rec({ outcome: 'failed', cost: 6 }),
      rec({ outcome: 'in_flight', cost: 100 }), // held out
      rec({ outcome: 'unobservable', cost: 100 }), // held out
    ];
    const r = aggregate(records, 'month', 0, 0, true);
    expect(r.tasksTotal).toBe(5);
    expect(r.observable).toBe(3);
    expect(r.successCount).toBe(2);
    expect(r.failedCount).toBe(1);
    expect(r.coverage).toBeCloseTo(3 / 5, 10);
    // in_flight / unobservable cost is NOT in the numerator.
    expect(r.totalCostObservable).toBeCloseTo(12, 10);
    expect(r.successRate).toBeCloseTo(2 / 3, 10);
    expect(r.meanCostPerAttempt).toBeCloseTo(12 / 3, 10);
    expect(r.costPerSuccessfulTask).toBeCloseTo(12 / 2, 10);
  });

  it('decomposition identity holds: costPerSuccess == meanCostPerAttempt / successRate', () => {
    const records = [
      rec({ outcome: 'success', cost: 3 }),
      rec({ outcome: 'failed', cost: 7 }),
      rec({ outcome: 'success', cost: 5 }),
    ];
    const r = aggregate(records, 'month', 0, 0, false);
    expect(r.costPerSuccessfulTask!).toBeCloseTo(r.meanCostPerAttempt! / r.successRate!, 10);
  });

  it('null rate / headline when nothing observable or no successes', () => {
    const noObs = aggregate([rec({ outcome: 'unobservable', cost: 9 })], 'day', 0, 0, false);
    expect(noObs.successRate).toBeNull();
    expect(noObs.meanCostPerAttempt).toBeNull();
    expect(noObs.costPerSuccessfulTask).toBeNull();
    expect(noObs.coverage).toBe(0);

    const noSucc = aggregate([rec({ outcome: 'failed', cost: 9 })], 'day', 0, 0, false);
    expect(noSucc.successRate).toBe(0);
    expect(noSucc.costPerSuccessfulTask).toBeNull(); // 0 successes → undefined headline
  });

  it('counts labelled tasks', () => {
    const r = aggregate(
      [rec({ outcome: 'success', cost: 1, labelled: true }), rec({ outcome: 'failed', cost: 1 })],
      'day', 0, 0, false,
    );
    expect(r.labelledCount).toBe(1);
  });

  it('byModel: dominant-assigned rate gated by MIN_OBSERVABLE; exact split sums to observable cost', () => {
    // 12 sonnet-dominant observable tasks (≥ MIN) + 1 opus-dominant (< MIN).
    const records: TaskRecord[] = [];
    for (let i = 0; i < 12; i++) {
      records.push(rec({ outcome: i < 9 ? 'success' : 'failed', cost: 2 }));
    }
    records.push({
      id: 'x', project: '/p', cost: 10, costByModel: { 'claude-opus-4-6': 10 },
      dominantModel: 'claude-opus-4-6', outcome: 'success', labelled: false, confidence: 'high',
    });
    const r = aggregate(records, 'month', 0, 0, true);

    const sonnet = r.byModel.find((m) => m.model === 'claude-sonnet-4-6')!;
    expect(sonnet.tasksObservable).toBe(12);
    expect(sonnet.successCount).toBe(9);
    expect(sonnet.successRate).toBeCloseTo(9 / 12, 10); // ≥ MIN → reported
    expect(sonnet.costPerSuccessfulTask).toBeCloseTo(24 / 9, 10);

    const opus = r.byModel.find((m) => m.model === 'claude-opus-4-6')!;
    expect(opus.tasksObservable).toBe(1);
    expect(opus.successRate).toBeNull(); // < MIN → suppressed
    expect(opus.costPerSuccessfulTask).toBeNull();

    // Exact split across all model rows sums to the observable cost total.
    const exactSum = r.byModel.reduce((s, m) => s + m.costByModelExact, 0);
    expect(exactSum).toBeCloseTo(r.totalCostObservable, 10);
  });

  it('property (seeded): identity + exact-split invariants hold over random task sets', () => {
    // Deterministic mulberry32 RNG — reproducible, no fast-check dependency.
    let s = 0x9e3779b9;
    const rng = (): number => {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const outcomes: TaskOutcome[] = ['success', 'failed', 'in_flight', 'unobservable'];
    const models = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5'];

    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rng() * 40);
      const records: TaskRecord[] = [];
      for (let i = 0; i < n; i++) {
        // 1–2 models with random non-negative costs summing to `cost`.
        const cbm: Record<string, number> = {};
        const k = 1 + Math.floor(rng() * 2);
        for (let j = 0; j < k; j++) cbm[models[Math.floor(rng() * models.length)]!] = Math.round(rng() * 1000) / 100;
        const cost = Object.values(cbm).reduce((a, b) => a + b, 0);
        records.push({
          id: `${trial}-${i}`, project: '/p', cost, costByModel: cbm,
          dominantModel: dominantModel(cbm), outcome: outcomes[Math.floor(rng() * outcomes.length)]!,
          labelled: false, confidence: 'low',
        });
      }
      const r = aggregate(records, 'month', 0, 0, true);

      // Counts partition the total.
      expect(r.successCount + r.failedCount + r.inFlightCount + r.unobservableCount).toBe(r.tasksTotal);
      // Decomposition identity (when defined).
      if (r.costPerSuccessfulTask !== null && r.successRate && r.meanCostPerAttempt !== null) {
        expect(r.costPerSuccessfulTask).toBeCloseTo(r.meanCostPerAttempt / r.successRate, 6);
      }
      // Exact per-model split sums to observable cost.
      const exactSum = r.byModel.reduce((acc, m) => acc + m.costByModelExact, 0);
      expect(exactSum).toBeCloseTo(r.totalCostObservable, 6);
    }
  });
});

// ─── Integration through buildCostPerTaskReport ─────────────────────────────

function makeSession(o: Partial<SessionRecord> & { sessionId: string; projectPath: string }): SessionRecord {
  return {
    sourceFile: '/x/s.jsonl', firstTimestamp: BASE_TS, lastTimestamp: BASE_TS + 600_000,
    claudeVersion: '2.1.70', entrypoint: null, gitBranch: 'main', permissionMode: 'default',
    isInteractive: true, promptCount: 1, assistantMessageCount: 1, inputTokens: 0, outputTokens: 0,
    cacheCreationTokens: 0, cacheReadTokens: 0, webSearchRequests: 0, webFetchRequests: 0,
    toolUseCounts: [], models: [], repoUrl: null, accountUuid: null, organizationUuid: null,
    subscriptionType: null, thinkingBlocks: 0, parentSessionId: null, isSubagent: false,
    sourceDeleted: false, throttleEvents: 0, activeDurationMs: 600_000, medianResponseTimeMs: null,
    ...o,
  };
}

function makeMessage(o: { sessionId: string; model: string; tools: string[]; prompt: string; uuid: string }): MessageRecord {
  return {
    uuid: o.uuid, sessionId: o.sessionId, timestamp: BASE_TS, claudeVersion: null, model: o.model,
    stopReason: 'end_turn', inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: o.tools, filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: o.prompt,
  };
}

function noopCache(): CacheClient {
  return { read: vi.fn(() => null), readWithInputs: vi.fn(() => null), readMostRecentForDate: vi.fn(() => null), write: vi.fn() };
}

describe('buildCostPerTaskReport (integration)', () => {
  let store: Store;
  let dbPath: string;

  // Per-project git fixtures driving the four outcomes via computeConfidence.
  const gitByProject: Record<string, ProjectGitActivity | null> = {
    '/p/success': git({ commitsToday: 1, pushed: true, linesAdded: 10 }), // high → success
    // medium with NO commit (long, edit-heavy session) → in_flight. A committed
    // task is now classified as success, so in_flight requires the no-commit path.
    '/p/inflight': git({ commitsToday: 0, linesAdded: 80 }),              // medium (edits) → in_flight
    '/p/failed': git({ commitsToday: 0 }),                                // low + git + Edit → failed
    '/p/unobs': null,                                                     // git null → unobservable
  };

  function deps(): BuildDailyDigestDeps {
    return {
      getProjectGitActivity: vi.fn((p: string) => gitByProject[p] ?? null),
      getAuthorEmail: vi.fn(() => 'test@example.com'),
      cache: noopCache(),
      now: () => NOW_TS,
      intlTz: () => 'UTC',
      embeddingProvider: null,
    };
  }

  beforeEach(() => {
    dbPath = tmp('db');
    store = new Store(dbPath);
    let n = 0;
    for (const [project, tools] of [
      ['/p/success', ['Edit']], ['/p/inflight', ['Edit']], ['/p/failed', ['Edit']], ['/p/unobs', ['Read']],
    ] as const) {
      const sid = `s-${project.slice(3)}`;
      // /p/inflight needs a long active session so computeConfidence reaches
      // 'medium' via the duration+lines path (no commit) → in_flight.
      const activeDurationMs = project === '/p/inflight' ? 35 * 60_000 : 600_000;
      store.upsertSession(makeSession({
        sessionId: sid,
        projectPath: project,
        activeDurationMs,
        lastTimestamp: BASE_TS + activeDurationMs,
      }));
      store.upsertMessages([makeMessage({ uuid: `m${n++}`, sessionId: sid, model: 'claude-sonnet-4-6', tools: [...tools], prompt: `work in ${project}` })]);
    }
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it('classifies the four outcomes end-to-end and reports observable-only coverage', async () => {
    const r = await buildCostPerTaskReport(store, {
      period: 'day', nowMs: NOW_TS, tz: 'UTC', correctionsClient: null, digestDeps: deps(),
    });
    expect(r.tasksTotal).toBe(4);
    expect(r.successCount).toBe(1);
    expect(r.inFlightCount).toBe(1);
    expect(r.failedCount).toBe(1);
    expect(r.unobservableCount).toBe(1);
    expect(r.observable).toBe(2); // success + failed
    expect(r.coverage).toBeCloseTo(2 / 4, 10);
    expect(r.successRate).toBeCloseTo(1 / 2, 10);
    // Headline = observable cost / successes. Each observable task costs the
    // same single-message cost.
    const perTask = estimateCost('claude-sonnet-4-6', 100, 50, 0, 0).cost;
    expect(r.totalCostObservable).toBeCloseTo(2 * perTask, 10);
    expect(r.costPerSuccessfulTask).toBeCloseTo((2 * perTask) / 1, 10);
    expect(r.labelledCount).toBe(0);
  });

  it('an explicit user label overrides the proxy and is counted as labelled', async () => {
    // openCorrections() chmods the DB's parent dir, which fails on the shared
    // system temp dir — so the corrections DB must live in its own subdir.
    const corrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cpt-corr-'));
    const corrPath = path.join(corrDir, 'corrections.db');
    const corrections = openCorrections({ dbPath: corrPath });
    try {
      // Label the unobservable task ('/p/unobs') as a success.
      const sig = computeSignature({ project: '/p/unobs', filePathsTouched: [], firstPrompt: 'work in /p/unobs' });
      corrections.add(sig, { kind: 'outcome', value: 'success' });

      const r = await buildCostPerTaskReport(store, {
        period: 'day', nowMs: NOW_TS, tz: 'UTC', correctionsClient: corrections, digestDeps: deps(),
      });
      // The previously-unobservable task is now an observable, labelled success.
      expect(r.successCount).toBe(2); // proxy success + labelled success
      expect(r.unobservableCount).toBe(0);
      expect(r.labelledCount).toBe(1);
    } finally {
      try { fs.rmSync(corrDir, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  // ── buildCalibrationReport (proxy/signal agreement vs labels) ──
  it('calibration report scores proxy predictions against user labels', async () => {
    const corrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cpt-cal-'));
    const corrections = openCorrections({ dbPath: path.join(corrDir, 'c.db') });
    try {
      // Label two tasks where the proxy already agrees: success→success, failed→fail.
      corrections.add(
        computeSignature({ project: '/p/success', filePathsTouched: [], firstPrompt: 'work in /p/success' }),
        { kind: 'outcome', value: 'success' },
      );
      corrections.add(
        computeSignature({ project: '/p/failed', filePathsTouched: [], firstPrompt: 'work in /p/failed' }),
        { kind: 'outcome', value: 'fail' },
      );

      const report = await buildCalibrationReport(store, {
        period: 'day', nowMs: NOW_TS, tz: 'UTC', correctionsClient: corrections, digestDeps: deps(),
      });

      // Only the two labelled tasks are in the eval set.
      expect(report.n).toBe(2);
      // Proxy agrees with both labels.
      expect(report.proxyOnly.accuracy).toBeCloseTo(1, 10);
      expect(report.proxyOnly.observableN).toBe(2);
      expect(report.proxyOnly.failedPrecision).toBe(1);
      expect(report.proxyOnly.meetsFailedFloor).toBe(true);
      // Brier needs a score → proxy path has none; with-signals path does.
      expect(report.proxyOnly.brier).toBeNull();
      expect(report.withSignals.brier).not.toBeNull();
    } finally {
      corrections.close();
      fs.rmSync(corrDir, { recursive: true, force: true });
    }
  });

  // ── experimentalSignals (Phase-A accuracy hook, default off) ──
  it('experimentalSignals: true is a no-op on the standard fixture (no lexicon/truncation triggers)', async () => {
    const base = { period: 'day' as const, nowMs: NOW_TS, tz: 'UTC', correctionsClient: null, digestDeps: deps() };
    const off = await buildCostPerTaskReport(store, base);
    const on = await buildCostPerTaskReport(store, { ...base, experimentalSignals: true });
    // None of the fixture prompts contain repair/acceptance phrases; single
    // messages mean no repeated truncation; the weak rework signal alone cannot
    // cross a threshold — so the outcome distribution is unchanged.
    expect(on.successCount).toBe(off.successCount);
    expect(on.failedCount).toBe(off.failedCount);
    expect(on.inFlightCount).toBe(off.inFlightCount);
    expect(on.unobservableCount).toBe(off.unobservableCount);
  });

  it('experimentalSignals: a repair follow-up turn flips the in_flight task to failed', async () => {
    // Add a LATER second user turn to the in_flight session containing a repair
    // phrase. The later timestamp makes it a genuine follow-up (index ≥ 1) rather
    // than the task's opening prompt, which the conversational detector ignores.
    store.upsertMessages([
      { ...makeMessage({ uuid: 'm-repair', sessionId: 's-inflight', model: 'claude-sonnet-4-6', tools: [], prompt: "that's wrong, revert it" }), timestamp: BASE_TS + 60_000 },
    ]);
    const base = { period: 'day' as const, nowMs: NOW_TS, tz: 'UTC', correctionsClient: null, digestDeps: deps() };
    const off = await buildCostPerTaskReport(store, base);
    const on = await buildCostPerTaskReport(store, { ...base, experimentalSignals: true });
    // Off: still in_flight. On: the repair turn moves it to failed.
    expect(off.inFlightCount).toBeGreaterThanOrEqual(1);
    expect(on.failedCount).toBeGreaterThan(off.failedCount);
    // PRIVACY: the prompt text read to derive the signal must NOT appear in the
    // report payload (security review Sec-2).
    expect(JSON.stringify(on)).not.toContain("that's wrong");
    expect(JSON.stringify(on)).not.toContain('revert it');
  });

  // ── includeTasks (per-task labelling list) ──
  it('omits the tasks list by default (keeps the metric payload prompt-text-free)', async () => {
    const r = await buildCostPerTaskReport(store, {
      period: 'day', nowMs: NOW_TS, tz: 'UTC', correctionsClient: null, digestDeps: deps(),
    });
    expect(r.tasks).toBeUndefined();
  });

  it('includes a per-task list with signatures when includeTasks is set', async () => {
    const r = await buildCostPerTaskReport(store, {
      period: 'day', nowMs: NOW_TS, tz: 'UTC', correctionsClient: null, digestDeps: deps(),
      includeTasks: true,
    });
    expect(r.tasks).toBeDefined();
    expect(r.tasks!.length).toBe(4);
    for (const task of r.tasks!) {
      expect(typeof task.id).toBe('string');
      expect(typeof task.title).toBe('string');
      expect(task.signature).toMatchObject({
        projectPath: expect.any(String),
        promptPrefix: expect.any(String),
      });
      expect(Array.isArray(task.signature.filePaths)).toBe(true);
    }
    // The list is capped (MAX_LABELLABLE_TASKS) and round-trips a usable
    // signature — write it back and confirm it lands as a label.
    const corrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpt-tasks-'));
    const client = openCorrections({ dbPath: path.join(corrDir, 'c.db') });
    try {
      client.add(r.tasks![0]!.signature, { kind: 'outcome', value: 'success' });
      expect(client.forSignature(r.tasks![0]!.signature).some((a) => a.kind === 'outcome')).toBe(true);
    } finally {
      client.close();
      fs.rmSync(corrDir, { recursive: true, force: true });
    }
  });

  // ── attachCostPerTask (dashboard wrapper) ──
  it('attachCostPerTask populates data.costPerTask using the dashboard filters', async () => {
    const data = buildDashboard(store, { period: 'day' });
    expect(data.costPerTask).toBeNull(); // sync build never computes it
    await attachCostPerTask(store, data, { period: 'day' }, {
      nowMs: NOW_TS, tz: 'UTC', correctionsClient: null, digestDeps: deps(),
    });
    expect(data.costPerTask).not.toBeNull();
    expect(data.costPerTask!.period).toBe('day');
    expect(data.costPerTask!.tasksTotal).toBe(4);
  });

  it("attachCostPerTask caps an 'all' dashboard period to 'month' for the card", async () => {
    const data = buildDashboard(store, { period: 'all' });
    await attachCostPerTask(store, data, { period: 'all' }, {
      nowMs: NOW_TS, tz: 'UTC', correctionsClient: null, digestDeps: deps(),
    });
    // 'all' would iterate the full history per day (slow); the card caps to month.
    expect(data.costPerTask!.period).toBe('month');
  });

  it('attachCostPerTask never throws — leaves costPerTask null on failure', async () => {
    const data = buildDashboard(store, { period: 'day' });
    // A digestDeps whose clock throws makes the build fail outright (git errors,
    // by contrast, degrade gracefully); the wrapper must swallow it and leave
    // the card absent rather than crash the whole dashboard.
    const boomDeps: BuildDailyDigestDeps = {
      ...deps(),
      now: () => { throw new Error('boom'); },
    };
    await expect(
      attachCostPerTask(store, data, { period: 'day' }, {
        nowMs: NOW_TS, tz: 'UTC', correctionsClient: null, digestDeps: boomDeps,
      }),
    ).resolves.toBeDefined();
    expect(data.costPerTask).toBeNull();
  });
});
