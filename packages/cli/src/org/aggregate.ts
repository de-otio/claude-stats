/**
 * Org-plane LOCAL AGGREGATION projection (Phase F-core, client side).
 *
 * A PURE function: local `sessions` rows → MINIMIZED {@link AggregateProjection}
 * records — the ONLY payload shape the sync client ever sends to the org
 * backend. The client MINIMIZES (rolls individual sessions up into
 * per-`(period, cohort)` counts and totals); k-anonymity, if any, is a COHORT
 * property enforced ORG-SIDE (review N3), never computed here.
 *
 * ── Plane-separation invariant (structural, non-negotiable) ──────────────────
 * The output type {@link AggregateProjection} is a DIFFERENT shape from
 * `SessionRecord` / `SyncSessionInput`. It is structurally INCAPABLE of carrying
 * `prompt_text`, `file_paths`, raw transcript content, session/source ids or
 * paths, or any key material — enforced BY TYPE via the compile-time invariant
 * in `packages/core/src/types/shard.ts`, not by a runtime filter. There is no
 * code path in this module that copies a raw prompt, transcript, path, id, or
 * key onto the payload: we read only numeric counters and non-sensitive model
 * labels off each row, and emit an opaque, caller-minimized cohort handle.
 *
 * ── Determinism ──────────────────────────────────────────────────────────────
 * Functional core: pure and reproducible. Period bucketing uses each row's OWN
 * timestamp in UTC — never `Date.now()` — and both the model list and the record
 * list are sorted, so the projection of a given row set is byte-stable across
 * runs and machines (a requirement for pinned tests).
 */
import type { SessionRow } from "../store/index.js";
import type { AggregateProjection } from "@claude-stats/core/types/shard";
import type { AggregateSyncInput } from "@claude-stats/core/types/api";
import { estimateCost } from "@claude-stats/core/pricing";

/** The period granularity of an aggregate bucket. Mirrors {@link AggregateProjection.periodKind}. */
export type PeriodKind = AggregateProjection["periodKind"];

/** Aggregate-payload schema version stamped into every emitted record's `_schema`. */
export const AGGREGATE_SCHEMA_VERSION = 1;

export interface AggregateProjectionOptions {
  /** Bucket granularity: `"day" | "week" | "month"`. */
  readonly periodKind: PeriodKind;
  /**
   * Maps a raw `account_uuid` to an OPAQUE, client-minimized cohort id
   * (e.g. an HMAC-derived handle). Called ONLY for rows that carry an
   * `account_uuid`. MUST NOT return the raw uuid or any reversible value —
   * that is the caller's responsibility. Injected (rather than importing the
   * HMAC helper) so this projection stays pure and crypto-free, hence trivially
   * testable and reusable.
   */
  readonly cohortIdFor: (accountUuid: string) => string;
  /** Cohort id assigned to rows with no `account_uuid` (the unattributed bucket). */
  readonly unattributedCohortId: string;
  /** Value stamped into `_schema`. Defaults to {@link AGGREGATE_SCHEMA_VERSION}. */
  readonly schemaVersion?: number;
}

/**
 * The UTC start-of-period ISO date (`YYYY-MM-DD`) for `epochMs` under `kind`.
 *
 * - `day`   → that calendar day (UTC).
 * - `week`  → the ISO week's Monday (UTC).
 * - `month` → the 1st of that month (UTC).
 *
 * Pure and total; exported so bucketing can be tested directly.
 */
