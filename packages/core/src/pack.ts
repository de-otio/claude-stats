/**
 * The justification pack — pure model builders + renderers.
 *
 * Design: doc/analysis/ticket-attribution/05-justification-pack.md,
 *         04-reporting-and-roi.md.
 *
 * Everything here is pure: no clock (`generatedAt` is injected), no I/O, no
 * `Math.random()`, and every collection is sorted before it is rendered. That
 * is what makes "generate twice under a frozen clock → byte-identical bytes"
 * hold — the pack's entire credibility argument (05 §5.3).
 *
 * Quotes `insight.ts`'s formatters rather than re-deriving strings, so the
 * pack and the dashboard can never disagree about what a number means.
 *
 * LOCALIZATION SCOPE, stated so the boundary is not mistaken for an oversight:
 * the sentences this pack SHARES with the dashboard and the CLI — the cost
 * caveat, the coverage caveat, the dev-time label — go through the injected
 * `InsightT` and are localized. The pack's OWN chrome (section headings, the
 * table column labels, `MODE_LABEL`, `TASK_CLASS_LABELS`, `UNAVAILABLE_TEXT`,
 * `scopeLabel`) is still English. That is deliberate: those strings have
 * exactly one surface, so localizing them cannot create the cross-surface drift
 * this module exists to prevent, and folding them in would double this change.
 * They are a separate, self-contained lane.
 */
import { isTicketKey } from "./tickets.js";
import type { InsightT } from "./insight.js";
import {
  calibrationCaveat,
  calibrationEnablement,
  confidenceCaveat,
  costCaveat,
  formatDevTime,
  formatMoney,
  formatMoneyCsv,
  formatPercent,
  trendOf,
} from "./insight.js";
import { computeReconciliation } from "./reconciliation.js";
import type { CalibrationEstimate } from "./calibration.js";
import type { ConstraintImpactReport } from "./constraintImpact/index.js";
import type { HygieneDigest } from "./hygiene/index.js";
import type { AccountMode, Confidence, PolicyEvent, ReconciliationCause, TaskClass, TicketCoverage } from "./types/insight.js";
import type {
  JustificationPackModel,
  JustificationPackSectionId,
  PackCalibrationSection,
  PackConstraintClassRow,
  PackConstraintSection,
  PackHeadline,
  PackHygieneDetectorRow,
  PackHygieneSection,
  PackMethodology,
  PackNonTicketRow,
  PackReconciliation,
  PackScope,
  PackSectionUnavailable,
  PackTicketRow,
} from "./types/pack.js";

/** English one-line explanation per residual cause — pack chrome, deliberately
 *  not localized (same "own English chrome" scope this file's header states
 *  for `MODE_LABEL`/`TASK_CLASS_LABELS`). Keep in cost-relevance order so the
 *  rendered list reads as "most likely first". */
const RECONCILIATION_CAUSE_TEXT: Readonly<Record<ReconciliationCause, string>> = {
  "unpriced-usage": "Usage on models with no pricing row this period (see unpriced-token count above).",
  "fallback-rates": "Some usage priced at first-party rates in place of an unconfigured partner rate.",
  "scope-mismatch":
    "The invoice's scope was not confirmed in config (reconciliation.scopeNote) — it may cover a different " +
    "account, project, or date range than this report.",
  unexplained: "No known cause accounts for this residual from the data available to this report.",
};

export const PACK_SCHEMA_VERSION = 1;

export const ALL_PACK_SECTIONS: readonly JustificationPackSectionId[] = [
  "headline",
  "tickets",
  "nonticket",
  "hygiene",
  "constraint",
  "calibration",
];

/** Sections 1–3 of 05 §5.2 — "a complete monthly pack for a team with no
 *  policy events." The developer still opts in explicitly; this is only the
 *  CLI/MCP default when `--sections` is omitted. */
export const DEFAULT_PACK_SECTIONS: readonly JustificationPackSectionId[] = [
  "headline",
  "tickets",
  "nonticket",
];

export const TASK_CLASS_LABELS: Readonly<Record<TaskClass | "unclassified", string>> = {
  debug: "Debugging",
  "refactor-multi-file": "Multi-file refactor",
  greenfield: "Greenfield build",
  review: "Code review",
  "config-chore": "Config / infra chore",
  explore: "Exploration",
  unknown: "Unclassified (classifier abstained)",
  unclassified: "Not yet classified",
};

export const CONFIDENCE_LABELS: Readonly<Record<Confidence, string>> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

// ─── Section builders ─────────────────────────────────────────────────────────

export interface BuildHeadlineInput {
  mode: AccountMode;
  currency: string;
  coverage: TicketCoverage;
  hourlyRate?: number | null;
  reconciledInvoiceTotal?: number | null;
  /** Fraction, e.g. 0.05 for ±5%. Defaults to 0.05. */
  reconciliationTolerance?: number;
  /** What the invoice figure covers — `config.reconciliation.scopeNote`,
   *  passed straight through to {@link computeReconciliation}. */
  reconciliationScopeNote?: string | null;
  anyFallbackRates?: boolean;
  /** Configured monthly plan fee. Only rendered when `mode === "plan"` — a
   *  metered account's fee field (if any) is not this figure's business
   *  (I-4). */
  planFee?: number | null;
  /** Tokens with no pricing row this period — pass `TicketCostReport
   *  .unknownTokens` straight through (I-3). Defaults to 0, never silently
   *  dropped by an omitted field: a caller that forgets to wire it gets an
   *  honest "no unpriced usage" rather than a caveat that happens to vanish. */
  unknownTokens?: number;
}

