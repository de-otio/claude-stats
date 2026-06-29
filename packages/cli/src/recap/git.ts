/**
 * Git enrichment for the daily-recap feature.
 *
 * SR-1 SECURITY CRITICAL: all subprocess invocations use execFileSync with
 * array argv. Never exec, never shell-string concatenation, never execSync(string).
 * See plans/daily-recap/shared/security-requirements.md#SR-1.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectGitActivity } from './types.js';

// SR-1: Email validation. Rejects strings that start with '-' (option injection),
// contain NUL bytes, or contain newlines (multi-line injection).
const EMAIL_OK = /^[^\0\n\-][^\0\n]*$/;

const MAX_BUFFER = 5 * 1024 * 1024; // 5 MB
const MAX_SUBJECTS = 5;
const MAX_SUBJECT_LEN = 120;

/**
 * Verify projectPath is a resolved absolute directory containing a .git folder.
 * Returns the resolved path on success, or null on failure.
 */
function resolveGitDir(projectPath: string): string | null {
  try {
    const p = path.resolve(projectPath);
    const stat = fs.statSync(p);
    if (!stat.isDirectory()) return null;
    if (!fs.existsSync(path.join(p, '.git'))) return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * Read git config user.email for the repo at projectPath.
 * Returns null if git is missing, the path is not a repo, or the call fails.
 */
export function getAuthorEmail(projectPath: string): string | null {
  const p = resolveGitDir(projectPath);
  if (p === null) return null;
  try {
    const out = execFileSync('git', ['-C', p, 'config', 'user.email'], {
      encoding: 'utf8',
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Return the HEAD commit SHA for the repo at projectPath, or null.
 */
export function getLastCommitSha(projectPath: string): string | null {
  const p = resolveGitDir(projectPath);
  if (p === null) return null;
  try {
    // HEAD is a literal, not user-supplied — no '--' separator needed here.
    // 'git rev-parse HEAD --' would cause git to treat HEAD as a pathspec too.
    const out = execFileSync('git', ['-C', p, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    });
    const sha = out.trim();
    // A valid SHA-1 or SHA-256 hex string; sanity-check format
    return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Return true if HEAD has been pushed to its upstream (rev-list @{u}..HEAD is empty).
 * Any error (no upstream, git not found, non-zero exit) → false.
 */
export function isPushed(projectPath: string): boolean {
  const p = resolveGitDir(projectPath);
  if (p === null) return false;
  try {
    const out = execFileSync(
      'git',
      ['-C', p, 'rev-list', '@{u}..HEAD', '--'],
      { encoding: 'utf8' },
    );
    return out.trim() === '';
  } catch {
    return false;
  }
}

/**
 * Count PRs merged by @me today (within startMs..endMs) using `gh`.
 * Returns null silently if gh is not installed, not authenticated, or rate-limited.
 */
export function getMergedPrCountToday(
  projectPath: string,
  startMs: number,
  endMs: number,
): number | null {
  const p = resolveGitDir(projectPath);
  if (p === null) return null;
  // Date is constructed by us — not user-supplied
  const dateYmd = new Date(startMs).toISOString().slice(0, 10);
  // Ignore endMs for the gh search (gh merged:>= filter is day-granular)
  void endMs;
  try {
    const out = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--author=@me',
        '--state=merged',
        `--search=merged:>=${dateYmd}`,
        '--json=number',
      ],
      { encoding: 'utf8', cwd: p },
    );
    const parsed: unknown = JSON.parse(out);
    if (!Array.isArray(parsed)) return null;
    return parsed.length;
  } catch {
    // gh missing, not authed, rate-limited, non-zero exit — all silently null
    return null;
  }
}

/**
 * Parse a single --shortstat line.
 * Format (each part is optional):
 *   " N files changed[, X insertions(+)][, Y deletions(-)]"
 */
function parseShortstat(line: string): {
  files: number;
  added: number;
  removed: number;
} {
  const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
  const addedMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
  const removedMatch = line.match(/(\d+)\s+deletions?\(-\)/);
  return {
    files: filesMatch ? parseInt(filesMatch[1]!, 10) : 0,
    added: addedMatch ? parseInt(addedMatch[1]!, 10) : 0,
    removed: removedMatch ? parseInt(removedMatch[1]!, 10) : 0,
  };
}

/**
 * Read author-scoped git activity for a project over the given time window.
 *
 * SR-1: uses execFileSync with array argv. Validates authorEmail against
 * EMAIL_OK before use. Date arguments are constructed from startMs/endMs —
 * never accepted raw from callers.
 *
 * @returns ProjectGitActivity on success, null on any failure or rejection.
 */
export function getProjectGitActivity(
  projectPath: string,
  startMs: number,
  endMs: number,
  authorEmail: string,
): ProjectGitActivity | null {
  // SR-1: Validate email before passing to git --author=
  if (!EMAIL_OK.test(authorEmail)) {
    console.warn('git enrichment skipped: email failed validation');
    return null;
  }

  const p = resolveGitDir(projectPath);
  if (p === null) {
    console.warn(`git enrichment skipped: not a git directory at ${projectPath}`);
    return null;
  }

  // SR-1: Date arguments are ISO-8601 strings we construct — not user-supplied
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  let rawOutput: string;
  try {
    rawOutput = execFileSync(
      'git',
      [
        '-C',
        p,
        'log',
        `--since=${startIso}`,
        `--until=${endIso}`,
        `--author=${authorEmail}`,
        '--no-merges',
        '--shortstat',
        '--format=%H|%ct|%s',
        '--', // separator before any value-position argument that could be user-controlled
      ],
      { encoding: 'utf8', maxBuffer: MAX_BUFFER },
    );
  } catch (err: unknown) {
    // maxBuffer exceeded or git not found
    const message =
      err instanceof Error ? err.message : 'unknown error';
    // Do not include email or commit subjects in the warning
    console.warn(`git enrichment failed for ${p}: ${message.slice(0, 80)}`);
    return null;
  }

  // Parse interleaved format:
  //   <hash>|<unix_ts>|<subject>
  //   <blank line>
  //    N files changed, X insertions(+), Y deletions(-)
  //   <blank line>
  //   <next commit or end>
  const lines = rawOutput.split('\n');

  let commitsToday = 0;
  let filesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  const rawSubjects: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Commit header lines match hash|ts|subject
    if (/^[0-9a-f]{7,64}\|/.test(line)) {
      commitsToday++;
      const pipeIdx = line.indexOf('|');
      const rest = line.slice(pipeIdx + 1);
      const pipeIdx2 = rest.indexOf('|');
      const subjectRaw = pipeIdx2 >= 0 ? rest.slice(pipeIdx2 + 1) : '';
      // Take only first line; cap at 120 chars
      const subject = subjectRaw.split('\n')[0]!.slice(0, MAX_SUBJECT_LEN);
      if (subject) rawSubjects.push(subject);
    } else if (line.trim().match(/^\d+\s+files?\s+changed/)) {
      const stats = parseShortstat(line);
      filesChanged += stats.files;
      linesAdded += stats.added;
      linesRemoved += stats.removed;
    }
  }

  // Cap subjects at 5; note the rest as "+N more"
  let subjects: string[];
  if (rawSubjects.length <= MAX_SUBJECTS) {
    subjects = rawSubjects;
  } else {
    const extra = rawSubjects.length - MAX_SUBJECTS;
    subjects = [...rawSubjects.slice(0, MAX_SUBJECTS), `+${extra} more`];
  }

  const pushed = isPushed(p);
  const prMerged = getMergedPrCountToday(p, startMs, endMs);

  return {
    commitsToday,
    filesChanged,
    linesAdded,
    linesRemoved,
    subjects,
    pushed,
    prMerged,
  };
}

// ─── Windowed (multi-day) git provider ──────────────────────────────────────
//
// Performance: the per-day `getProjectGitActivity` above spawns FOUR
// subprocesses (git config, git log, git rev-list, gh pr list — one of them a
// GitHub network call). A multi-day report (cost-per-task / calibration) calls
// it once per day per project, so a 30-day "month" with N projects spawns
// ~120·N processes — almost all redundant, since the author email and push
// state are window-invariant and the commit/PR data can be fetched once over
// the whole window and bucketed by day in memory.
//
// `createWindowedGitProvider` does exactly that: per project it lazily runs ONE
// `git log` over the full window, ONE `git rev-list` (isPushed), and ONE
// `gh pr list`, then answers each per-day query from the prefetched data. The
// returned `getProjectGitActivity` produces the SAME `ProjectGitActivity` shape
// the per-day path produces (commit stats sliced to the day; window-invariant
// `pushed`; per-day `prMerged` reconstructed from merge dates), so the digest —
// and the metric built on it — is unchanged.

interface WindowedCommit {
  /** Commit time in epoch ms (from %ct). */
  tsMs: number;
  subject: string;
  files: number;
  added: number;
  removed: number;
}

interface PrefetchedProjectGit {
  /** Resolved git dir (absolute). */
  dir: string;
  /** Commits by @author over the window, newest-first (git log default order). */
  commits: readonly WindowedCommit[];
  /** HEAD pushed to upstream — window-invariant. */
  pushed: boolean;
  /**
   * YYYY-MM-DD (UTC) merge dates of @me's merged PRs since the window start, or
   * null when `gh` is missing / unauthenticated / errored (mirrors the per-day
   * null). Used to reconstruct per-day `prMerged` via `merged:>=<day>` counting.
   */
  prMergeDatesUtc: readonly string[] | null;
}

export interface WindowedGitProvider {
  getAuthorEmail(projectPath: string): string | null;
  getProjectGitActivity(
    projectPath: string,
    startMs: number,
    endMs: number,
    authorEmail: string,
  ): ProjectGitActivity | null;
}

/**
 * Parse a windowed `git log --shortstat --format=%H|%ct|%s` into per-commit
 * records, attributing each shortstat line to the commit header that precedes
 * it. Same field extraction as the per-day parser, but keyed per commit so the
 * caller can slice by day.
 */
function parseWindowedGitLog(raw: string): WindowedCommit[] {
  const lines = raw.split('\n');
  const commits: WindowedCommit[] = [];
  let cur: WindowedCommit | null = null;
  for (const line of lines) {
    if (/^[0-9a-f]{7,64}\|/.test(line)) {
      const pipeIdx = line.indexOf('|');
      const rest = line.slice(pipeIdx + 1);
      const pipeIdx2 = rest.indexOf('|');
      const ctStr = pipeIdx2 >= 0 ? rest.slice(0, pipeIdx2) : rest;
      const subjectRaw = pipeIdx2 >= 0 ? rest.slice(pipeIdx2 + 1) : '';
      const ct = parseInt(ctStr, 10);
      cur = {
        tsMs: Number.isFinite(ct) ? ct * 1000 : NaN,
        subject: subjectRaw.split('\n')[0]!.slice(0, MAX_SUBJECT_LEN),
        files: 0,
        added: 0,
        removed: 0,
      };
      commits.push(cur);
    } else if (line.trim().match(/^\d+\s+files?\s+changed/)) {
      const stats = parseShortstat(line);
      if (cur !== null) {
        cur.files += stats.files;
        cur.added += stats.added;
        cur.removed += stats.removed;
      }
    }
  }
  return commits;
}

/**
 * Run ONE `gh pr list` for @me's merged PRs since `sinceYmd`, returning their
 * UTC merge dates (YYYY-MM-DD). Returns null on any failure (gh missing / not
 * authed / rate-limited / non-zero exit) — same silent-null contract as
 * `getMergedPrCountToday`. The `--limit 200` lifts the per-day call's implicit
 * 30-cap so per-day reconstruction is exact for any realistic window (the
 * common <30-PRs case is identical to the old behaviour).
 */
function getMergedPrDatesSince(gitDir: string, sinceYmd: string): string[] | null {
  try {
    const out = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--author=@me',
        '--state=merged',
        `--search=merged:>=${sinceYmd}`,
        '--limit=200',
        '--json=mergedAt',
      ],
      { encoding: 'utf8', cwd: gitDir },
    );
    const parsed: unknown = JSON.parse(out);
    if (!Array.isArray(parsed)) return null;
    const dates: string[] = [];
    for (const row of parsed) {
      const mergedAt = (row as { mergedAt?: unknown }).mergedAt;
      if (typeof mergedAt === 'string' && mergedAt.length >= 10) {
        dates.push(mergedAt.slice(0, 10)); // YYYY-MM-DD (UTC, as gh emits it)
      }
    }
    return dates;
  } catch {
    return null;
  }
}

/**
 * Build a multi-day git provider whose `getProjectGitActivity` answers per-day
 * queries from data fetched ONCE per project over [windowStartMs, windowEndMs).
 *
 * Drop-in for the `getAuthorEmail` / `getProjectGitActivity` deps of
 * {@link buildDailyDigest}. Per-day windows passed to `getProjectGitActivity`
 * MUST fall within the provider's window (callers in the cost-per-task /
 * calibration loop guarantee this by deriving the window from the same dates).
 */
export function createWindowedGitProvider(
  windowStartMs: number,
  windowEndMs: number,
): WindowedGitProvider {
  const emailCache = new Map<string, string | null>();
  const prefetchCache = new Map<string, PrefetchedProjectGit | null>();
  const windowStartYmd = new Date(windowStartMs).toISOString().slice(0, 10);

  const resolveEmail = (projectPath: string): string | null => {
    if (emailCache.has(projectPath)) return emailCache.get(projectPath)!;
    const email = getAuthorEmail(projectPath);
    emailCache.set(projectPath, email);
    return email;
  };

  const prefetch = (projectPath: string): PrefetchedProjectGit | null => {
    if (prefetchCache.has(projectPath)) return prefetchCache.get(projectPath)!;

    const email = resolveEmail(projectPath);
    // No email (not a repo / git missing) → no enrichment, matching the per-day
    // path where buildDailyDigest skips getGitActivity when email is null.
    if (email === null || !EMAIL_OK.test(email)) {
      prefetchCache.set(projectPath, null);
      return null;
    }
    const dir = resolveGitDir(projectPath);
    if (dir === null) {
      prefetchCache.set(projectPath, null);
      return null;
    }

    const startIso = new Date(windowStartMs).toISOString();
    const endIso = new Date(windowEndMs).toISOString();
    let commits: WindowedCommit[];
    try {
      const raw = execFileSync(
        'git',
        [
          '-C',
          dir,
          'log',
          `--since=${startIso}`,
          `--until=${endIso}`,
          `--author=${email}`,
          '--no-merges',
          '--shortstat',
          '--format=%H|%ct|%s',
          '--',
        ],
        { encoding: 'utf8', maxBuffer: MAX_BUFFER },
      );
      commits = parseWindowedGitLog(raw);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.warn(`git enrichment failed for ${dir}: ${message.slice(0, 80)}`);
      prefetchCache.set(projectPath, null);
      return null;
    }

    const data: PrefetchedProjectGit = {
      dir,
      commits,
      pushed: isPushed(dir),
      prMergeDatesUtc: getMergedPrDatesSince(dir, windowStartYmd),
    };
    prefetchCache.set(projectPath, data);
    return data;
  };

  return {
    getAuthorEmail: resolveEmail,
    getProjectGitActivity(projectPath, startMs, endMs, _authorEmail): ProjectGitActivity | null {
      void _authorEmail; // email is resolved/cached internally
      const data = prefetch(projectPath);
      if (data === null) return null;

      let commitsToday = 0;
      let filesChanged = 0;
      let linesAdded = 0;
      let linesRemoved = 0;
      const rawSubjects: string[] = [];
      for (const c of data.commits) {
        if (c.tsMs >= startMs && c.tsMs < endMs) {
          commitsToday++;
          filesChanged += c.files;
          linesAdded += c.added;
          linesRemoved += c.removed;
          if (c.subject) rawSubjects.push(c.subject);
        }
      }

      let subjects: string[];
      if (rawSubjects.length <= MAX_SUBJECTS) {
        subjects = rawSubjects;
      } else {
        const extra = rawSubjects.length - MAX_SUBJECTS;
        subjects = [...rawSubjects.slice(0, MAX_SUBJECTS), `+${extra} more`];
      }

      // Per-day prMerged reconstructs the per-day `merged:>=<dayYmd>` semantics:
      // count of @me's merged PRs whose UTC merge date is >= this day's UTC date
      // (the per-day path keyed on new Date(startMs) UTC, not the tz date).
      let prMerged: number | null;
      if (data.prMergeDatesUtc === null) {
        prMerged = null;
      } else {
        const dayYmd = new Date(startMs).toISOString().slice(0, 10);
        prMerged = data.prMergeDatesUtc.filter((d) => d >= dayYmd).length;
      }

      return {
        commitsToday,
        filesChanged,
        linesAdded,
        linesRemoved,
        subjects,
        pushed: data.pushed,
        prMerged,
      };
    },
  };
}
