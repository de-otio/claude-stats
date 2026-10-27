/**
 * Placeholder-output flag (claude-code-2.1.311 review, finding R1).
 *
 * Claude Code versions before 2.1.307 wrote streamed subagent assistant
 * entries whose `output_tokens` is a mid-stream placeholder (the final count
 * never lands) and whose `stop_reason` is empty. Output on those rows is
 * under-reported, so detectors that read per-turn output or per-session turn
 * counts must not treat them as measurements. Dedupe already prefers real
 * rows where a sibling exists (check V1); this flag covers the rest.
 *
 * Computed from existing columns only — no schema change. Pure.
 */

/** First writer version whose subagent rows are not placeholders. */
export const PLACEHOLDER_FIXED_IN = "2.1.307";

/** The columns the predicate reads, structurally typed so the store row and
 *  fixtures can both feed it. */
export interface PlaceholderOutputInput {
  /** `sessions.is_subagent` — true for a subagent session. */
  isSubagent: boolean;
  /** `messages.claude_version` — the writer version. Missing/unparseable → not flagged. */
  claudeVersion: string | null | undefined;
  /** `messages.stop_reason`. Empty string and null both count as "no stop reason". */
  stopReason: string | null | undefined;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Semver {
  core: [number, number, number];
  pre: boolean;
}

function parseSemver(v: string): Semver | null {
  const m = SEMVER.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== undefined };
}

/** True when `version` parses and sorts strictly below `than` (numeric
 *  component compare; a prerelease sorts below its own release). */
export function isVersionBefore(version: string | null | undefined, than: string): boolean {
  if (!version) return false;
  const a = parseSemver(version);
  const b = parseSemver(than);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.core[i]! !== b.core[i]!) return a.core[i]! < b.core[i]!;
  }
  return a.pre && !b.pre;
}

/**
 * True iff the row is a pre-2.1.307 subagent row with no stop reason — its
 * output tokens are a placeholder, not a measurement. Output magnitude is
 * deliberately NOT a condition (check V5: rows with 11–100 output tokens and
 * an empty stop reason behave as placeholders too).
 */
export function isPlaceholderOutput(row: PlaceholderOutputInput): boolean {
  if (!row.isSubagent) return false;
  if (row.stopReason != null && row.stopReason !== "") return false;
  return isVersionBefore(row.claudeVersion, PLACEHOLDER_FIXED_IN);
}