export function buildPackHeadline(t: InsightT, input: BuildHeadlineInput): PackHeadline {
  const totalCost = input.coverage.totalCost;
  const devTimeLabel =
    input.hourlyRate && input.hourlyRate > 0 && totalCost > 0
      ? formatDevTime(t, totalCost, input.hourlyRate)
      : null;

  // Reconciliation only makes sense for metered accounts (04 §4.3): a plan
  // account's bottom-up figure is equivalent-API-VALUE, not money, so
  // comparing it against an invoice's actual dollars is a category error, not
  // a residual.
  const reconciliation: PackReconciliation | null =
    input.mode === "metered"
      ? computeReconciliation({
          bottomUp: totalCost,
          invoiceTotal: input.reconciledInvoiceTotal,
          tolerance: input.reconciliationTolerance,
          unknownTokens: input.unknownTokens,
          anyFallbackRates: input.anyFallbackRates,
          scopeNote: input.reconciliationScopeNote,
        })
      : null;

  // Attributed cost split by evidence tier, as a fraction of attributedCost —
  // the same mix `coverageCaveat`'s prose already describes, as numbers a
  // CSV/appendix reader can carry into a spreadsheet without re-parsing a
  // sentence (I-5). Null when there's nothing attributed to split.
  const confidenceMix: Readonly<Record<Confidence, number>> | null =
    input.coverage.attributedCost > 0
      ? {
          high: (input.coverage.byConfidence.high ?? 0) / input.coverage.attributedCost,
          medium: (input.coverage.byConfidence.medium ?? 0) / input.coverage.attributedCost,
          low: (input.coverage.byConfidence.low ?? 0) / input.coverage.attributedCost,
        }
      : null;

  return {
    mode: input.mode,
    currency: input.currency,
    totalCost,
    devTimeLabel,
    coverageRatio: input.coverage.ratio,
    coverageCaveat: confidenceCaveat(t, input.coverage),
    // `costCaveat` now takes `reconciledWithinTolerance` explicitly (fixed
    // alongside this call site — it used to read ANY ratio as an affirmative
    // "reconciles with the invoice at X%", which was actively misleading for
    // a residual far from tolerance). With that fixed, feeding the real ratio
    // and verdict through is safe and is exactly what makes this caveat state
    // something instead of nothing (R — reconciliation was the starved
    // integration point `costCaveat`'s `reconciledRatio` param was built for).
    costCaveatText: costCaveat(t, input.mode, {
      reconciledRatio: reconciliation?.ratio ?? null,
      reconciledWithinTolerance: reconciliation?.withinTolerance,
      anyFallbackRates: input.anyFallbackRates ?? false,
    }),
    reconciliation,
    // I-4: only a plan-mode pack states a plan fee — a metered account's fee
    // field (if any exists in config) has no place in this headline.
    planFee: input.mode === "plan" ? (input.planFee ?? null) : null,
    anyFallbackRates: input.anyFallbackRates ?? false,
    unknownTokens: input.unknownTokens ?? 0,
    confidenceMix,
  };
}

/** A minimal per-ticket source row — whatever shape the caller's report has,
 *  as long as it carries these fields (`ticketing/index.ts`'s `TicketCostRow`
 *  is a superset and satisfies this directly). */
export interface RawPackTicketRow {
  ticketKey: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessionCount: number;
  confidence: Confidence;
}

/**
 * Minimize + sort raw ticket rows into the redacted pack shape. Rows whose key
 * fails `isTicketKey` are dropped rather than rendered — defence in depth: a
 * corrupt store row can never reach an outward-facing document even if it
 * somehow bypassed the write-path validator.
 */
export function buildTicketRows(rows: readonly RawPackTicketRow[]): PackTicketRow[] {
  return rows
    .filter((r) => isTicketKey(r.ticketKey))
    .map((r): PackTicketRow => ({
      ticketKey: r.ticketKey,
      cost: r.cost,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      sessionCount: r.sessionCount,
      confidence: r.confidence,
    }))
    .sort((a, b) => b.cost - a.cost || a.ticketKey.localeCompare(b.ticketKey));
}

/** Per-class aggregate the caller supplies to `buildNonTicketRows`.
 *  `byConfidence` is optional so existing/simpler callers keep working; when
 *  present it carries the classifier's own confidence for the sessions in
 *  this bucket, cost-weighted, so the row can report which tier dominates
 *  rather than dropping that information on the floor (I-5). */
export interface NonTicketClassAggregate {
  cost: number;
  sessionCount: number;
  byConfidence?: Readonly<Record<Confidence, number>>;
}

export function buildNonTicketRows(
  byClass: ReadonlyMap<string, NonTicketClassAggregate>,
): PackNonTicketRow[] {
  return [...byClass.entries()]
    .map(([taskClass, v]): PackNonTicketRow => {
      let confidence: Confidence | null = null;
      if (v.byConfidence) {
        const order: Confidence[] = ["high", "medium", "low"];
        let bestValue = 0;
        for (const c of order) {
          const value = v.byConfidence[c] ?? 0;
          if (value > bestValue) {
            bestValue = value;
            confidence = c;
          }
        }
      }
      return {
        taskClass: taskClass as TaskClass | "unclassified",
        cost: v.cost,
        sessionCount: v.sessionCount,
        confidence,
      };
    })
    .sort((a, b) => b.cost - a.cost || a.taskClass.localeCompare(b.taskClass));
}

export interface BuildMethodologyInput {
  pricingVerifiedDate: string;
  taskClassVersion: number;
  languageMode: AccountMode;
  policyEvents: readonly Pick<PolicyEvent, "date" | "kind" | "scope">[];
}

export function buildPackMethodology(input: BuildMethodologyInput): PackMethodology {
  return {
    pricingVerifiedDate: input.pricingVerifiedDate,
    taskClassVersion: input.taskClassVersion,
    languageMode: input.languageMode,
    policyEvents: input.policyEvents
      .map((e) => ({ date: e.date, kind: e.kind, scope: e.scope ?? null }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind)),
  };
}

// ─── The three engine-fed sections ────────────────────────────────────────────
//
// Each takes an already-computed engine result and MINIMIZES it to the pack's
// outward-facing shape. The minimization lives here, in core, beside the
// compile-time forbidden-field assertions in `types/pack.ts` — not in the CLI
// shell, where a future caller could quietly hand a richer object straight to
// a renderer.

export interface BuildPackHygieneInput {
  /** `buildHygieneDigest`'s output, verbatim. */
  readonly digest: HygieneDigest;
  /** Total equivalent-API cost over the same window — the denominator. */
  readonly totalCost: number;
  /** `digest.totalEstimatedWaste / totalCost` as the caller computed it, and
   *  the same ratio over the preceding window of equal length. Both null-able
   *  for the same reason: no spend to divide by. */
  readonly wasteRatio: number | null;
  readonly previousWasteRatio: number | null;
}

