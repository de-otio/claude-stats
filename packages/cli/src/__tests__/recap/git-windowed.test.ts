/**
 * Tests for createWindowedGitProvider in packages/cli/src/recap/git.ts.
 *
 * The provider fetches git data ONCE over a multi-day window and answers
 * per-day queries from memory. The load-bearing property is PARITY: for every
 * day in the window its per-day output must equal the per-day
 * `getProjectGitActivity` (which the multi-day digest loop used to call once
 * per day). Uses real temp git repos with commits dated on distinct days.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProjectGitActivity, createWindowedGitProvider } from '../../recap/git.js';

/**
 * These tests shell out to real `git` — `init`, several `commit`s, then the
 * reads under test — so a single case is ~2s of subprocess work even on an idle
 * machine. Vitest's 5s default is comfortable in isolation and too tight under
 * a full-suite run, where a dozen workers contend for process slots and disk;
 * the result was a test that passed alone and timed out in CI-shaped runs.
 *
 * Declaring the real cost is the honest fix. Raising the cap does not hide a
 * slow implementation: the code under test does no I/O of its own beyond the
 * `git` calls the fixture forces, and the parity assertions are unchanged.
 */
const GIT_SUBPROCESS_TIMEOUT_MS = 30_000;

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function tmpRepo(email: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-recap-win-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', dir], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', email], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Tester'], { encoding: 'utf8' });
  return dir;
}

/** Commit `n` lines to a fresh file, authored by `email`, dated `isoDate`. */
function commitOnDate(repo: string, email: string, message: string, isoDate: string, lines = 3): void {
  const f = path.join(repo, `${message.replace(/\W+/g, '_')}.txt`);
  fs.writeFileSync(f, Array(lines + 1).join('line\n'));
  execFileSync('git', ['-C', repo, 'add', '--', f], { encoding: 'utf8' });
  const env = { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate };
  execFileSync(
    'git',
    ['-C', repo, 'commit', '--no-gpg-sign', `--author=Tester <${email}>`, '-m', message],
    { encoding: 'utf8', env },
  );
}

// A 3-day UTC window: 2025-03-15, -16, -17.
const EMAIL = 'tester@example.com';
const WINDOW_START = Date.UTC(2025, 2, 15, 0, 0, 0);
const WINDOW_END = Date.UTC(2025, 2, 18, 0, 0, 0);
const DAYS = [
  { start: Date.UTC(2025, 2, 15), end: Date.UTC(2025, 2, 16) },
  { start: Date.UTC(2025, 2, 16), end: Date.UTC(2025, 2, 17) },
  { start: Date.UTC(2025, 2, 17), end: Date.UTC(2025, 2, 18) },
];

describe('createWindowedGitProvider', () => {
  it('per-day output matches per-day getProjectGitActivity across the window', () => {
    const repo = tmpRepo(EMAIL);
    // Day 15: 2 commits; day 16: 1 commit; day 17: 3 commits — distinct line counts.
    commitOnDate(repo, EMAIL, 'd15-a', '2025-03-15T09:00:00Z', 5);
    commitOnDate(repo, EMAIL, 'd15-b', '2025-03-15T18:00:00Z', 2);
    commitOnDate(repo, EMAIL, 'd16-a', '2025-03-16T12:00:00Z', 7);
    commitOnDate(repo, EMAIL, 'd17-a', '2025-03-17T01:00:00Z', 1);
    commitOnDate(repo, EMAIL, 'd17-b', '2025-03-17T10:00:00Z', 4);
    commitOnDate(repo, EMAIL, 'd17-c', '2025-03-17T23:00:00Z', 9);

    const provider = createWindowedGitProvider(WINDOW_START, WINDOW_END);

    const expectedCommits = [2, 1, 3];
    DAYS.forEach((day, i) => {
      const direct = getProjectGitActivity(repo, day.start, day.end, EMAIL);
      const windowed = provider.getProjectGitActivity(repo, day.start, day.end, EMAIL);
      expect(direct).not.toBeNull();
      expect(windowed).not.toBeNull();
      // Git-derived fields must match the per-day path exactly.
      expect(windowed!.commitsToday).toBe(expectedCommits[i]);
      expect(windowed!.commitsToday).toBe(direct!.commitsToday);
      expect(windowed!.filesChanged).toBe(direct!.filesChanged);
      expect(windowed!.linesAdded).toBe(direct!.linesAdded);
      expect(windowed!.linesRemoved).toBe(direct!.linesRemoved);
      expect([...windowed!.subjects]).toEqual([...direct!.subjects]);
      expect(windowed!.pushed).toBe(direct!.pushed);
      // No GitHub remote on a temp repo → gh fails → both null. (Avoids any
      // env-dependent flake from a locally-authenticated gh.)
      expect(windowed!.prMerged).toBe(direct!.prMerged);
    });
  });

  it('resolves and memoises the author email; returns null for a non-git dir', () => {
    const repo = tmpRepo(EMAIL);
    const provider = createWindowedGitProvider(WINDOW_START, WINDOW_END);
    expect(provider.getAuthorEmail(repo)).toBe(EMAIL);
    // Second call hits the memo and returns the same value.
    expect(provider.getAuthorEmail(repo)).toBe(EMAIL);

    const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-recap-win-nogit-'));
    tmpDirs.push(notGit);
    expect(provider.getAuthorEmail(notGit)).toBeNull();
    expect(
      provider.getProjectGitActivity(notGit, DAYS[0]!.start, DAYS[0]!.end, EMAIL),
    ).toBeNull();
  });

  it('caps per-day subjects at 5 with "+N more"', () => {
    const repo = tmpRepo(EMAIL);
    for (let i = 1; i <= 7; i++) {
      commitOnDate(repo, EMAIL, `many-${i}`, `2025-03-16T0${i}:00:00Z`, 1);
    }
    const provider = createWindowedGitProvider(WINDOW_START, WINDOW_END);
    const day16 = provider.getProjectGitActivity(repo, DAYS[1]!.start, DAYS[1]!.end, EMAIL);
    expect(day16).not.toBeNull();
    expect(day16!.commitsToday).toBe(7);
    expect(day16!.subjects.length).toBe(6); // 5 + "+N more"
    expect(day16!.subjects[5]).toMatch(/^\+2 more$/);
  });
}, GIT_SUBPROCESS_TIMEOUT_MS);
