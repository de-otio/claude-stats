import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeSnapshotHash,
  createFileCache,
  type SnapshotHashInputs,
} from '../../recap/cache.js';
import type { DailyDigest } from '../../recap/types.js';

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
});
