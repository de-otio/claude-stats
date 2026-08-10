/** Shared helpers for the efficiency-hygiene detectors. Pure, no I/O. */
import { estimateCost, type CacheWriteSplit, type RateOverrides } from "../pricing.js";
import type { HygieneMessageRow } from "./types.js";

/** One session's messages in the caller's row order — grouping never reorders.
 *  The store hands rows over already sorted by `ORDER BY m.timestamp ASC`,
 *  which on SQLite sorts NULL timestamps FIRST (verified: SQLite treats NULL
 *  as smaller than any value). That ordering is what the order-sensitive
 *  detectors rely on: a null-timestamp row landing at the FRONT leaves each
 *  session's last row a real, timestamped message, which is what
 *  `abandonedSpend` reads. Do not "fix" the query to `NULLS LAST` without
 *  revisiting that detector. */
export interface SessionGroup {
  sessionId: string;
  projectPath: string;
  messages: HygieneMessageRow[];
}

/** Group a flat, timestamp-ordered row array into per-session groups,
 *  preserving row order within each group. */
export function groupBySession(rows: readonly HygieneMessageRow[]): SessionGroup[] {
  const order: string[] = [];
  const groups = new Map<string, SessionGroup>();
  for (const row of rows) {
    let g = groups.get(row.sessionId);
    if (!g) {
      g = { sessionId: row.sessionId, projectPath: row.projectPath, messages: [] };
      groups.set(row.sessionId, g);
      order.push(row.sessionId);
    }
    g.messages.push(row);
  }
  return order.map((id) => groups.get(id)!);
}

/** Equivalent-API cost of one message's tokens; 0 for an unpriced model
 *  (never silently dropped from a sum — callers summing across a session with
 *  a mix of known/unknown models will under-count by the unknown share, which
 *  is the same convention `estimateCost` establishes everywhere else).
 *
 *  Passes the row's own TTL split through to `estimateCost` (cache-ttl-fit
 *  A2/D2) so every hygiene detector prices cache writes at the rate they were
 *  actually written at, not uniformly at the 5-minute rate. A row with both
 *  split fields at `0` (pre-column schema, or a genuinely 5m-only write) still
 *  takes `estimateCost`'s rule-2 path, not rule-1 — the two rules agree to the
 *  last bit on that input (see `pricing.ts`'s byte-identical test), so this is
 *  not a behavior change for callers whose fixtures predate the split. */
export function messageCost(row: HygieneMessageRow, overrides?: RateOverrides): number {
  if (!row.model) return 0;
  const ttlSplit: CacheWriteSplit = {
    ephemeral5mCacheTokens: row.ephemeral5mCacheTokens,
    ephemeral1hCacheTokens: row.ephemeral1hCacheTokens,
  };
  return estimateCost(row.model, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens, overrides, ttlSplit).cost;
}

/** Sum of `messageCost` over a set of rows. */
export function sumCost(rows: readonly HygieneMessageRow[], overrides?: RateOverrides): number {
  let total = 0;
  for (const r of rows) total += messageCost(r, overrides);
  return total;
}

/** `input + cacheRead + cacheCreation` — the full context fed to the model on
 *  one turn, whatever fraction of it was cached. The billed volume unit every
 *  context-carry-cost quantity is built from (context-carry-cost A1). */
export function totalContext(row: HygieneMessageRow): number {
  return row.inputTokens + row.cacheReadTokens + row.cacheCreationTokens;
}

/** The default drop rule shared by `contextIncrements`' floorless post-reset
 *  classification and `detectResets`' floored one: a drop to below
 *  `(1 - dropRatio) × prev`. One constant, two consumers with two different
 *  floors — see `detectResets`' doc for why they must stay distinguishable. */
const DEFAULT_DROP_RATIO = 0.4;
/** `detectResets`' floor: a drop only counts as a reset when the context it
 *  dropped FROM was already large. `contextIncrements`' post-reset rule below
 *  does NOT apply this floor (context-carry-cost A1 item 4 / plan.md §12: the
 *  distinct-content denominator uses the floorless rule; the resets
 *  ledger/sawtooth uses this floored one — measured difference on a real
 *  30-day window was 0.3%, immaterial, but the two rules answer different
 *  questions and must not be unified into one). */
