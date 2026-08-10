/**
 * Context bloat — turns that ADD a large amount to the context, repeatedly.
 *
 * Signal (context-carry-cost plan.md §3): the thing a developer can actually
 * change is what a turn ADDS, not how big the context already was. On a
 * million-token context window a large *total* input is the ordinary case —
 * measured on a real 30-day window, the old level-based rule tripped on 72.3%
 * of requests and fired on 50% of sessions, which is a detector that says
 * "yes" and therefore says nothing. The same window has 79 turns (0.25% of
 * requests) whose context INCREMENT clears 20K, and every one of those is a
 * decision someone made this turn.
 *
 * So this detector flags the increment:
 *
 *     increment(n) = totalContext(n) − totalContext(n−1)   within a session
 *
 * via the shared, DISCRIMINATED `contextIncrements()` helper — filtered to
 * `kind === "growth"` and nothing else (context-carry-cost D9). The
 * discrimination is load-bearing, not stylistic: on that same window an
 * undiscriminated "increment > 0" filter would have handed this detector 84
 * `"session-start"` rows and 102 `"post-reset"` rows on top of the intended 79
 * — a 3.4× inflation that inverts the entire point of the rewrite. A session's
 * first request is not growth (there is nothing to have grown from), a
 * post-compaction baseline is not growth (the context just got SMALLER), and a
 * shrink is obviously not growth.
 *
 * Precision guard: `minOccurrences` (default 3) requires the pattern to repeat
 * within the session — one large read is often legitimate, a repeated pattern
 * is not. `maxOutputRatio` is GONE (context-carry-cost D1): it was a proxy for
 * "this turn did not earn its input", and against an increment it adds nothing
 * but a way to miss real findings.
 *
 * The detector id stays `context-bloat` (plan.md §3.3 — someone who suppressed
 * "the noisy context one" has not asked to be re-surprised under a new id), so
 * the `rule`/`threshold`/`detail` strings below carry the whole burden of
 * telling a reader that this finding means something different now. They are
 * written to be self-describing for exactly that reason.
 */
import type { HygieneFinding, HygieneThresholds, HygieneMessageRow } from "./types.js";
import { groupBySession, groupNum, contextIncrements, detectResets, type ContextIncrement } from "./util.js";
import { resolvePricing, type RateOverrides } from "../pricing.js";

/**
 * A tool name may be interpolated into `detail` ONLY if it matches this.
 *
 * `HygieneFinding.detail` ships VERBATIM in the `get_efficiency_hints` MCP
 * payload to a caller agent — it does not pass through `sanitizePromptText` or
 * `wrapUntrusted`, the controls this repo built for exactly that channel. The
 * value here comes off `messages.tools`, i.e. `block.name` copied out of a
 * JSONL transcript, and a third-party MCP server chooses its own tool names:
 * they arrive namespaced `mcp__<server>__<tool>` with `<server>` being whatever
 * that server's author typed. A name containing a fake closing tag followed by
 * instructions is therefore reachable, and would be read by the caller agent as
 * text the tool itself emitted.
 *
 * So: allow-list, never escape-list. Letters, digits, `_`, `.`, `-`, at most 64
 * characters — which covers every real tool name including the `mcp__…` form,
 * and admits no whitespace, no angle brackets, no quotes and no control
 * characters. On a non-match the clause is degraded to an unnamed "following a
 * tool call", never dropped silently and never sanitised-and-shipped (a
 * "cleaned" hostile name is still attacker-chosen text).
 */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** One flagged growth increment, with the carry cost it is priced at. */
interface FlaggedIncrement {
  increment: ContextIncrement;
  /** `0` for an unpriced/null model — the token volume is still reported in
   *  `detail`, but no dollar figure is guessed at (the honest-degrade
   *  convention `messageCost`/`ttlFit.ts` use). */
  carryCost: number;
}

/**
 * What one added increment costs for the rest of its context cycle.
 *
 *     carryCost = increment × remainingRequestsInCycle × cacheReadRate(model)
 *
 * This is the context-carry-cost formula (plan.md §4.3), NOT `sumCost(flagged)`
 * — the flagged turn's own bill is mostly history it did not add, so charging
 * the whole turn to this finding would over-claim by roughly an order of
 * magnitude and inflate `hygieneRatio` with it.
 *
 * `remainingRequestsInCycle` is INCLUSIVE of the adding turn (the increment is
 * measured on that turn's own context, so it is already being paid for once)
 * and runs to the next RESET, not to the end of the session: a token added just
 * before a compaction is nearly free, and a formula that ran to the session end
 * would overstate every late-cycle addition.
 *
 * It is a LOWER bound, twice over, and the `rule` string says so:
 *  - every carried token is priced at the cache-READ rate (≈0.1× input), but a
 *    carried token is re-WRITTEN at 1.25–2× on each cache-expiry boundary in
 *    its cycle;
 *  - the reset-forcing case (an addition so large it triggers auto-compaction)
 *    is priced at its near-zero remaining-requests value here, without the
 *    reset request's own cost added back. `contextCarry.ts` (a separate module,
 *    a separate surface) makes that correction for its own ranking; this
 *    detector deliberately stays on the conservative side of it rather than
 *    growing a second, subtly different pricing path.
 */
function carryCostOf(row: HygieneMessageRow, increment: number, remainingRequestsInCycle: number, overrides?: RateOverrides): number {
  if (!row.model) return 0;
  const { pricing } = resolvePricing(row.model, overrides);
  if (!pricing) return 0;
  return (increment / 1_000_000) * pricing.cacheReadPerMillion * remainingRequestsInCycle;
}

