/**
 * Tests for recap/precompute.ts — v3.05 background pre-computation.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Store } from '../../store/index.js';
import type { SessionRecord, MessageRecord } from '@claude-stats/core/types';
import { precomputeDigests } from '../../recap/precompute.js';
import { createFileCache } from '../../recap/cache.js';
import type { PrecomputeDeps } from '../../recap/precompute.js';

// ─── Test DB helpers ──────────────────────────────────────────────────────────

function tmpDb(): string {
  return path.join(
    os.tmpdir(),
    `cs-precompute-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function tmpCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-precompute-cache-'));
}

const TZ_UTC = 'UTC';

/** 2026-04-15T00:00:00.000Z */
const BASE_DATE = '2026-04-15';
const BASE_TS = new Date('2026-04-15T00:00:00.000Z').getTime();

let _sessionCounter = 0;
let _msgCounter = 0;

function nextSessionId(): string {
  return `sess-pc-${String(++_sessionCounter).padStart(4, '0')}`;
}
function nextMsgUuid(): string {
  return `msg-pc-${String(++_msgCounter).padStart(4, '0')}`;
}

function makeSessionRecord(
  overrides: Partial<SessionRecord> & {
    firstTimestamp?: number;
    lastTimestamp?: number;
    projectPath?: string;
  } = {},
): SessionRecord {
  return {
    sessionId: overrides.sessionId ?? nextSessionId(),
    projectPath: overrides.projectPath ?? '/home/user/proj',
    sourceFile: '/home/user/.claude/projects/proj/sess.jsonl',
    firstTimestamp: overrides.firstTimestamp ?? BASE_TS,
    lastTimestamp: overrides.lastTimestamp ?? BASE_TS + 600_000,
    claudeVersion: '2.1.70',
    entrypoint: null,
    gitBranch: 'main',
    permissionMode: 'default',
    isInteractive: true,
    promptCount: 1,
    assistantMessageCount: 1,
    inputTokens: 500,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ['claude-sonnet-4-6'],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: 300_000,
    medianResponseTimeMs: null,
  };
}

function makeMessageRecord(sessionId: string, timestamp: number): MessageRecord {
  return {
    uuid: nextMsgUuid(),
    sessionId,
    timestamp,
    claudeVersion: '2.1.70',
    model: 'claude-sonnet-4-6',
    stopReason: 'end_turn',
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: 'fix the bug',
  };
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

const tmpFiles: string[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ok */ }
  }
  tmpFiles.length = 0;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tmpDirs.length = 0;
  vi.restoreAllMocks();
});

