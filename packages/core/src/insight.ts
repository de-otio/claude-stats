/**
 * Answer formatters — the single place a number becomes a sentence.
 *
 * The dashboard's Insights cards, the exported justification pack, the CLI
 * report header, and the MCP tools all render the same five business answers.
 * If each built its own wording, the document a developer hands to a manager
 * would drift from the screen they were both looking at a minute earlier — and
 * a report that disagrees with the tool that produced it is worse than no
 * report. So the sentence is computed once, here, and every surface renders the
 * result rather than composing its own.
 *
 * Pure by construction: no clock, no I/O, no ambient locale lookup. Time and
 * the translator are always passed in, so a pack regenerated tomorrow from the
 * same store and the same translator is byte-identical to today's — the
 * determinism the pack's credibility depends on.
 *
 * LOCALIZATION — the seam is `InsightT`, injected.
 * Every sentence, caveat and enablement line below is a `common:insight.*` key
 * resolved through a translator the CALLER supplies. It is a parameter, never a
 * module-level i18n singleton: a singleton would make these functions
 * untestable without booting i18next, bind a pure module to a stateful one, and
 * — worst — let the sentence's language depend on import order rather than on
 * the surface rendering it. The composition stays here rather than moving into
 * the renderers because the moment two surfaces compose their own sentences,
 * the pack and the dashboard are free to disagree, which is the entire failure
 * this module exists to prevent.
 *
 * Punctuation is keyed too (`insight.punctuation.*`). A sentence terminator and
 * a clause separator are prose in ja/zh ("。", "、"), not ASCII furniture, and a
 * hardcoded "." would be the same defect as a hardcoded word, just quieter.
 *
 * The guard against regression is `insight-localization.test.ts`: it drives
 * every formatter through an identity translator and fails on any English
 * residue, so a formatter added without a key cannot ship silently.
 *
 * Design: doc/analysis/gui-redesign/02 §2.2, 03 §3.4;
 *         doc/analysis/ticket-attribution/05 §5.3.
 */
import type { CalibrationEstimate, CalibrationScope } from "./calibration.js";
import type {
  AccountMode,
  Confidence,
  InsightAnswer,
  InsightQuestion,
  Reconciliation,
  ReconciliationCause,
  TicketCoverage,
} from "./types/insight.js";

/**
 * The injected translator. Structurally identical to the `t` every surface
 * already has (i18next's, the dashboard's `TranslateFn`, the CLI's `t`), so a
 * caller passes the one it holds — no adapter, no second i18n stack.
 *
 * Declared here rather than imported from `./i18n.js` deliberately: this module
 * must not depend on i18next at all, and the CONTRACT is only "key in, string
 * out". That is what lets a test pass `(key) => key` and see exactly which keys
 * a formatter used.
 */
export type InsightT = (key: string, options?: Record<string, unknown>) => string;

/**
 * Interpolate `values` into `key` normally, but splice `literals` in AFTER
 * translation, so caller-supplied text is never itself read as a template.
 *
 * Why this exists. i18next's interpolator rescans the string it is building, so
 * a value containing `{{…}}` gets substituted in turn. Before localization the
 * answer sentences were built with template literals, where that was
 * impossible; routing a recommendation title or a plan verdict through `t()`
 * quietly made it possible. Observed, not theorised: a lead titled
 * `"{{count}} injected"` rendered as
 *
 *     "1 injected — x (+{{count}} more)."
 *
 * — the caller's text absorbed the recommendation count, and the count's own
 * slot was left raw on the card. A silently mangled sentence on the default tab
 * is exactly the I1 failure ("a confident number that is quietly wrong"), so
 * caller text is kept out of the template pass entirely rather than trusted.
 *
 * The slot marker is U+0000, which cannot occur in a locale file, in any
 * formatter's output, or in a `{{...}}` placeholder name — so a marker can
 * never collide with real content, and a caller's own text cannot forge one.
 */
const SLOT = "\u0000";

function tLiteral(
  t: InsightT,
  key: string,
  values: Record<string, unknown>,
  literals: Record<string, string>,
): string {
  const slots: string[] = [];
  const withSlots: Record<string, unknown> = { ...values };
  for (const [name, text] of Object.entries(literals)) {
    withSlots[name] = `${SLOT}${slots.length}${SLOT}`;
    // Strip any U+0000 the caller's own string carries, so it cannot forge a
    // slot marker and displace another value. Costs nothing on real input —
    // no legitimate title, verdict or ticket key contains a NUL.
    slots.push(text.split(SLOT).join(""));
  }
  return t(key, withSlots).replace(
    new RegExp(`${SLOT}(\\d+)${SLOT}`, "g"),
    (_m, i: string) => slots[Number(i)] ?? "",
  );
}

