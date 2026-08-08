/**
 * API-level throttle/overload wait — built on Claude Code's own structured
 * error signals, not on inference over ordinary message gaps.
 *
 * ## Why this module exists (and what the previous attempt got wrong)
 *
 * A prior version of this module asserted "a real rate-limit rejection is
 * rejected by the API before any response is written, so it never reaches
 * the session JSONL at all", and on that premise built a heuristic: any gap
 * between consecutive messages in a floor/ceiling band was counted as
 * "quota-shaped blocked time". Replicated against a real store, that
 * heuristic reported ~1,125 hours of blocked time for an account that is
 * neither metered nor on Bedrock — it was measuring ordinary human pauses,
 * not throttling.
 *
 * The premise was false. Real session transcripts (checked directly, not
 * from memory) contain TWO distinct structured signals Claude Code itself
 * writes for an API-level error:
 *
 *  1. `type:"system", subtype:"api_error", source:"request_retry"` (or
 *     `"connection_retry"`) — one line per retry attempt, carrying
 *     `retryAttempt`, `maxRetries`, and — the load-bearing field —
 *     `retryInMs`: the client's OWN scheduled backoff before its next
 *     attempt. This was verified against real transcripts by comparing
 *     `retryInMs` on one attempt to the observed timestamp gap to the next
 *     attempt in the same retry chain (42 measurable pairs): the observed
 *     gap was NEVER shorter than the scheduled backoff (0 of 42), and
 *     exceeded it by under five seconds in 35 of 42 — the remainder being
 *     long request latency on the retried call. Summing this field is
 *     therefore a measured LOWER BOUND on the wait the client actually
 *     took, not an inference and not an over-statement: on that same
 *     corpus the scheduled sum was roughly a quarter of the observed
 *     elapsed time, so the figure errs conservatively (I1).
 *
 *  2. `type:"assistant", isApiErrorMessage:true` with a short `error` string
 *     (`"rate_limit"` | `"server_error"`) and `apiErrorStatus` (429 / 5xx) —
 *     the TERMINAL, user-visible rejection: retries exhausted, or (for every
 *     429 observed in real data) never retried at all. This line carries no
 *     wait duration — there is nothing scheduled once the client has given
 *     up — only a COUNT.
 *
 * ## Why the two are kept apart, and why 429 gets a count but no duration
 *
 * In every real transcript checked, retry-ladder entries (mechanism 1) were
 * observed **only** for 5xx (`server_error` — Anthropic-side infrastructure
 * overload, e.g. `529 Overloaded`) — never for 429 (`rate_limit`). Terminal
 * 429 rejections had zero preceding retry-ladder entries in the same
 * session: the client does not blind-retry a rate limit the way it retries a
 * transient 5xx. That makes `retryInMs` an availability-wait figure for
 * infrastructure overload, which is **not** a throttle/quota signal and must
 * never be reported as "cost of a constraint" — a 529 is Anthropic being
 * overloaded for everyone, not something an org's policy caused.
 *
 * The metric this module's callers actually want — how long a 429 rejection
 * blocked the developer — is therefore **not measurable** from this data:
 * Claude Code does not log how long a rate-limit rejection lasted, only that
 * it happened. Per I1 ("prefer abstaining to inflating"), this module reports
 * the 429 count as the honest floor and does not attach a wait duration to
 * it. The measured overload-wait figure is reported separately, explicitly
 * labelled as not policy-caused, so a reader can never mistake one for the
 * other.
 *
 * ## Account-mode scope (a second corrected premise)
 *
 * The rejected prior version also assumed this metric is exclusively a
 * Bedrock/metered phenomenon and needed to be withheld entirely from plan
 * accounts. Real data contradicts that too: both structured signals were
 * observed in a `claude-vscode` seat-plan session, not just metered/API-key
 * traffic — the retry ladder wraps every Anthropic API call the client
 * makes, regardless of billing route. `accountMode` therefore selects
 * VOCABULARY here (so a plan reader is never shown Bedrock-quota language),
 * not whether the metric renders at all; abstention is driven purely by
 * `eventCount === 0` for each half, same as every other honest-empty card in
 * this codebase.
 *
 * ## The retry ladder also carries LOCAL failures
 *
 * A third correction, found by re-checking the corpus rather than the doc:
 * a sizeable minority of retry-ladder entries carry no HTTP status at all
 * and instead set `error.isNetworkDown: true` — the developer's own
 * connection dropped. Same mechanism, same `retryInMs`, entirely different
 * cause. Folding those into a figure whose rendered caveat asserts
 * "Anthropic's own infrastructure availability" would attribute a local
 * outage to Anthropic. `summarizeApiThrottle` therefore excludes them from
 * the overload count and wait, and reports them in
 * `networkDownRetryEvents` so they are visible rather than dropped.
 *
 * Design: doc/analysis/constraint-impact/01-what-constraints-cost.md,
 * 03-measurement-mechanics.md §3.2.
 */
