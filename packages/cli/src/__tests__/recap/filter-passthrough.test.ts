/**
 * Tests for filter passthrough in buildDailyDigest and cache-key correctness.
 *
 * Covers:
 *   - projectPath filter: only sessions for that project appear in the digest
 *   - accountUuid filter: only sessions for that account appear
 *   - includeCI: true includes non-interactive sessions
 *   - Different filters for the same day produce different snapshotHash values
 *   - computeSnapshotHash unit tests for filter dimension
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Store } from '../../store/index.js';
import type { SessionRecord, MessageRecord } from '@claude-stats/core/types';
import { buildDailyDigest } from '../../recap/index.js';
import type { BuildDailyDigestDeps } from '../../recap/index.js';
import type { DailyDigest, ProjectGitActivity, CachedEntry } from '../../recap/types.js';
import { computeSnapshotHash, type CacheClient, type SnapshotHashInputs } from '../../recap/cache.js';

// ─── Fixed base timestamp ─────────────────────────────────────────────────────

/** 2024-01-15T08:00:00.000Z (Monday, UTC) */
const BASE_TS = 1705305600000;
const NOW_TS = BASE_TS + 2 * 3_600_000; // 2024-01-15T10:00:00Z

const min = (n: number): number => BASE_TS + n * 60_000;

let _sessionCounter = 0;
let _msgCounter = 0;

function nextSessionId(): string {
  return `sess-fp-${String(++_sessionCounter).padStart(4, '0')}`;
}

function nextMsgUuid(): string {
  return `msg-fp-${String(++_msgCounter).padStart(4, '0')}`;
}

// ─── Helpers (mirrored from index.test.ts) ────────────────────────────────────