/**
 * Positions (into `messages`) at which a new context cycle begins: the
 * session's first message, plus the first message after each detected reset.
 * Ascending, because `detectResets` walks the session in order.
 *
 * Uses the shared `detectResets` with its own defaults (the FLOORED rule — see
 * `util.ts`), never a second drop rule of its own: a detector and the report
 * that prices it must not disagree about where a cycle ended. The reset knobs
 * are deliberately NOT exposed on `HygieneThresholds["contextBloat"]` — a
 * caller who could retune them here but not in `contextCarry.ts` is exactly the
 * drift that shared helper exists to prevent.
 */
function cycleStartPositions(messages: readonly HygieneMessageRow[], posOf: ReadonlyMap<HygieneMessageRow, number>): number[] {
  const starts = [0];
  for (const reset of detectResets(messages)) {
    const pos = posOf.get(reset.afterRow);
    if (pos !== undefined && pos > 0) starts.push(pos);
  }
  return starts;
}

export function detectContextBloat(
  rows: readonly HygieneMessageRow[],
  thresholds: HygieneThresholds["contextBloat"],
  overrides?: RateOverrides,
): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  for (const group of groupBySession(rows)) {
    const messages = group.messages;

    // `contextIncrements` is called on THIS SESSION'S messages, so every
    // `increment.prev` is a row from this same session — the flat `rows` array
    // arrives ordered by timestamp across ALL sessions (the store's
    // `ORDER BY m.timestamp ASC`), which means a naive `rows[i - 1]` would
    // routinely read a different session's message. Both the growth
    // classification and the tool attribution below depend on that not
    // happening.
    const flagged: FlaggedIncrement[] = [];
    const posOf = new Map<HygieneMessageRow, number>();
    messages.forEach((m, i) => posOf.set(m, i));
    const starts = cycleStartPositions(messages, posOf);

    for (const inc of contextIncrements(messages)) {
      // D9: growth ONLY. `"session-start"` and `"post-reset"` carry the row's
      // WHOLE context as their `increment` and would flood this detector;
      // `"shrink"` carries a non-positive number that an `Math.abs`-style
      // reading would flag as a large addition when it is the opposite.
      if (inc.kind !== "growth") continue;
      if (inc.increment < thresholds.minIncrementTokens) continue;
      const pos = posOf.get(inc.row);
      if (pos === undefined) continue;
      const nextStart = starts.find((s) => s > pos);
      const cycleEnd = nextStart === undefined ? messages.length - 1 : nextStart - 1;
      const remaining = cycleEnd - pos + 1;
      flagged.push({ increment: inc, carryCost: carryCostOf(inc.row, inc.increment, remaining, overrides) });
    }

    if (flagged.length < thresholds.minOccurrences) continue;

    const largest = flagged.reduce((a, b) => (b.increment.increment > a.increment.increment ? b : a));
    const estimatedWaste = flagged.reduce((n, f) => n + f.carryCost, 0);

    // Attribution: the tool call that PRODUCED an increment sits on the
    // previous message — the result only reaches the context on the next
    // request (75 of 79 measured large increments carried no tools at all on
    // the flagged row, with the responsible call on the row before). `prev` is
    // non-null for every `"growth"` increment by construction, and is always a
    // row from this same session.
    const detail = `${flagged.length} turns added ${groupNum(thresholds.minIncrementTokens)}+ tokens to context; largest ${groupNum(largest.increment.increment)}${toolClause(largest.increment.prev)}.`;

    findings.push({
      detectorId: "context-bloat",
      sessionIds: [group.sessionId],
      estimatedWaste,
      rule: "A turn's context INCREMENT — its total input (fresh plus cached) minus the previous turn's, within the same session — is at or above the threshold, on at least the threshold number of turns in that session. Only genuine growth counts: a session's first request, a post-compaction baseline, and any turn whose context shrank are all excluded. This replaces an earlier rule that flagged the turn's total input LEVEL, which fired on most requests because a large context is the ordinary case; the estimate is the increment's carry cost (the added tokens re-sent at the cache-read rate on every remaining request in the same context cycle), which is a lower bound — carried tokens are re-written at the pricier cache-write rate on each cache-expiry boundary, and that is not counted here.",
      threshold: `≥${groupNum(thresholds.minIncrementTokens)} token context INCREMENT (not total input), on ≥${thresholds.minOccurrences} turns in one session`,
      remedy: "Trim what each turn ADDS — scoped reads instead of whole-file or whole-tree loads, and summarise large tool output before it lands in context. An addition made early in a session is re-sent on every later request until the next compaction, so the earlier it lands the more it costs.",
      detail,
    });
  }
  return findings;
}

/**
 * The ", following a `X` call" clause, or a degraded/absent one.
 *
 * Three cases, all of them honest:
 *  - the previous row invoked a tool whose name passes `SAFE_TOOL_NAME` → name
 *    it (a tool NAME is allowed in `detail`; a tool ARGUMENT never is, and
 *    `messages.tools` holds only `block.name` — call arguments live in the
 *    separate `file_paths` column and never reach this module);
 *  - it invoked a tool whose name does NOT pass → say a tool call happened,
 *    without naming it (see `SAFE_TOOL_NAME`'s doc for the threat);
 *  - it invoked no tool at all → say nothing, rather than claim a tool call
 *    that did not happen.
 *
 * When the previous row invoked several tools the FIRST is named — the store
 * preserves the transcript's own block order, so this is the first call that
 * turn made. Deterministic and arbitrary in equal measure; the alternative
 * (naming all of them) makes the sentence unreadable for no extra signal.
 */
function toolClause(prev: HygieneMessageRow | null): string {
  const name = prev?.tools[0];
  if (name === undefined) return "";
  if (!SAFE_TOOL_NAME.test(name)) return ", following a tool call";
  return `, following a \`${name}\` call`;
}
