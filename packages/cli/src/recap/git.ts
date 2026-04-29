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