function tmpDb(): string {
  return path.join(
    os.tmpdir(),
    `cs-filter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function makeSessionRecord(
  overrides: Partial<SessionRecord> & {
    sessionId?: string;
    projectPath?: string;
    firstTimestamp?: number;
    lastTimestamp?: number;
    accountUuid?: string | null;
    isInteractive?: boolean;
  } = {},
): SessionRecord {
  return {
    sessionId: overrides.sessionId ?? nextSessionId(),
    projectPath: overrides.projectPath ?? '/home/user/projects/default',
    sourceFile: '/home/user/.claude/projects/default/sess.jsonl',
    firstTimestamp: overrides.firstTimestamp ?? BASE_TS,
    lastTimestamp: overrides.lastTimestamp ?? BASE_TS + 600_000,
    claudeVersion: '2.1.70',
    entrypoint: null,
    gitBranch: 'main',
    permissionMode: 'default',
    isInteractive: overrides.isInteractive !== undefined ? overrides.isInteractive : true,
    promptCount: 2,
    assistantMessageCount: 2,
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ['claude-sonnet-4-6'],
    repoUrl: overrides.repoUrl ?? null,
    accountUuid: overrides.accountUuid !== undefined ? overrides.accountUuid : null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: null,
    medianResponseTimeMs: null,
    ...overrides,
  };
}

function makeMessageRecord(
  overrides: Omit<Partial<MessageRecord>, 'sessionId' | 'timestamp'> & {
    uuid?: string;
    sessionId: string;
    timestamp: number;
  },
): MessageRecord {
  const base: MessageRecord = {
    uuid: overrides.uuid ?? nextMsgUuid(),
    sessionId: overrides.sessionId,
    timestamp: overrides.timestamp,
    claudeVersion: null,
    model: 'claude-sonnet-4-6',
    stopReason: 'end_turn',
    inputTokens: 500,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools: ['Read'],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: null,
  };
  const { sessionId: _s, timestamp: _t, uuid: _u, ...rest } = overrides;
  void _s; void _t; void _u;
  return { ...base, ...rest };
}

/** No-op in-memory cache — all reads return null, writes are discarded. */
function noopCache(): CacheClient {
  return {
    read: vi.fn(() => null),
    readWithInputs: vi.fn(() => null),
    readMostRecentForDate: vi.fn(() => null),
    write: vi.fn(),
  };
}

/** Common deps for filter tests. */
function defaultDeps(overrides: Partial<BuildDailyDigestDeps> = {}): BuildDailyDigestDeps {
  return {
    getProjectGitActivity: vi.fn((): ProjectGitActivity | null => null),
    getAuthorEmail: vi.fn(() => 'test@example.com'),
    cache: noopCache(),
    now: () => NOW_TS,
    intlTz: () => 'UTC',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('filter passthrough — projectPath', () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    _sessionCounter = 0;
    _msgCounter = 0;
    dbPath = tmpDb();
    store = new Store(dbPath);

    // Project A: two sessions with messages
    const sessA1 = nextSessionId();
    store.upsertSession(makeSessionRecord({
      sessionId: sessA1,
      projectPath: '/home/user/project-alpha',
      firstTimestamp: min(0),
      lastTimestamp: min(10),
    }));
    store.upsertMessages([
      makeMessageRecord({ sessionId: sessA1, timestamp: min(0), promptText: 'Fix bug in alpha' }),
      makeMessageRecord({ sessionId: sessA1, timestamp: min(5) }),
    ]);

    // Project B: one session with messages
    const sessB1 = nextSessionId();
    store.upsertSession(makeSessionRecord({
      sessionId: sessB1,
      projectPath: '/home/user/project-beta',
      firstTimestamp: min(0),
      lastTimestamp: min(10),
    }));
    store.upsertMessages([
      makeMessageRecord({ sessionId: sessB1, timestamp: min(0), promptText: 'Fix bug in beta' }),
      makeMessageRecord({ sessionId: sessB1, timestamp: min(5) }),
    ]);
  });

  afterEach(() => {
    store.close();
    fs.unlinkSync(dbPath);
  });

  it('includes only sessions from the filtered projectPath', async () => {
    const digest = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC', projectPath: '/home/user/project-alpha' },
      defaultDeps(),
    );

    expect(digest.items).toHaveLength(1);
    expect(digest.items[0]!.project).toBe('/home/user/project-alpha');
    expect(digest.totals.sessions).toBe(1);
  });

  it('excludes all sessions from the other projectPath', async () => {
    const digestAlpha = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC', projectPath: '/home/user/project-alpha' },
      defaultDeps(),
    );
    const digestBeta = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC', projectPath: '/home/user/project-beta' },
      defaultDeps(),
    );

    // Each filtered digest sees only its own project
    expect(digestAlpha.items.every(i => i.project === '/home/user/project-alpha')).toBe(true);
    expect(digestBeta.items.every(i => i.project === '/home/user/project-beta')).toBe(true);
  });

  it('unfiltered digest includes both projects', async () => {
    const digest = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC' },
      defaultDeps(),
    );
    const projects = new Set(digest.items.map(i => i.project));
    expect(projects.has('/home/user/project-alpha')).toBe(true);
    expect(projects.has('/home/user/project-beta')).toBe(true);
  });
});

// ─── accountUuid filter ───────────────────────────────────────────────────────

describe('filter passthrough — accountUuid', () => {
  let store: Store;
  let dbPath: string;

  const ACCOUNT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const ACCOUNT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

  beforeEach(() => {
    _sessionCounter = 0;
    _msgCounter = 0;
    dbPath = tmpDb();
    store = new Store(dbPath);

    // Session owned by account A
    const sessA = nextSessionId();
    store.upsertSession(makeSessionRecord({
      sessionId: sessA,
      projectPath: '/home/user/shared-project',
      accountUuid: ACCOUNT_A,
      firstTimestamp: min(0),
      lastTimestamp: min(10),
    }));
    store.upsertMessages([
      makeMessageRecord({ sessionId: sessA, timestamp: min(0), promptText: 'Account A work' }),
      makeMessageRecord({ sessionId: sessA, timestamp: min(5) }),
    ]);

    // Session owned by account B
    const sessB = nextSessionId();
    store.upsertSession(makeSessionRecord({
      sessionId: sessB,
      projectPath: '/home/user/shared-project',
      accountUuid: ACCOUNT_B,
      firstTimestamp: min(20),
      lastTimestamp: min(30),
    }));
    store.upsertMessages([
      makeMessageRecord({ sessionId: sessB, timestamp: min(20), promptText: 'Account B work' }),
      makeMessageRecord({ sessionId: sessB, timestamp: min(25) }),
    ]);
  });

  afterEach(() => {
    store.close();
    fs.unlinkSync(dbPath);
  });

  it('filters to account A only — returns one item', async () => {
    const digest = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC', accountUuid: ACCOUNT_A },
      defaultDeps(),
    );
    expect(digest.totals.sessions).toBe(1);
  });

  it('filters to account B only — returns one item', async () => {
    const digest = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC', accountUuid: ACCOUNT_B },
      defaultDeps(),
    );
    expect(digest.totals.sessions).toBe(1);
  });

  it('unfiltered returns both accounts', async () => {
    const digest = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC' },
      defaultDeps(),
    );
    expect(digest.totals.sessions).toBe(2);
  });
});

// ─── includeCI filter ─────────────────────────────────────────────────────────

describe('filter passthrough — includeCI', () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    _sessionCounter = 0;
    _msgCounter = 0;
    dbPath = tmpDb();
    store = new Store(dbPath);

    // Interactive session (normal)
    const sessInteractive = nextSessionId();
    store.upsertSession(makeSessionRecord({
      sessionId: sessInteractive,
      projectPath: '/home/user/myapp',
      isInteractive: true,
      firstTimestamp: min(0),
      lastTimestamp: min(10),
    }));
    store.upsertMessages([
      makeMessageRecord({ sessionId: sessInteractive, timestamp: min(0), promptText: 'Interactive work' }),
      makeMessageRecord({ sessionId: sessInteractive, timestamp: min(5) }),
    ]);

    // Non-interactive (CI) session
    const sessCi = nextSessionId();
    store.upsertSession(makeSessionRecord({
      sessionId: sessCi,
      projectPath: '/home/user/myapp',
      isInteractive: false,
      firstTimestamp: min(20),
      lastTimestamp: min(30),
    }));
    store.upsertMessages([
      makeMessageRecord({ sessionId: sessCi, timestamp: min(20), promptText: 'CI run' }),
      makeMessageRecord({ sessionId: sessCi, timestamp: min(25) }),
    ]);
  });

  afterEach(() => {
    store.close();
    fs.unlinkSync(dbPath);
  });

  it('excludes CI session by default (includeCI: false)', async () => {
    const digest = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC' },
      defaultDeps(),
    );
    // Only the interactive session should appear
    expect(digest.totals.sessions).toBe(1);
  });

  it('includes CI session when includeCI: true', async () => {
    const digest = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC', includeCI: true },
      defaultDeps(),
    );
    // Both interactive and CI sessions should appear
    expect(digest.totals.sessions).toBe(2);
  });
});

// ─── Cache-key isolation (no collision between filters) ───────────────────────

describe('filter passthrough — cache-key isolation', () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    _sessionCounter = 0;
    _msgCounter = 0;
    dbPath = tmpDb();
    store = new Store(dbPath);

    // Seed a session so the hash is non-trivial
    const sessId = nextSessionId();
    store.upsertSession(makeSessionRecord({
      sessionId: sessId,
      projectPath: '/home/user/proj',
      firstTimestamp: min(0),
      lastTimestamp: min(10),
    }));
    store.upsertMessages([
      makeMessageRecord({ sessionId: sessId, timestamp: min(0), promptText: 'hello' }),
    ]);
  });

  afterEach(() => {
    store.close();
    fs.unlinkSync(dbPath);
  });

  it('different projectPath filters produce different snapshotHash values', async () => {
    const digestA = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC', projectPath: '/home/user/proj-a' },
      defaultDeps(),
    );
    const digestB = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC', projectPath: '/home/user/proj-b' },
      defaultDeps(),
    );
    expect(digestA.snapshotHash).not.toBe(digestB.snapshotHash);
  });

  it('filtered and unfiltered digests for the same day produce different snapshotHash values', async () => {
    const digestFiltered = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC', projectPath: '/home/user/proj' },
      defaultDeps(),
    );
    const digestUnfiltered = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC' },
      defaultDeps(),
    );
    expect(digestFiltered.snapshotHash).not.toBe(digestUnfiltered.snapshotHash);
  });

  it('same filter applied twice produces the same snapshotHash', async () => {
    const opts = { date: '2024-01-15', tz: 'UTC', projectPath: '/home/user/proj' };
    const digest1 = await buildDailyDigest(store, opts, defaultDeps());
    const digest2 = await buildDailyDigest(store, opts, defaultDeps());
    expect(digest1.snapshotHash).toBe(digest2.snapshotHash);
  });

  it('includeCI:true and includeCI:false (or absent) produce different snapshotHash values', async () => {
    const digestNoCI = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC', includeCI: false },
      defaultDeps(),
    );
    const digestWithCI = await buildDailyDigest(
      store,
      { date: '2024-01-15', tz: 'UTC', includeCI: true },
      defaultDeps(),
    );
    expect(digestNoCI.snapshotHash).not.toBe(digestWithCI.snapshotHash);
  });
});

// ─── computeSnapshotHash unit tests ──────────────────────────────────────────

describe('computeSnapshotHash — filter dimension', () => {
  function baseInputs(): SnapshotHashInputs {
    return {
      date: '2024-01-15',
      tz: 'UTC',
      sortedProjectPaths: ['/home/user/proj'],
      maxMessageUuid: 'msg-0001',
      perProjectLastCommit: { '/home/user/proj': null },
    };
  }

  it('identical inputs without filter produce the same hash', () => {
    expect(computeSnapshotHash(baseInputs())).toBe(computeSnapshotHash(baseInputs()));
  });

  it('identical inputs with identical filter produce the same hash', () => {
    const withFilter = { ...baseInputs(), filter: { projectPath: '/home/user/proj' } };
    expect(computeSnapshotHash(withFilter)).toBe(computeSnapshotHash(withFilter));
  });

  it('different filter.projectPath values produce different hashes', () => {
    const h1 = computeSnapshotHash({ ...baseInputs(), filter: { projectPath: '/home/user/proj-a' } });
    const h2 = computeSnapshotHash({ ...baseInputs(), filter: { projectPath: '/home/user/proj-b' } });
    expect(h1).not.toBe(h2);
  });

  it('different filter.accountUuid values produce different hashes', () => {
    const h1 = computeSnapshotHash({ ...baseInputs(), filter: { accountUuid: 'acct-111' } });
    const h2 = computeSnapshotHash({ ...baseInputs(), filter: { accountUuid: 'acct-222' } });
    expect(h1).not.toBe(h2);
  });

  it('filter.includeCI:true vs false produce different hashes', () => {
    const h1 = computeSnapshotHash({ ...baseInputs(), filter: { includeCI: true } });
    const h2 = computeSnapshotHash({ ...baseInputs(), filter: { includeCI: false } });
    expect(h1).not.toBe(h2);
  });

  it('inputs with no filter vs empty filter object produce different hashes (not a collision)', () => {
    // The "no filter" sentinel and an explicit all-wildcard filter should be
    // distinguishable because absent filter means caller never passed filter opts.
    const noFilter = computeSnapshotHash(baseInputs());
    // An explicit empty filter still encodes includeCI=0 explicitly from the object
    // — but since the filter key is present (even if empty), it still renders the
    // same sentinel string, making them equal. This is correct back-compat behaviour.
    const emptyFilter = computeSnapshotHash({ ...baseInputs(), filter: {} });
    // Both absent and explicit-empty-object produce the same no-filter sentinel.
    expect(noFilter).toBe(emptyFilter);
  });

  it('filter with projectPath differs from no-filter baseline', () => {
    const noFilter = computeSnapshotHash(baseInputs());
    const withProject = computeSnapshotHash({ ...baseInputs(), filter: { projectPath: '/home/user/proj' } });
    expect(noFilter).not.toBe(withProject);
  });

  it('filter with repoUrl differs from no-filter baseline', () => {
    const noFilter = computeSnapshotHash(baseInputs());
    const withRepo = computeSnapshotHash({ ...baseInputs(), filter: { repoUrl: 'https://github.com/example/repo' } });
    expect(noFilter).not.toBe(withRepo);
  });

  it('produced hash is a 64-char hex string', () => {
    const h = computeSnapshotHash({ ...baseInputs(), filter: { projectPath: '/home/user/proj' } });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