/**
 * Reduce the hygiene digest to a per-detector waste table plus a trend.
 *
 * Unavailable — rather than a 0% clean sheet — when there is no spend to
 * divide by. Zero waste over zero spend is not good hygiene; it is no data,
 * and a "0% wasted" line in a document going to a manager would be a claim
 * the window cannot support.
 */
export function buildPackHygieneSection(input: BuildPackHygieneInput): PackHygieneSection | PackSectionUnavailable {
  if (input.wasteRatio === null || input.totalCost <= 0) {
    return {
      available: false,
      reason: "No spend was recorded in this period, so there is no denominator to express waste as a share of.",
      enablementPath: "Run `claude-stats collect`, then regenerate the pack for a period with recorded usage.",
    };
  }

  const detectors: PackHygieneDetectorRow[] = input.digest.active
    .map((r): PackHygieneDetectorRow => ({
      detectorId: r.detectorId,
      title: r.title,
      findingCount: r.findings.length,
      estimatedWaste: r.findings.reduce((n, f) => n + f.estimatedWaste, 0),
      computed: r.computed,
      enablementPath: r.enablementPath ?? null,
    }))
    .sort((a, b) => b.estimatedWaste - a.estimatedWaste || a.detectorId.localeCompare(b.detectorId));

  return {
    available: true,
    totalCost: input.totalCost,
    estimatedWaste: input.digest.totalEstimatedWaste,
    wasteRatio: input.wasteRatio,
    previousWasteRatio: input.previousWasteRatio,
    trend: trendOf(input.wasteRatio, input.previousWasteRatio),
    findingCount: input.digest.totalFindings,
    detectors,
    suppressedDetectorIds: [...input.digest.suppressedIds].sort(),
  };
}

export interface BuildPackConstraintInput {
  /** `compareConstraintImpact`'s report, or null when no declared policy
   *  event could be compared across (none declared, or all dated after the
   *  available data). */
  readonly report: ConstraintImpactReport | null;
  /** Declared events other than the compared one — see the field's doc. */
  readonly otherPolicyEventCount: number;
}

export function buildPackConstraintSection(
  input: BuildPackConstraintInput,
): PackConstraintSection | PackSectionUnavailable {
  const report = input.report;
  if (!report) {
    return {
      available: false,
      reason:
        "No policy event has been declared on or before the end of this period, so there is no boundary " +
        "to compare across. This section never infers a boundary from the data — a change in the numbers " +
        "is not evidence that a policy changed.",
      enablementPath:
        "Declare the date a policy took effect under `policyEvents` in your claude-stats config, then " +
        "regenerate the pack.",
    };
  }

  const classes = report.classes.map((c): PackConstraintClassRow => ({
    classKey: c.classKey,
    grain: c.grain,
    verdict: c.verdict,
    nBefore: c.nBefore,
    nAfter: c.nAfter,
    avgCostBefore: c.avgCostBefore,
    avgCostAfter: c.avgCostAfter,
    tokenSavingsAtAfterVolume: c.tokenSavingsAtAfterVolume,
    devTimeCostAtAfterVolume: c.devTimeCostAtAfterVolume,
    netEffectAtAfterVolume: c.netEffectAtAfterVolume,
    direction: c.direction,
  }));

  return {
    available: true,
    // `detail` is LOCAL-ONLY and is dropped structurally here, exactly as the
    // methodology appendix's own policy-event shape drops it.
    policyEvent: {
      date: report.policyEvent.date,
      kind: report.policyEvent.kind,
      scope: report.policyEvent.scope ?? null,
    },
    comparisonScope: "all-recorded-history",
    currency: report.currency,
    minSessionsPerClass: report.minSessionsPerClass,
    classesCompared: report.classesCompared,
    classesInsufficientData: report.classesInsufficientData,
    totalTokenSavings: report.totalTokenSavings,
    totalDevTimeCost: report.totalDevTimeCost,
    totalNetEffect: report.totalNetEffect,
    netEffectAvailable: report.netEffectAvailable,
    classes,
    notMeasured: [...report.notMeasured],
    confoundNote: report.confoundNote,
    otherPolicyEventCount: input.otherPolicyEventCount,
  };
}

export interface BuildPackCalibrationInput {
  /** `buildAttributionCalibration(store).estimate`. Narrowed to the
   *  attribution subject so this builder's fixed `subject: "attribution"`
   *  cannot be made to mislabel an outcome estimate. */
  readonly estimate: CalibrationEstimate & { readonly subject: "attribution" };
  /** `…​.review.unproposed` — the recall-side count. */
  readonly unproposed: number;
}

/**
 * Always available: `uncalibrated` is an answer, not a missing section. The
 * gate lives in `calibrate`, which returns a null `rate` below the floor, so
 * there is nothing here for a renderer to print a percentage from.
 */
export function buildPackCalibrationSection(t: InsightT, input: BuildPackCalibrationInput): PackCalibrationSection {
  const e = input.estimate;
  return {
    available: true,
    subject: "attribution",
    scope: e.scope,
    state: e.state,
    n: e.n,
    agreed: e.agreed,
    disagreed: e.disagreed,
    rate: e.rate,
    interval: e.interval ? { lo: e.interval.lo, hi: e.interval.hi } : null,
    minN: e.minN,
    needed: e.needed,
    measures: "agreement-on-reviewed-subset",
    caveat: calibrationCaveat(t, e),
    enablement: calibrationEnablement(t, e),
    unproposed: input.unproposed,
  };
}

export interface BuildPackModelInput {
  generatedAt: number;
  period: { since: number; until: number; label: string };
  /** What this generation was filtered to. Omitted (or a field left
   *  undefined) defaults to "no filter" — an explicit, honest unscoped pack,
   *  never a silently-blank one (I-2). */
  scope?: { projectPath?: string | null; accountUuid?: string | null };
  sections: readonly JustificationPackSectionId[];
  headline: BuildHeadlineInput;
  tickets?: readonly RawPackTicketRow[];
  nonTicketByClass?: ReadonlyMap<string, NonTicketClassAggregate>;
  methodology: BuildMethodologyInput;
  /** Engine results for the three optional sections. Each is only read when
   *  its section was opted into; omitting one while opting the section in
   *  yields a `PackSectionUnavailable` naming the missing input, never a
   *  silently absent heading. */
  hygiene?: BuildPackHygieneInput;
  constraint?: BuildPackConstraintInput;
  calibration?: BuildPackCalibrationInput;
}

