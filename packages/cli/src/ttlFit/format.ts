/**
 * Rendering for `claude-stats ttl-fit` — turns a `TtlFitResult` into
 * localized, human-readable lines. Pure formatting: no store, no clock, no
 * process I/O beyond the `NodeJS.WritableStream` handed to `printTtlFit`.
 *
 * Deliberately separate from `packages/cli/src/cli/index.ts`: that directory
 * is excluded from coverage instrumentation (IMPLEMENTATION.md §7/§3-C1), so
 * any rendering logic living there would be unverifiable. This module is
 * instrumented, and the command body that calls it stays a thin shell.
 *
 * Honesty rules enforced here (IMPLEMENTATION.md §3-C1, spec §5.3):
 *  - Never print a verdict line without the margin beside it — `windowCost`,
 *    the recovered-read/write/write-1h totals, the dominant model's
 *    `breakEvenRatio`, and the near-boundary band are always rendered before
 *    any verdict.
 *  - `observedTtl === "unknown"` or `recommendation.verdict ===
 *    "insufficient-data"` prints NOTHING verdict-like — it states what is
 *    missing instead (never a guessed `prefer-*`).
 *  - `recommendation.reason` is an English source string (deliberate
 *    localization deferral — `hygiene/types.ts`'s convention, carried into
 *    `ttlFit.ts`). It is never printed here; every sentence below is built
 *    from the typed fields through `t()` so it can be translated.
 *  - A verdict naming a TTL the window was not actually recorded at
 *    (`isProjection`) is labelled a projection, never presented with the same
 *    confidence as a same-TTL measurement.
 */
import type { TtlFitResult, TtlFitOriginRow } from "@claude-stats/core/ttlFit";
import { formatCost } from "@claude-stats/core/pricing";
import { formatCount, formatPercent } from "@claude-stats/core/insight";

/** Minimal translator shape — matches `../i18n.js`'s exported `t()` exactly,
 *  so this module neither imports i18next's own `TFunction` typing nor the
 *  CLI's global i18n singleton. Passed in explicitly so every rendering path
 *  here is testable against a fixture translator with no i18n bootstrap. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

const MINUTE_MS = 60_000;

function originLabel(t: Translate, origin: TtlFitOriginRow["origin"]): string {
  switch (origin) {
    case "session-start":
      return t("cli:ttlFit.originSessionStart");
    case "mid-work":
      return t("cli:ttlFit.originMidWork");
    case "resume-short":
      return t("cli:ttlFit.originResumeShort");
    case "resume-long":
      return t("cli:ttlFit.originResumeLong");
  }
}

function observedTtlLabel(t: Translate, observedTtl: TtlFitResult["observedTtl"]): string {
  switch (observedTtl) {
    case "1h":
      return t("cli:ttlFit.observedTtl1h");
    case "5m":
      return t("cli:ttlFit.observedTtl5m");
    case "mixed":
      return t("cli:ttlFit.observedTtlMixed");
    case "unknown":
      return t("cli:ttlFit.observedTtlUnknown");
  }
}

/** Short "1-hour"/"5-minute" token for interpolation into a sentence (as
 *  opposed to `observedTtlLabel`'s whole standalone sentence). Only ever
 *  called for `"1h"`/`"5m"` — `isProjection` never returns `true` for
 *  `"mixed"`/`"unknown"`, since neither carries a single TTL to name. */
function ttlShortLabel(t: Translate, observedTtl: "1h" | "5m"): string {
  return observedTtl === "1h" ? t("cli:ttlFit.ttlShort1h") : t("cli:ttlFit.ttlShort5m");
}

/**
 * True when the recommended verdict names a TTL this window was NOT actually
 * recorded at — a counterfactual projection, not a same-TTL measurement (see
 * `TtlFitResult.observedTtl`'s doc in `@claude-stats/core/ttlFit`). Never true
 * for `too-close-to-call` or `insufficient-data`, neither of which names a TTL
 * to switch to.
 */
export function isProjection(result: Pick<TtlFitResult, "observedTtl" | "recommendation">): boolean {
  const { observedTtl, recommendation } = result;
  if (recommendation.verdict === "prefer-5m") return observedTtl === "1h";
  if (recommendation.verdict === "prefer-1h") return observedTtl === "5m";
  return false;
}

function ratioLabel(ratio: number | null): string {
  return ratio !== null && Number.isFinite(ratio) ? ratio.toFixed(3) : "—";
}

