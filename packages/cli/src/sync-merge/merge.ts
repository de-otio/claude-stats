/**
 * Phase D — conflict-free convergent MERGE (pure functional core).
 *
 * Folds the {@link StampedRecord}s pulled from EVERY device's shards into one
 * canonical per-session view. The whole point is CONVERGENCE: any two devices
 * that have pulled the same set of shards compute byte-identical output no matter
 * what order the shards arrived in. That requires the fold to be a commutative,
 * associative, idempotent monoid — so this module is written as exactly that and
 * the property tests pin it (merge/merge.test.ts).
 *
 * ‼️ THE MERGE KEY IS THE ORIGIN LOGICAL CLOCK, NOT THE DB `updated_at` (B2).
 *    `updated_at` is stamped `Date.now()` at LOCAL MERGE time by the store's
 *    upserts, so it is non-convergent, unpinnable, and tiebreak-free. The
 *    cross-device decision is made HERE, off {@link OriginClock}, BEFORE anything
 *    touches SQLite. See {@link compareClock}.
 *
 * Per-session fold:
 *   - descriptive fields  → LWW: taken wholesale from the higher-clock record.
 *   - monotonic counters  → `max()` across all versions (idempotent + order-free).
 *   - first_timestamp     → `min()`; last_timestamp → `max()` (nulls ignored).
 *   - messages            → union by `uuid`, higher-clock record wins a uuid tie.
 *
 * `max`/`min`/LWW-pick are each a commutative-associative-idempotent combine, so
 * the record they compose into is too. No IO, no clock, no randomness here.
 */

import type {
  DeviceId,
  OriginClock,
  StampedRecord,
} from "@claude-stats/core/types/shard";
import type { SessionExportPayload } from "../backup/records.js";
import type { MessageRow, SessionRow } from "../store/index.js";

/**
 * Total order on {@link OriginClock}: the cross-device merge key. Ordered by the
 * monotonic `counter`, then the origin `DeviceId` as the DETERMINISTIC TIEBREAK
 * (B2). `wallMs` is deliberately NOT consulted — it is a human-readable ordering
 * hint only and is subject to cross-device skew, so letting it decide would break
 * convergence. Returns <0, 0, or >0 like a comparator.
 */
export function compareClock(a: OriginClock, b: OriginClock): number {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.originDevice !== b.originDevice) return a.originDevice < b.originDevice ? -1 : 1;
  return 0;
}

/** The later of two clocks under {@link compareClock}; `b` wins an exact tie. */
export function laterClock(a: OriginClock, b: OriginClock): OriginClock {
  return compareClock(a, b) >= 0 ? a : b;
}

/**
 * A fully-merged session: the convergent winner for one `session_id` across all
 * pulled shards, plus the clock that won it (retained for a stable message
 * tiebreak and for glanceable diagnostics).
 */
export interface MergedSession {
  readonly clock: OriginClock;
  readonly session: SessionRow;
  readonly messages: readonly MessageRow[];
}

/** SessionRow fields folded with `max()` — cumulative, monotonic-by-collection. */
const MONOTONIC_COUNTER_FIELDS = [
  "prompt_count",
  "assistant_message_count",
  "input_tokens",
  "output_tokens",
  "cache_creation_tokens",
  "cache_read_tokens",
  "web_search_requests",
  "web_fetch_requests",
  "thinking_blocks",
  "throttle_events",
] as const;

/** Sticky boolean-ish flags: once true on ANY device, stays true (also `max()`). */
const STICKY_FLAG_FIELDS = ["is_interactive", "is_subagent"] as const;

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

/**
 * Combine two merged sessions for the SAME `session_id` into their convergent
 * join. Commutative, associative, idempotent: `combine(x,x)===x`,
 * `combine(a,b)===combine(b,a)`, `combine(a,combine(b,c))===combine(combine(a,b),c)`.
 */
export function combineSession(a: MergedSession, b: MergedSession): MergedSession {
  // LWW base = the higher-clock record; descriptive fields come from it wholesale.
  const winner = compareClock(a.clock, b.clock) >= 0 ? a : b;
  const session: SessionRow = { ...winner.session };

  // Monotonic counters: max() across both versions (order-free, idempotent).
  for (const f of MONOTONIC_COUNTER_FIELDS) {
    session[f] = Math.max(a.session[f], b.session[f]);
  }
  for (const f of STICKY_FLAG_FIELDS) {
    session[f] = Math.max(a.session[f], b.session[f]);
  }
  // Timespan: widest observed across versions.
  session.first_timestamp = minNullable(a.session.first_timestamp, b.session.first_timestamp);
  session.last_timestamp = maxNullable(a.session.last_timestamp, b.session.last_timestamp);
  session.active_duration_ms = maxNullable(a.session.active_duration_ms, b.session.active_duration_ms);

  return {
    clock: laterClock(a.clock, b.clock),
    session,
    messages: unionMessages(a, b),
  };
}

/**
 * Union two versions' messages by `uuid`; on a uuid collision the message from
 * the higher-clock record wins. Output is sorted by `uuid` so equal inputs
 * (in any order) yield byte-identical arrays — convergence at the message level.
 */
function unionMessages(a: MergedSession, b: MergedSession): readonly MessageRow[] {
  const lowerFirst = compareClock(a.clock, b.clock) < 0 ? [a, b] : [b, a];
  const byUuid = new Map<string, MessageRow>();
  // Insert lower-clock first, then let the higher-clock record overwrite ties.
  for (const side of lowerFirst) {
    for (const m of side.messages) byUuid.set(m.uuid, m);
  }
  return [...byUuid.values()].sort((x, y) => (x.uuid < y.uuid ? -1 : x.uuid > y.uuid ? 1 : 0));
}

function sortByUuid(messages: readonly MessageRow[]): readonly MessageRow[] {
  return [...messages].sort((x, y) => (x.uuid < y.uuid ? -1 : x.uuid > y.uuid ? 1 : 0));
}

function toMerged(record: StampedRecord<SessionExportPayload>): MergedSession {
  return {
    clock: record.clock,
    session: record.value.session,
    // Sort here too so a session that is NEVER combined normalizes identically to
    // one that is — otherwise idempotency (merge(X) === merge(X∪X)) would break on
    // message ORDER alone.
    messages: sortByUuid(record.value.messages),
  };
}

/**
 * Merge every pulled record into the canonical per-session view. Order-free:
 * grouping is by `session_id` and each group is folded with {@link combineSession},
 * then the result is sorted by `session_id`, so the output is a pure function of
 * the INPUT SET regardless of shard/record ordering.
 */
export function mergeRecords(
  records: readonly StampedRecord<SessionExportPayload>[],
): readonly MergedSession[] {
  const bySession = new Map<string, MergedSession>();
  for (const record of records) {
    const incoming = toMerged(record);
    const id = incoming.session.session_id;
    const existing = bySession.get(id);
    bySession.set(id, existing ? combineSession(existing, incoming) : incoming);
  }
  return [...bySession.values()].sort((a, b) =>
    a.session.session_id < b.session.session_id ? -1 : a.session.session_id > b.session.session_id ? 1 : 0,
  );
}

/** Distinct origin devices that authored the merged records (diagnostics/F13). */
export function originDevicesOf(
  records: readonly StampedRecord<SessionExportPayload>[],
): ReadonlySet<DeviceId> {
  const seen = new Set<DeviceId>();
  for (const r of records) seen.add(r.clock.originDevice);
  return seen;
}