const DEFAULT_RESET_MIN_BEFORE_TOKENS = 150_000;

/** One step of a session's timestamp-ordered chain, with a null-timestamp row
 *  never appearing as either `row` or `prev` — see `walkSessionChains`. */
interface ChainStep {
  sessionId: string;
  row: HygieneMessageRow;
  /** The chain-previous row (last row with a valid timestamp, in this same
   *  unbroken run) — `null` at a session's first valid-timestamp row, or at
   *  the first valid-timestamp row after a null-timestamp break. */
  prev: HygieneMessageRow | null;
  curTotal: number;
  /** `null` exactly when `prev` is `null`. */
  prevTotal: number | null;
}

/**
 * Shared single-pass walk over every session's messages, in the row order the
 * caller supplied (the store's `ORDER BY m.timestamp ASC`, NULLS FIRST on
 * SQLite — see `groupBySession`'s doc). One implementation of the chain/break
 * bookkeeping so `contextIncrements` and `detectResets` cannot drift apart on
 * it (`hygiene/util.ts`'s own "one implementation of every shared quantity"
 * rule) — they differ only in which STEPS they act on and how they classify
 * them, never in how the chain is walked.
 *
 * A row with `timestamp === null` is excluded from gap/order-sensitive
 * analysis (never yielded as a step's `row`) and BREAKS the chain: the next
 * valid-timestamp row's `prev`/`prevTotal` come back `null`, exactly as if it
 * were its session's first message. This matches `reEntryBurn.ts`'s
 * convention — a null on either side of a pair breaks that pair rather than
 * bridging it — and `ttlFit.ts`'s `prevTimestamp = null` reset, deliberately:
 * a caller cannot distinguish "genuinely first" from "resumed after a null
 * break" from the step alone, same as `ttlFit.ts`'s `"session-start"` origin
 * bucket collapses both. Excluded rows are not counted by this function
 * itself — a caller who needs that count already has `rows` and can filter
 * `timestamp === null` directly, the same way `ttlFit.ts`'s `excludedRows`
 * is computed from the same rows it walks.
 */
function* walkSessionChains(rows: readonly HygieneMessageRow[]): Generator<ChainStep> {
  for (const group of groupBySession(rows)) {
    let prevRow: HygieneMessageRow | null = null;
    let prevTotal: number | null = null;
    for (const row of group.messages) {
      if (row.timestamp === null) {
        prevRow = null;
        prevTotal = null;
        continue;
      }
      const curTotal = totalContext(row);
      yield { sessionId: group.sessionId, row, prev: prevRow, curTotal, prevTotal };
      prevRow = row;
      prevTotal = curTotal;
    }
  }
}

/**
 * One row's context increment, DISCRIMINATED by what the increment actually
 * means (context-carry-cost D9) — no consumer may ever treat a bare
 * `increment` number as "growth", because two of the four kinds are not
 * growth at all:
 *
 *  - `"growth"` — this turn added more than it dropped since the chain's
 *    previous valid-timestamp row. `prev` is that row; `increment` is the
 *    positive difference.
 *  - `"session-start"` — no valid chain-previous row exists: this is the
 *    session's first valid-timestamp row, OR the first one after a
 *    null-timestamp break (see `walkSessionChains`; the two are
 *    indistinguishable from here, deliberately, matching `ttlFit.ts`). `prev`
 *    is `null`; `increment` is this row's WHOLE `totalContext` — a session
 *    (or a resumed chain) starts by definition with no prior carried volume,
 *    so its first observed total is new content, not growth over anything.
 *  - `"post-reset"` — this row's total dropped to below `(1 - dropRatio) ×
 *    prev` (FLOORLESS — no `minBeforeTokens` gate; see `detectResets` for the
 *    floored sibling rule and why the two are deliberately different).
 *    `increment` is again this row's WHOLE `totalContext`: after a
 *    compaction/`/compact`, this tool cannot see whether the new baseline is
 *    fresh text or a restatement of what was dropped, so the conservative
 *    (D8) choice is to count all of it as distinct rather than none of it.
 *  - `"shrink"` — the total dropped, but not by enough to qualify as a reset.
 *    `increment` is the (non-positive) difference — genuinely not growth.
 *
 * **Why the discrimination is load-bearing, not stylistic:** on a real
 * 30-day, 66,475-request window, 84 rows were `"session-start"` and 102 were
 * `"post-reset"` — 186 rows that an UNDISCRIMINATED helper would hand to a
 * consumer filtering only "increment > 0" alongside the 79 genuine `"growth"`
 * rows above the 20K context-bloat threshold. That is a 3.4× inflation on top
 * of the intended 79 turns and inverts the entire premise of the context-bloat
 * rewrite (context-carry-cost plan.md §3, IMPLEMENTATION.md D9). Neither
 * consumer may ever receive a bare `increment`:
 *  - `context-bloat` (B3) MUST filter to `kind === "growth"` only.
 *  - `contextCarry`'s distinct-content denominator (B2) sums
 *    `"growth" + "session-start" + "post-reset"` increments (D8), excluding
 *    `"shrink"`.
 */