/** Render one `TtlFitResult` as plain-text lines, localized through `t`. */
export function formatTtlFitLines(result: TtlFitResult, t: Translate): string[] {
  const lines: string[] = [];
  const push = (s: string): void => {
    lines.push(s);
  };

  push(t("cli:ttlFit.title"));
  push("");

  push(t("cli:ttlFit.gapHistogramTitle"));
  for (const bucket of result.gapHistogram) {
    push(
      "  " +
        t("cli:ttlFit.gapHistogramRow", {
          label: bucket.label,
          requests: formatCount(bucket.requests),
          readTokens: formatCount(bucket.readTokens),
          creationTokens: formatCount(bucket.creationTokens),
          pctRebuilt: formatPercent(bucket.pctRebuilt),
        }),
    );
  }
  push("");

  push(t("cli:ttlFit.originTitle"));
  for (const row of result.writesByOrigin) {
    push(
      "  " +
        t("cli:ttlFit.originRow", {
          origin: originLabel(t, row.origin),
          creationTokens: formatCount(row.creationTokens),
          share: formatPercent(row.share),
        }),
    );
  }
  push("");

  push(t("cli:ttlFit.modelTableTitle"));
  if (result.byModel.length === 0) {
    push("  " + t("cli:ttlFit.modelTableEmpty"));
  } else {
    for (const row of result.byModel) {
      if (row.netCostOfShortTtl === null) {
        // D10 guard: this model's pricing half is null (synthesized or
        // incoherent rate). Its token volume is real and already shown above
        // in the gap histogram / origin table; only the dollar figures are
        // withheld here.
        push(
          "  " +
            t("cli:ttlFit.modelRowUnpriced", {
              model: row.model,
              writeTokens: formatCount(row.writeTokens),
            }),
        );
      } else {
        push(
          "  " +
            t("cli:ttlFit.modelRow", {
              model: row.model,
              recoveredReadTokens: formatCount(row.recoveredReadTokens),
              writeTokens: formatCount(row.writeTokens),
              writeTokens1h: formatCount(row.writeTokens1h),
              extra: formatCost(row.extraCostAtShortTtl!),
              saved: formatCost(row.savedOnWritesAtShortTtl!),
              net: formatCost(row.netCostOfShortTtl),
              breakEvenRatio: ratioLabel(row.breakEvenRatio),
            }),
        );
      }
    }
  }
  if (result.unpricedRows > 0) {
    push(
      "  " +
        t("cli:ttlFit.unpricedNote", {
          unpricedRows: formatCount(result.unpricedRows),
          unpricedWriteTokens: formatCount(result.unpricedWriteTokens),
        }),
    );
  }
  push("");

  push(observedTtlLabel(t, result.observedTtl));
  push("");

  // The margin — ALWAYS rendered before any verdict-like line below, per
  // spec §5.3 ("no verdict without the margin"). Printed unconditionally,
  // including on insufficient-data, so a reader always has the numbers a
  // verdict (or its absence) rests on.
  const dominant = result.byModel[0];
  push(
    t("cli:ttlFit.marginLine", {
      windowCost: formatCost(result.windowCost),
      recoveredReadTokens: formatCount(result.totals.recoveredReadTokens),
      writeTokens: formatCount(result.totals.writeTokens),
      writeTokens1h: formatCount(result.totals.writeTokens1h),
      breakEvenRatio: dominant !== undefined ? ratioLabel(dominant.breakEvenRatio) : "—",
    }),
  );
  push(
    t("cli:ttlFit.nearBoundaryLine", {
      requests: formatCount(result.nearBoundary.requests),
      readTokens: formatCount(result.nearBoundary.readTokens),
      windowMinutes: (result.nearBoundary.windowMs / MINUTE_MS).toFixed(1),
      impliedSwing: formatCost(result.nearBoundary.impliedSwing),
    }),
  );
  push("");

  const { verdict } = result.recommendation;
  if (verdict === "insufficient-data") {
    // Never print anything verdict-like here — say what's missing instead.
    push(
      result.observedTtl === "unknown"
        ? t("cli:ttlFit.noTtlColumns")
        : t("cli:ttlFit.insufficientData", {
            windowCost: formatCost(result.windowCost),
            writeTokens: formatCount(result.totals.writeTokens),
            writeTokens1h: formatCount(result.totals.writeTokens1h),
            excludedRows: formatCount(result.excludedRows),
            unpricedRows: formatCount(result.unpricedRows),
          }),
    );
    return lines;
  }

  const net = result.totals.netCostOfShortTtl;
  const amount = net === null ? "—" : formatCost(Math.abs(net));
  if (verdict === "too-close-to-call") {
    push(t("cli:ttlFit.verdictTooClose", { amount }));
  } else if (verdict === "prefer-5m") {
    push(t("cli:ttlFit.verdictPrefer5m", { amount }));
  } else {
    push(t("cli:ttlFit.verdictPrefer1h", { amount }));
  }
  if (isProjection(result)) {
    // Safe cast: `isProjection` only returns `true` when `observedTtl` is
    // exactly the single TTL opposite the recommended one — never `"mixed"`
    // or `"unknown"`.
    push(t("cli:ttlFit.verdictProjection", { ttl: ttlShortLabel(t, result.observedTtl as "1h" | "5m") }));
  }

  return lines;
}

/** Render (or JSON-dump) one `TtlFitResult` to a stream. */
export function printTtlFit(
  result: TtlFitResult,
  out: NodeJS.WritableStream,
  t: Translate,
  opts: { json?: boolean } = {},
): void {
  if (opts.json) {
    out.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  for (const line of formatTtlFitLines(result, t)) out.write(line + "\n");
}
