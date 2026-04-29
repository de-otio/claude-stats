import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeSnapshotHash,
  createFileCache,
  type SnapshotHashInputs,
} from '../../recap/cache.js';
import type { DailyDigest, CachedEntry } from '../../recap/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseInputs(): SnapshotHashInputs {
  return {
    date: '2026-04-26',
    tz: 'Europe/Berlin',
    sortedProjectPaths: ['/home/user/proj-a', '/home/user/proj-b'],
    maxMessageUuid: 'uuid-abc-123',
    perProjectLastCommit: {
      '/home/user/proj-a': 'deadbeef',
      '/home/user/proj-b': null,
    },
  };
}

function baseDigest(): DailyDigest {
  return {
    date: '2026-04-26',
    tz: 'Europe/Berlin',
    totals: { sessions: 2, segments: 4, activeMs: 60000, estimatedCost: 0.05, projects: 2 },
    items: [],
    cached: false,
    snapshotHash: 'placeholder',
  };
}

// ── Test isolation ────────────────────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
}

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ── computeSnapshotHash — determinism ─────────────────────────────────────────

describe('computeSnapshotHash', () => {
  it('produces the same hash for the same inputs', () => {
    const h1 = computeSnapshotHash(baseInputs());
    const h2 = computeSnapshotHash(baseInputs());
    expect(h1).toBe(h2);
    // Must be a lowercase 64-char hex string (SHA-256).
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when date changes', () => {
    const h1 = computeSnapshotHash(baseInputs());
    const h2 = computeSnapshotHash({ ...baseInputs(), date: '2026-04-27' });
    expect(h1).not.toBe(h2);
  });

  it('differs when tz changes', () => {
    const h1 = computeSnapshotHash(baseInputs());
    const h2 = computeSnapshotHash({ ...baseInputs(), tz: 'America/New_York' });
    expect(h1).not.toBe(h2);
  });

  it('differs when a new project path is added (SR-4)', () => {
    const h1 = computeSnapshotHash(baseInputs());
    const h2 = computeSnapshotHash({
      ...baseInputs(),
      sortedProjectPaths: [...baseInputs().sortedProjectPaths, '/home/user/proj-c'],
    });
    expect(h1).not.toBe(h2);
  });

  it('differs when maxMessageUuid changes', () => {
    const h1 = computeSnapshotHash(baseInputs());
    const h2 = computeSnapshotHash({ ...baseInputs(), maxMessageUuid: 'uuid-xyz-999' });
    expect(h1).not.toBe(h2);
  });

  it('differs when a per-project commit SHA changes', () => {
    const h1 = computeSnapshotHash(baseInputs());
    const h2 = computeSnapshotHash({
      ...baseInputs(),
      perProjectLastCommit: {
        '/home/user/proj-a': 'cafebabe', // changed
        '/home/user/proj-b': null,
      },
    });
    expect(h1).not.toBe(h2);
  });

  it('is the same when project paths are reordered (sorted internally)', () => {
    const h1 = computeSnapshotHash({
      ...baseInputs(),
      sortedProjectPaths: ['/home/user/proj-a', '/home/user/proj-b'],
    });
    const h2 = computeSnapshotHash({
      ...baseInputs(),
      sortedProjectPaths: ['/home/user/proj-b', '/home/user/proj-a'],
    });
    expect(h1).toBe(h2);
  });

  it('is the same when perProjectLastCommit keys are in different order', () => {
    const h1 = computeSnapshotHash({
      ...baseInputs(),
      perProjectLastCommit: {
        '/home/user/proj-a': 'deadbeef',
        '/home/user/proj-b': null,
      },
    });
    const h2 = computeSnapshotHash({
      ...baseInputs(),
      perProjectLastCommit: {
        '/home/user/proj-b': null,
        '/home/user/proj-a': 'deadbeef',
      },
    });
    expect(h1).toBe(h2);
  });

  it('differs when maxMessageUuid is null vs a real uuid', () => {
    const h1 = computeSnapshotHash({ ...baseInputs(), maxMessageUuid: null });
    const h2 = computeSnapshotHash({ ...baseInputs(), maxMessageUuid: 'some-uuid' });
    expect(h1).not.toBe(h2);
  });
});

// ── CacheClient — file I/O ────────────────────────────────────────────────────