export interface ContextIncrement {
  row: HygieneMessageRow;
  /** The chain-previous row this increment is measured against. `null` for
   *  `kind === "session-start"` (there is nothing to measure against). */
  prev: HygieneMessageRow | null;
  increment: number;
  kind: "growth" | "session-start" | "post-reset" | "shrink";
}

/**
 * Per-session, timestamp-ordered context increments over `rows`, discriminated
 * by kind (see `ContextIncrement`'s doc — read it before consuming this
 * result). Null-timestamp rows are excluded (never yielded) and break the
 * chain rather than bridging across it, matching `reEntryBurn.ts`'s
 * convention.
 *
 * Uses the FLOORLESS drop rule for `"post-reset"` classification — no
 * `minBeforeTokens` gate. This is deliberately different from `detectResets`'
 * floored rule below; see that function's doc for why the two must not be
 * unified.
 */
export function contextIncrements(rows: readonly HygieneMessageRow[]): ContextIncrement[] {
  const out: ContextIncrement[] = [];
  for (const step of walkSessionChains(rows)) {
    if (step.prev === null || step.prevTotal === null) {
      out.push({ row: step.row, prev: null, increment: step.curTotal, kind: "session-start" });
      continue;
    }
    const diff = step.curTotal - step.prevTotal;
    if (diff > 0) {
      out.push({ row: step.row, prev: step.prev, increment: diff, kind: "growth" });
    } else if (step.curTotal < step.prevTotal * (1 - DEFAULT_DROP_RATIO)) {
      out.push({ row: step.row, prev: step.prev, increment: step.curTotal, kind: "post-reset" });
    } else {
      out.push({ row: step.row, prev: step.prev, increment: diff, kind: "shrink" });
    }
  }
  return out;
}

/** One detected reset — a drop in context large enough, from a large enough
 *  starting point, to be a `/compact` or auto-compaction rather than ordinary
 *  turn-to-turn variation. `beforeRow`/`afterRow` are the two chain-adjacent
 *  messages the drop was measured between (never across a null-timestamp
 *  break — see `walkSessionChains`). */
export interface ContextResetEvent {
  sessionId: string;
  /** Last message of the ending cycle. */
  beforeRow: HygieneMessageRow;
  /** First message of the new cycle. */
  afterRow: HygieneMessageRow;
  beforeTokens: number;
  afterTokens: number;
}

export interface DetectResetsOptions {
  /** Drop fraction: a reset fires when `afterTokens < (1 - dropRatio) ×
   *  beforeTokens`. Default 0.4 (a >40% drop). */
  dropRatio?: number;
  /** `beforeTokens` must exceed this before a drop counts as a reset at all —
   *  the FLOOR that `contextIncrements`' `"post-reset"` classification does
   *  NOT apply (see that function's doc). Default 150,000. */
  minBeforeTokens?: number;
}

