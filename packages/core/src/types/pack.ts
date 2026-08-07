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

/** Enablement sentence for an opted-in section this build cannot yet compute,
 *  or null when the section wasn't opted into (and is simply omitted). */
export interface PackUnavailableSections {
  readonly hygiene: string | null;
  readonly constraint: string | null;
  readonly calibration: string | null;
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
  readonly unavailableSections: PackUnavailableSections;
}

// ─── Compile-time plane-separation invariants ────────────────────────────────
// If any pack row type ever grows a forbidden field, these lines fail to
// compile — the same mechanism `types/shard.ts` uses for `AggregateProjection`.

type Assert<T extends true> = T;
type _PackTicketRowSafe = Assert<HasNoForbiddenPackFields<PackTicketRow>>;
type _PackNonTicketRowSafe = Assert<HasNoForbiddenPackFields<PackNonTicketRow>>;
type _PackMethodologyPolicyEventSafe = Assert<HasNoForbiddenPackFields<PackMethodologyPolicyEvent>>;
type _PackHeadlineSafe = Assert<HasNoForbiddenPackFields<PackHeadline>>;
// Re-assert the underlying org-plane invariant is actually imported and live,
// not merely referenced in a comment.
type _ReusesOrgPlaneVocabulary = Assert<HasNoPersonalFields<PackTicketRow>>;
export type {
  _PackTicketRowSafe,
  _PackNonTicketRowSafe,
  _PackMethodologyPolicyEventSafe,
  _PackHeadlineSafe,
  _ReusesOrgPlaneVocabulary,
};