export function bucketStart(epochMs: number, kind: PeriodKind): string {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-based
  const day = d.getUTCDate();

  if (kind === "month") {
    return `${y}-${pad2(m + 1)}-01`;
  }
  if (kind === "week") {
    // ISO week starts Monday. getUTCDay(): 0=Sun … 6=Sat.
    const isoOffset = (d.getUTCDay() + 6) % 7; // days elapsed since Monday
    // Date.UTC normalizes month/year underflow when day - isoOffset ≤ 0.
    const monday = new Date(Date.UTC(y, m, day - isoOffset));
    return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
  }
  return `${y}-${pad2(m + 1)}-${pad2(day)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * A single accumulating bucket. Internal + MUTABLE by deliberate exception:
 * accumulators are the one place local mutation buys real clarity/perf over a
 * fold that reallocates on every row. Never escapes this module — the returned
 * {@link AggregateProjection}s are fresh immutable records.
 */
interface Bucket {
  readonly periodStart: string;
  readonly cohortId: string;
  sessionCount: number;
  promptCount: number;
  assistantMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
  readonly models: Set<string>;
}

/**
 * Project local `sessions` rows into minimized org-plane aggregate records.
 *
 * Rows are grouped by `(bucketStart(timestamp), cohortId)`. A row's bucketing
 * timestamp is its `first_timestamp`, falling back to `last_timestamp`; a row
 * with neither is skipped (it cannot be placed in time). Per bucket we sum the
 * session count, prompt/assistant-message counts, token counters, and a
 * per-session cost estimate (using the row's primary model), and union the
 * model labels.
 *
 * The result is sorted by `(periodStart, cohortId)` for determinism.
 */
export function projectAggregates(
  rows: readonly SessionRow[],
  options: AggregateProjectionOptions,
): AggregateProjection[] {
  const schema = options.schemaVersion ?? AGGREGATE_SCHEMA_VERSION;
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const ts = row.first_timestamp ?? row.last_timestamp;
    if (ts === null || ts === undefined) continue; // un-bucketable in time

    const cohortId = row.account_uuid
      ? options.cohortIdFor(row.account_uuid)
      : options.unattributedCohortId;
    const periodStart = bucketStart(ts, options.periodKind);

    // NUL separator can't appear in an ISO date or an opaque cohort handle.
    const key = `${periodStart}\u0000${cohortId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        periodStart,
        cohortId,
        sessionCount: 0,
        promptCount: 0,
        assistantMessageCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        estimatedCostUsd: 0,
        models: new Set<string>(),
      };
      buckets.set(key, bucket);
    }

    const models = parseModels(row.models);
    for (const model of models) bucket.models.add(model);

    bucket.sessionCount += 1;
    bucket.promptCount += row.prompt_count;
    bucket.assistantMessageCount += row.assistant_message_count;
    bucket.inputTokens += row.input_tokens;
    bucket.outputTokens += row.output_tokens;
    bucket.cacheCreationTokens += row.cache_creation_tokens;
    bucket.cacheReadTokens += row.cache_read_tokens;

    const primaryModel = models[0];
    if (primaryModel) {
      bucket.estimatedCostUsd += estimateCost(
        primaryModel,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens,
        row.cache_creation_tokens,
      ).cost;
    }
  }

  return [...buckets.values()]
    .map((b): AggregateProjection => ({
      periodStart: b.periodStart,
      periodKind: options.periodKind,
      cohortId: b.cohortId,
      sessionCount: b.sessionCount,
      promptCount: b.promptCount,
      assistantMessageCount: b.assistantMessageCount,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cacheCreationTokens: b.cacheCreationTokens,
      cacheReadTokens: b.cacheReadTokens,
      estimatedCostUsd: b.estimatedCostUsd,
      models: [...b.models].sort(),
      _schema: schema,
    }))
    .sort((a, b) =>
      a.periodStart === b.periodStart
        ? compareStr(a.cohortId, b.cohortId)
        : compareStr(a.periodStart, b.periodStart),
    );
}

