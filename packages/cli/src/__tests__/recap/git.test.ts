/**
 * Tests for packages/cli/src/recap/git.ts
 *
 * Uses real temp git repos created via execFileSync to avoid relying on global
 * git config. SR-1 negative cases verify that malicious user.email values are
 * rejected and no files are written to /tmp.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getProjectGitActivity,
  getAuthorEmail,
  getLastCommitSha,
  isPushed,
  getMergedPrCountToday,
} from '../../recap/git.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-recap-git-'));
}

function gitExec(args: string[], cwd: string): string {
  return execFileSync('git', args, { encoding: 'utf8', cwd }).trim();
}

interface RepoOpts {
  /** Author for commits (default: "Test User <test@example.com>") */
  author?: string;
  /** Whether to create an initial commit (default: true) */
  initialCommit?: boolean;
}

/**
 * Initialise a bare-minimum git repo in tmpDir.
 * Configures user.name/email locally so tests don't rely on global config.
 */
function initRepo(tmpDir: string, opts: RepoOpts = {}): void {
  const author = opts.author ?? 'Test User <test@example.com>';
  const emailMatch = author.match(/<([^>]+)>/);
  const email = emailMatch ? emailMatch[1]! : 'test@example.com';
  const nameMatch = author.match(/^([^<]+)</);
  const name = nameMatch ? nameMatch[1]!.trim() : 'Test User';

  execFileSync('git', ['init', tmpDir], { encoding: 'utf8' });
  execFileSync('git', ['-C', tmpDir, 'config', 'user.email', email], {
    encoding: 'utf8',
  });
  execFileSync('git', ['-C', tmpDir, 'config', 'user.name', name], {
    encoding: 'utf8',
  });

  if (opts.initialCommit !== false) {
    makeCommit(tmpDir, 'initial', author);
  }
}

/**
 * Write a file and make a commit, using --author to pin who authored it.
 * `commitDate` allows overriding the commit timestamp (GIT_COMMITTER_DATE
 * and GIT_AUTHOR_DATE env vars).
 */
function makeCommit(
  repoDir: string,
  message: string,
  author: string,
  commitDate?: Date,
): string {
  const filePath = path.join(repoDir, `${Date.now()}-${Math.random()}.txt`);
  fs.writeFileSync(filePath, message + '\n');
  execFileSync('git', ['-C', repoDir, 'add', '--', filePath], {
    encoding: 'utf8',
  });

  const dateStr = (commitDate ?? new Date()).toISOString();
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: dateStr,
    GIT_COMMITTER_DATE: dateStr,
  };
  execFileSync(
    'git',
    [
      '-C',
      repoDir,
      'commit',
      '--no-gpg-sign',
      `--author=${author}`,
      '-m',
      message,
    ],
    { encoding: 'utf8', env },
  );

  return gitExec(['rev-parse', 'HEAD'], repoDir);
}

// ---------------------------------------------------------------------------
// Window helpers — use a stable window that is definitely "today" for tests
// ---------------------------------------------------------------------------

function todayWindow(): { startMs: number; endMs: number } {
  const now = Date.now();
  // 24-hour window ending 1 hour in the future to avoid flakiness
  return {
    startMs: now - 23 * 60 * 60 * 1000,
    endMs: now + 60 * 60 * 1000,
  };
}

// ---------------------------------------------------------------------------
// SR-1 evil-file tracking
// ---------------------------------------------------------------------------

function evilGlob(pid: number): string {
  return path.join(os.tmpdir(), `recap-evil-${pid}-*`);
}

function findEvilFiles(pid: number): string[] {
  const dir = os.tmpdir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`recap-evil-${pid}-`))
    .map((f) => path.join(dir, f));
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

afterEach(() => {
  // Remove temp repos
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  // SR-1: Defensive cleanup of any evil files (they should NOT exist)
  const evil = findEvilFiles(process.pid);
  for (const f of evil) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // best-effort
    }
  }
});