/** Wrap composed clauses as one sentence — the terminator is a locale's, not
 *  ASCII's. `text` is always already-composed content (often caller-supplied),
 *  so it goes in as a literal. */
function sentence(t: InsightT, text: string): string {
  return tLiteral(t, "common:insight.punctuation.sentence", {}, { text });
}

// ─── Primitives ───────────────────────────────────────────────────────────────

/** Fixed-locale money formatting. Deliberately not `toLocaleString` with a
 *  runtime locale — the pack must not change shape with the machine it ran on.
 *
 *  `opts.precise` keeps two decimal places regardless of magnitude, for
 *  surfaces read closely rather than glanced at (the justification pack's
 *  per-ticket table, its CSV export). Default (`precise` unset/false) is the
 *  glanceable form: whole dollars once the amount reaches 100. Both branches
 *  route through this one function so no surface can silently diverge on
 *  what a given number of cents renders as (I-1). */
export function formatMoney(amount: number, currency = "USD", opts: { precise?: boolean } = {}): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `;
  // I-6: a positive amount that rounds to "0.00" at 2 decimals is real, priced
  // spend, not nothing — stating it as an exact zero is more confident than
  // the basis supports. Every `formatMoney` call site gets this for free
  // rather than each surface needing to remember to special-case it.
  if (amount > 0 && amount < 0.005) return `<${symbol}0.01`;
  const rounded = opts.precise
    ? amount.toFixed(2)
    : Math.abs(amount) >= 100
      ? Math.round(amount).toString()
      : amount.toFixed(2);
  const withSeparators = rounded.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${symbol}${withSeparators}`;
}

/**
 * CSV-cell money: a plain decimal string (no symbol, no thousands separator)
 * so ordinary amounts stay numeric-parseable in a spreadsheet — but, same
 * honesty rule as `formatMoney` (I-6), a positive amount never collapses to
 * a bare "0.00". Real generated output once emitted
 * `unclassified,2026-01,0.00,1` for a session with genuine priced tokens;
 * this widens the precision just far enough to show the amount is non-zero,
 * rather than lying by omission the way a plain `toFixed(2)` does.
 */
export function formatMoneyCsv(amount: number): string {
  if (amount > 0 && amount < 0.005) {
    for (let decimals = 3; decimals <= 6; decimals++) {
      const s = amount.toFixed(decimals);
      if (Number(s) > 0) return s;
    }
    return amount.toFixed(6);
  }
  return amount.toFixed(2);
}

/** Percentage; null renders as an em dash, never as "0%". `decimals` defaults
 *  to 0 (glanceable); the pack passes 1 for its closer-read tables — still
 *  the same rounding/em-dash rule, so it can never format "0%" for a null
 *  ratio the way a hand-rolled percent formatter could. */