describe('createFileCache', () => {
  it('returns null on read when the cache file does not exist', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const result = cache.read('nonexistent-hash');
    expect(result).toBeNull();
  });

  it('write then read returns a byte-identical digest', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const digest = baseDigest();
    const hash = computeSnapshotHash(baseInputs());

    cache.write(hash, digest);
    const result = cache.read(hash);

    expect(result).toEqual(digest);
  });

  it('second write with same hash wins (overwrites, mtime updated)', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const hash = computeSnapshotHash(baseInputs());

    const digest1 = { ...baseDigest(), snapshotHash: 'first' };
    cache.write(hash, digest1);

    const digest2 = { ...baseDigest(), snapshotHash: 'second' };
    cache.write(hash, digest2);

    const result = cache.read(hash);
    expect(result?.snapshotHash).toBe('second');
  });

  it('cache file has mode 0o600 after write (SR-3)', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const hash = computeSnapshotHash(baseInputs());

    cache.write(hash, baseDigest());

    const cacheFilePath = path.join(tmpDir, `${hash}.json`);
    const mode = fs.statSync(cacheFilePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns null (not throws) for a corrupt cache file', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const hash = 'aaaa' + '0'.repeat(60);

    // Write a corrupt (non-JSON) file directly.
    fs.writeFileSync(path.join(tmpDir, `${hash}.json`), 'not valid json {{{{');

    const result = cache.read(hash);
    expect(result).toBeNull();
  });

  it('LRU prune: writing 31 entries with maxEntries:30 leaves only 30 files', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir, maxEntries: 30 });

    // Write 31 entries with distinct hashes, adding a tiny sleep between
    // each so mtimes are distinguishable on filesystems with 1ms resolution.
    // We avoid actual sleeping by tweaking file mtimes after the fact.
    for (let i = 0; i < 31; i++) {
      const inputs: SnapshotHashInputs = {
        ...baseInputs(),
        // Each iteration gets a unique date to produce a unique hash.
        date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      };
      const hash = computeSnapshotHash(inputs);
      cache.write(hash, { ...baseDigest(), snapshotHash: hash });

      // Advance the mtime of the file by i milliseconds so pruning has a
      // stable sort order even on coarse-grained filesystems.
      const filePath = path.join(tmpDir, `${hash}.json`);
      const baseTime = new Date('2026-04-01T00:00:00Z');
      const t = new Date(baseTime.getTime() + i);
      fs.utimesSync(filePath, t, t);
    }

    const remaining = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
    expect(remaining.length).toBe(30);
  });

  it('LRU prune removes the oldest entry', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir, maxEntries: 2 });

    const hashes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const inputs: SnapshotHashInputs = {
        ...baseInputs(),
        date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      };
      const hash = computeSnapshotHash(inputs);
      hashes.push(hash);
      cache.write(hash, { ...baseDigest(), snapshotHash: hash });

      // Set distinct mtimes: i=0 is oldest.
      const filePath = path.join(tmpDir, `${hash}.json`);
      const baseTime = new Date('2026-04-01T00:00:00Z');
      const t = new Date(baseTime.getTime() + i);
      fs.utimesSync(filePath, t, t);
    }

    const remaining = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
    expect(remaining.length).toBe(2);
    // The file with i=0 (oldest mtime) should be gone.
    expect(remaining).not.toContain(`${hashes[0]}.json`);
    expect(remaining).toContain(`${hashes[1]}.json`);
    expect(remaining).toContain(`${hashes[2]}.json`);
  });

  // v3.07: Empty digest serialises and deserialises losslessly
  it('empty digest serialises and deserialises losslessly (byte-identical round-trip)', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });

    // An empty digest: no items, zero totals — as produced by the negative-caching
    // short-circuit path in buildDailyDigest for days with no sessions.
    const emptyDigest: DailyDigest = {
      date: '2026-04-26',
      tz: 'UTC',
      totals: { sessions: 0, segments: 0, activeMs: 0, estimatedCost: 0, projects: 0 },
      items: [],
      cached: false,
      snapshotHash: 'abc123',
    };

    const hash = computeSnapshotHash({
      date: '2026-04-26',
      tz: 'UTC',
      sortedProjectPaths: [],
      maxMessageUuid: null,
      perProjectLastCommit: {},
    });

    cache.write(hash, emptyDigest);
    const result = cache.read(hash);

    // Byte-identical round-trip: every field must match exactly.
    expect(result).not.toBeNull();
    expect(result!.date).toBe(emptyDigest.date);
    expect(result!.tz).toBe(emptyDigest.tz);
    expect(result!.totals).toEqual(emptyDigest.totals);
    expect(result!.items).toHaveLength(0);
    expect(result!.cached).toBe(false);
    expect(result!.snapshotHash).toBe(emptyDigest.snapshotHash);
    // Serialise both to JSON to confirm byte-identity
    expect(JSON.stringify(result)).toBe(JSON.stringify(emptyDigest));
  });

  // v3.07: LRU prune treats empty digests like any other entry
  it('LRU prune counts empty digests toward maxEntries (no special treatment)', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir, maxEntries: 2 });

    const hashes: string[] = [];

    // Write two empty-digest entries and one regular entry (3 total, maxEntries=2)
    for (let i = 0; i < 3; i++) {
      const isEmptyDigest = i < 2;
      const digest: DailyDigest = isEmptyDigest
        ? {
            date: `2026-04-${String(i + 1).padStart(2, '0')}`,
            tz: 'UTC',
            totals: { sessions: 0, segments: 0, activeMs: 0, estimatedCost: 0, projects: 0 },
            items: [],
            cached: false,
            snapshotHash: `empty-${i}`,
          }
        : baseDigest();

      const inputs: SnapshotHashInputs = {
        ...baseInputs(),
        date: `2026-04-${String(i + 1).padStart(2, '0')}`,
      };
      const hash = computeSnapshotHash(inputs);
      hashes.push(hash);
      cache.write(hash, { ...digest, snapshotHash: hash });

      // Assign distinct mtimes so the sort is stable: i=0 oldest.
      const filePath = path.join(tmpDir, `${hash}.json`);
      const baseTime = new Date('2026-04-01T00:00:00Z');
      const t = new Date(baseTime.getTime() + i);
      fs.utimesSync(filePath, t, t);
    }

    const remaining = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
    // Prune must have reduced count to maxEntries regardless of whether entries
    // are empty digests or regular digests.
    expect(remaining.length).toBe(2);
    // Oldest (i=0) must be gone — it was an empty digest, but that doesn't exempt it.
    expect(remaining).not.toContain(`${hashes[0]}.json`);
  });
});

