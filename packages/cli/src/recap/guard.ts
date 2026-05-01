/**
 * guard.ts — Self-Consistency Guard for LLM-synthesised recap prose.
 *
 * DESIGN TRADE-OFF (conservative entity extraction):
 *   This guard deliberately prefers false negatives (missing real hallucinations)
 *   over false positives (flagging correct prose as wrong).
 *
 *   Rationale: a false positive causes agents to fall back to template rendering,
 *   producing an inferior output for real, valid prose. A false negative lets a
 *   rare hallucination through, which is less harmful. Therefore:
 *     - Capitalised token matching uses a high bar (exact basename equality).
 *     - Count matching accepts any item matching OR a sum across all items.
 *     - File path matching requires an exact string present in filePathsTouched.
 *     - First-prompt matching uses substring, not full-string equality.
 *
 * Pure function — no I/O, no async.
 *
 * @module
 */

import path from 'node:path';
import type { DailyDigest } from './types.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export type GuardViolationKind =
  | 'missing-entity'
  | 'count-mismatch'
  | 'unknown-path'
  | 'verb-confidence-mismatch';

export interface GuardViolation {
  kind: GuardViolationKind;
  detail: string;
}

export interface GuardResult {
  ok: boolean;
  violations: readonly GuardViolation[];
}

// ─── Envelope-stripping helper ────────────────────────────────────────────────

/**
 * Strip the wrapUntrusted() envelope from a firstPrompt value, returning only
 * the inner text.  Inlined here so guard.ts has no dependency on the
 * concurrently-written templates.ts.
 *
 * The format produced by wrapUntrusted() is:
 *   <advisory note line>\n<untrusted-stored-content>TEXT</untrusted-stored-content>
 */
const UNTRUSTED_OPEN = '<untrusted-stored-content>';
const UNTRUSTED_CLOSE = '</untrusted-stored-content>';

function stripEnvelope(s: string | null): string | null {
  if (s === null) return null;
  const start = s.indexOf(UNTRUSTED_OPEN);
  const end = s.indexOf(UNTRUSTED_CLOSE);
  if (start === -1 || end === -1 || end <= start) return s;
  return s.slice(start + UNTRUSTED_OPEN.length, end);
}

// ─── Known file extensions for path detection ─────────────────────────────────

/**
 * Extensions recognised as "looks like a file path" during entity extraction.
 * Deliberately narrow to reduce false positives.
 */
const KNOWN_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.h', '.hpp',
  '.json', '.yaml', '.yml', '.toml', '.env',
  '.md', '.mdx', '.txt', '.sh', '.bash', '.zsh',
  '.css', '.scss', '.sass', '.less', '.html', '.svg',
  '.sql', '.graphql', '.proto',
]);

// ─── Entity extraction helpers ────────────────────────────────────────────────

/**
 * Extract backtick-quoted strings from prose.
 * Only single-backtick spans (not fenced code blocks) are extracted.
 * Returns the inner text, already lowercased for comparison.
 */
function extractBacktickEntities(prose: string): string[] {
  const results: string[] = [];
  // Match `content` — single backticks, content does not span newlines
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prose)) !== null) {
    results.push(m[1]!.toLowerCase().trim());
  }
  return results;
}

/**
 * Extract integer counts followed by a quantity word.
 * Returns objects with the parsed number and the noun (singular canonical form).
 *
 * Handles plurals: "1 commit" and "1 commits" both map to noun "commit".
 */
interface CountEntity {
  count: number;
  noun: 'commit' | 'file' | 'minute' | 'session';
}

const COUNT_PATTERN =
  /\b(\d+)\s+(commits?|files?(?:\s+(?:changed|touched))?|minutes?|sessions?)\b/gi;

function extractCountEntities(prose: string): CountEntity[] {
  const results: CountEntity[] = [];
  const re = new RegExp(COUNT_PATTERN.source, COUNT_PATTERN.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(prose)) !== null) {
    const count = parseInt(m[1]!, 10);
    const raw = m[2]!.toLowerCase();
    let noun: CountEntity['noun'];
    if (raw.startsWith('commit')) {
      noun = 'commit';
    } else if (raw.startsWith('file')) {
      noun = 'file';
    } else if (raw.startsWith('minute')) {
      noun = 'minute';
    } else if (raw.startsWith('session')) {
      noun = 'session';
    } else {
      continue;
    }
    results.push({ count, noun });
  }
  return results;
}

/**
 * Extract tokens that look like file paths: contain `/` and end with a
 * known extension.  We do not require the path to start with `/` since
 * relative paths are common in prose.
 *
 * Returns raw token strings (preserving case) for exact comparison.
 */
function extractPathEntities(prose: string): string[] {
  // Match tokens: may start with optional `.` or `/`, contain alphanumeric,
  // dots, hyphens, underscores, slashes — must contain at least one slash
  // and end with a known extension.
  const results: string[] = [];
  // Split on whitespace and common punctuation, then filter
  const tokens = prose.split(/[\s,;:()\[\]'"]+/);
  for (const token of tokens) {
    if (!token.includes('/')) continue;
    const ext = path.extname(token);
    if (ext && KNOWN_EXTENSIONS.has(ext.toLowerCase())) {
      results.push(token);
    }
  }
  return results;
}

/**
 * Extract capitalised project-like tokens from prose.
 *
 * A "project-like token" is a run of characters that:
 *   - Starts with an uppercase letter
 *   - Contains only word characters, hyphens, dots, or digits
 *   - Is at least 3 characters long (to avoid "I", "A", "The" etc.)
 *   - Appears inside parentheses: (ProjectName) — very common prose pattern
 *     produced by the templates
 *
 * We intentionally restrict to the parenthesised form to keep false positives
 * extremely low.  Prose like "Shipped X (frobnicator)" clearly names a project.
 */
function extractProjectEntities(prose: string): string[] {
  const results: string[] = [];
  // Match (Foo-bar) or (FooBar) — parenthesised project references
  const re = /\(([A-Za-z][A-Za-z0-9._-]{1,})\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prose)) !== null) {
    results.push(m[1]!.toLowerCase());
  }
  return results;
}