/** Parse a `sessions.models` JSON column into a string[]; tolerant of malformed data. */
function parseModels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((m): m is string => typeof m === "string");
    }
  } catch {
    // malformed models column — treat as no models
  }
  return [];
}

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Per-user aggregate projection (deployed `syncAggregate` contract) ────────
//
// The deployed AppSync server (schema.graphql `input AggregateSyncInput` →
// `userAggregates`, PK=userId/SK=period) is a PER-USER, PER-DAY model — NOT the
// cohort model above. Its table key is `(userId, period)`, so it holds exactly
// one row per (user, day); we therefore roll a day's sessions up into a single
// total row (summed across the user's linked accounts and projects). This is
// what feeds the personal dashboard (myStats) and, via the aggregate-stats
// stream worker, per-member TeamStats.
//
// projectId is left null in this projection: the deployed key cannot hold more
// than one project per day, so per-project fidelity is a separate follow-up
// (it needs an SK-format change server-side; the table is currently empty).

interface UserBucket {
  readonly period: string;
  sessionCount: number;
  subagentSessionCount: number;
  promptCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  activeMs: number;
  estimatedCost: number;
  readonly models: Set<string>;
  readonly toolUseCounts: Record<string, number>;
}

export interface UserAggregateOptions {
  /** Representative derived accountId stamped on every row (server key ignores it). */
  readonly accountId: string;
  /** Bucket granularity; the deployed readers expect daily buckets. Default "day". */
  readonly periodKind?: PeriodKind;
}

/**
 * Project local `sessions` rows into the deployed per-user `AggregateSyncInput`
 * shape — one row per period bucket, summed across all rows passed in. PURE and
 * deterministic (bucketing uses each row's own timestamp, sorted output).
 * `_version` is 0 for every row; the sync client bumps it on conflict retries.
 */
export function projectUserAggregates(
  rows: readonly SessionRow[],
  options: UserAggregateOptions,
): AggregateSyncInput[] {
  const periodKind = options.periodKind ?? "day";
  const buckets = new Map<string, UserBucket>();

  for (const row of rows) {
    const ts = row.first_timestamp ?? row.last_timestamp;
    if (ts === null || ts === undefined) continue; // un-bucketable in time

    const period = bucketStart(ts, periodKind);
    let b = buckets.get(period);
    if (!b) {
      b = {
        period,
        sessionCount: 0,
        subagentSessionCount: 0,
        promptCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        activeMs: 0,
        estimatedCost: 0,
        models: new Set<string>(),
        toolUseCounts: {},
      };
      buckets.set(period, b);
    }

    b.sessionCount += 1;
    if (row.is_subagent) b.subagentSessionCount += 1;
    b.promptCount += row.prompt_count;
    b.inputTokens += row.input_tokens;
    b.outputTokens += row.output_tokens;
    b.cacheCreationTokens += row.cache_creation_tokens;
    b.cacheReadTokens += row.cache_read_tokens;
    b.activeMs += row.active_duration_ms ?? 0;

    const models = parseModels(row.models);
    for (const m of models) b.models.add(m);
    mergeToolCounts(b.toolUseCounts, row.tool_use_counts);

    const primaryModel = models[0];
    if (primaryModel) {
      b.estimatedCost += estimateCost(
        primaryModel,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens,
        row.cache_creation_tokens,
      ).cost;
    }
  }

  return [...buckets.values()]
    .map((b): AggregateSyncInput => ({
      period: b.period,
      projectId: null,
      sessionCount: b.sessionCount,
      subagentSessionCount: b.subagentSessionCount,
      promptCount: b.promptCount,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cacheCreationTokens: b.cacheCreationTokens,
      cacheReadTokens: b.cacheReadTokens,
      activeMinutes: Math.round(b.activeMs / 60000),
      toolUseCounts: b.toolUseCounts,
      models: [...b.models].sort(),
      accountId: options.accountId,
      estimatedCost: Math.round(b.estimatedCost * 100) / 100,
      _version: 0,
    }))
    .sort((a, b) => compareStr(a.period, b.period));
}

/** Merge a session's `tool_use_counts` JSON column into an accumulating map. */
function mergeToolCounts(into: Record<string, number>, raw: string): void {
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [tool, count] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
          into[tool] = (into[tool] ?? 0) + count;
        }
      }
    }
  } catch {
    // malformed tool_use_counts column — skip
  }
}
