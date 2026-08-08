/**
 * Justification-pack types — the outward-facing deliverable a developer hands
 * a manager (doc/analysis/ticket-attribution/05-justification-pack.md).
 *
 * SYNC-GRADE REDACTION, enforced by type. This is the same pattern
 * `./shard.ts`'s `AggregateProjection` uses for the org-sync payload: every
 * row shape below is structurally INCAPABLE of carrying prompt text, file
 * paths, session ids, or raw evidence strings, because the forbidden field
 * names can never type-check onto these interfaces. The pack "runs the same
 * sensitivity rules as sync, not the looser rules of the local dashboard"
 * (05 §5.3) — so this file imports the org plane's own forbidden-field
 * vocabulary (`ForbiddenPersonalField`) and only ever ADDS to it, never
 * narrows it, which is what "reuse rather than write a second, weaker
 * filter" means in practice.
 */
import type { HasNoPersonalFields, ForbiddenPersonalField } from "./shard.js";
import type { AccountMode, Confidence, PolicyEvent, Reconciliation, TaskClass } from "./insight.js";

/** Pack-specific additions to the org plane's forbidden-field list: evidence
 *  text, per-session id arrays, and the LOCAL-ONLY `PolicyEvent.detail` field
 *  (types/insight.ts marks `detail` local-only — it must never leave the
 *  machine, so the pack's own policy-event shape omits it structurally). */
export type ForbiddenPackField = ForbiddenPersonalField | "sessionIds" | "evidence" | "detail";

/** True iff `T` names no field forbidden on an outward-facing pack payload. */
export type HasNoForbiddenPackFields<T> =
  Extract<keyof T, ForbiddenPackField> extends never ? true : false;

export type JustificationPackSectionId =
  | "headline"
  | "tickets"
  | "nonticket"
  | "hygiene"
  | "constraint"
  | "calibration";

/** One per-ticket row — the same `ticketKey, period, cost, tokens, confidence,
 *  sessionCount` shape the CSV exports already define (04 §4.1). */
export interface PackTicketRow {
  readonly ticketKey: string;
  readonly cost: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly sessionCount: number;
  readonly confidence: Confidence;
}

/** One row of the "non-ticket work" breakdown — the explained remainder,
 *  grouped by task class (04 §4.2 rule 3), never by free-text label. */
export interface PackNonTicketRow {
  readonly taskClass: TaskClass | "unclassified";
  readonly cost: number;
  readonly sessionCount: number;
  /** The classifier's own confidence tier for this bucket (cost-weighted
   *  majority when a class mixes tiers), or null when the sessions in it were
   *  never classified at all (the `unclassified` bucket) — a bare number with
   *  no tier is a different honesty gap than one that's low-confidence, and
   *  the two must not collapse into the same rendering (I-5). */
  readonly confidence: Confidence | null;
}

/** The pack's reconciliation block is exactly the shared `Reconciliation`
 *  shape — no pack-specific fields, so a residual and its named causes read
 *  identically wherever reconciliation appears (pack, dashboard, CLI). */
export type PackReconciliation = Reconciliation;

export interface PackHeadline {
  readonly mode: AccountMode;
  readonly currency: string;
  readonly totalCost: number;
  /** Salary-denominator framing, or null when no hourly rate is configured. */
  readonly devTimeLabel: string | null;
  readonly coverageRatio: number | null;
  readonly coverageCaveat: string | null;
  /** The cost caveat sentence from `insight.ts`'s `costCaveat` — quoted, not
   *  reworded, so the pack and the dashboard never disagree. */
  readonly costCaveatText: string;
  readonly reconciliation: PackReconciliation | null;
  /** Configured monthly plan fee — populated only in `mode: "plan"`, null for
   *  metered accounts or when no fee is configured (I-4: previously computed
   *  by the caller and discarded, so a plan-mode pack never stated the one
   *  number a manager comparing plan against metered actually needs). */
  readonly planFee: number | null;
  /** True when any priced usage this period fell back to first-party rates —
   *  the same signal `costCaveatText`'s prose already carries, exposed as a
   *  raw flag too so a CSV/appendix reader gets it without parsing a sentence. */
  readonly anyFallbackRates: boolean;
  /** Tokens whose model had no pricing row this period, carried through from
   *  `TicketCostReport.unknownTokens` (I-3) — a pack that hides this is the
   *  one surface silently understating spend that every other surface caveats. */
  readonly unknownTokens: number;
  /** Attributed cost split by evidence tier, as a fraction of attributedCost
   *  (sums to 1). Null when there is no attributed cost to split. The same
   *  mix `coverageCaveat`'s prose describes, exposed as numbers for the CSV. */
  readonly confidenceMix: Readonly<Record<Confidence, number>> | null;
}