// ── v3.06: readWithInputs and readMostRecentForDate ───────────────────────────

describe('createFileCache — v3.06 readWithInputs', () => {
  it('write with inputs, readWithInputs returns full CachedEntry', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const digest = baseDigest();
    const inputs = baseInputs();
    const hash = computeSnapshotHash(inputs);

    cache.write(hash, digest, inputs);
    const entry: CachedEntry | null = cache.readWithInputs(hash);

    expect(entry).not.toBeNull();
    expect(entry!.digest).toEqual(digest);
    expect(entry!.inputs).toEqual(inputs);
  });

  it('write without inputs (legacy), readWithInputs returns null (no inputs persisted)', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const digest = baseDigest();
    const hash = computeSnapshotHash(baseInputs());

    // Legacy write: no inputs argument
    cache.write(hash, digest);
    const entry = cache.readWithInputs(hash);

    // No inputs were stored → null
    expect(entry).toBeNull();
    // But read() (legacy path) still works
    expect(cache.read(hash)).toEqual(digest);
  });

  it('readWithInputs returns null for a corrupt cache file', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const hash = 'bbbb' + '0'.repeat(60);

    fs.writeFileSync(path.join(tmpDir, `${hash}.json`), 'not json +++');
    expect(cache.readWithInputs(hash)).toBeNull();
  });

  it('inputs are preserved across re-serialisation (round-trip)', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const inputs: SnapshotHashInputs = {
      ...baseInputs(),
      perSessionLastMessageUuid: {
        'sess-aaa': 'uuid-1',
        'sess-bbb': null,
      },
    };
    const digest = baseDigest();
    const hash = computeSnapshotHash(inputs);

    cache.write(hash, digest, inputs);
    const entry = cache.readWithInputs(hash);

    expect(entry).not.toBeNull();
    expect(entry!.inputs.perSessionLastMessageUuid).toEqual({
      'sess-aaa': 'uuid-1',
      'sess-bbb': null,
    });
  });
});

