/**
 * Constraint before/after — glue between the store and the pure engine in
 * `@claude-stats/core/constraintImpact`.
 *
 * Mirrors the shape of `../hygiene/index.ts` and `../ticketing/index.ts`:
 * fetches the rows the pure module needs, maps store snake_case to the core
 * camelCase row shape, and hands the result to `compareConstraintImpact`.
 *
 * Design: doc/analysis/constraint-impact/.
 */
import {
  compareConstraintImpact,
  parsePolicyEventBoundaryMs,
  type ConstraintImpactSessionRow,
  type ConstraintImpactClassification,
  type ConstraintImpactReport,
} from "@claude-stats/core/constraintImpact";
import { groupBySession, sumCost, type HygieneMessageRow } from "@claude-stats/core/hygiene";
import { nonNegativeFiniteInt, type RateOverrides } from "@claude-stats/core/pricing";
import { TASK_CLASS_VERSION } from "@claude-stats/core/taskClass";
import type { PolicyEvent, TaskClass, CoarseTaskClass, Confidence } from "@claude-stats/core/types/insight";
import type { HygieneMessageStoreRow, Store } from "../store/index.js";

export type { ConstraintImpactReport, ClassImpactComparison } from "@claude-stats/core/constraintImpact";

export interface ConstraintImpactFilters {
  projectPath?: string;
  repoUrl?: string;
  accountUuid?: string;
  /** Explicit `false` excludes non-interactive (CI) sessions. Mirrors `MessageFilter`. */
  includeCI?: boolean;
  /** Explicit `false` excludes sessions whose transcript was deleted. Mirrors `MessageFilter`. */
  includeDeleted?: boolean;
  /**
   * Clip the "before" side to sessions active at/after this epoch-ms, and the
   * "after" side to sessions active before this epoch-ms — bounds how far
   * back/forward the comparison looks around the policy boundary. Undefined
   * on either end means "the full available history on that side".
   */
  since?: number;
  until?: number;
  minSessionsPerClass?: number;
  rateOverrides?: RateOverrides;
  /** `config.rate.hourly` — absent/null means "not configured"; the report
   *  states dev-time in minutes and never invents a rate. */
  hourlyRate?: number | null;
  currency?: string;
}

/**
 * Coverage denominator for the classification join — the piece a per-class
 * delta is only honest with (03 §3.2 Gap 1: "reclassify before quoting a
 * per-class delta"). Sessions the classifier never reached, or reached at an
 * OLDER version than the one currently active, are excluded from every class
 * row rather than mixed into a comparison the classifier itself would no
 * longer stand behind.
 */
export interface ConstraintImpactCoverage {
  /** Sessions in the compared windows with no stored classification at all. */
  unclassified: number;
  /** Sessions classified by a version older than `TASK_CLASS_VERSION`. */
  staleClassifierVersion: number;
  /** Distinct classifier versions seen among CLASSIFIED sessions in the
   *  compared windows (ascending). More than one entry is why
   *  `staleClassifierVersion` is non-zero. */
  classifierVersionsSeen: readonly number[];
}

export interface ConstraintImpactResult {
  report: ConstraintImpactReport;
  coverage: ConstraintImpactCoverage;
}

// Same guarded parse every `toHygieneMessageRow` mapper carries (context-carry-
// cost B1/review F11): `messages.tools` is a JSON array of `block.name` values
// with no runtime check at write time (`ContentBlock.name` is `name?: string`),
// so a hand-edited JSONL or a synced shard can carry a non-string element or
// malformed JSON. Parsing at the store boundary — not inside the pure
// `hygiene/`/`constraintImpact/` modules — means one bad row degrades to `[]`
// rather than taking down the whole window's report.
function parseTools(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string");
  } catch {
    return [];
  }
}

function toHygieneMessageRow(row: HygieneMessageStoreRow): HygieneMessageRow {
  return {
    sessionId: row.session_id,
    projectPath: row.project_path,
    uuid: row.uuid,
    timestamp: row.timestamp,
    model: row.model,
    // Coerced here (review F1) — this module's `tokensOf`/`sumCost` sum these
    // across a session and feed a before/after cost delta, so an unvalidated
    // negative or NaN would otherwise poison the comparison.
    inputTokens: nonNegativeFiniteInt(row.input_tokens),
    outputTokens: nonNegativeFiniteInt(row.output_tokens),
    cacheReadTokens: nonNegativeFiniteInt(row.cache_read_tokens),
    cacheCreationTokens: nonNegativeFiniteInt(row.cache_creation_tokens),
    ephemeral5mCacheTokens: row.ephemeral_5m_cache_tokens,
    ephemeral1hCacheTokens: row.ephemeral_1h_cache_tokens,
    toolErrorCount: row.tool_error_count,
    tools: parseTools(row.tools),
  };
}

function tokensOf(row: HygieneMessageRow): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens;
}

/** Build one side's session rows: message-sourced fields (cost/tokens/turns/
 *  tool-errors/models) from `getMessagesForHygiene`, session-aggregate fields
 *  (active dev-minutes, median response time) joined from `getSessions` over
 *  the SAME window via `activeSince` — the predicate documented to agree with
 *  the message-scoped reads even when a session straddles the boundary. */