import type { AccountMode } from "../types/insight.js";
import type { ApiErrorEvent } from "../types.js";
import type { InsightT } from "../insight.js";
import { formatDurationHours } from "../insight.js";

export interface ApiThrottleSummary {
  /** Terminal, user-visible 429 rejections — the throttle/quota-shaped
   *  signal. Exact count; never a duration (see module doc). */
  rateLimitRejections: number;
  rateLimitSessionsAffected: number;
  /** Terminal, user-visible 5xx rejections — reported for completeness, but
   *  NOT a throttle/policy signal; excluded from any "constraint cost". */
  serverErrorRejections: number;
  /** Measured (not inferred) client-scheduled backoff wait, summed across
   *  every retry-ladder attempt — empirically a 5xx/availability figure, see
   *  module doc. Zero when no retry-ladder entries were observed. */
  measuredOverloadWaitMs: number;
  overloadRetryEvents: number;
  overloadSessionsAffected: number;
  /** Retry-ladder attempts the client itself flagged `isNetworkDown` — the
   *  DEVELOPER's own connection dropped, not Anthropic's infrastructure.
   *  Carried on the identical retry-ladder mechanism, so they must be split
   *  out here: the overload figures above are rendered with a caveat that
   *  asserts "Anthropic's own infrastructure availability", and a local
   *  outage folded into them would be a false cause — the same defect class
   *  this module was rebuilt to remove. Counted, never silently dropped, but
   *  not currently rendered — see the N-2 note on `unknownEvents` below;
   *  the same gap applies to this field. */
  networkDownRetryEvents: number;
  /** Events whose kind this module could not classify (an unrecognised
   *  status/error string) — tracked here, never silently folded into either
   *  total. N-2: this field, `rateLimitSessionsAffected`,
   *  `serverErrorRejections` and `networkDownRetryEvents` are on this summary
   *  so a caller CAN inspect them, but `formatApiThrottle` below does not
   *  read any of the four — none of them reach a rendered sentence yet. "An
   *  incomplete classification is visible" is true of this struct, not of
   *  anything a user currently sees; a caller that renders only
   *  `ApiThrottleAnswer` gets no signal that some events were unclassified. */
  unknownEvents: number;
}

const EMPTY_SUMMARY: ApiThrottleSummary = {
  rateLimitRejections: 0,
  rateLimitSessionsAffected: 0,
  serverErrorRejections: 0,
  measuredOverloadWaitMs: 0,
  overloadRetryEvents: 0,
  overloadSessionsAffected: 0,
  networkDownRetryEvents: 0,
  unknownEvents: 0,
};

/**
 * Reduce a flat list of `ApiErrorEvent`s (already period/account-scoped by
 * the caller) into the two independent totals this module renders. Pure: no
 * clock, no I/O, order-independent.
 */