export function formatPercent(ratio: number | null, decimals = 0): string {
  if (ratio === null || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(decimals)}%`;
}

/**
 * Render a duration given in hours as dev-minutes/hours/days, whichever reads
 * most naturally at that magnitude. Split out of `formatDevTime` so a caller
 * that already has elapsed hours (no cost, no rate — e.g. a measured blocked
 * wait time) renders through the exact same three branches rather than a
 * second hand-rolled formatter that could drift from this one (I-1).
 *
 * The NUMBER is fixed-locale (same reason as `formatMoney`); only the unit is
 * translated, because "dev-hours" is a word.
 */
export function formatDurationHours(t: InsightT, hours: number): string {
  if (hours < 1) return t("common:insight.devTime.minutes", { value: Math.round(hours * 60) });
  if (hours < 8) return t("common:insight.devTime.hours", { value: hours.toFixed(1) });
  return t("common:insight.devTime.days", { value: (hours / 8).toFixed(1) });
}

/**
 * Express a cost as developer time. The lever that turns a token bill into a
 * number a manager already has intuitions about — a month of heavy usage is
 * typically a low single-digit percentage of one salary.
 */
export function formatDevTime(t: InsightT, cost: number, hourlyRate: number): string {
  if (hourlyRate <= 0) return "—";
  return formatDurationHours(t, cost / hourlyRate);
}

/** Direction of travel vs the previous comparable period. */
export function trendOf(current: number, previous: number | null, epsilon = 0.02): InsightAnswer["trend"] {
  if (previous === null || !Number.isFinite(previous) || previous === 0) return "unknown";
  const delta = (current - previous) / Math.abs(previous);
  if (delta > epsilon) return "up";
  if (delta < -epsilon) return "down";
  return "flat";
}

// ─── Caveats (the honesty obligations) ────────────────────────────────────────

/**
 * The cost vocabulary a *report* speaks, as opposed to the mode a single
 * account is billed under (`AccountMode`).
 *
 * A dashboard can span several accounts, and they need not agree: a plan seat
 * for interactive work beside a metered API/Bedrock account for automation is
 * an ordinary setup, not a pathology. When they disagree there is no single
 * correct vocabulary for the combined figure — "$312, equivalent API value" is
 * wrong for the metered half and "$312, actual metered cost" is wrong for the
 * plan half. `mixed` is the honest third answer: report the sum, and say the
 * sum means two different things (I1 — a confident number that is quietly
 * wrong is worse than a number that states its own limits).
 *
 * Deliberately NOT folded into `AccountMode`: an *account* is never mixed, and
 * `resolveAccountMode()` in the CLI's config must keep returning a value that
 * can be stored as a per-account billing fact.
 */
export type CostVocabulary = AccountMode | "mixed";

/**
 * The caveat chip is load-bearing, not decoration: it is where the confidence
 * mix, the calibration state, and the estimate-vs-actual distinction live. A
 * figure rendered without its caveat is a figure that has quietly dropped the
 * thing that makes it defensible.
 */
export function costCaveat(
  t: InsightT,
  mode: CostVocabulary,
  opts: {
    reconciledRatio?: number | null;
    /**
     * Whether the reconciliation above fell within the configured tolerance.
     * REQUIRED whenever `reconciledRatio` is set — without it this function
     * cannot tell "reconciles" from "does not reconcile" and would have to
     * guess, which is exactly the silent-wrong-number failure I1 forbids.
     * `costCaveat` previously read ANY ratio as an affirmative "reconciles
     * with the invoice at X%", including a residual nowhere near tolerance;
     * that bug is why this field exists rather than a bare boolean derived
     * from the ratio here.
     */
    reconciledWithinTolerance?: boolean;
    anyFallbackRates?: boolean;
  } = {},
): string {
  if (mode === "plan") return t("common:insight.caveat.plan");
  if (mode === "mixed") return t("common:insight.caveat.mixed");

  // The metered branch has several independent qualifiers. Each outcome is
  // its own COMPLETE sentence key rather than fragments joined with "; " and
  // run through a capitalizer: a translator handed "some usage priced at…"
  // cannot know whether it will land sentence-initial, and the capitalize()
  // this replaces was an English typographic rule applied blind to ten
  // languages (a no-op in ja/zh, wrong for a Slavic clause that must inflect
  // differently in each position).
  const reconciled = opts.reconciledRatio != null && Number.isFinite(opts.reconciledRatio);
  const ratio = reconciled ? formatPercent(opts.reconciledRatio!) : "";
  if (reconciled && opts.reconciledWithinTolerance === false) {
    return opts.anyFallbackRates
      ? t("common:insight.caveat.notReconciledAndFallback", { ratio })
      : t("common:insight.caveat.notReconciled", { ratio });
  }
  if (reconciled && opts.reconciledWithinTolerance === true) {
    return opts.anyFallbackRates
      ? t("common:insight.caveat.reconciledAndFallback", { ratio })
      : t("common:insight.caveat.reconciled", { ratio });
  }
  if (opts.anyFallbackRates) return t("common:insight.caveat.fallbackRates");
  return t("common:insight.caveat.metered");
}

// ─── Invoice reconciliation, in full ──────────────────────────────────────────

/** One labelled figure in the reconciliation panel. */
export interface ReconciliationLine {
  /** Stable, unlocalized id — what a test or a CSV column keys on. */
  readonly id: "bottomUp" | "invoiceTotal" | "residual" | "tolerance";
  readonly label: string;
  readonly value: string;
}

/**
 * Everything a surface needs to render a reconciliation, already localized and
 * already formatted. No surface composes any of it.
 */
export interface ReconciliationDetail {
  /** "Reconciles / does not reconcile", as a complete sentence. */
  readonly verdict: string;
  /** The four figures, in reading order. */
  readonly lines: readonly ReconciliationLine[];
  /** Heading for the cause list; null when there is nothing to explain. */
  readonly causesLabel: string | null;
  /** Named candidate causes, localized. Empty when within tolerance. */
  readonly causes: readonly string[];
  /** What the invoice covers — the user's own note, or the sentence saying it
   *  was never stated. Never null: an unstated scope is itself information. */
  readonly scope: string;
}

const RECONCILIATION_CAUSE_KEY: Readonly<Record<ReconciliationCause, string>> = {
  "unpriced-usage": "common:insight.reconciliation.cause.unpricedUsage",
  "fallback-rates": "common:insight.reconciliation.cause.fallbackRates",
  "scope-mismatch": "common:insight.reconciliation.cause.scopeMismatch",
  unexplained: "common:insight.reconciliation.cause.unexplained",
};

/**
 * Expand a {@link Reconciliation} into the panel a surface renders.
 *
 * This exists because the dashboard PROMISED it and did not have it. The
 * `reconciliation-drift` alert tells the reader, in ten languages, to "see the
 * cost card's caveat for the residual and its candidate causes" — and the caveat
 * `costCaveat` produces carries only the ratio. The residual, the invoice total,
 * the tolerance band and the named causes were computed by
 * `computeReconciliation`, stored on `DashboardData`, and rendered nowhere. An
 * alert that points at a caveat that does not exist is worse than no alert: it
 * spends the reader's trust and then sends them looking for something that was
 * never there.
 *
 * The residual is rendered as a MAGNITUDE plus a direction sentence rather than
 * a signed number. `residual = invoiceTotal - bottomUp`, so the sign encodes
 * which side is higher — and "$-49.40" makes the reader do that decoding, on the
 * one figure in the panel that decides whether the estimate is under- or
 * over-counting. The two directions are two different findings and they read as
 * two different sentences.
 */
export function reconciliationDetail(
  t: InsightT,
  rec: Reconciliation,
  currency = "USD",
): ReconciliationDetail {
  const money = (n: number) => formatMoney(n, currency, { precise: true });
  const residualIsInvoiceHigher = rec.residual >= 0;

  const lines: ReconciliationLine[] = [
    {
      id: "bottomUp",
      label: t("common:insight.reconciliation.label.bottomUp"),
      value: money(rec.bottomUp),
    },
    {
      id: "invoiceTotal",
      label: t("common:insight.reconciliation.label.invoiceTotal"),
      value: money(rec.invoiceTotal),
    },
    {
      id: "residual",
      label: t("common:insight.reconciliation.label.residual"),
      value: t(
        residualIsInvoiceHigher
          ? "common:insight.reconciliation.residualInvoiceHigher"
          : "common:insight.reconciliation.residualLocalHigher",
        {
          // Magnitudes: the direction is in the sentence, so a minus sign here
          // would state it twice and contradict itself half the time.
          money: money(Math.abs(rec.residual)),
          percent: formatPercent(Math.abs(rec.residualRatio)),
        },
      ),
    },
    {
      id: "tolerance",
      label: t("common:insight.reconciliation.label.tolerance"),
      value: t("common:insight.reconciliation.toleranceBand", {
        percent: rec.tolerancePercent,
      }),
    },
  ];

  return {
    verdict: t(
      rec.withinTolerance
        ? "common:insight.reconciliation.verdict.within"
        : "common:insight.reconciliation.verdict.outside",
      { ratio: formatPercent(rec.ratio) },
    ),
    lines,
    // Gated on the cause list rather than on `withinTolerance`, so the label
    // cannot outlive the list it heads: `computeReconciliation` leaves
    // `candidateCauses` empty exactly when there is nothing to explain, and a
    // heading over an empty list would read as a finding that was withheld.
    causesLabel:
      rec.candidateCauses.length > 0 ? t("common:insight.reconciliation.causesLabel") : null,
    causes: rec.candidateCauses.map((c) => t(RECONCILIATION_CAUSE_KEY[c])),
    scope: rec.scopeNote
      ? tLiteral(t, "common:insight.reconciliation.scopeStated", {}, { note: rec.scopeNote })
      : t("common:insight.reconciliation.scopeUnstated"),
  };
}

/**
 * Confidence-tier summary, e.g. "72% high · 21% medium · 7% low confidence".
 *
 * When there IS spend in the window but NONE of it attributed (0% coverage),
 * a bare zero is a silent-wrong-number risk (I1): it reads identically
 * whether ticket attribution is unconfigured, misconfigured (e.g. a
 * lowercase branch convention outside the case-sensitive-without-allowlist
 * default — see `scanKeys` in `attribution.ts`), or genuinely has no
 * ticket-linked work this period. Surface the enablement path instead of
 * returning null, so the caller never renders "0%" with no explanation.
 * `totalCost <= 0` (no spend at all) stays null — there's nothing to enable.
 */
export function confidenceCaveat(t: InsightT, coverage: TicketCoverage): string | null {
  if (coverage.attributedCost <= 0) {
    return coverage.totalCost > 0 ? t("common:insight.coverage.none") : null;
  }
  const order: Confidence[] = ["high", "medium", "low"];
  const parts = order
    .filter((c) => (coverage.byConfidence[c] ?? 0) > 0)
    .map((c) =>
      t("common:insight.coverage.tier", {
        percent: formatPercent((coverage.byConfidence[c] ?? 0) / coverage.attributedCost),
        tier: t(`common:insight.confidence.${c}`),
      }),
    );
  if (parts.length === 0) return null;
  const joined = parts.join(t("common:insight.punctuation.dotJoin"));
  return coverage.ambiguousSessions > 0
    ? t("common:insight.coverage.mixAmbiguous", { parts: joined, count: coverage.ambiguousSessions })
    : t("common:insight.coverage.mix", { parts: joined });
}

// ─── Calibration (the "is this confidence tier earned?" obligation) ───────────
//
// Keys are held in explicit records rather than built with a template literal.
// A closed union interpolated into a key string is greppable to a reader but not
// to `grep`, and a subject added without its sentences would then fail at
// runtime in one language rather than at review.

const CALIBRATION_MEASURED_KEY: Readonly<Record<CalibrationEstimate["subject"], string>> = {
  attribution: "common:insight.calibration.measured.attribution",
  outcome: "common:insight.calibration.measured.outcome",
};

const CALIBRATION_UNCALIBRATED_KEY: Readonly<Record<CalibrationEstimate["subject"], string>> = {
  attribution: "common:insight.calibration.uncalibrated.attribution",
  outcome: "common:insight.calibration.uncalibrated.outcome",
};

const CALIBRATION_ENABLEMENT_KEY: Readonly<Record<CalibrationEstimate["subject"], string>> = {
  attribution: "common:insight.calibration.enablement.attribution",
  outcome: "common:insight.calibration.enablement.outcome",
};

/**
 * The window clause, one complete sentence per scope.
 *
 * Whole records rather than a key built from the union member for the same
 * reason as the three above: a scope added without its sentence must fail at
 * review, not at runtime in one language.
 */
const CALIBRATION_SCOPE_KEY: Readonly<Record<CalibrationScope, string>> = {
  "whole-store": "common:insight.calibration.scope.wholeStore",
  day: "common:insight.calibration.scope.day",
  week: "common:insight.calibration.scope.week",
  month: "common:insight.calibration.scope.month",
  "custom-range": "common:insight.calibration.scope.customRange",
};

/**
 * State which window an estimate was gathered over.
 *
 * Separate from {@link calibrationCaveat}'s body rather than folded into its
 * sentences: the scope varies independently of subject AND of state, so folding
 * would multiply five windows × two subjects × two states into twenty
 * sentences a translator has to keep consistent. As its own clause it is five
 * keys, and the join is the locale's.
 */
export function calibrationScopeNote(t: InsightT, scope: CalibrationScope): string {
  return t(CALIBRATION_SCOPE_KEY[scope]);
}

/**
 * State a mechanism's measured agreement, or state that it has none.
 *
 * The measured sentence carries four things that must never be separated from
 * the percentage: the denominator `n`, the 95% interval, the fact that the
 * denominator is a self-selected review subset, and the direction of the
 * resulting bias. A rate stripped of any of them reads as "attribution is X%
 * accurate", which is not what was measured (see `calibration.ts`'s header) and
 * is the exact claim-stronger-than-its-basis failure I1 exists to stop.
 *
 * The uncalibrated sentence states the gap to the floor rather than an apology.
 * Below the floor there is no number to render, so the sentence IS the answer.
 *
 * The scope clause is appended in BOTH states, not only the measured one. "12 of
 * the 30 labels needed" over a week and over three years are different reports
 * on how far away a figure is, and a reader deciding whether to keep labelling
 * needs to know which they are looking at.
 */
export function calibrationCaveat(t: InsightT, estimate: CalibrationEstimate): string {
  const body =
    estimate.state === "uncalibrated"
      ? t(CALIBRATION_UNCALIBRATED_KEY[estimate.subject], {
          n: estimate.n,
          minN: estimate.minN,
        })
      : t(CALIBRATION_MEASURED_KEY[estimate.subject], {
          percent: formatPercent(estimate.rate),
          n: estimate.n,
          lo: formatPercent(estimate.interval?.lo ?? null),
          hi: formatPercent(estimate.interval?.hi ?? null),
        });
  // The same separator `answerBought` uses to stack caveat clauses, so the
  // scope clause sits in a caveat exactly as every other clause does — and it
  // is a locale's separator, empty in ja/zh where a space between sentences is
  // wrong.
  return [body, calibrationScopeNote(t, estimate.scope)].join(
    t("common:insight.punctuation.caveatJoin"),
  );
}

/**
 * The labelling nudge: what the user would have to do to make calibration
 * possible. Null once measured — a nudge that keeps nagging after the sample is
 * sufficient is noise, and the caveat already carries the figure.
 *
 * This is the enablement path I1 requires. "Uncalibrated" without it tells the
 * reader a number is missing and leaves them no way to produce it.
 */
export function calibrationEnablement(t: InsightT, estimate: CalibrationEstimate): string | null {
  if (estimate.state === "measured") return null;
  return t(CALIBRATION_ENABLEMENT_KEY[estimate.subject]);
}

// ─── The five answers ─────────────────────────────────────────────────────────

/** Inputs for Q1 — "What did AI cost?" */
export interface CostAnswerInput {
  mode: CostVocabulary;
  cost: number;
  previousCost: number | null;
  currency?: string;
  hourlyRate?: number | null;
  /** Plan accounts only: monthly fee and the resulting multiplier. */
  planFee?: number | null;
  planMultiplier?: number | null;
  reconciledRatio?: number | null;
  /** Required alongside `reconciledRatio` to state "reconciles" vs "does not
   *  reconcile" rather than defaulting to silence (see `costCaveat`). */
  reconciledWithinTolerance?: boolean;
  anyFallbackRates?: boolean;
}

export function answerCost(t: InsightT, input: CostAnswerInput): InsightAnswer {
  const currency = input.currency ?? "USD";
  const money = formatMoney(input.cost, currency);

  if (input.cost <= 0) {
    return unavailable("cost", t("common:insight.cost.unavailable"), {
      reason: "no-data",
      enablement: t("common:insight.cost.enablement"),
    });
  }

  const clauses: string[] = [t("common:insight.cost.thisPeriod", { money })];
  if (input.hourlyRate && input.hourlyRate > 0) {
    clauses.push(
      t("common:insight.cost.devTime", { devTime: formatDevTime(t, input.cost, input.hourlyRate) }),
    );
  }
  // `plan` only — never `mixed`. A multiplier against the plan fee divides the
  // WHOLE period's cost by a fee that covers only part of it, which overstates
  // the plan's value by however much metered spend is in scope. Under a mixed
  // vocabulary the multiplier is dropped and the caveat says why.
  if (input.mode === "plan" && input.planFee && input.planMultiplier) {
    clauses.push(
      t("common:insight.cost.planMultiplier", {
        multiplier: input.planMultiplier.toFixed(1),
        fee: formatMoney(input.planFee, currency),
      }),
    );
  }

  return {
    question: "cost",
    answer: sentence(t, clauses.join(t("common:insight.punctuation.clauseJoin"))),
    value: money,
    trend: trendOf(input.cost, input.previousCost),
    caveat: costCaveat(t, input.mode, {
      reconciledRatio: input.reconciledRatio ?? null,
      reconciledWithinTolerance: input.reconciledWithinTolerance,
      anyFallbackRates: input.anyFallbackRates ?? false,
    }),
    evidenceLink: "cost-and-controlling",
  };
}

/** Inputs for Q2 — "What did it buy?" */
export interface BoughtAnswerInput {
  completedTasks: number | null;
  coverage: TicketCoverage | null;
  topTicket: { key: string; cost: number } | null;
  currency?: string;
  previousCoverageRatio?: number | null;
  /**
   * Calibration for the mechanisms this card's figures rest on, appended to the
   * confidence caveat.
   *
   * Q2 is where it belongs because Q2 is where both live: `completedTasks` is
   * outcome detection's output, and the coverage percentage is graded by
   * attribution confidence. Quoting either beside a confidence tier that nothing
   * has ever checked is the defect Lane K exists to close, so the tiers and
   * their calibration state travel together on one caveat rather than one
   * appearing without the other.
   *
   * Absent/empty leaves the caveat exactly as it was — a caller that has not
   * gathered calibration must not be made to imply it has.
   */
  calibration?: readonly CalibrationEstimate[] | null;
}

export function answerBought(t: InsightT, input: BoughtAnswerInput): InsightAnswer {
  if (!input.coverage || input.coverage.totalCost <= 0) {
    return unavailable("bought", t("common:insight.bought.unavailable"), {
      reason: "not-enabled",
      enablement: t("common:insight.bought.enablement"),
    });
  }
  const currency = input.currency ?? "USD";
  const clauses: string[] = [];
  if (input.completedTasks !== null) {
    clauses.push(t("common:insight.bought.completed", { count: input.completedTasks }));
  }
  clauses.push(t("common:insight.bought.attributed", { percent: formatPercent(input.coverage.ratio) }));
  if (input.topTicket) {
    clauses.push(
      // `key` is caller data (validated as a ticket key, but caller data), so
      // it is spliced rather than interpolated — same rule everywhere.
      tLiteral(
        t,
        "common:insight.bought.topTicket",
        { cost: formatMoney(input.topTicket.cost, currency) },
        { key: input.topTicket.key },
      ),
    );
  }

  // The confidence mix and the calibration of that mix are one honesty
  // obligation, so they are one caveat string. Composed here (rather than the
  // surfaces each concatenating) for the same reason every other sentence is:
  // the dashboard and the exported pack must not be free to render different
  // halves of it.
  const caveatParts = [
    confidenceCaveat(t, input.coverage),
    ...(input.calibration ?? []).map((e) => calibrationCaveat(t, e)),
  ].filter((s): s is string => s !== null && s.length > 0);

  return {
    question: "bought",
    answer: sentence(t, clauses.join(t("common:insight.punctuation.listJoin"))),
    value: formatPercent(input.coverage.ratio),
    trend: trendOf(input.coverage.ratio ?? 0, input.previousCoverageRatio ?? null),
    caveat: caveatParts.length > 0 ? caveatParts.join(t("common:insight.punctuation.caveatJoin")) : null,
    evidenceLink: "tickets-and-value",
  };
}

/** Inputs for Q3 — "Was it efficient?" */
export interface EfficiencyAnswerInput {
  recoverableWaste: number | null;
  cost: number;
  currency?: string;
  /** Self-audited waste as a share of spend, this period and the previous one. */
  hygieneRatio?: number | null;
  previousHygieneRatio?: number | null;
}

export function answerEfficiency(t: InsightT, input: EfficiencyAnswerInput): InsightAnswer {
  if (input.recoverableWaste === null) {
    return unavailable("efficiency", t("common:insight.efficiency.unavailable"), {
      reason: "no-data",
      enablement: t("common:insight.efficiency.enablement"),
    });
  }
  const currency = input.currency ?? "USD";
  const share = input.cost > 0 ? input.recoverableWaste / input.cost : 0;
  const clauses = [
    t("common:insight.efficiency.recoverable", {
      money: formatMoney(input.recoverableWaste, currency),
      percent: formatPercent(share),
    }),
  ];
  if (input.hygieneRatio != null) {
    const percent = formatPercent(input.hygieneRatio);
    // Three complete sentence keys rather than a "{{direction}}" slot: "down
    // from"/"up from" is a preposition that governs the case of the noun after
    // it in several target languages, so it cannot be swapped independently of
    // the clause it sits in.
    clauses.push(
      input.previousHygieneRatio == null
        ? t("common:insight.efficiency.hygiene", { percent })
        : t(
            input.hygieneRatio < input.previousHygieneRatio
              ? "common:insight.efficiency.hygieneDown"
              : "common:insight.efficiency.hygieneUp",
            { percent, previous: formatPercent(input.previousHygieneRatio) },
          ),
    );
  }

  return {
    question: "efficiency",
    answer: sentence(t, clauses.join(t("common:insight.punctuation.clauseJoin"))),
    value: formatMoney(input.recoverableWaste, currency),
    // Falling waste is an improvement, so the trend is inverted deliberately:
    // "down" here means the number got better, matching how the card reads.
    trend: trendOf(input.hygieneRatio ?? share, input.previousHygieneRatio ?? null),
    caveat: null,
    evidenceLink: "efficiency-and-hygiene",
  };
}

/** Inputs for Q4 — "Is the setup right?" */
export interface SetupAnswerInput {
  planVerdict: string | null;
  recommendedPlan: string | null;
  projectedSaving: number | null;
  currency?: string;
  /** Set when a declared policy boundary has a measured effect. */
  policyImpact?: { date: string; classes: number; costPerTaskDelta: number } | null;
}

export function answerSetup(t: InsightT, input: SetupAnswerInput): InsightAnswer {
  const currency = input.currency ?? "USD";
  if (input.policyImpact) {
    const pct = formatPercent(input.policyImpact.costPerTaskDelta);
    return {
      question: "setup",
      answer: t("common:insight.setup.policyImpact", {
        date: input.policyImpact.date,
        percent: pct,
        count: input.policyImpact.classes,
      }),
      value: pct,
      trend: "up",
      caveat: t("common:insight.setup.policyCaveat"),
      evidenceLink: "plan-and-policy",
    };
  }
  if (!input.planVerdict) {
    return unavailable("setup", t("common:insight.setup.unavailable"), {
      reason: "no-data",
      enablement: t("common:insight.setup.enablement"),
    });
  }
  // `planVerdict` arrives already localized — the caller owns it because the
  // verdict vocabulary is the plan surface's, not this module's.
  const hasSaving = Boolean(input.projectedSaving && input.recommendedPlan);
  return {
    question: "setup",
    answer: hasSaving
      ? tLiteral(
          t,
          "common:insight.setup.verdictWithSaving",
          { saving: formatMoney(input.projectedSaving!, currency) },
          { verdict: input.planVerdict, plan: input.recommendedPlan! },
        )
      : sentence(t, input.planVerdict),
    value: input.recommendedPlan,
    trend: "unknown",
    caveat: hasSaving ? t("common:insight.setup.savingCaveat") : null,
    evidenceLink: "plan-and-policy",
  };
}

/** One actionable recommendation, as the dashboard's engine already produces them. */
export interface RecommendationInput {
  title: string;
  impact?: string | null;
  severity?: string;
}

/** Inputs for Q5 — "What should change?" */
export interface ChangeAnswerInput {
  recommendations: RecommendationInput[];
  doingWell?: string | null;
}

export function answerChange(t: InsightT, input: ChangeAnswerInput): InsightAnswer {
  if (input.recommendations.length === 0) {
    return {
      question: "change",
      // `doingWell` arrives already localized and already terminated — it is a
      // whole sentence the caller composed, so it is NOT wrapped again.
      answer: input.doingWell ?? t("common:insight.change.nothing"),
      value: null,
      trend: "flat",
      caveat: null,
      evidenceLink: "efficiency-and-hygiene",
    };
  }
  const lead = input.recommendations[0]!;
  // Counted over ALL recommendations, not over a top-N slice. The card's
  // headline value is the full count, so a slice-derived "(+2 more)" would put
  // two contradicting numbers on one card as soon as there are more than three
  // — the same figure disagreeing with itself, which is the I1 failure this
  // module exists to prevent. Below four recommendations the two counts
  // coincide, which is exactly why the defect was invisible.
  const others = input.recommendations.length - 1;
  // `title`/`impact` are engine-composed strings the caller already localized.
  const leadText = lead.impact
    ? tLiteral(t, "common:insight.change.withImpact", {}, { title: lead.title, impact: lead.impact })
    : lead.title;
  return {
    question: "change",
    answer:
      others > 0
        ? tLiteral(t, "common:insight.change.more", { count: others }, { lead: leadText })
        : sentence(t, leadText),
    value: String(input.recommendations.length),
    trend: "unknown",
    caveat: null,
    evidenceLink: "efficiency-and-hygiene",
  };
}

/**
 * Build an answer that says why it can't answer. Never returns an empty string
 * or a zero — an empty widget teaches the reader the tool is broken, whereas a
 * stated enablement path is how a feature gets discovered.
 *
 * Takes no translator: `answer` and `detail.enablement` are ALREADY-TRANSLATED
 * sentences, because only the caller knows which question it is answering. The
 * `reason` discriminant (`"no-data"` / `"not-enabled"`) is a machine value and
 * is deliberately NOT localized — surfaces branch on it.
 */
export function unavailable(
  question: InsightQuestion,
  answer: string,
  detail: NonNullable<InsightAnswer["unavailable"]>,
): InsightAnswer {
  return {
    question,
    answer,
    value: null,
    trend: "unknown",
    caveat: null,
    evidenceLink: null,
    unavailable: detail,
  };
}
