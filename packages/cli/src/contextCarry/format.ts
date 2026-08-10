/**
 * Rendering for `claude-stats context` — turns a `ContextCarryResult` into
 * localized, human-readable lines. Pure formatting: no store, no clock, no
 * process I/O beyond the `NodeJS.WritableStream` handed to `printContextCarry`.
 *
 * Deliberately separate from `packages/cli/src/cli/index.ts`: that directory
 * is excluded from coverage instrumentation (IMPLEMENTATION.md §7/§4-C1), so
 * any rendering logic living there would be unverifiable. This module is
 * instrumented, and the command body that calls it stays a thin shell.
 *
 * Honesty rules enforced here (IMPLEMENTATION.md §1 D10/D11/D12, §4-C1):
 *  - `distinctTokensEstimate`/`amplificationEstimate` are never printed as a
 *    bound ("at most"/"at least") — both are biased in both directions, and
 *    every surface here states that on the SAME line as the number.
 *  - The carried-to-new ratio is stated as "the average request carried X
 *    tokens of context to produce Y of new content" (D12), never as "every
 *    distinct token was re-sent N times" — that reads a per-token lifetime
 *    into an aggregate ratio it does not support.
 *  - `totalCarryCost` and every `aboveCap[].cost` figure are labelled a LOWER
 *    bound on the same line: priced at the cache-read rate, which is the
 *    cheapest form the cost can take, not the cost of capping (rework is not
 *    measured here).
 *  - Every `number | null` field renders as an honest "not available" rather
 *    than a guessed value or a fabricated `0`.
 *  - `sawtooth === null` (fewer than 3 resets) is stated as insufficient
 *    data, never averaged from 1 or 2 events.
 */
import type { ContextCarryResult } from "@claude-stats/core/contextCarry";
import { formatCost } from "@claude-stats/core/pricing";
import { formatCount, formatPercent } from "@claude-stats/core/insight";

/** Minimal translator shape — matches `../i18n.js`'s exported `t()` exactly,
 *  same convention as `ttlFit/format.ts#Translate`. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** How many `concentration` rows the CLI text view shows. D3 permits the CLI
 *  and local dashboard to render this array (unlike the MCP tool, which omits
 *  it entirely) — capped here so a window with hundreds of sessions doesn't
 *  dump an unreadable wall of session ids to a terminal. */
const CONCENTRATION_ROWS_SHOWN = 5;

/** Same null-safe ratio convention `contextCarry.ts` itself uses (review F2):
 *  `null` — never `NaN`, never a fabricated `0` — on a non-positive or
 *  non-finite denominator. */
function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/** Total requests in the window — every row falls into exactly one size
 *  band (`bandIndexFor` in `contextCarry.ts` partitions `[0, ∞)`), so summing
 *  band counts gives the request total without re-deriving it from `rows`. */
function totalRequests(result: ContextCarryResult): number {
  return result.sizeBands.reduce((sum, band) => sum + band.requests, 0);
}

function costOrDash(cost: number | null): string {
  return cost === null ? "—" : formatCost(cost);
}