/** A policy event as it may appear in the pack — `detail` deliberately
 *  dropped (LOCAL-ONLY per `types/insight.ts`'s `PolicyEvent`). */
export interface PackMethodologyPolicyEvent {
  readonly date: string;
  readonly kind: PolicyEvent["kind"];
  readonly scope: PolicyEvent["scope"] | null;
}

export interface PackMethodology {
  readonly pricingVerifiedDate: string;
  readonly taskClassVersion: number;
  readonly languageMode: AccountMode;
  readonly policyEvents: readonly PackMethodologyPolicyEvent[];
}

/**
 * An opted-in section with nothing to report, plus the concrete step that
 * would give it something.
 *
 * This is NOT "the feature isn't built" — the three optional sections are all
 * wired to real engines. It is the honest empty state: no policy event has
 * been declared, or the window carries no spend to divide waste by. `reason`
 * says which; `enablementPath` says what to do about it. A section that can
 * only say "unavailable" and leaves the reader no way to produce the number
 * is the failure this shape exists to prevent.
 */
export interface PackSectionUnavailable {
  readonly available: false;
  readonly reason: string;
  readonly enablementPath: string | null;
}

/** Direction of travel vs the comparable previous window — the same vocabulary
 *  `insight.ts#trendOf` produces. Restated here rather than imported so this
 *  types module keeps its one-way dependency on `types/insight.js`; the
 *  builders assign `trendOf`'s output straight into it, so a drift in either
 *  union fails to compile. */
export type PackTrend = "up" | "down" | "flat" | "unknown";

/**
 * One detector's contribution to the hygiene section — a COUNT and a cost,
 * never the findings themselves.
 *
 * `HygieneFinding` carries `sessionIds` and free-text evidence. Both are
 * deliberately dropped here: the efficiency-hygiene design states that only
 * the aggregate trend is meant to leave the machine, never a per-session or
 * per-developer feed, and this document is the one artifact built to leave.
 * `sessionIds` is additionally a `ForbiddenPackField`, so the omission is
 * enforced by the compile-time assertions at the bottom of this file rather
 * than by this comment.
 */
export interface PackHygieneDetectorRow {
  readonly detectorId: string;
  readonly title: string;
  readonly findingCount: number;
  readonly estimatedWaste: number;
  /** False when the detector could not run for lack of a required input —
   *  distinct from "ran and found nothing", which is a clean sheet. */
  readonly computed: boolean;
  /** Set only when `computed` is false. */
  readonly enablementPath: string | null;
}

/** Self-audited waste as a share of spend, and its direction of travel. */
export interface PackHygieneSection {
  readonly available: true;
  readonly totalCost: number;
  readonly estimatedWaste: number;
  /** `estimatedWaste / totalCost`. Never a bare 0 standing in for "no spend
   *  to divide by" — that case is a `PackSectionUnavailable` instead. */
  readonly wasteRatio: number;
  /** The same ratio over the immediately-preceding window of equal length,
   *  or null when there was no prior spend to compare against. */
  readonly previousWasteRatio: number | null;
  readonly trend: PackTrend;
  readonly findingCount: number;
  readonly detectors: readonly PackHygieneDetectorRow[];
  /** Detector ids the developer has switched off. Reported so a suppressed
   *  detector cannot make the sheet merely LOOK clean. */
  readonly suppressedDetectorIds: readonly string[];
}