/** Assemble the whole pack model. The single place section opt-in is applied
 *  — every renderer downstream just reads what's present (05 §5.3: "the tool
 *  never produces a pack the developer hasn't reviewed"). */
export function buildJustificationPackModel(t: InsightT, input: BuildPackModelInput): JustificationPackModel {
  const wanted = new Set(input.sections);

  const tickets =
    wanted.has("tickets") && input.tickets ? buildTicketRows(input.tickets) : null;
  const nonTicket =
    wanted.has("nonticket") && input.nonTicketByClass
      ? buildNonTicketRows(input.nonTicketByClass)
      : null;

  // An opted-in section with no engine input is a WIRING fault, not an empty
  // period, and it says so rather than borrowing the honest empty state's
  // wording — a caller that forgot to pass a report must not read as "your
  // data has nothing to show".
  const missingInput = (section: string, call: string): PackSectionUnavailable => ({
    available: false,
    reason: `The ${section} section was requested but no ${section} data was supplied to this generation.`,
    enablementPath: `This is a wiring fault in the caller: pass \`${call}\` through to buildJustificationPackModel.`,
  });

  const hygiene = !wanted.has("hygiene")
    ? null
    : input.hygiene
      ? buildPackHygieneSection(input.hygiene)
      : missingInput("hygiene", "buildHygieneReport(...)");

  const constraint = !wanted.has("constraint")
    ? null
    : input.constraint
      ? buildPackConstraintSection(input.constraint)
      : missingInput("constraint", "buildConstraintImpactReport(...)");

  const calibration = !wanted.has("calibration")
    ? null
    : input.calibration
      ? buildPackCalibrationSection(t, input.calibration)
      : missingInput("calibration", "buildAttributionCalibration(store)");

  const scope: PackScope = {
    projectPath: input.scope?.projectPath ?? null,
    accountUuid: input.scope?.accountUuid ?? null,
  };

  return {
    generatedAt: input.generatedAt,
    period: { ...input.period },
    scope,
    sections: ALL_PACK_SECTIONS.filter((s) => wanted.has(s)),
    headline: buildPackHeadline(t, input.headline),
    tickets,
    nonTicket,
    methodology: buildPackMethodology(input.methodology),
    hygiene,
    constraint,
    calibration,
  };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isoStamp(ms: number): string {
  return new Date(ms).toISOString();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Money and percentages route through `insight.ts`'s shared formatters with
// `precise: true` / 1 decimal — the pack is read closely (not glanced at like
// a dashboard tile), so it keeps its finer precision, but through the SAME
// implementation the dashboard uses, so the two can never quote different
// figures for the same underlying number (I-1). `fmtMoney`/`fmtPct` are thin
// currying wrappers kept only to avoid threading `currency` through every
// call site below.
function fmtMoney(n: number, currency: string): string {
  return formatMoney(n, currency, { precise: true });
}

function fmtPct(n: number): string {
  return formatPercent(n, 1);
}

/** Non-money integer with the same fixed-locale thousands separator as
 *  `formatMoney` — used for the unpriced-token count, which is a count, not
 *  a currency figure, and must not silently drift to a runtime locale. */
function fmtInt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const MODE_LABEL: Record<AccountMode, string> = {
  plan: "Flat-rate plan (equivalent-API-value framing)",
  metered: "Metered / pay-per-token billing (actual cost)",
};

/** One human-readable line describing what a pack was filtered to — always
 *  rendered, because "no filter" is itself a fact the reader needs (I-2): a
 *  scoped pack must never be textually indistinguishable from a whole-machine
 *  one, and an unscoped pack should say so rather than just omitting a line. */
function scopeLabel(scope: PackScope): string {
  const parts: string[] = [];
  if (scope.projectPath) parts.push(`project ${redactScopeValue(scope.projectPath)}`);
  if (scope.accountUuid) parts.push(`account ${redactScopeValue(scope.accountUuid)}`);
  return parts.length > 0 ? parts.join(" · ") : "unscoped — all projects and accounts on this machine";
}

/**
 * Opt-in disclosure of literal scope values. Module-level rather than threaded
 * through every renderer because it is a document-wide decision, not a per-row
 * one, and every call site would otherwise have to remember to pass it - which
 * is exactly the omission that produced this defect.
 */
let DISCLOSE_SCOPE_VALUES = false;

/** Set disclosure mode; returns the previous value so a test can restore it
 *  and not leak the setting into its neighbours. */
export function setDiscloseScopeValues(disclose: boolean): boolean {
  const prev = DISCLOSE_SCOPE_VALUES;
  DISCLOSE_SCOPE_VALUES = disclose;
  return prev;
}

/**
 * A scope value as it may appear in an outward-facing document.
 *
 * The reader needs to know a pack was filtered - a one-project total and a
 * whole-machine total must never read alike. They do not need the literal
 * value, and the literal value is the risky part: an absolute project path
 * routinely encodes an employer, a client, or an unreleased product name in a
 * parent directory. This document is built to be handed to someone outside the
 * machine, so emitting one by default inverts this module's own rule that the
 * default is the minimum.
 */
function redactScopeValue(value: string): string {
  return DISCLOSE_SCOPE_VALUES ? value : `[withheld:${shortDigest(value)}]`;
}

/**
 * Deterministic, non-reversible short marker (FNV-1a). Not a security boundary
 * - an eight-hex digest of a guessable path is guessable - and not meant to be
 * one: it defeats disclosure BY ACCIDENT, which is the real failure mode here,
 * a path pasted into a document nobody reread before sending. Two packs scoped
 * alike carry the same marker so a series stays comparable, and it is
 * deterministic because the pack must regenerate byte-identically.
 */
function shortDigest(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ─── Section renderers ────────────────────────────────────────────────────────

/** The honest empty state: what is missing, and the way to produce it. The
 *  enablement line is never dropped — an "unavailable" with no way out is the
 *  failure this block exists to avoid. */
function renderUnavailable(s: PackSectionUnavailable): string {
  const out = [`<div class="unavailable">${escapeHtml(s.reason)}`];
  if (s.enablementPath) out.push(`<br><strong>To enable:</strong> ${escapeHtml(s.enablementPath)}`);
  out.push(`</div>`);
  return out.join("");
}

/** `up` in waste is bad and `down` is good, which is the opposite of every
 *  other trend in this document — so the direction is spelled out in words
 *  rather than left to an arrow the reader has to interpret. */
const WASTE_TREND_TEXT: Readonly<Record<PackHygieneSection["trend"], string>> = {
  up: "up from",
  down: "down from",
  flat: "level with",
  unknown: "",
};

function renderHygieneSection(s: PackHygieneSection, currency: string): string {
  const parts: string[] = [`<div class="headline">`];
  parts.push(
    `<div class="figure">${fmtPct(s.wasteRatio)}</div>`,
    `<div>of spend this period is self-audited waste — ${fmtMoney(s.estimatedWaste, currency)} of ` +
      `${fmtMoney(s.totalCost, currency)}, across ${s.findingCount} finding${s.findingCount === 1 ? "" : "s"}.</div>`,
  );
  parts.push(
    s.previousWasteRatio !== null
      ? `<div class="caveat">${WASTE_TREND_TEXT[s.trend]} ${fmtPct(s.previousWasteRatio)} over the preceding ` +
          `period of equal length.</div>`
      : `<div class="caveat">No comparable preceding period with recorded spend, so there is no trend to state.</div>`,
  );
  parts.push(
    `<div class="caveat">Waste is estimated conservatively by six local detectors and is an upper bound on what ` +
      `could plausibly have been avoided, not money that was definitely lost.</div>`,
  );
  parts.push(`</div>`);

  parts.push(
    `<table><thead><tr><th>Pattern</th><th class="num">Findings</th><th class="num">Estimated waste</th>` +
      `</tr></thead><tbody>`,
  );
  for (const d of s.detectors) {
    parts.push(
      `<tr><td>${escapeHtml(d.title)}${
        d.computed ? "" : ` — <em>not computed${d.enablementPath ? `: ${escapeHtml(d.enablementPath)}` : ""}</em>`
      }</td>` +
        `<td class="num">${d.computed ? d.findingCount : "—"}</td>` +
        `<td class="num">${d.computed ? fmtMoney(d.estimatedWaste, currency) : "—"}</td></tr>`,
    );
  }
  parts.push(`</tbody></table>`);

  if (s.suppressedDetectorIds.length > 0) {
    parts.push(
      `<div class="caveat">${s.suppressedDetectorIds.length} detector` +
        `${s.suppressedDetectorIds.length === 1 ? " is" : "s are"} switched off and excluded from the figures above: ` +
        `${escapeHtml(s.suppressedDetectorIds.join(", "))}.</div>`,
    );
  }
  return parts.join("\n");
}

const IMPACT_DIRECTION_LABEL: Readonly<Record<PackConstraintClassRow["direction"], string>> = {
  favorable: "Favourable",
  unfavorable: "Unfavourable",
  negligible: "Negligible",
  unknown: "Unknown",
};

/** `classKey` is a fine task class, or `coarse:<name>` when confidence did not
 *  support the fine grain. Fine names get their reader-facing label; anything
 *  else is shown verbatim rather than guessed at. */
function constraintClassLabel(row: PackConstraintClassRow): string {
  if (row.grain === "coarse") return row.classKey.replace(/^coarse:/, "") + " (coarse grain)";
  return TASK_CLASS_LABELS[row.classKey as TaskClass] ?? row.classKey;
}

function renderConstraintSection(s: PackConstraintSection): string {
  const parts: string[] = [];
  const c = s.currency;
  const e = s.policyEvent;

  parts.push(`<div class="headline">`);
  parts.push(
    `<div>Compared across the <strong>${escapeHtml(e.kind)}</strong> policy declared ` +
      `${escapeHtml(e.date)}${e.scope ? ` (${escapeHtml(e.scope)})` : ""}.</div>`,
  );
  // The one section whose window is NOT the pack's period. Said plainly, in
  // the section itself, rather than left to the appendix.
  parts.push(
    `<div class="caveat">This comparison spans <strong>all recorded sessions either side of that date</strong>, ` +
      `not only this period. A month either side rarely clears the ${s.minSessionsPerClass}-session-per-class ` +
      `floor this report abstains below.</div>`,
  );

  // Stated up front, not left to the "0 classes compared" footnote under the
  // table: a reader who sees a "Constraint impact" heading with a policy date
  // under it will take the section's presence as evidence the policy was
  // evaluated. When no class cleared the floor, it was not.
  if (s.classesCompared === 0) {
    parts.push(
      `<div><strong>This boundary is not evaluated.</strong> No task class had enough sessions on both sides ` +
        `to compare, so nothing below supports a claim either way about the policy's effect.</div>`,
    );
  }

  if (s.netEffectAvailable && s.totalNetEffect !== null) {
    const favourable = s.totalNetEffect > 0;
    parts.push(
      `<div class="figure">${favourable ? "" : "−"}${fmtMoney(Math.abs(s.totalNetEffect), c)}</div>`,
      `<div>net effect at the after-period's volume — ${favourable ? "in favour of" : "against"} the policy.</div>`,
    );
  }
  parts.push(
    `<div>Token cost: ${s.totalTokenSavings !== null ? `${fmtMoney(s.totalTokenSavings, c)} saved` : "not comparable"}` +
      ` · Developer time: ${
        s.totalDevTimeCost !== null
          ? `${fmtMoney(s.totalDevTimeCost, c)} ${s.totalDevTimeCost >= 0 ? "additional" : "recovered"}`
          : "not priced"
      }</div>`,
  );
  if (!s.netEffectAvailable) {
    parts.push(
      `<div class="caveat">No hourly rate is configured, so the developer-time half of this ledger has no price ` +
        `and no net effect is stated. A token saving on its own is half a ledger, not a result — configure ` +
        `<code>rate.hourly</code> to complete it.</div>`,
    );
  }
  parts.push(`<div class="caveat">${escapeHtml(s.confoundNote)}</div>`);
  parts.push(`</div>`);

  parts.push(
    `<table><thead><tr><th>Kind of work</th><th class="num">Sessions before → after</th>` +
      `<th class="num">Avg cost before → after</th><th class="num">Net effect</th><th>Direction</th>` +
      `</tr></thead><tbody>`,
  );
  for (const row of s.classes) {
    const compared = row.verdict === "compared";
    parts.push(
      `<tr><td>${escapeHtml(constraintClassLabel(row))}</td>` +
        `<td class="num">${row.nBefore} → ${row.nAfter}</td>` +
        `<td class="num">${
          compared && row.avgCostBefore !== null && row.avgCostAfter !== null
            ? `${fmtMoney(row.avgCostBefore, c)} → ${fmtMoney(row.avgCostAfter, c)}`
            : "—"
        }</td>` +
        `<td class="num">${row.netEffectAtAfterVolume !== null ? fmtMoney(row.netEffectAtAfterVolume, c) : "—"}</td>` +
        `<td>${
          compared
            ? escapeHtml(IMPACT_DIRECTION_LABEL[row.direction])
            : `<em>Too few sessions (floor ${s.minSessionsPerClass})</em>`
        }</td></tr>`,
    );
  }
  parts.push(`</tbody></table>`);

  parts.push(
    `<div class="caveat">${s.classesCompared} class${s.classesCompared === 1 ? "" : "es"} compared, ` +
      `${s.classesInsufficientData} abstained for want of sessions.</div>`,
  );
  if (s.otherPolicyEventCount > 0) {
    parts.push(
      `<div class="caveat">${s.otherPolicyEventCount} other policy event` +
        `${s.otherPolicyEventCount === 1 ? " is" : "s are"} declared and not compared here — see the methodology ` +
        `appendix. This is one boundary, not the whole policy history.</div>`,
    );
  }
  if (s.notMeasured.length > 0) {
    parts.push(
      `<div class="caveat"><strong>Deliberately not measured:</strong> ${s.notMeasured
        .map(escapeHtml)
        .join("; ")}.</div>`,
    );
  }
  return parts.join("\n");
}

function renderCalibrationSection(s: PackCalibrationSection): string {
  const parts: string[] = [`<div class="headline">`];
  if (s.state === "measured" && s.rate !== null) {
    parts.push(`<div class="figure">${fmtPct(s.rate)}</div>`);
    parts.push(
      `<div>agreement between the automatic attribution pass and the developer's own rulings` +
        `${s.interval ? ` (95% CI ${fmtPct(s.interval.lo)}–${fmtPct(s.interval.hi)})` : ""}, over ${s.n} ruling` +
        `${s.n === 1 ? "" : "s"}.</div>`,
    );
  } else {
    parts.push(
      `<div>Not calibrated: ${s.n} of the ${s.minN} rulings needed before an agreement rate would be reported. ` +
        `Nothing is claimed about attribution accuracy on this evidence.</div>`,
    );
  }
  // Quoted from the shared formatter, never reworded — the same sentence the
  // dashboard shows for the same estimate.
  parts.push(`<div class="caveat">${escapeHtml(s.caveat)}</div>`);
  if (s.enablement) parts.push(`<div class="caveat">${escapeHtml(s.enablement)}</div>`);
  if (s.unproposed > 0) {
    parts.push(
      `<div class="caveat">${s.unproposed} link${s.unproposed === 1 ? " was" : "s were"} added by hand naming a ` +
        `ticket the automatic pass never proposed. That is a miss on the pass's part; it is reported here and ` +
        `deliberately kept out of the agreement rate above, which would otherwise flatter it.</div>`,
    );
  }
  parts.push(`</div>`);
  return parts.join("\n");
}

/**
 * Render the self-contained HTML document. No external assets, no scripts,
 * no network calls — opens correctly forwarded as an email attachment or
 * printed to PDF, which is the whole point of this format (05 §5.1).
 */
export function renderJustificationPackHtml(model: JustificationPackModel): string {
  const parts: string[] = [];
  const h = model.headline;

  parts.push(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">`,
    `<title>Claude Code justification pack — ${escapeHtml(model.period.label)}</title>`,
    `<style>`,
    `:root{--fg:#1a1a1a;--muted:#5a5a66;--bg:#ffffff;--panel:#f6f6f8;--line:#dcdce2;--accent:#2f5fd6;}`,
    `@media (prefers-color-scheme:dark){:root{--fg:#e8e8ec;--muted:#a5a5b2;--bg:#15151a;--panel:#1e1e26;--line:#33333d;--accent:#7fa2ff;}}`,
    `*{box-sizing:border-box}body{margin:0;padding:2.5rem 3rem;background:var(--bg);color:var(--fg);`,
    `font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:840px;margin-inline:auto}`,
    `h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:2rem 0 .75rem;border-bottom:1px solid var(--line);padding-bottom:.35rem}`,
    `.meta{color:var(--muted);font-size:.85rem;margin-bottom:1.5rem}`,
    `.headline{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1.25rem 1.5rem}`,
    `.figure{font-size:2rem;font-weight:600}.caveat{color:var(--muted);font-size:.85rem;margin-top:.4rem}`,
    `table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--line)}`,
    `th{color:var(--muted);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.03em}`,
    `td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}`,
    `.unavailable{background:var(--panel);border:1px dashed var(--line);border-radius:8px;padding:.9rem 1.1rem;color:var(--muted);font-size:.9rem}`,
    `.appendix{font-size:.85rem;color:var(--muted)}.appendix dt{font-weight:600;color:var(--fg);margin-top:.6rem}`,
    `@media print{body{padding:0 1cm}.headline{border:1px solid #999}}`,
    `</style></head><body>`,
  );

  parts.push(
    `<h1>Claude Code usage — justification pack</h1>`,
    `<div class="meta">Period ${escapeHtml(model.period.label)} ` +
      `(${isoDate(model.period.since)} – ${isoDate(model.period.until)}) · ` +
      `Scope: ${escapeHtml(scopeLabel(model.scope))} · ` +
      `generated ${escapeHtml(isoStamp(model.generatedAt))}</div>`,
  );

  if (model.sections.includes("headline")) {
    parts.push(`<div class="headline">`);
    parts.push(`<div class="figure">${fmtMoney(h.totalCost, h.currency)}</div>`);
    if (h.devTimeLabel) parts.push(`<div>≈ ${escapeHtml(h.devTimeLabel)} at the configured rate</div>`);
    if (h.planFee != null) {
      parts.push(`<div>Plan fee: ${fmtMoney(h.planFee, h.currency)}/mo</div>`);
    }
    if (h.coverageRatio != null) {
      parts.push(`<div>${fmtPct(h.coverageRatio)} of spend is ticket-attributable</div>`);
    }
    parts.push(`<div class="caveat">${escapeHtml(h.costCaveatText)}</div>`);
    if (h.coverageCaveat) parts.push(`<div class="caveat">${escapeHtml(h.coverageCaveat)}</div>`);
    if (h.unknownTokens > 0) {
      parts.push(
        `<div class="caveat">${fmtInt(h.unknownTokens)} tokens from unpriced models are excluded from the ` +
          `total above — the figure understates spend by that amount.</div>`,
      );
    }
    if (h.reconciliation) {
      const r = h.reconciliation;
      const verdict = r.withinTolerance ? "reconciles" : "does not reconcile";
      parts.push(
        `<div class="caveat">Bottom-up ${fmtMoney(r.bottomUp, h.currency)} vs invoice ` +
          `${fmtMoney(r.invoiceTotal, h.currency)} → ${fmtPct(r.ratio)} — ${verdict} within ±${r.tolerancePercent}%.</div>`,
      );
      parts.push(
        `<div class="caveat">Invoice scope: ${escapeHtml(r.scopeNote ?? "not confirmed in config (reconciliation.scopeNote) — verify it covers the same account(s) and date range as this report")}.</div>`,
      );
      if (!r.withinTolerance) {
        const signedResidual = `${r.residual >= 0 ? "+" : "−"}${fmtMoney(Math.abs(r.residual), h.currency)}`;
        parts.push(
          `<div class="caveat">Residual: ${signedResidual} (invoice minus bottom-up, ${fmtPct(Math.abs(r.residualRatio))} of the invoice). ` +
            `Candidate cause${r.candidateCauses.length > 1 ? "s" : ""}: ${r.candidateCauses
              .map((c) => escapeHtml(RECONCILIATION_CAUSE_TEXT[c]))
              .join(" ")}</div>`,
        );
      }
    }
    parts.push(`</div>`);
  }

  if (model.sections.includes("tickets")) {
    parts.push(`<h2>Per-ticket spend</h2>`);
    if (model.tickets && model.tickets.length > 0) {
      parts.push(
        `<table><thead><tr><th>Ticket</th><th>Confidence</th><th class="num">Sessions</th>` +
          `<th class="num">Cost</th></tr></thead><tbody>`,
      );
      for (const t of model.tickets) {
        parts.push(
          `<tr><td>${escapeHtml(t.ticketKey)}</td><td>${escapeHtml(CONFIDENCE_LABELS[t.confidence] ?? t.confidence)}</td>` +
            `<td class="num">${t.sessionCount}</td><td class="num">${fmtMoney(t.cost, h.currency)}</td></tr>`,
        );
      }
      parts.push(`</tbody></table>`);
    } else {
      parts.push(`<div class="unavailable">No ticket-attributed spend in this period.</div>`);
    }
  }

  if (model.sections.includes("nonticket")) {
    parts.push(`<h2>Non-ticket work</h2>`);
    if (model.nonTicket && model.nonTicket.length > 0) {
      parts.push(
        `<table><thead><tr><th>Kind of work</th><th>Classification confidence</th>` +
          `<th class="num">Sessions</th><th class="num">Cost</th></tr></thead><tbody>`,
      );
      for (const row of model.nonTicket) {
        const confidenceLabel = row.confidence ? CONFIDENCE_LABELS[row.confidence] : "—";
        parts.push(
          `<tr><td>${escapeHtml(TASK_CLASS_LABELS[row.taskClass] ?? row.taskClass)}</td>` +
            `<td>${escapeHtml(confidenceLabel)}</td>` +
            `<td class="num">${row.sessionCount}</td><td class="num">${fmtMoney(row.cost, h.currency)}</td></tr>`,
        );
      }
      parts.push(`</tbody></table>`);
    } else {
      parts.push(`<div class="unavailable">No non-ticket spend in this period.</div>`);
    }
  }

  if (model.hygiene) {
    parts.push(`<h2>Hygiene trend</h2>`);
    parts.push(
      model.hygiene.available
        ? renderHygieneSection(model.hygiene, h.currency)
        : renderUnavailable(model.hygiene),
    );
  }

  if (model.constraint) {
    parts.push(`<h2>Constraint impact</h2>`);
    parts.push(
      model.constraint.available
        ? renderConstraintSection(model.constraint)
        : renderUnavailable(model.constraint),
    );
  }

  if (model.calibration) {
    parts.push(`<h2>Calibration</h2>`);
    parts.push(
      model.calibration.available
        ? renderCalibrationSection(model.calibration)
        : renderUnavailable(model.calibration),
    );
  }

  const m = model.methodology;
  parts.push(`<h2>Methodology</h2><dl class="appendix">`);
  parts.push(`<dt>Scope</dt><dd>${escapeHtml(scopeLabel(model.scope))}.</dd>`);
  parts.push(`<dt>Pricing table</dt><dd>Verified ${escapeHtml(m.pricingVerifiedDate)}.</dd>`);
  parts.push(`<dt>Language mode</dt><dd>${escapeHtml(MODE_LABEL[m.languageMode])}.</dd>`);
  parts.push(
    `<dt>Confidence tiers</dt><dd>High/medium/low evidence grade per attribution — see ` +
      `doc/analysis/ticket-attribution/01-attribution-signals.md. A session linked to more ` +
      `than one ticket with no message-level evidence to split on is reported as ambiguous, ` +
      `never silently split.</dd>`,
  );
  parts.push(
    `<dt>Task classes (classifier v${m.taskClassVersion})</dt><dd>${Object.values(TASK_CLASS_LABELS)
      .map(escapeHtml)
      .join(" · ")}.</dd>`,
  );
  if (m.policyEvents.length > 0) {
    parts.push(
      `<dt>Declared policy events</dt><dd>${m.policyEvents
        .map((e) => escapeHtml(`${e.date} — ${e.kind}${e.scope ? ` (${e.scope})` : ""}`))
        .join("; ")}.</dd>`,
    );
  }
  parts.push(`</dl>`);

  parts.push(`</body></html>`);
  return parts.join("\n");
}

// ─── CSV bundle ───────────────────────────────────────────────────────────────

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(cells: readonly (string | number)[]): string {
  return cells.map(csvCell).join(",");
}

/** `ticketKey, period, projectPath, accountUuid, cost, tokens, sessionCount,
 *  confidence` — the export shape 04 §4.1 defines, extended with the pack's
 *  scope columns (I-2) and reused for the pack's CSV bundle. `cost` goes
 *  through `formatMoneyCsv` rather than a bare `toFixed(2)` so a genuinely
 *  priced sub-cent row never renders as an indistinguishable "0.00" (I-6). */
export function renderTicketsCsv(model: JustificationPackModel): string {
  const lines = [
    csvLine([
      "ticketKey",
      "period",
      "projectPath",
      "accountUuid",
      "cost",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheCreationTokens",
      "sessionCount",
      "confidence",
    ]),
  ];
  for (const t of model.tickets ?? []) {
    lines.push(
      csvLine([
        t.ticketKey,
        model.period.label,
        model.scope.projectPath ? redactScopeValue(model.scope.projectPath) : "",
        model.scope.accountUuid ? redactScopeValue(model.scope.accountUuid) : "",
        formatMoneyCsv(t.cost),
        t.inputTokens,
        t.outputTokens,
        t.cacheReadTokens,
        t.cacheCreationTokens,
        t.sessionCount,
        t.confidence,
      ]),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** `confidence` is the classification tier for the class bucket (or `"n/a"`
 *  when the sessions in it were never classified) — I-5: a bare cost/session
 *  count with no quality signal at all was the gap here, unlike `tickets.csv`
 *  which already carried a confidence column per row. */
export function renderNonTicketCsv(model: JustificationPackModel): string {
  const lines = [csvLine(["taskClass", "period", "projectPath", "accountUuid", "cost", "sessionCount", "confidence"])];
  for (const row of model.nonTicket ?? []) {
    lines.push(
      csvLine([
        row.taskClass,
        model.period.label,
        model.scope.projectPath ? redactScopeValue(model.scope.projectPath) : "",
        model.scope.accountUuid ? redactScopeValue(model.scope.accountUuid) : "",
        formatMoneyCsv(row.cost),
        row.sessionCount,
        row.confidence ?? "n/a",
      ]),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * Carries the same honesty obligations the HTML headline renders — the
 * fallback-rate flag, the confidence mix, and unpriced tokens — into the CSV
 * (I-5). Without these columns a spreadsheet reader gets a bare total with
 * none of the qualification the HTML document carefully attaches to it.
 */
export function renderSummaryCsv(model: JustificationPackModel): string {
  const h = model.headline;
  const lines = [
    csvLine([
      "period",
      "projectPath",
      "accountUuid",
      "mode",
      "currency",
      "totalCost",
      "coverageRatio",
      "confidenceHigh",
      "confidenceMedium",
      "confidenceLow",
      "anyFallbackRates",
      "unknownTokens",
      "planFee",
      "reconciledInvoiceTotal",
      "reconciledRatio",
      "withinTolerance",
      "reconciliationResidual",
      "reconciliationScopeNote",
      "reconciliationCandidateCauses",
      // The three optional sections' headline figures. Empty when the section
      // was not opted into OR could not be computed — a spreadsheet reader
      // must not be able to tell those apart from a zero, so neither ever
      // renders as one.
      "hygieneWasteRatio",
      "hygieneWasteCost",
      "constraintNetEffect",
      "attributionAgreementRate",
      "attributionAgreementN",
    ]),
    csvLine([
      model.period.label,
      model.scope.projectPath ? redactScopeValue(model.scope.projectPath) : "",
      model.scope.accountUuid ? redactScopeValue(model.scope.accountUuid) : "",
      h.mode,
      h.currency,
      formatMoneyCsv(h.totalCost),
      h.coverageRatio != null ? h.coverageRatio.toFixed(4) : "",
      h.confidenceMix ? h.confidenceMix.high.toFixed(4) : "",
      h.confidenceMix ? h.confidenceMix.medium.toFixed(4) : "",
      h.confidenceMix ? h.confidenceMix.low.toFixed(4) : "",
      String(h.anyFallbackRates),
      h.unknownTokens,
      h.planFee != null ? h.planFee.toFixed(2) : "",
      h.reconciliation ? h.reconciliation.invoiceTotal.toFixed(2) : "",
      h.reconciliation ? h.reconciliation.ratio.toFixed(4) : "",
      h.reconciliation ? String(h.reconciliation.withinTolerance) : "",
      h.reconciliation ? formatMoneyCsv(h.reconciliation.residual) : "",
      h.reconciliation?.scopeNote ?? "",
      h.reconciliation ? h.reconciliation.candidateCauses.join(";") : "",
      model.hygiene?.available ? model.hygiene.wasteRatio.toFixed(4) : "",
      model.hygiene?.available ? formatMoneyCsv(model.hygiene.estimatedWaste) : "",
      model.constraint?.available && model.constraint.totalNetEffect !== null
        ? formatMoneyCsv(model.constraint.totalNetEffect)
        : "",
      // Null below the sample floor by construction, so an uncalibrated store
      // yields an empty cell rather than a rate nobody may quote.
      model.calibration?.available && model.calibration.rate !== null
        ? model.calibration.rate.toFixed(4)
        : "",
      model.calibration?.available ? model.calibration.n : "",
    ]),
  ];
  return lines.join("\r\n") + "\r\n";
}