describe('createFileCache — v3.06 readMostRecentForDate', () => {
  it('finds entry by date and tz, returning the one with the latest mtime', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const inputs = baseInputs(); // date: 2026-04-26, tz: Europe/Berlin

    const hash1 = computeSnapshotHash({ ...inputs, maxMessageUuid: 'uuid-aaa' });
    const hash2 = computeSnapshotHash({ ...inputs, maxMessageUuid: 'uuid-bbb' });

    const digest1: DailyDigest = { ...baseDigest(), snapshotHash: hash1 };
    const digest2: DailyDigest = { ...baseDigest(), snapshotHash: hash2 };

    cache.write(hash1, digest1, { ...inputs, maxMessageUuid: 'uuid-aaa' });
    cache.write(hash2, digest2, { ...inputs, maxMessageUuid: 'uuid-bbb' });

    // Assign distinct mtimes: hash1 is older, hash2 is newer
    const baseTime = new Date('2026-04-26T00:00:00Z');
    fs.utimesSync(path.join(tmpDir, `${hash1}.json`), new Date(baseTime.getTime() + 1), new Date(baseTime.getTime() + 1));
    fs.utimesSync(path.join(tmpDir, `${hash2}.json`), new Date(baseTime.getTime() + 2), new Date(baseTime.getTime() + 2));

    const result = cache.readMostRecentForDate('2026-04-26', 'Europe/Berlin');
    expect(result).not.toBeNull();
    // Should return hash2 (newer mtime)
    expect(result!.digest.snapshotHash).toBe(hash2);
    expect(result!.inputs.maxMessageUuid).toBe('uuid-bbb');
  });

  it('returns null when no entry matches date+tz', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const inputs = baseInputs(); // date: 2026-04-26, tz: Europe/Berlin
    const hash = computeSnapshotHash(inputs);
    cache.write(hash, baseDigest(), inputs);

    // Query a different date
    expect(cache.readMostRecentForDate('2026-04-27', 'Europe/Berlin')).toBeNull();
    // Query a different tz
    expect(cache.readMostRecentForDate('2026-04-26', 'UTC')).toBeNull();
  });

  it('returns null when the matching entry has no inputs (legacy entry)', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const hash = computeSnapshotHash(baseInputs());
    // Write without inputs (legacy)
    cache.write(hash, baseDigest());

    const result = cache.readMostRecentForDate('2026-04-26', 'Europe/Berlin');
    // Entry matches date+tz but has no inputs — cannot be used for patching
    expect(result).toBeNull();
  });

  it('returns null when cache directory does not exist', () => {
    tmpDir = createTmpDir();
    // Use a non-existent subdirectory
    const nonExistentDir = path.join(tmpDir, 'does-not-exist');
    const cache = createFileCache({ rootDir: nonExistentDir });

    const result = cache.readMostRecentForDate('2026-04-26', 'Europe/Berlin');
    expect(result).toBeNull();
  });

  it('skips corrupt cache files when scanning for date match', () => {
    tmpDir = createTmpDir();
    const cache = createFileCache({ rootDir: tmpDir });
    const inputs = baseInputs();
    const goodHash = computeSnapshotHash(inputs);
    const badHash = 'cccc' + '0'.repeat(60);

    // Write one good entry and one corrupt file
    cache.write(goodHash, baseDigest(), inputs);
    fs.writeFileSync(path.join(tmpDir, `${badHash}.json`), 'not json +++', { mode: 0o600 });

    // Set mtime of corrupt file to be newer than the good file
    const baseTime = new Date('2026-04-26T00:00:00Z');
    fs.utimesSync(path.join(tmpDir, `${goodHash}.json`), new Date(baseTime.getTime() + 1), new Date(baseTime.getTime() + 1));
    fs.utimesSync(path.join(tmpDir, `${badHash}.json`), new Date(baseTime.getTime() + 2), new Date(baseTime.getTime() + 2));

    // Should find the good entry, not the corrupt one
    const result = cache.readMostRecentForDate('2026-04-26', 'Europe/Berlin');
    expect(result).not.toBeNull();
    expect(result!.digest.snapshotHash).toBe('placeholder'); // from baseDigest()
  });
});