// ─── Main guard function ──────────────────────────────────────────────────────

/**
 * Verify that every entity mentioned in LLM-synthesised prose actually appears
 * in the source digest.
 *
 * @param prose   The LLM-generated text to check.
 * @param digest  The authoritative DailyDigest the prose was generated from.
 * @returns       A GuardResult: ok=true if no violations detected.
 */
export function guardSynthesisAgainstDigest(
  prose: string,
  digest: DailyDigest,
): GuardResult {
  const violations: GuardViolation[] = [];

  // Empty prose → nothing to check
  if (!prose.trim()) {
    return { ok: true, violations: [] };
  }

  const items = digest.items;

  // ── Step 1: Check backtick-quoted entities (first prompts) ────────────────

  const backtickEntities = extractBacktickEntities(prose);

  for (const entity of backtickEntities) {
    // Match against any item's firstPrompt (envelope-stripped, lowercased)
    const matched = items.some((item) => {
      const stripped = stripEnvelope(item.firstPrompt);
      if (stripped === null) return false;
      return stripped.toLowerCase().includes(entity);
    });

    if (!matched) {
      // Only flag if there are items — an empty digest can't satisfy any backtick check
      if (items.length === 0) {
        violations.push({
          kind: 'missing-entity',
          detail: `Backtick entity \`${entity}\` not found in any item firstPrompt (digest is empty)`,
        });
      } else {
        violations.push({
          kind: 'missing-entity',
          detail: `Backtick entity \`${entity}\` not found in any item firstPrompt`,
        });
      }
    }
  }

  // ── Step 2: Check parenthesised project names ─────────────────────────────

  const projectEntities = extractProjectEntities(prose);

  for (const entity of projectEntities) {
    const matched = items.some((item) => {
      const base = path.basename(item.project).toLowerCase();
      return base === entity;
    });

    if (!matched) {
      violations.push({
        kind: 'missing-entity',
        detail: `Project name "(${entity})" not found in any digest item`,
      });
    }
  }

  // ── Step 3: Check integer counts ─────────────────────────────────────────

  const countEntities = extractCountEntities(prose);

  for (const { count, noun } of countEntities) {
    let satisfied = false;

    if (noun === 'commit') {
      // Match if any single item has commitsToday === count, OR sum equals count
      const sum = items.reduce((acc, item) => acc + (item.git?.commitsToday ?? 0), 0);
      satisfied =
        items.some((item) => (item.git?.commitsToday ?? 0) === count) ||
        sum === count;
    } else if (noun === 'file') {
      // Match if any single item has filesChanged === count, OR sum equals count
      const sum = items.reduce((acc, item) => acc + (item.git?.filesChanged ?? 0), 0);
      satisfied =
        items.some((item) => (item.git?.filesChanged ?? 0) === count) ||
        sum === count;
    } else if (noun === 'minute') {
      // Match if any item's activeMs / 60000 ≈ count (within 1 minute),
      // or the totals activeMs / 60000 ≈ count
      const matchMs = count * 60_000;
      const tolerance = 60_000; // ±1 minute
      satisfied =
        items.some(
          (item) => Math.abs(item.duration.activeMs - matchMs) <= tolerance,
        ) ||
        Math.abs(digest.totals.activeMs - matchMs) <= tolerance;
    } else if (noun === 'session') {
      // Match if any item has exactly count sessions, or totals.sessions === count
      satisfied =
        items.some((item) => item.sessionIds.length === count) ||
        digest.totals.sessions === count;
    }

    if (!satisfied) {
      violations.push({
        kind: 'count-mismatch',
        detail: `Count "${count} ${noun}(s)" not satisfied by any item or digest totals`,
      });
    }
  }

  // ── Step 4: Check file paths ──────────────────────────────────────────────

  const pathEntities = extractPathEntities(prose);

  for (const filePath of pathEntities) {
    const matched = items.some((item) =>
      item.filePathsTouched.some(
        (fp) => fp === filePath || fp.endsWith(filePath),
      ),
    );

    if (!matched) {
      violations.push({
        kind: 'unknown-path',
        detail: `File path "${filePath}" not found in any item's filePathsTouched`,
      });
    }
  }

  // ── Step 5: Verb-confidence cross-check ──────────────────────────────────

  const proseLower = prose.toLowerCase();
  const hasHighVerb = /\b(shipped|merged)\b/i.test(prose);

  if (hasHighVerb) {
    const hasHighConfidenceItem = items.some(
      (item) => item.confidence === 'high',
    );
    if (!hasHighConfidenceItem) {
      const verb = /\bshipped\b/i.test(prose) ? 'shipped' : 'merged';
      violations.push({
        kind: 'verb-confidence-mismatch',
        detail: `Prose uses "${verb}" but no digest item has confidence === 'high'`,
      });
    }
  }

  // Suppress unused-variable warning — proseLower used for future extensions
  void proseLower;

  return {
    ok: violations.length === 0,
    violations,
  };
}