/** Render one `ContextCarryResult` as plain-text lines, localized through `t`. */
export function formatContextCarryLines(result: ContextCarryResult, t: Translate): string[] {
  const lines: string[] = [];
  const push = (s: string): void => {
    lines.push(s);
  };

  push(t("cli:contextCarry.title"));
  push("");

  push(
    t("cli:contextCarry.volumeLine", {
      carriedTokens: formatCount(result.carriedTokens),
      distinctTokensEstimate: formatCount(result.distinctTokensEstimate),
    }),
  );
  // D10: the estimate above is biased in BOTH directions — stated on the same
  // screen as the number, never relegated to a footnote a reader can miss.
  push(t("cli:contextCarry.distinctCaveat"));

  const requests = totalRequests(result);
  const meanContext = ratio(result.carriedTokens, requests);
  const meanNew = ratio(result.distinctTokensEstimate, requests);
  if (meanContext !== null && meanNew !== null && result.amplificationEstimate !== null) {
    // D12: stated as an aggregate per-request average, never as "every
    // distinct token was re-sent N times" (a per-token lifetime claim this
    // ratio cannot support).
    push(
      t("cli:contextCarry.perRequestLine", {
        requests: formatCount(requests),
        meanContext: formatCount(meanContext),
        meanNew: formatCount(meanNew),
        ratio: result.amplificationEstimate.toFixed(1),
      }),
    );
  } else {
    push(t("cli:contextCarry.perRequestInsufficientData"));
  }
  push("");

  push(t("cli:contextCarry.sizeBandsTitle"));
  for (const band of result.sizeBands) {
    if (band.requests === 0) {
      push("  " + t("cli:contextCarry.sizeBandRowNoRequests", { label: band.label }));
    } else {
      push(
        "  " +
          t("cli:contextCarry.sizeBandRow", {
            label: band.label,
            requests: formatCount(band.requests),
            shareOfVolume: formatPercent(band.shareOfVolume),
            shareOfCost: formatPercent(band.shareOfCost),
            costPerRequest: costOrDash(band.costPerRequest),
          }),
      );
    }
  }
  push("");

  push(t("cli:contextCarry.aboveCapTitle"));
  if (result.aboveCap.length === 0) {
    push("  " + t("cli:contextCarry.aboveCapEmpty"));
  } else {
    for (const cap of result.aboveCap) {
      push(
        "  " +
          t("cli:contextCarry.aboveCapRow", {
            capTokens: formatCount(cap.capTokens),
            tokensAbove: formatCount(cap.tokensAbove),
            share: formatPercent(cap.share),
            cost: formatCost(cap.cost),
          }),
      );
    }
    // Never a cap figure without the rework caveat attached (spec §4.6) — one
    // caveat line covers every row above, printed unconditionally whenever any
    // row exists to attach it to.
    push(t("cli:contextCarry.aboveCapCaveat"));
  }
  push("");

  push(t("cli:contextCarry.resetsLine", { resets: formatCount(result.resets.length) }));
  if (result.sawtooth !== null) {
    push(
      t("cli:contextCarry.sawtoothLine", {
        resets: formatCount(result.resets.length),
        floorTokens: formatCount(result.sawtooth.floorTokens),
        peakTokens: formatCount(result.sawtooth.peakTokens),
        requestsPerCycle: result.sawtooth.requestsPerCycle.toFixed(1),
      }),
    );
  } else {
    // Never averaged from 1 or 2 events (spec §4.6) — say so instead.
    push(t("cli:contextCarry.sawtoothInsufficientData"));
  }
  push("");

  push(
    t("cli:contextCarry.preludeLine", {
      medianFirstRequestTokens: formatCount(result.prelude.medianFirstRequestTokens),
      sessions: formatCount(result.prelude.sessions),
      cost: formatCost(result.prelude.cost),
    }),
  );
  if (result.prelude.shareOfCarriedVolume !== null) {
    push(t("cli:contextCarry.preludeShareLine", { share: formatPercent(result.prelude.shareOfCarriedVolume) }));
  } else {
    push(t("cli:contextCarry.preludeShareUnavailable"));
  }
  push("");

  if (result.totalCarryCost !== null) {
    // Labelled a lower bound on the SAME line as the number (spec §4.6).
    push(t("cli:contextCarry.carryCostLine", { cost: formatCost(result.totalCarryCost) }));
  } else {
    push(t("cli:contextCarry.carryCostUnavailable"));
  }
  if (result.unpricedRows > 0) {
    push(
      t("cli:contextCarry.unpricedNote", {
        unpricedRows: formatCount(result.unpricedRows),
        unpricedTokens: formatCount(result.unpricedTokens),
      }),
    );
  }
  if (result.excludedRows > 0) {
    push(t("cli:contextCarry.excludedNote", { excludedRows: formatCount(result.excludedRows) }));
  }
  push("");

  // D3: the CLI/local dashboard MAY render `concentration` (session ids never
  // leave this process here); the MCP tool omits the field entirely.
  if (result.concentration.length > 0) {
    const top = result.concentration.slice(0, CONCENTRATION_ROWS_SHOWN);
    push(t("cli:contextCarry.concentrationTitle", { count: formatCount(top.length) }));
    for (const row of top) {
      push(
        "  " +
          t("cli:contextCarry.concentrationRow", {
            sessionId: row.sessionId,
            requests: formatCount(row.requests),
            meanContext: row.meanContext === null ? "—" : formatCount(row.meanContext),
            share: formatPercent(row.share),
          }),
      );
    }
  }

  return lines;
}

/** Render (or JSON-dump) one `ContextCarryResult` to a stream. */
export function printContextCarry(
  result: ContextCarryResult,
  out: NodeJS.WritableStream,
  t: Translate,
  opts: { json?: boolean } = {},
): void {
  if (opts.json) {
    out.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  for (const line of formatContextCarryLines(result, t)) out.write(line + "\n");
}