/**
 * Detect context resets (`/compact`, auto-compaction, or anything else that
 * produces the same signature — this is inference from token counts, not an
 * event log) per session, timestamp-ordered. This is the FLOORED sibling of
 * `contextIncrements`' `"post-reset"` rule: it requires `beforeTokens >
 * minBeforeTokens` before a drop counts, so a small session's ordinary
 * turn-to-turn shrink is never reported as a reset event/ledger entry or fed
 * into the sawtooth statistics.
 *
 * The floorless rule inside `contextIncrements` and this floored rule are
 * DELIBERATELY different (context-carry-cost A1 item 4 / plan.md §12): the
 * distinct-content denominator (B2's `distinctTokensEstimate`) wants every
 * qualifying drop counted, however small the starting point, because the
 * post-drop baseline is still content this tool cannot prove is a restatement
 * (D8); the resets ledger and the sawtooth (`ContextCarryResult.resets`/
 * `.sawtooth`) want only resets big enough to be a real compaction event, not
 * noise. On a real 30-day window the two rules' denominators differed by
 * 0.3% — immaterial, but the two answer different questions and must stay
 * distinguishable rather than collapsed into one function with one floor.
 *
 * Null-timestamp rows are excluded and break the chain (never bridged),
 * matching `reEntryBurn.ts`'s convention.
 */
export function detectResets(rows: readonly HygieneMessageRow[], options?: DetectResetsOptions): ContextResetEvent[] {
  const dropRatio = options?.dropRatio ?? DEFAULT_DROP_RATIO;
  const minBeforeTokens = options?.minBeforeTokens ?? DEFAULT_RESET_MIN_BEFORE_TOKENS;
  const out: ContextResetEvent[] = [];
  for (const step of walkSessionChains(rows)) {
    if (step.prev === null || step.prevTotal === null) continue;
    if (!(step.prevTotal > minBeforeTokens)) continue;
    if (step.curTotal < step.prevTotal * (1 - dropRatio)) {
      out.push({
        sessionId: step.sessionId,
        beforeRow: step.prev,
        afterRow: step.row,
        beforeTokens: step.prevTotal,
        afterTokens: step.curTotal,
      });
    }
  }
  return out;
}

/** The total context of a session's FIRST stored message — Phase 3's prelude
 *  input (context-carry-cost §6/D6). `null` only when `group` has no
 *  messages (should not occur for a group `groupBySession` produced from a
 *  non-empty row array, but a caller building `group` some other way gets an
 *  honest `null` rather than a thrown error or a fabricated `0`). Deliberately
 *  the group's first row regardless of whether IT carries a valid timestamp —
 *  `totalContext` needs only the token columns, and a null-timestamp first
 *  message still really was the first thing sent. */
export function firstRequestContext(group: SessionGroup): number | null {
  const first = group.messages[0];
  return first === undefined ? null : totalContext(first);
}

/**
 * Which cache TTL a window's messages were actually recorded at, from the two
 * ephemeral columns — the ground truth `ttlFit.ts` and the hygiene detectors
 * both key their defaults and their "is this figure a real measurement or a
 * counterfactual" labeling on (cache-ttl-fit A2/D2/§4.5).
 *
 * Rule: any 1h tokens and no 5m tokens anywhere in `rows` → `"1h"`; any 5m and
 * no 1h → `"5m"`; both present → `"mixed"`; neither (every row's split is
 * `0`/`0` — pre-column schema, or truly empty) → `"unknown"`.
 */
export function observedTtlOf(rows: readonly HygieneMessageRow[]): "1h" | "5m" | "mixed" | "unknown" {
  let has5m = false;
  let has1h = false;
  for (const row of rows) {
    if (row.ephemeral5mCacheTokens > 0) has5m = true;
    if (row.ephemeral1hCacheTokens > 0) has1h = true;
    if (has5m && has1h) break;
  }
  if (has5m && has1h) return "mixed";
  if (has1h) return "1h";
  if (has5m) return "5m";
  return "unknown";
}

/**
 * Group a token count with thousands separators, LOCALE-INDEPENDENTLY.
 *
 * Every `rule` / `threshold` / `detail` string in this module is an English
 * source string (see `types.ts`'s LOCALIZATION note) — nothing translates them,
 * and they ship verbatim in the `get_efficiency_hints` MCP payload and in the
 * justification pack. A bare `toLocaleString()` formats them in the HOST's
 * locale, so on a de-DE machine `30174` renders as `30.174`, which an English
 * reader (or a consuming agent) reads as thirty-point-one-seven-four — a
 * 1000× misreading of a figure that is supposed to be checkable.
 *
 * Caught by actually running the detector rather than by a test: the repo has
 * already taken one CI failure from host-locale-formatted numbers reaching an
 * assertion, and this is the same class of defect one layer further out.
 */
export function groupNum(n: number): string {
  return n.toLocaleString("en-US");
}
