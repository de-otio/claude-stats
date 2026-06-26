/**
 * Archetype classifier for the value-per-cost efficiency frontier (T2 / plan §4).
 *
 * `classifyArchetype` is a PURE, first-match rule chain over the fields already
 * available on every `DailyDigestItem` via `ClassifyInput`. It never throws, never
 * reads the clock, never touches the filesystem, and never calls `Date.now` or
 * `Math.random`. The `other` fallback ensures a value is always returned.
 *
 * SECURITY (F4 ReDoS guard): tool names and file paths are matched with
 * `Set.has` and object-key lookup ONLY. No regex is applied to any tool name
 * or file path string.
 *
 * Plan: ../../../../plans/value-per-cost/README.md §4
 */
import { MULTI_FILE_THRESHOLD, type Archetype, type ClassifyInput } from './types.js';

// ─── Internal constants ──────────────────────────────────────────────────────

/**
 * Tools that create or modify workspace files.
 * Kept in sync with the identical set in `../index.ts` (MUTATING_TOOLS).
 */
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Maximum total mutating-tool calls for a task to qualify as `mechanical_edit`
 * (a small, targeted change to ≤ 2 files).
 */
const LOW_EDIT_COUNT = 3;

/**
 * Minimum total mutating-tool calls for a task to qualify as `multi_file_refactor`
 * (a sweep across many files). Combines with the `filePathsTouched` floor.
 */
const HIGH_EDIT_COUNT = 5;

/**
 * Minimum share of (Read + Bash) calls out of all calls to classify a task
 * as `debugging`. A debugging session is characterised by heavy exploration
 * and execution, not file mutation.
 */
const READ_BASH_SHARE_FLOOR = 0.5;

// ─── Helpers (pure) ─────────────────────────────────────────────────────────

/** Sum of the counts of all mutating tools in the histogram. */
function sumMutating(hist: Readonly<Record<string, number>>): number {
  let n = 0;
  for (const [key, val] of Object.entries(hist)) {
    if (MUTATING_TOOLS.has(key)) n += val;
  }
  return n;
}

/** Sum of all counts in the histogram (total tool calls). */
function sumTotal(hist: Readonly<Record<string, number>>): number {
  let n = 0;
  for (const val of Object.values(hist)) n += val;
  return n;
}

// ─── Classifier ─────────────────────────────────────────────────────────────

/**
 * Classify a `ClassifyInput` into one of the six closed archetypes.
 *
 * Rules fire in priority order (first-match); `other` is the unconditional
 * fallback. The function never throws: an empty `toolHistogram` returns
 * `'research_qa'`; an empty `filePathsTouched` does not prevent matching.
 *
 * Priority:
 *  1. `research_qa`       — no mutating tool at all.
 *  2. `greenfield`        — Write-dominant (Write > Read), at least one Write call.
 *  3. `mechanical_edit`   — mutating, ≤ 2 files touched, low total edit count.
 *  4. `debugging`         — (Read + Bash) share of total calls > READ_BASH_SHARE_FLOOR.
 *  5. `multi_file_refactor` — mutating, ≥ MULTI_FILE_THRESHOLD files, high edit count.
 *  6. `other`             — explicit fallback.
 */
export function classifyArchetype(item: ClassifyInput): Archetype {
  // Coalesce so the no-throw guarantee is total even if an upstream digest item
  // is malformed (the fields are typed required, but defence is cheap — review L1).
  const hist = item.toolHistogram ?? {};
  const paths = item.filePathsTouched ?? [];

  const editCalls = sumMutating(hist);

  // Rule 1: no mutating tool → pure read/research/Q&A task.
  if (editCalls === 0) return 'research_qa';

  const write = hist['Write'] ?? 0;
  const read  = hist['Read']  ?? 0;
  const bash  = hist['Bash']  ?? 0;

  // Rule 2: Write outnumbers Read — the primary activity is creating new files.
  if (write > 0 && write > read) return 'greenfield';

  // Rule 3: tiny footprint — few files, few edit calls → a small targeted change.
  if (paths.length <= 2 && editCalls <= LOW_EDIT_COUNT) return 'mechanical_edit';

  // Rule 4: exploration-heavy — more than half of all calls are Read or Bash.
  const total = sumTotal(hist);
  const readBashShare = total > 0 ? (read + bash) / total : 0;
  if (readBashShare > READ_BASH_SHARE_FLOOR) return 'debugging';

  // Rule 5: broad sweep — many files changed and many edit calls.
  if (paths.length >= MULTI_FILE_THRESHOLD && editCalls >= HIGH_EDIT_COUNT) {
    return 'multi_file_refactor';
  }

  // Rule 6: no rule fired.
  return 'other';
}