function tmpRepo(opts: RepoOpts = {}): string {
  const dir = makeTmpDir();
  tmpDirs.push(dir);
  initRepo(dir, opts);
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getProjectGitActivity', () => {
  // -------------------------------------------------------------------------
  // Test 1: Author commits in window
  // -------------------------------------------------------------------------
  it('returns commitsToday=3 and subjects for 3 authored commits in window', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const { startMs, endMs } = todayWindow();
    makeCommit(repo, 'feat: first', 'Alice <alice@example.com>');
    makeCommit(repo, 'fix: second', 'Alice <alice@example.com>');
    makeCommit(repo, 'chore: third', 'Alice <alice@example.com>');

    const result = getProjectGitActivity(repo, startMs, endMs, 'alice@example.com');
    expect(result).not.toBeNull();
    // initial commit + 3 = 4 total authored by alice@example.com
    expect(result!.commitsToday).toBeGreaterThanOrEqual(3);
    expect(result!.subjects.some((s) => s.includes('first'))).toBe(true);
    expect(result!.subjects.some((s) => s.includes('second'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 2: Other-author commits are excluded
  // -------------------------------------------------------------------------
  it('excludes commits by other authors', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const { startMs, endMs } = todayWindow();
    makeCommit(repo, 'feat: by other', 'Other Person <other@example.com>');
    makeCommit(repo, 'feat: also other', 'Other Person <other@example.com>');

    // Query for alice — only the initial commit should match
    const result = getProjectGitActivity(repo, startMs, endMs, 'alice@example.com');
    expect(result).not.toBeNull();
    // "by other" and "also other" must not appear in subjects
    expect(result!.subjects.every((s) => !s.includes('by other'))).toBe(true);
    expect(result!.subjects.every((s) => !s.includes('also other'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 3: Boundary — 1 second before window is excluded
  // -------------------------------------------------------------------------
  it('excludes a commit at startMs - 1000ms', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const { startMs, endMs } = todayWindow();
    const justBefore = new Date(startMs - 1000);

    // Make an extra file commit dated before the window
    const filePath = path.join(repo, 'before.txt');
    fs.writeFileSync(filePath, 'before window\n');
    execFileSync('git', ['-C', repo, 'add', '--', filePath], { encoding: 'utf8' });
    const dateStr = justBefore.toISOString();
    const env = { ...process.env, GIT_AUTHOR_DATE: dateStr, GIT_COMMITTER_DATE: dateStr };
    execFileSync(
      'git',
      [
        '-C', repo, 'commit', '--no-gpg-sign',
        '--author=Alice <alice@example.com>',
        '-m', 'BEFORE_WINDOW_COMMIT',
      ],
      { encoding: 'utf8', env },
    );

    const result = getProjectGitActivity(repo, startMs, endMs, 'alice@example.com');
    expect(result).not.toBeNull();
    expect(result!.subjects.every((s) => !s.includes('BEFORE_WINDOW_COMMIT'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: Boundary — commit at endMs - 1000ms is included
  // -------------------------------------------------------------------------
  it('includes a commit at endMs - 1000ms', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const { startMs, endMs } = todayWindow();
    const insideWindow = new Date(endMs - 1000);

    const filePath = path.join(repo, 'inside.txt');
    fs.writeFileSync(filePath, 'inside window\n');
    execFileSync('git', ['-C', repo, 'add', '--', filePath], { encoding: 'utf8' });
    const dateStr = insideWindow.toISOString();
    const env = { ...process.env, GIT_AUTHOR_DATE: dateStr, GIT_COMMITTER_DATE: dateStr };
    execFileSync(
      'git',
      [
        '-C', repo, 'commit', '--no-gpg-sign',
        '--author=Alice <alice@example.com>',
        '-m', 'INSIDE_WINDOW_COMMIT',
      ],
      { encoding: 'utf8', env },
    );

    const result = getProjectGitActivity(repo, startMs, endMs, 'alice@example.com');
    expect(result).not.toBeNull();
    expect(result!.subjects.some((s) => s.includes('INSIDE_WINDOW_COMMIT'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5: --shortstat parsing
  // -------------------------------------------------------------------------
  it('parses filesChanged, linesAdded, linesRemoved from shortstat', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const { startMs, endMs } = todayWindow();

    // Commit 1: write 2 files with 15 lines each
    const file1 = path.join(repo, 'file1.txt');
    const file2 = path.join(repo, 'file2.txt');
    fs.writeFileSync(file1, Array(16).join('line\n'));
    fs.writeFileSync(file2, Array(16).join('line\n'));
    execFileSync('git', ['-C', repo, 'add', '--', file1, file2], { encoding: 'utf8' });
    execFileSync('git', [
      '-C', repo, 'commit', '--no-gpg-sign',
      '--author=Alice <alice@example.com>', '-m', 'commit1',
    ], { encoding: 'utf8' });

    // Commit 2: modify both files (remove 5 lines from file1, add them to file2)
    fs.writeFileSync(file1, Array(11).join('line\n'));
    fs.writeFileSync(file2, Array(21).join('line\n') + 'extra\n');
    execFileSync('git', ['-C', repo, 'add', '--', file1, file2], { encoding: 'utf8' });
    execFileSync('git', [
      '-C', repo, 'commit', '--no-gpg-sign',
      '--author=Alice <alice@example.com>', '-m', 'commit2',
    ], { encoding: 'utf8' });

    const result = getProjectGitActivity(repo, startMs, endMs, 'alice@example.com');
    expect(result).not.toBeNull();
    // filesChanged >= 2 (initial commit also counts)
    expect(result!.filesChanged).toBeGreaterThan(0);
    expect(result!.linesAdded).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 6: Subject truncation at 120 chars
  // -------------------------------------------------------------------------
  it('truncates commit subjects at 120 characters', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const { startMs, endMs } = todayWindow();
    const longSubject = 'A'.repeat(200);

    makeCommit(repo, longSubject, 'Alice <alice@example.com>');

    const result = getProjectGitActivity(repo, startMs, endMs, 'alice@example.com');
    expect(result).not.toBeNull();
    expect(result!.subjects.every((s) => s.length <= 120)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 7: Subject cap with "+N more"
  // -------------------------------------------------------------------------
  it('caps subjects at 5 and appends "+N more" for 8 commits', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const { startMs, endMs } = todayWindow();

    for (let i = 1; i <= 7; i++) {
      makeCommit(repo, `unique-subject-${i}`, 'Alice <alice@example.com>');
    }

    const result = getProjectGitActivity(repo, startMs, endMs, 'alice@example.com');
    expect(result).not.toBeNull();
    // 1 initial + 7 = 8 commits — subjects should be capped
    expect(result!.commitsToday).toBe(8);
    // At most 6 entries (5 subjects + "+N more")
    expect(result!.subjects.length).toBeLessThanOrEqual(6);
    // The last entry is "+N more"
    const last = result!.subjects[result!.subjects.length - 1]!;
    expect(last).toMatch(/^\+\d+ more$/);
    // Preceding 5 entries are real subjects
    expect(result!.subjects.slice(0, 5).every((s) => !s.startsWith('+'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 8: No .git/ directory → null
  // -------------------------------------------------------------------------
  it('returns null for a directory without .git/', () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const { startMs, endMs } = todayWindow();

    const result = getProjectGitActivity(dir, startMs, endMs, 'alice@example.com');
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 9: Missing git binary → null
  // -------------------------------------------------------------------------
  it('returns null when git binary is not found on PATH', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const { startMs, endMs } = todayWindow();

    // Override PATH to an empty temp dir so git cannot be found
    const emptyBin = makeTmpDir();
    tmpDirs.push(emptyBin);
    const origPath = process.env['PATH'];
    process.env['PATH'] = emptyBin;
    try {
      const result = getProjectGitActivity(repo, startMs, endMs, 'alice@example.com');
      expect(result).toBeNull();
    } finally {
      process.env['PATH'] = origPath;
    }
  });

  // -------------------------------------------------------------------------
  // Test 10: isPushed — pushed branch
  // -------------------------------------------------------------------------
  it('isPushed returns true when branch has no unpushed commits', () => {
    // Create a "remote" bare repo and clone from it so @{u} exists
    const bareDir = makeTmpDir();
    tmpDirs.push(bareDir);
    execFileSync('git', ['init', '--bare', bareDir], { encoding: 'utf8' });

    const cloneDir = makeTmpDir();
    tmpDirs.push(cloneDir);
    execFileSync('git', ['clone', bareDir, cloneDir], { encoding: 'utf8' });
    execFileSync('git', ['-C', cloneDir, 'config', 'user.email', 'alice@example.com'], { encoding: 'utf8' });
    execFileSync('git', ['-C', cloneDir, 'config', 'user.name', 'Alice'], { encoding: 'utf8' });

    // Make a commit and push
    const f = path.join(cloneDir, 'hello.txt');
    fs.writeFileSync(f, 'hello\n');
    execFileSync('git', ['-C', cloneDir, 'add', '--', f], { encoding: 'utf8' });
    execFileSync('git', ['-C', cloneDir, 'commit', '--no-gpg-sign', '--author=Alice <alice@example.com>', '-m', 'init'], { encoding: 'utf8' });
    execFileSync('git', ['-C', cloneDir, 'push', 'origin', 'HEAD'], { encoding: 'utf8' });

    expect(isPushed(cloneDir)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 11: isPushed — local-only commits
  // -------------------------------------------------------------------------
  it('isPushed returns false for a branch with no upstream', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    // No remote configured → @{u} does not exist → isPushed should be false
    expect(isPushed(repo)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // SR-1 Test 12: malicious user.email = "--output=/tmp/recap-evil-..."
  // -------------------------------------------------------------------------
  it('SR-1: rejects email starting with "--output=..." and creates no evil file', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const { startMs, endMs } = todayWindow();

    const evilEmail = `--output=/tmp/recap-evil-${process.pid}-${Date.now()}`;

    const result = getProjectGitActivity(repo, startMs, endMs, evilEmail);

    // Must return null — no git enrichment
    expect(result).toBeNull();

    // SR-1: No evil file must have been created
    const evilFiles = findEvilFiles(process.pid);
    expect(evilFiles).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // SR-1 Test 13: email with newline injection
  // -------------------------------------------------------------------------
  it('SR-1: rejects email containing newline and exec injection', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const { startMs, endMs } = todayWindow();

    const evilEmail = `x@y\n--exec=touch /tmp/recap-evil-${process.pid}-newline`;

    const result = getProjectGitActivity(repo, startMs, endMs, evilEmail);

    expect(result).toBeNull();

    const evilFiles = findEvilFiles(process.pid);
    expect(evilFiles).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // SR-1 Test 14: email starting with "-" (leading dash injection)
  // -------------------------------------------------------------------------
  it('SR-1: rejects email starting with a leading dash', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const { startMs, endMs } = todayWindow();

    const evilEmail = `-z foo@bar.com`;

    const result = getProjectGitActivity(repo, startMs, endMs, evilEmail);

    expect(result).toBeNull();

    const evilFiles = findEvilFiles(process.pid);
    expect(evilFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getLastCommitSha
// ---------------------------------------------------------------------------

describe('getLastCommitSha', () => {
  // Test 15: correctness
  it('returns the HEAD SHA matching rev-parse output', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const expectedSha = gitExec(['rev-parse', 'HEAD'], repo);

    const result = getLastCommitSha(repo);
    expect(result).toBe(expectedSha);
  });

  it('returns null for a directory without .git/', () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    expect(getLastCommitSha(dir)).toBeNull();
  });

  it('returns null for a non-existent path', () => {
    expect(getLastCommitSha('/tmp/does-not-exist-cs-recap')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAuthorEmail
// ---------------------------------------------------------------------------

describe('getAuthorEmail', () => {
  it('returns the configured user.email for a repo', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const email = getAuthorEmail(repo);
    expect(email).toBe('alice@example.com');
  });

  it('returns null for a directory without .git/', () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    expect(getAuthorEmail(dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getMergedPrCountToday
// ---------------------------------------------------------------------------

describe('getMergedPrCountToday', () => {
  // Test 16: gh missing → null, doesn't throw
  it('returns null when gh is not on PATH, without throwing', () => {
    const repo = tmpRepo({ author: 'Alice <alice@example.com>' });
    const { startMs, endMs } = todayWindow();

    const emptyBin = makeTmpDir();
    tmpDirs.push(emptyBin);
    const origPath = process.env['PATH'];
    process.env['PATH'] = emptyBin;
    try {
      let result: number | null;
      expect(() => {
        result = getMergedPrCountToday(repo, startMs, endMs);
      }).not.toThrow();
      // Must be null (gh not found)
      expect(result!).toBeNull();
    } finally {
      process.env['PATH'] = origPath;
    }
  });

  it('returns null for a directory without .git/', () => {
    const dir = makeTmpDir();
    tmpDirs.push(dir);
    const { startMs, endMs } = todayWindow();
    expect(getMergedPrCountToday(dir, startMs, endMs)).toBeNull();
  });
});