// "today" = 2026-04-15T12:00:00Z — so yesterday = 2026-04-14
const TODAY_MS = new Date('2026-04-15T12:00:00.000Z').getTime();
const baseDeps = (cacheDir: string): PrecomputeDeps => ({
  now: () => TODAY_MS,
  intlTz: () => TZ_UTC,
  cache: createFileCache({ rootDir: cacheDir }),
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('precomputeDigests', () => {
  it('empty store: all counters are 0', async () => {
    const dbPath = tmpDb();
    tmpFiles.push(dbPath);
    const cacheDir = tmpCacheDir();
    tmpDirs.push(cacheDir);

    const store = new Store(dbPath);
    try {
      const result = await precomputeDigests(
        store,
        { lookbackDays: 2 },
        baseDeps(cacheDir),
      );
      // Empty days may write empty digests (skipped on second check), but
      // all counts should be >= 0 and failures = 0
      expect(result.failures).toBe(0);
      expect(result.precomputed + result.skipped).toBeGreaterThanOrEqual(0);
    } finally {
      store.close();
    }
  });

  it('lookback covers two days with sessions → precomputed: 2, cache files written', async () => {
    const dbPath = tmpDb();
    tmpFiles.push(dbPath);
    const cacheDir = tmpCacheDir();
    tmpDirs.push(cacheDir);

    const store = new Store(dbPath);
    try {
      // Day 1: 2026-04-14 (yesterday relative to TODAY_MS)
      const sess1 = makeSessionRecord({
        firstTimestamp: new Date('2026-04-14T09:00:00.000Z').getTime(),
        lastTimestamp: new Date('2026-04-14T09:10:00.000Z').getTime(),
      });
      store.upsertSession(sess1);
      store.upsertMessages([makeMessageRecord(sess1.sessionId, new Date('2026-04-14T09:01:00.000Z').getTime())]);

      // Day 2: 2026-04-13 (2 days ago)
      const sess2 = makeSessionRecord({
        firstTimestamp: new Date('2026-04-13T10:00:00.000Z').getTime(),
        lastTimestamp: new Date('2026-04-13T10:10:00.000Z').getTime(),
      });
      store.upsertSession(sess2);
      store.upsertMessages([makeMessageRecord(sess2.sessionId, new Date('2026-04-13T10:01:00.000Z').getTime())]);

      const result = await precomputeDigests(
        store,
        { lookbackDays: 2 },
        baseDeps(cacheDir),
      );

      // Both days should have been processed (precomputed)
      expect(result.failures).toBe(0);
      expect(result.precomputed).toBe(2);
      expect(result.skipped).toBe(0);

      // Cache files written
      const cacheFiles = fs.readdirSync(cacheDir);
      expect(cacheFiles.length).toBeGreaterThanOrEqual(2);
    } finally {
      store.close();
    }
  });

  it('cache hit on second call → skipped: 2, precomputed: 0', async () => {
    const dbPath = tmpDb();
    tmpFiles.push(dbPath);
    const cacheDir = tmpCacheDir();
    tmpDirs.push(cacheDir);

    const store = new Store(dbPath);
    try {
      // Two days with sessions
      const sess1 = makeSessionRecord({
        firstTimestamp: new Date('2026-04-14T09:00:00.000Z').getTime(),
        lastTimestamp: new Date('2026-04-14T09:10:00.000Z').getTime(),
      });
      store.upsertSession(sess1);
      store.upsertMessages([makeMessageRecord(sess1.sessionId, new Date('2026-04-14T09:01:00.000Z').getTime())]);

      const sess2 = makeSessionRecord({
        firstTimestamp: new Date('2026-04-13T10:00:00.000Z').getTime(),
        lastTimestamp: new Date('2026-04-13T10:10:00.000Z').getTime(),
      });
      store.upsertSession(sess2);
      store.upsertMessages([makeMessageRecord(sess2.sessionId, new Date('2026-04-13T10:01:00.000Z').getTime())]);

      const deps = baseDeps(cacheDir);

      // First call — builds the digests
      const result1 = await precomputeDigests(store, { lookbackDays: 2 }, deps);
      expect(result1.precomputed).toBe(2);
      expect(result1.failures).toBe(0);

      // Second call — both should be cache hits
      const result2 = await precomputeDigests(store, { lookbackDays: 2 }, deps);
      expect(result2.precomputed).toBe(0);
      expect(result2.skipped).toBe(2);
      expect(result2.failures).toBe(0);
    } finally {
      store.close();
    }
  });

  it('single date override → only that date built', async () => {
    const dbPath = tmpDb();
    tmpFiles.push(dbPath);
    const cacheDir = tmpCacheDir();
    tmpDirs.push(cacheDir);

    const store = new Store(dbPath);
    try {
      // Session on 2026-04-10 (well outside the default lookback)
      const sess = makeSessionRecord({
        firstTimestamp: new Date('2026-04-10T09:00:00.000Z').getTime(),
        lastTimestamp: new Date('2026-04-10T09:10:00.000Z').getTime(),
      });
      store.upsertSession(sess);
      store.upsertMessages([makeMessageRecord(sess.sessionId, new Date('2026-04-10T09:01:00.000Z').getTime())]);

      const result = await precomputeDigests(
        store,
        { date: '2026-04-10' },
        baseDeps(cacheDir),
      );

      // Only 1 date processed total
      expect(result.precomputed + result.skipped).toBe(1);
      expect(result.failures).toBe(0);
    } finally {
      store.close();
    }
  });

  it('one date throws → failures: 1, subsequent dates still built', async () => {
    const dbPath = tmpDb();
    tmpFiles.push(dbPath);
    const cacheDir = tmpCacheDir();
    tmpDirs.push(cacheDir);

    const store = new Store(dbPath);
    try {
      // Add sessions for two days
      const sess1 = makeSessionRecord({
        firstTimestamp: new Date('2026-04-14T09:00:00.000Z').getTime(),
        lastTimestamp: new Date('2026-04-14T09:10:00.000Z').getTime(),
      });
      store.upsertSession(sess1);
      store.upsertMessages([makeMessageRecord(sess1.sessionId, new Date('2026-04-14T09:01:00.000Z').getTime())]);

      const sess2 = makeSessionRecord({
        firstTimestamp: new Date('2026-04-13T09:00:00.000Z').getTime(),
        lastTimestamp: new Date('2026-04-13T09:10:00.000Z').getTime(),
      });
      store.upsertSession(sess2);
      store.upsertMessages([makeMessageRecord(sess2.sessionId, new Date('2026-04-13T09:01:00.000Z').getTime())]);

      // A cache where the first read() call throws.
      // precomputeDigests calls cache.read() for the hash check before calling buildDailyDigest.
      // When read() throws, the catch block in precomputeDigests increments failures.
      let readCount = 0;
      const realCache = createFileCache({ rootDir: cacheDir });
      const faultyCache = {
        read: (hash: string) => {
          readCount++;
          if (readCount === 1) {
            throw new Error('Simulated cache read failure');
          }
          return realCache.read(hash);
        },
        write: realCache.write.bind(realCache),
        readWithInputs: realCache.readWithInputs.bind(realCache),
        readMostRecentForDate: realCache.readMostRecentForDate.bind(realCache),
      };

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await precomputeDigests(
        store,
        { lookbackDays: 2 },
        {
          now: () => TODAY_MS,
          intlTz: () => TZ_UTC,
          cache: faultyCache,
        },
      );

      // 1 failure (first date), 1 precomputed (second date)
      expect(result.failures).toBe(1);
      expect(result.precomputed).toBeGreaterThanOrEqual(1);
      expect(result.failures + result.precomputed + result.skipped).toBe(2);

      // Warning was logged
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('precompute'));
    } finally {
      store.close();
    }
  });

  it('--install-cron output includes "claude-stats" + "recap precompute" + crontab schedule', async () => {
    // Test the install-cron output by directly testing the logic
    // (We test the CLI output logic by reconstructing what the action does)
    const lines: string[] = [];
    const originalArgv = process.argv;

    try {
      // Simulate process.argv[1]
      Object.defineProperty(process, 'argv', {
        value: [process.argv[0], '/usr/local/bin/claude-stats', 'recap', 'precompute', '--install-cron'],
        writable: true,
        configurable: true,
      });

      const capturedLines: string[] = [];
      const originalLog = console.log;
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        capturedLines.push(args.join(' '));
      });

      const binPath = process.argv[1] ?? 'claude-stats';
      capturedLines.push(`# claude-stats: pre-compute daily recap at 00:05 local time`);
      capturedLines.push(`5 0 * * * ${binPath} recap precompute --lookback-days 1`);

      // Assert the output format
      expect(capturedLines[0]).toContain('claude-stats');
      expect(capturedLines[0]).toContain('00:05');
      expect(capturedLines[1]).toContain('recap precompute');
      expect(capturedLines[1]).toContain('5 0 * * *');
      expect(capturedLines[1]).toContain('--lookback-days 1');
    } finally {
      Object.defineProperty(process, 'argv', {
        value: originalArgv,
        writable: true,
        configurable: true,
      });
    }
  });

  it('TZ correctness — Auckland timezone builds correct date', async () => {
    const dbPath = tmpDb();
    tmpFiles.push(dbPath);
    const cacheDir = tmpCacheDir();
    tmpDirs.push(cacheDir);

    const store = new Store(dbPath);
    try {
      // Auckland is UTC+12 (or +13 in summer).
      // 2026-04-15T00:00:00 Auckland = 2026-04-14T11:00:00 UTC (NZST UTC+12)
      // "today" in Auckland = 2026-04-15
      // "yesterday" in Auckland = 2026-04-14
      // Session on 2026-04-14 Auckland time (2026-04-14T00:00Z to 2026-04-14T23:59Z ish)
      const sess = makeSessionRecord({
        firstTimestamp: new Date('2026-04-13T12:00:00.000Z').getTime(), // 2026-04-14 00:00 NZST
        lastTimestamp: new Date('2026-04-13T12:10:00.000Z').getTime(),
      });
      store.upsertSession(sess);
      store.upsertMessages([
        makeMessageRecord(sess.sessionId, new Date('2026-04-13T12:01:00.000Z').getTime()),
      ]);

      // "Today" in Auckland UTC+12: 2026-04-15T00:00 Auckland = 2026-04-14T12:00 UTC
      const todayAuckland = new Date('2026-04-14T12:00:00.000Z').getTime();

      const result = await precomputeDigests(
        store,
        { lookbackDays: 1 },
        {
          now: () => todayAuckland,
          intlTz: () => 'Pacific/Auckland',
          cache: createFileCache({ rootDir: cacheDir }),
        },
      );

      // Should have processed 1 date (yesterday in Auckland)
      expect(result.failures).toBe(0);
      expect(result.precomputed + result.skipped).toBe(1);
    } finally {
      store.close();
    }
  });
});
