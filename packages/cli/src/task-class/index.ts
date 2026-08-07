/**
 * The task-class classify pass — the imperative shell around the pure
 * classifier in `@claude-stats/core/taskClass`.
 *
 * Spec: doc/analysis/constraint-impact/05-task-class-spec.md §5.9.
 *
 * Everything decision-shaped happens in core; this module only reads rows,
 * hands them over, and writes the answer back. It is idempotent and resumable:
 * the work list is "sessions with no classification, or one from an older
 * classifier version", so an interrupted run resumes exactly where it stopped
 * and a version bump reclassifies precisely the stale corpus.
 */
import {
  TASK_CLASS_VERSION,
  classifyTaskClass,
  deriveFeatures,
  type TaskClassMessage,
} from "@claude-stats/core/taskClass";
import type { Store, MessageRow } from "../store/index.js";

/** A `messages` row as the classifier's narrow projection sees it. */
function toClassifierMessage(row: MessageRow): TaskClassMessage {
  return {
    tools: parseJsonArray(row.tools),
    filePaths: parseJsonArray(row.file_paths),
    toolErrorCount: row.tool_error_count ?? 0,
    // `is_turn_start` is a V18 column and is not declared on `MessageRow`;
    // reading it defensively keeps this working for both pre- and post-V18
    // rows without widening the row type for one caller.
    isTurnStart: (row as MessageRow & { is_turn_start?: number }).is_turn_start === 1,
  };
}

/**
 * Parse a stored JSON array column into strings, tolerating malformed content.
 *
 * Never throws: a single corrupt row must not abort a whole classify pass, and
 * an unparseable tools column is genuinely "no tool evidence", which the sparse
 * rule then handles honestly.
 */
function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export interface ClassifyPassOptions {
  /** Injected clock. Never `Date.now()` inside the pass — tests pin this. */
  now?: () => number;
  /** Cap the number of sessions processed in one run (resumable batching). */
  limit?: number;
}

export interface ClassifyPassResult {
  /** Sessions classified in this run. */
  classified: number;
  /** Sessions that were already current at `TASK_CLASS_VERSION` before the run. */
  alreadyCurrent: number;
  /** Sessions still owed work after this run (non-zero only when `limit` bit). */
  remaining: number;
  version: number;
}

/**
 * Classify every session that needs it, writing results to schema V21.
 *
 * Sessions with no messages still get a row — as `unknown` / `sparse`. Leaving
 * them absent would make "unclassified" mean two different things (not yet
 * looked at vs looked at and undecidable), and the coverage denominator the
 * report has to publish would be unreadable.
 */
export function runTaskClassPass(store: Store, opts: ClassifyPassOptions = {}): ClassifyPassResult {
  const now = opts.now ?? (() => Date.now());
  const before = store.getSessionIdsNeedingTaskClass(TASK_CLASS_VERSION);
  const alreadyCurrent =
    store.getTaskClassVersions().find((v) => v.classifier_version === TASK_CLASS_VERSION)?.n ?? 0;

  const batch = opts.limit !== undefined && opts.limit > 0 ? before.slice(0, opts.limit) : before;
  const at = now();

  for (const sessionId of batch) {
    const messages = store.getSessionMessages(sessionId).map(toClassifierMessage);
    const result = classifyTaskClass(deriveFeatures(messages));
    store.setTaskClass({
      sessionId,
      taskClass: result.fine,
      coarseClass: result.coarse,
      confidence: result.confidence,
      rule: result.rule,
      abstainReason: result.abstainReason,
      classifierVersion: result.version,
      classifiedAt: at,
    });
  }

  return {
    classified: batch.length,
    alreadyCurrent: Math.max(0, alreadyCurrent),
    remaining: before.length - batch.length,
    version: TASK_CLASS_VERSION,
  };
}