/** Loose direction read off a class's net effect — `insight`-side vocabulary
 *  restated for the same reason as {@link PackTrend}. */
export type PackImpactDirection = "favorable" | "unfavorable" | "negligible" | "unknown";

/** One task class's before/after row. `insufficient-data` rows are carried,
 *  not dropped: a report that silently omits the classes it could not compare
 *  looks complete when it is not. */
export interface PackConstraintClassRow {
  readonly classKey: string;
  readonly grain: "fine" | "coarse";
  readonly verdict: "compared" | "insufficient-data";
  readonly nBefore: number;
  readonly nAfter: number;
  readonly avgCostBefore: number | null;
  readonly avgCostAfter: number | null;
  readonly tokenSavingsAtAfterVolume: number | null;
  readonly devTimeCostAtAfterVolume: number | null;
  readonly netEffectAtAfterVolume: number | null;
  readonly direction: PackImpactDirection;
}

/**
 * Before/after across one declared policy boundary.
 *
 * `comparisonScope` is `"all-recorded-history"` and says so as a machine
 * token, because this is the one section whose window is NOT the pack's
 * period: a month-long slice either side of a boundary rarely clears the
 * per-class session floor, so the comparison spans everything recorded on
 * each side. The calibration section states its own scope for the same
 * reason. A figure whose window the reader has to assume is a claim stronger
 * than its basis.
 */
export interface PackConstraintSection {
  readonly available: true;
  readonly policyEvent: PackMethodologyPolicyEvent;
  readonly comparisonScope: "all-recorded-history";
  readonly currency: string;
  readonly minSessionsPerClass: number;
  readonly classesCompared: number;
  readonly classesInsufficientData: number;
  readonly totalTokenSavings: number | null;
  readonly totalDevTimeCost: number | null;
  readonly totalNetEffect: number | null;
  /** False when no hourly rate is configured, so the dev-time half of the
   *  ledger has no price and the net effect cannot be stated at all. */
  readonly netEffectAvailable: boolean;
  readonly classes: readonly PackConstraintClassRow[];
  /** What this comparison deliberately does not compute. */
  readonly notMeasured: readonly string[];
  readonly confoundNote: string;
  /** Declared policy events OTHER than the one compared here. They are all
   *  listed in the methodology appendix; this count is what stops the section
   *  from reading as "the only policy change there was". */
  readonly otherPolicyEventCount: number;
}

/**
 * How well the automatic attribution pass agrees with the developer's own
 * rulings — the footnote every ticket figure above rests on.
 *
 * Attribution, not outcome: the pack's numbers are attribution-derived, and
 * outcome calibration is gathered over a different window by a much more
 * expensive path. `state: "uncalibrated"` is a first-class, fully-available
 * answer — `rate` and `interval` are both null there by construction, so a
 * renderer cannot print a percentage from a sample too small to support one.
 */
export interface PackCalibrationSection {
  readonly available: true;
  readonly subject: "attribution";
  /** `"whole-store"` — every ruling ever made, not this period's. Stated,
   *  because the section sits inside a period-scoped document. */
  readonly scope: string;
  readonly state: "measured" | "uncalibrated";
  readonly n: number;
  readonly agreed: number;
  readonly disagreed: number;
  readonly rate: number | null;
  readonly interval: { readonly lo: number; readonly hi: number } | null;
  readonly minN: number;
  readonly needed: number;
  /** Stable machine token for what the rate is a rate OF — never "accuracy". */
  readonly measures: "agreement-on-reviewed-subset";
  /** The localized honesty sentence, quoted from `insight.ts` so the pack and
   *  the dashboard can never disagree about what the figure means. */
  readonly caveat: string;
  /** The localized labelling nudge; null once measured. */
  readonly enablement: string | null;
  /** Manual links naming a ticket the automatic pass never proposed — a
   *  RECALL figure, reported beside the rate and never folded into it. */
  readonly unproposed: number;
}