export function summarizeApiThrottle(events: readonly ApiErrorEvent[]): ApiThrottleSummary {
  if (events.length === 0) return EMPTY_SUMMARY;

  let rateLimitRejections = 0;
  let serverErrorRejections = 0;
  let measuredOverloadWaitMs = 0;
  let overloadRetryEvents = 0;
  let networkDownRetryEvents = 0;
  let unknownEvents = 0;
  const rateLimitSessions = new Set<string>();
  const overloadSessions = new Set<string>();

  for (const e of events) {
    if (e.terminal) {
      if (e.kind === "rate_limit") {
        rateLimitRejections++;
        rateLimitSessions.add(e.sessionId);
      } else if (e.kind === "server_error") {
        serverErrorRejections++;
      } else {
        unknownEvents++;
      }
    } else {
      // Retry-ladder attempt. Regardless of the status it eventually
      // resolves to, the client incurred this scheduled wait, so it counts
      // toward the measured overload-wait total whenever a duration is
      // present — but see the module doc: in every real sample this was
      // exclusively a 5xx signal, so an event classified "rate_limit" or
      // "unknown" here (never observed, but not impossible) is counted
      // toward the wait total too, since the WAIT is measured independent of
      // classification — only the two REJECTION counts above depend on
      // classification being exact.
      //
      // EXCEPT when the client flagged `isNetworkDown`: that retry was the
      // developer's OWN connection dropping, carried on the identical
      // mechanism. The overload figures render a caveat asserting
      // "Anthropic's own infrastructure availability", so counting a local
      // outage there would state a cause the data contradicts. Split out,
      // not dropped.
      if (e.isNetworkDown) {
        if (e.retryInMs != null) networkDownRetryEvents++;
      } else {
        if (e.retryInMs != null) {
          measuredOverloadWaitMs += e.retryInMs;
          overloadRetryEvents++;
          overloadSessions.add(e.sessionId);
        }
        if (e.kind === "unknown") unknownEvents++;
      }
    }
  }

  return {
    rateLimitRejections,
    rateLimitSessionsAffected: rateLimitSessions.size,
    serverErrorRejections,
    measuredOverloadWaitMs,
    overloadRetryEvents,
    overloadSessionsAffected: overloadSessions.size,
    networkDownRetryEvents,
    unknownEvents,
  };
}

/** Two independent, independently-abstainable sentences — never merged into
 *  one figure, because they measure different things (a policy-adjacent
 *  rejection count vs a measured, non-policy availability wait). */
export interface ApiThrottleAnswer {
  /** Rejection-count sentence, or null when there were none this period
   *  (abstain, not "0 times" — see module doc on I1). */
  rejectionHeadline: string | null;
  rejectionCaveat: string | null;
  /** Measured-wait sentence for the separate overload signal, or null when
   *  no retry-ladder events were observed this period. */
  overloadHeadline: string | null;
  overloadCaveat: string | null;
}

/**
 * Render `summarizeApiThrottle`'s output through the shared formatters and a
 * translator — the "quote insight.ts, never compose your own wording" rule
 * every other surface in this codebase follows.
 */
export function formatApiThrottle(
  t: InsightT,
  summary: ApiThrottleSummary,
  accountMode: AccountMode,
): ApiThrottleAnswer {
  const rejectionHeadline =
    summary.rateLimitRejections > 0
      ? t("common:insight.apiThrottle.rejection.summary", { count: summary.rateLimitRejections })
      : null;
  const rejectionCaveat =
    summary.rateLimitRejections > 0
      ? t(
          accountMode === "metered"
            ? "common:insight.apiThrottle.rejection.caveatMetered"
            : "common:insight.apiThrottle.rejection.caveatPlan",
        )
      : null;

  const overloadHeadline =
    summary.overloadRetryEvents > 0
      ? t("common:insight.apiThrottle.overload.summary", {
          count: summary.overloadRetryEvents,
          time: formatDurationHours(t, summary.measuredOverloadWaitMs / 3_600_000),
        })
      : null;
  const overloadCaveat =
    summary.overloadRetryEvents > 0 ? t("common:insight.apiThrottle.overload.caveat") : null;

  return { rejectionHeadline, rejectionCaveat, overloadHeadline, overloadCaveat };
}
