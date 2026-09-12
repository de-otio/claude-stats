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

/**
 * SessionRow fields that are a PROJECTION of the session's messages.
 *
 * ‼️ THESE ARE NO LONGER FOLDED WITH `max()` (V23). They were, and that was
 *    safe only while they could only ever grow. The usage-carrier row model
 *    makes them SHRINK — a session's token counters halve where its entries
 *    were multi-block — and `max()` across devices would have pinned the
 *    INFLATED value permanently: no logical clock can retract it, because a
 *    smaller number always loses to a larger one no matter how new it is. One
 *    un-upgraded peer would have held every device's history wrong forever.
 *
 *    They are recomputed from the merged message UNION instead, mirroring the
 *    store's own `recomputeSessionAggregatesSql` projection. The union is
 *    itself convergent, so a pure function of it is too — and a counter derived
 *    from the rows it summarises cannot disagree with them.
 *
 * `max()` survives ONLY as the fallback for a session whose union carries no
 * messages at all, which is exactly the `WHERE EXISTS (SELECT 1 FROM messages)`
 * arm of the SQL projection: with nothing to project from, the last known value
 * beats a fabricated zero.
 */
const PROJECTED_COUNTER_FIELDS = [
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
  const messages = unionMessages(a, b);

  // Counters derive from the union; with no union to derive from, the last
  // known value wins. See PROJECTED_COUNTER_FIELDS.
  if (messages.length > 0) {
    projectCounters(session, messages, Math.max(a.session.prompt_count, b.session.prompt_count));
  } else {
    for (const f of PROJECTED_COUNTER_FIELDS) {
      session[f] = Math.max(a.session[f], b.session[f]);
    }
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
    messages,
  };
}

/**
 * Overwrite a session's counter columns with the projection of `messages`,
 * mirroring the store's `recomputeSessionAggregatesSql` field for field.
 *
 * Non-carrier rows have zeroed token columns, so a plain sum over the union IS
 * a sum over carriers — no filter needed here, exactly as in SQL.
 *
 * `prompt_count` falls back to `fallbackPromptCount` when the union carries no
 * `is_turn_start` signal at all (rows collected before schema V18 have none),
 * rather than reporting "0 prompts" for the whole of history — the same CASE
 * the SQL projection uses.
 */
function projectCounters(
  session: SessionRow,
  messages: readonly MessageRow[],
  fallbackPromptCount: number,
): void {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let thinkingBlocks = 0;
  let webSearchRequests = 0;
  let webFetchRequests = 0;
  let throttleEvents = 0;
  let turnStarts = 0;
  for (const m of messages) {
    inputTokens += m.input_tokens;
    outputTokens += m.output_tokens;
    cacheCreationTokens += m.cache_creation_tokens;
    cacheReadTokens += m.cache_read_tokens;
    thinkingBlocks += m.thinking_blocks;
    webSearchRequests += m.web_search_requests ?? 0;
    webFetchRequests += m.web_fetch_requests ?? 0;
    throttleEvents += m.is_throttled ?? 0;
    turnStarts += m.is_turn_start ?? 0;
  }
  session.input_tokens = inputTokens;
  session.output_tokens = outputTokens;
  session.cache_creation_tokens = cacheCreationTokens;
  session.cache_read_tokens = cacheReadTokens;
  session.thinking_blocks = thinkingBlocks;
  session.web_search_requests = webSearchRequests;
  session.web_fetch_requests = webFetchRequests;
  session.throttle_events = throttleEvents;
  session.assistant_message_count = messages.length;
  session.prompt_count = turnStarts > 0 ? turnStarts : fallbackPromptCount;
}

/**
 * Worst-wins on `cost_basis`: a sync may ADD doubt about how a row's usage was
 * counted, never remove it. An absent value is doubt too — it means the writer
 * predates the column and cannot vouch for the number.
 */
function worstBasis(a: MessageRow, b: MessageRow): string {
  return (a.cost_basis ?? "pre-dedupe") === "per-response" &&
    (b.cost_basis ?? "pre-dedupe") === "per-response"
    ? "per-response"
    : "pre-dedupe";
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
    for (const m of side.messages) {
      const seen = byUuid.get(m.uuid);
      // The higher-clock row wins the VALUES, but `cost_basis` is worst-wins:
      // a device that cannot vouch for a number must not have its doubt erased
      // by a newer snapshot that merely didn't know to record any.
      byUuid.set(m.uuid, seen ? { ...m, cost_basis: worstBasis(seen, m) } : m);
    }
  }
  return [...byUuid.values()].sort((x, y) => (x.uuid < y.uuid ? -1 : x.uuid > y.uuid ? 1 : 0));
}

function sortByUuid(messages: readonly MessageRow[]): readonly MessageRow[] {
  return [...messages]
    // An absent `cost_basis` (a shard written before the column existed) means
    // "cannot vouch for this". Materialising that here — rather than leaving it
    // undefined — is what keeps a never-combined record byte-identical to a
    // combined one, and it is the same pessimistic default the column carries.
    .map((m) => (m.cost_basis === undefined ? { ...m, cost_basis: "pre-dedupe" } : m))
    .sort((x, y) => (x.uuid < y.uuid ? -1 : x.uuid > y.uuid ? 1 : 0));
}

function toMerged(record: StampedRecord<SessionExportPayload>): MergedSession {
  // Normalize here too so a session that is NEVER combined comes out identical to
  // one that is — otherwise idempotency (merge(X) === merge(X∪X)) would break on
  // message ORDER, on an absent `cost_basis`, or on counters that were never
  // reprojected. Same reason the sort has always lived here.
  const messages = sortByUuid(record.value.messages);
  const session: SessionRow = { ...record.value.session };
  if (messages.length > 0) {
    projectCounters(session, messages, session.prompt_count);
  }
  return { clock: record.clock, session, messages };
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