/**
 * What this generation was filtered to — null in either field means "no
 * filter", not "unknown" (I-2). Rendered prominently in every surface of the
 * pack (headline meta line, all three CSVs, methodology appendix) so a
 * project- or account-scoped pack is never textually indistinguishable from
 * one covering the whole machine.
 */
export interface PackScope {
  readonly projectPath: string | null;
  readonly accountUuid: string | null;
}

export interface JustificationPackModel {
  /** Epoch ms, injected — core never calls `Date.now()`, so a pack
   *  regenerated later from the same inputs is byte-identical. */
  readonly generatedAt: number;
  readonly period: { readonly since: number; readonly until: number; readonly label: string };
  readonly scope: PackScope;
  readonly sections: readonly JustificationPackSectionId[];
  readonly headline: PackHeadline;
  /** Null when "tickets" was not opted into this generation. */
  readonly tickets: readonly PackTicketRow[] | null;
  /** Null when "nonticket" was not opted into this generation. */
  readonly nonTicket: readonly PackNonTicketRow[] | null;
  readonly methodology: PackMethodology;
  /** Null in each of the three below means "not opted into this generation",
   *  and the section is omitted from the document entirely. Opted in, a
   *  section is either its computed shape or a `PackSectionUnavailable`
   *  carrying the reason and the way out. */
  readonly hygiene: PackHygieneSection | PackSectionUnavailable | null;
  readonly constraint: PackConstraintSection | PackSectionUnavailable | null;
  readonly calibration: PackCalibrationSection | PackSectionUnavailable | null;
}

// ─── Compile-time plane-separation invariants ────────────────────────────────
// If any pack row type ever grows a forbidden field, these lines fail to
// compile — the same mechanism `types/shard.ts` uses for `AggregateProjection`.

type Assert<T extends true> = T;
type _PackTicketRowSafe = Assert<HasNoForbiddenPackFields<PackTicketRow>>;
type _PackNonTicketRowSafe = Assert<HasNoForbiddenPackFields<PackNonTicketRow>>;
type _PackMethodologyPolicyEventSafe = Assert<HasNoForbiddenPackFields<PackMethodologyPolicyEvent>>;
type _PackHeadlineSafe = Assert<HasNoForbiddenPackFields<PackHeadline>>;
// The three engine-fed sections run the same gate. `PackHygieneDetectorRow` is
// the one that would fail loudest: `HygieneFinding.sessionIds` is exactly the
// field a "just pass the findings through" change would carry in.
type _PackHygieneDetectorRowSafe = Assert<HasNoForbiddenPackFields<PackHygieneDetectorRow>>;
type _PackHygieneSectionSafe = Assert<HasNoForbiddenPackFields<PackHygieneSection>>;
type _PackConstraintClassRowSafe = Assert<HasNoForbiddenPackFields<PackConstraintClassRow>>;
type _PackConstraintSectionSafe = Assert<HasNoForbiddenPackFields<PackConstraintSection>>;
type _PackCalibrationSectionSafe = Assert<HasNoForbiddenPackFields<PackCalibrationSection>>;
// Re-assert the underlying org-plane invariant is actually imported and live,
// not merely referenced in a comment.
type _ReusesOrgPlaneVocabulary = Assert<HasNoPersonalFields<PackTicketRow>>;
export type {
  _PackTicketRowSafe,
  _PackNonTicketRowSafe,
  _PackMethodologyPolicyEventSafe,
  _PackHeadlineSafe,
  _PackHygieneDetectorRowSafe,
  _PackHygieneSectionSafe,
  _PackConstraintClassRowSafe,
  _PackConstraintSectionSafe,
  _PackCalibrationSectionSafe,
  _ReusesOrgPlaneVocabulary,
};