function buildSideRows(
  store: Store,
  filters: ConstraintImpactFilters,
  since: number | undefined,
  until: number | undefined,
): ConstraintImpactSessionRow[] {
  const messageRows = store
    .getMessagesForHygiene({
      projectPath: filters.projectPath,
      repoUrl: filters.repoUrl,
      accountUuid: filters.accountUuid,
      since,
      until,
      includeCI: filters.includeCI,
      includeDeleted: filters.includeDeleted,
    })
    .map(toHygieneMessageRow);

  const sessionRows = store.getSessions({
    projectPath: filters.projectPath,
    repoUrl: filters.repoUrl,
    accountUuid: filters.accountUuid,
    activeSince: since,
    until,
    includeCI: filters.includeCI,
    includeDeleted: filters.includeDeleted,
  });
  const sessionById = new Map(sessionRows.map((s) => [s.session_id, s]));

  const rows: ConstraintImpactSessionRow[] = [];
  for (const group of groupBySession(messageRows)) {
    const session = sessionById.get(group.sessionId);
    const models = new Set<string>();
    let toolErrors = 0;
    let tokensTotal = 0;
    for (const m of group.messages) {
      if (m.model) models.add(m.model);
      toolErrors += m.toolErrorCount;
      tokensTotal += tokensOf(m);
    }
    rows.push({
      sessionId: group.sessionId,
      cost: sumCost(group.messages, filters.rateOverrides),
      tokensTotal,
      turns: group.messages.length,
      toolErrors,
      activeDurationMs: session?.active_duration_ms ?? null,
      medianResponseTimeMs: session?.median_response_time_ms ?? null,
      models: [...models],
    });
  }
  return rows;
}

/**
 * Join the classifier's stored verdicts for a set of session ids, gated to
 * the CURRENT classifier version. Returns the map `compareConstraintImpact`
 * needs plus the coverage counts a class row's caveat is built from.
 */
function buildTaskClassMap(
  store: Store,
  sessionIds: readonly string[],
): { map: Map<string, ConstraintImpactClassification>; coverage: ConstraintImpactCoverage } {
  const map = new Map<string, ConstraintImpactClassification>();
  const seen = new Set<string>();
  const versionsSeen = new Set<number>();
  let unclassified = 0;
  let staleClassifierVersion = 0;

  for (const id of sessionIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stored = store.getTaskClass(id);
    if (!stored) {
      unclassified += 1;
      continue;
    }
    versionsSeen.add(stored.classifier_version);
    if (stored.classifier_version !== TASK_CLASS_VERSION) {
      staleClassifierVersion += 1;
      continue;
    }
    map.set(id, {
      fine: stored.task_class as TaskClass,
      coarse: stored.coarse_class as CoarseTaskClass,
      confidence: stored.confidence as Confidence,
    });
  }

  return {
    map,
    coverage: {
      unclassified,
      staleClassifierVersion,
      classifierVersionsSeen: [...versionsSeen].sort((a, b) => a - b),
    },
  };
}

/**
 * Build the constraint-impact report for one declared policy boundary.
 *
 * `since`/`until` in `filters` bound how far the comparison looks on the
 * "before"/"after" sides respectively; the boundary itself always comes from
 * `policyEvent.date` (`03 §3.1` — declared, never inferred).
 */
export function buildConstraintImpactReport(
  store: Store,
  policyEvent: PolicyEvent,
  filters: ConstraintImpactFilters = {},
): ConstraintImpactResult {
  const boundaryMs = parsePolicyEventBoundaryMs(policyEvent.date);

  const rawBeforeRows = buildSideRows(store, filters, filters.since, boundaryMs);
  const rawAfterRows = buildSideRows(store, filters, boundaryMs, filters.until);

  // M-2: a session whose activity straddles the boundary owns messages on
  // BOTH sides, so it produces a row in both `rawBeforeRows` and
  // `rawAfterRows` — that part is correct, and `cost`/`tokensTotal`/`turns`/
  // `toolErrors` on each row are genuinely partial, since they're summed only
  // from that side's messages. But `activeDurationMs` and
  // `medianResponseTimeMs` are joined from the SESSION record's own aggregate
  // columns (see `buildSideRows`), which cover the session's full lifetime —
  // there is no per-window active-duration figure to join instead. Left
  // as-is, the straddling session's whole active duration would be
  // attributed in full to EACH side, double-counting the dev-time half of a
  // before/after ledger whose entire point is to weigh dev-time against
  // token cost. There's no honest way to split a lifetime duration by
  // message timestamp, so exclude — rather than approximate — these two
  // fields for a straddling session on both sides.
  const afterSessionIds = new Set(rawAfterRows.map((r) => r.sessionId));
  const straddlingSessionIds = new Set(
    rawBeforeRows.filter((r) => afterSessionIds.has(r.sessionId)).map((r) => r.sessionId),
  );
  const clipStraddler = (row: ConstraintImpactSessionRow): ConstraintImpactSessionRow =>
    straddlingSessionIds.has(row.sessionId)
      ? { ...row, activeDurationMs: null, medianResponseTimeMs: null }
      : row;
  const beforeRows = rawBeforeRows.map(clipStraddler);
  const afterRows = rawAfterRows.map(clipStraddler);

  const allSessionIds = [...beforeRows, ...afterRows].map((r) => r.sessionId);
  const { map: taskClassBySession, coverage } = buildTaskClassMap(store, allSessionIds);

  const report = compareConstraintImpact(beforeRows, afterRows, taskClassBySession, policyEvent, {
    minSessionsPerClass: filters.minSessionsPerClass,
    hourlyRate: filters.hourlyRate ?? null,
    currency: filters.currency,
  });

  return { report, coverage };
}
