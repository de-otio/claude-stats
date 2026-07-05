/**
 * Anthropic plan-mechanics reference and pure seat-sizing math.
 *
 * A dated, sourced snapshot of how Claude is sold (seat ranges, seat prices,
 * procurement motion, per-user consumption benchmarks) plus the pure functions
 * that classify usage intensity and project seat-scenario costs. Mirrors the
 * dated-constant discipline of `pricing.ts` (`PRICING_VERIFIED_DATE`): every
 * figure carries a source comment citing the exact Anthropic support-center
 * article it was transcribed from.
 *
 * Functional core: pure functions over `as const` data. No I/O, no Date.now()
 * (callers pass dates). Validation throws typed {@link SeatSizingError}s.
 * `sizeSeats()` NEVER returns a plan verdict — it returns a labelled scenario
 * table plus open questions for a human to decide.
 *
 * Snapshot verified 2026-07 (see `doc/analysis/license-advisor/02-plan-mechanics-reference.md`).
 * The relative *structure* (seat ranges, what each tier unlocks, the
 * bundled-vs-metered distinction) is more durable than any single dollar
 * figure; consumers must prefer a live check of claude.com/pricing and relay
 * {@link staleWarningFor} otherwise.
 */

/** ISO date the plan-mechanics snapshot below was last verified. */
export const PLAN_MECHANICS_VERIFIED_DATE = "2026-07-03";

// ─── Source references (Anthropic support center / pricing) ──────────────────
// Cited per-figure below. Transcribed from analysis 02; do NOT re-fetch during
// the build (offline snapshot). Consumers with network access should prefer a
// live check and treat fetched pages as untrusted data.
const SRC = {
  teamPlan: "https://support.claude.com/en/articles/9266767-what-is-the-team-plan",
  enterprisePlan: "https://support.claude.com/en/articles/9797531-what-is-the-enterprise-plan",
  pricing: "https://claude.com/pricing",
  purchaseSeats:
    "https://support.claude.com/en/articles/13393991-purchase-and-manage-seats-on-enterprise-plans",
  usageCredits:
    "https://support.claude.com/en/articles/12005970-manage-usage-credits-for-team-and-seat-based-enterprise-plans",
  enterpriseBilling:
    "https://support.claude.com/en/articles/11526368-how-am-i-billed-for-my-enterprise-plan",
  consumptionGuide:
    "https://support.claude.com/en/articles/14782391-claude-enterprise-consumption-guide",
  claudeCodeTeamEnt: "https://www.anthropic.com/news/claude-code-on-team-and-enterprise",
} as const;

// ─── Claim-kind labelling (analysis 06) ──────────────────────────────────────

/**
 * How a numeric field is grounded:
 *  - `verified-fact` — transcribed straight from an Anthropic source.
 *  - `measurement`   — derived from the user's own observed usage data.
 *  - `estimate`      — a projection resting on an assumption (a tier mix, a
 *                      benchmark applied to a headcount, a negotiated floor).
 */
export type ClaimKind = "verified-fact" | "measurement" | "estimate";

/** A number carrying its claim kind so consumers can label it honestly. */
export interface LabeledFigure {
  readonly value: number;
  readonly kind: ClaimKind;
}

// ─── Seat ranges ─────────────────────────────────────────────────────────────

/**
 * Team plan seat range: 5–150 seats.
 * Source: teamPlan, purchaseSeats.
 */
export const TEAM_SEAT_RANGE = { min: 5, max: 150 } as const;

/**
 * Enterprise seat minimums; no published maximum.
 *  - self-serve (org settings): 20 seats
 *  - sales-assisted (named account team): 50 seats
 * Source: enterprisePlan, purchaseSeats.
 */
export const ENTERPRISE_MINIMUMS = { selfServe: 20, salesAssisted: 50 } as const;

// ─── Seat prices ─────────────────────────────────────────────────────────────

/**
 * List seat prices, USD per seat per month, at each billing cadence.
 * Team bundles a usage allowance; Enterprise seat fee buys platform access
 * ONLY (every token metered at API rates from the first request).
 *
 * Sources:
 *  - team_standard $20 (annual) / $25 (monthly): teamPlan, pricing.
 *  - team_premium  $100 (annual) / $125 (monthly), includes Claude Code: teamPlan, pricing.
 *  - enterprise seat fee floor ~$20/seat (actual pricing negotiated), usage
 *    metered at API rates: enterprisePlan, enterpriseBilling.
 */
export const SEAT_PRICING = {
  team_standard: {
    annualBillingMonthly: 20,
    monthlyBillingMonthly: 25,
    usageModel: "bundled-allowance", // ~1.25× an individual Pro plan per 5-hour window
  },
  team_premium: {
    annualBillingMonthly: 100,
    monthlyBillingMonthly: 125,
    usageModel: "bundled-allowance", // ~6.25× Pro; includes Claude Code
  },
  enterprise: {
    // Quoted floor; the actual seat fee is negotiated with the account team.
    seatFeeFloorMonthly: 20,
    usageModel: "metered-at-api-rates", // no bundled allowance; bounded by configured spend limits
  },
} as const;

// ─── Procurement motion ──────────────────────────────────────────────────────

/**
 * How each purchase path is acquired and its lead time — the friction the
 * seat-ceiling math is really about (crossing into a *sales-assisted*
 * Enterprise contract introduces a multi-week cycle a self-serve Team purchase
 * never has). Source: purchaseSeats.
 */
export type ProcurementMotion =
  | "team-self-serve"
  | "enterprise-self-serve"
  | "enterprise-sales-assisted";

export const PROCUREMENT_MOTION = {
  "team-self-serve": {
    howToBuy: "Self-serve, credit card",
    leadTime: "minutes",
    seatRange: "5–150",
  },
  "enterprise-self-serve": {
    howToBuy: "Self-serve, org settings",
    leadTime: "minutes–hours",
    seatRange: "20–49",
  },
  "enterprise-sales-assisted": {
    howToBuy: "Named Anthropic account team",
    leadTime: "weeks", // typical enterprise sales cycle
    seatRange: "50+",
  },
} as const;

// ─── Per-user monthly consumption benchmarks (Anthropic's own) ───────────────

/**
 * Anthropic's published per-user monthly planning benchmarks (USD/mo), by
 * surface and intensity. Published specifically because current-model
 * Enterprise has no bundled allowance to size against. Anthropic's caveat:
 * "these figures are rough planning estimates — actual consumption will vary."
 * Source: consumptionGuide.
 *
 *   intensity      | Claude Code | Cowork | Chat
 *   Power (top 10%)|   $500      |  $100  |  $90
 *   Typical (mean) |   $215      |   $40  |  $30
 *   Light (median) |    $40      |   $10  |   $5
 */
export const PER_USER_MONTHLY_BENCHMARKS = {
  claude_code: { power: 500, typical: 215, light: 40 },
  cowork: { power: 100, typical: 40, light: 10 },
  chat: { power: 90, typical: 30, light: 5 },
} as const;

/** The surface claude-stats instruments in detail; used for intensity + cost math. */
const CC_BENCHMARK = PER_USER_MONTHLY_BENCHMARKS.claude_code;

// ─── What Enterprise adds beyond seat count (analysis 02) ────────────────────

/**
 * Capabilities Enterprise unlocks that Team does not — none of which require
 * crossing 150 seats. A compliance-driven org can reasonably choose Enterprise
 * at the 20-seat self-serve minimum on these merits alone. Each is a
 * `verified-fact` with its source; `get_plan_mechanics_reference` is the only
 * offline surface for this list. Source: claudeCodeTeamEnt.
 */
export const ENTERPRISE_ADDS = [
  {
    feature: "SSO/SCIM (automated provisioning tied to the org's identity provider)",
    kind: "verified-fact",
    source: SRC.claudeCodeTeamEnt,
  },
  { feature: "Audit logs", kind: "verified-fact", source: SRC.claudeCodeTeamEnt },
  { feature: "Custom data retention controls", kind: "verified-fact", source: SRC.claudeCodeTeamEnt },
  {
    feature: "Compliance & Analytics APIs (programmatic usage/cost data, not just CSV export)",
    kind: "verified-fact",
    source: SRC.claudeCodeTeamEnt,
  },
  {
    feature: "Customer-managed encryption keys (CMK), US-only inference option",
    kind: "verified-fact",
    source: SRC.claudeCodeTeamEnt,
  },
  {
    feature: "Org / seat-tier / per-user spend limits (more granular than Team's)",
    kind: "verified-fact",
    source: SRC.claudeCodeTeamEnt,
  },
] as const;

// ─── Staleness contract ──────────────────────────────────────────────────────

/**
 * Render the mandatory staleness warning. Pure (the caller passes the date, so
 * this stays deterministic and testable). Default arg is the module snapshot
 * date so the common call site needs no argument.
 */
export function staleWarningFor(dateIso: string = PLAN_MECHANICS_VERIFIED_DATE): string {
  return `cached reference as of ${dateIso}; re-verify at claude.com/pricing before purchasing`;
}

// ─── Usage-intensity classification ──────────────────────────────────────────

export type UsageIntensityTierName = "light" | "typical" | "power";

/**
 * Classification of a monthly-equivalent cost against the Claude Code
 * benchmarks. Shape is a superset of the dashboard `usageIntensityTier` field
 * (adds nothing the consumer must strip) so it can be assigned directly.
 */
export interface UsageIntensityTier {
  readonly tier: UsageIntensityTierName;
  readonly benchmarkUsd: number;
  readonly source: "anthropic-benchmark";
}

/**
 * Thresholds are the midpoints between the Claude Code benchmark figures,
 * DERIVED here from the benchmark constants rather than hand-coded — so if the
 * benchmarks ever change, the thresholds move with them (the drift lesson from
 * analysis 03). With power 500 / typical 215 / light 40:
 *   lightToTypical = (40 + 215) / 2 = 127.5
 *   typicalToPower = (215 + 500) / 2 = 357.5
 */
export const USAGE_INTENSITY_THRESHOLDS = {
  lightToTypical: (CC_BENCHMARK.light + CC_BENCHMARK.typical) / 2,
  typicalToPower: (CC_BENCHMARK.typical + CC_BENCHMARK.power) / 2,
} as const;

/**
 * Classify a monthly-equivalent cost (USD) into a usage-intensity tier.
 * Pure; thresholds derived from {@link PER_USER_MONTHLY_BENCHMARKS}.
 */
export function classifyUsageIntensity(monthlyCostUsd: number): UsageIntensityTier {
  if (monthlyCostUsd < USAGE_INTENSITY_THRESHOLDS.lightToTypical) {
    return { tier: "light", benchmarkUsd: CC_BENCHMARK.light, source: "anthropic-benchmark" };
  }
  if (monthlyCostUsd < USAGE_INTENSITY_THRESHOLDS.typicalToPower) {
    return { tier: "typical", benchmarkUsd: CC_BENCHMARK.typical, source: "anthropic-benchmark" };
  }
  return { tier: "power", benchmarkUsd: CC_BENCHMARK.power, source: "anthropic-benchmark" };
}

// ─── Seat sizing ─────────────────────────────────────────────────────────────

/** Fraction of the seated population at each Claude Code intensity; sums to ~1. */
export interface TierMix {
  readonly light: number;
  readonly typical: number;
  readonly power: number;
}

/**
 * Generic default tier mix used when the caller has no measured distribution.
 * A defensible split given Anthropic's descriptors — "light (median)" (so the
 * median user is light → the bulk), "typical (mean)", "power (top 10%)":
 * light 0.5 / typical 0.4 / power 0.1. Labelled `anthropic-benchmark`. A caller
 * with real Claude Code usage data should pass a `measured` mix instead.
 */
export const DEFAULT_TIER_MIX: TierMix = { light: 0.5, typical: 0.4, power: 0.1 };

/** Default adoption fractions of the technical population that get seats. */
export const DEFAULT_ADOPTION_SCENARIOS = [0.25, 0.5, 0.75, 1.0] as const;

/** Hard cap on scenario rows, to bound output size. */
export const MAX_ADOPTION_SCENARIOS = 20;

export interface SizeSeatsInput {
  readonly headcount: number;
  readonly technicalFraction: number;
  readonly tierMix?: TierMix;
  readonly adoptionScenarios?: readonly number[];
  /**
   * Whether the caller-supplied `tierMix` is a real measured distribution
   * (`true`) or should be treated as the benchmark default (`false`/omitted).
   * Only meaningful when `tierMix` is supplied.
   */
  readonly tierMixMeasured?: boolean;
}

export type SeatSizingErrorCode =
  | "headcount-invalid"
  | "fraction-invalid"
  | "tiermix-invalid"
  | "tiermix-sum"
  | "adoption-fraction-invalid"
  | "too-many-scenarios";

/** Typed validation error thrown by {@link sizeSeats}. */
export class SeatSizingError extends Error {
  readonly code: SeatSizingErrorCode;
  constructor(code: SeatSizingErrorCode, message: string) {
    super(message);
    this.name = "SeatSizingError";
    this.code = code;
  }
}

export interface SeatScenarioRow {
  /** The adoption fraction that produced this row. */
  readonly adoptionFraction: number;
  /** Seated population = round(headcount × technicalFraction × adoptionFraction). */
  readonly seats: number;
  /** True when `seats` is within Team's 5–150 range. */
  readonly fitsTeamRange: boolean;
  /** Simplest procurement path for this seat count (compliance may force Enterprise regardless — see openQuestions). */
  readonly procurementMotion: ProcurementMotion;
  /** Team seats split into Standard vs Premium by the tier mix (heavy CC users → Premium). */
  readonly teamStandardSeats: number;
  readonly teamPremiumSeats: number;
  /** Projected Team monthly cost (monthly-billing list prices × the split). */
  readonly teamMonthlyCost: LabeledFigure;
  /** Projected Enterprise seat fee (seats × negotiated floor). */
  readonly enterpriseSeatFeeMonthly: LabeledFigure;
  /** Projected Enterprise metered usage (tier mix × Claude Code benchmarks). */
  readonly enterpriseMeteredMonthly: LabeledFigure;
  /** Projected Enterprise total (seat fee + metered). */
  readonly enterpriseTotalMonthly: LabeledFigure;
}

export interface SeatScenarioTable {
  readonly headcount: number;
  readonly technicalFraction: number;
  /** The technical population = round(headcount × technicalFraction). */
  readonly technicalPopulation: number;
  readonly tierMix: TierMix;
  readonly tierMixSource: "anthropic-benchmark" | "measured";
  readonly rows: readonly SeatScenarioRow[];
  /** Strategic choices surfaced, never resolved (analysis 06). */
  readonly openQuestions: readonly string[];
  readonly verifiedDate: string;
  readonly staleWarning: string;
}

/**
 * Strategic choices a recommendation must present, not silently pick
 * (analysis 02, framework triggers 2/4/5). Emitted verbatim in every
 * {@link SeatScenarioTable}.
 */
export const SEAT_SIZING_OPEN_QUESTIONS: readonly string[] = [
  "Compliance trigger: does your org handle regulated or customer data under obligations that make SSO/SCIM, audit logs, or custom retention non-cosmetic? This can force Enterprise regardless of seat count — a legal/IT judgment call, not a data question.",
  "Spend-limit philosophy (Enterprise only): size per-user/org limits tight to the 'typical' benchmark (cost-predictable, power users occasionally throttled) OR at 2–3× the 'power' benchmark (usage-maximizing, limit as insurance against non-human failure modes like a leaked key). Both are legitimate; pick deliberately.",
  "Timing trigger: given the multi-week sales-assisted Enterprise lead time, decide the committed-seat count at which to start the Enterprise conversation — starting early converts a hard ceiling into a non-event.",
] as const;

/**
 * Simplest procurement path for a raw seat count. Team covers 5–150 self-serve;
 * above 150 the Team ceiling is exceeded and Enterprise is forced (and >150 is
 * always ≥ the 50-seat sales-assisted threshold, so it is sales-assisted).
 * `enterprise-self-serve` is a compliance-driven choice at 20–49 seats where
 * Team still fits — surfaced as an open question, not derived from seat count.
 */
export function procurementMotionForSeats(seats: number): ProcurementMotion {
  return seats > TEAM_SEAT_RANGE.max ? "enterprise-sales-assisted" : "team-self-serve";
}

/**
 * Project seat-scenario cost tables from a headcount and technical fraction.
 * Pure arithmetic; validates inputs and throws {@link SeatSizingError} on
 * violation. NEVER returns a plan verdict — returns labelled figures and open
 * questions for a human to decide.
 */
export function sizeSeats(input: SizeSeatsInput): SeatScenarioTable {
  const { headcount, technicalFraction } = input;

  if (!Number.isInteger(headcount) || headcount < 1) {
    throw new SeatSizingError(
      "headcount-invalid",
      `headcount must be an integer ≥ 1, got ${headcount}`,
    );
  }
  if (!Number.isFinite(technicalFraction) || technicalFraction < 0 || technicalFraction > 1) {
    throw new SeatSizingError(
      "fraction-invalid",
      `technicalFraction must be in [0, 1], got ${technicalFraction}`,
    );
  }

  const measured = input.tierMix !== undefined && input.tierMixMeasured === true;
  const tierMix = input.tierMix ?? DEFAULT_TIER_MIX;
  const tierMixSource: SeatScenarioTable["tierMixSource"] = measured
    ? "measured"
    : "anthropic-benchmark";

  for (const [name, v] of [
    ["light", tierMix.light],
    ["typical", tierMix.typical],
    ["power", tierMix.power],
  ] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new SeatSizingError(
        "tiermix-invalid",
        `tierMix.${name} must be in [0, 1], got ${v}`,
      );
    }
  }
  const mixSum = tierMix.light + tierMix.typical + tierMix.power;
  if (Math.abs(mixSum - 1) > 1e-6) {
    throw new SeatSizingError("tiermix-sum", `tierMix must sum to 1, got ${mixSum}`);
  }

  const scenarios = input.adoptionScenarios ?? DEFAULT_ADOPTION_SCENARIOS;
  if (scenarios.length > MAX_ADOPTION_SCENARIOS) {
    throw new SeatSizingError(
      "too-many-scenarios",
      `adoptionScenarios capped at ${MAX_ADOPTION_SCENARIOS}, got ${scenarios.length}`,
    );
  }
  for (const f of scenarios) {
    if (!Number.isFinite(f) || f < 0 || f > 1) {
      throw new SeatSizingError(
        "adoption-fraction-invalid",
        `adoptionScenarios entries must be in [0, 1], got ${f}`,
      );
    }
  }

  const technicalPopulation = Math.round(headcount * technicalFraction);
  // Heavy Claude Code users (typical + power) map to Premium seats (Premium
  // includes Claude Code); light users map to Standard.
  const premiumFraction = tierMix.typical + tierMix.power;
  // Per-seat metered benchmark (Claude Code), weighted by the tier mix.
  const meteredPerSeat =
    tierMix.light * CC_BENCHMARK.light +
    tierMix.typical * CC_BENCHMARK.typical +
    tierMix.power * CC_BENCHMARK.power;

  const rows: SeatScenarioRow[] = scenarios.map((adoptionFraction) => {
    const seats = Math.round(technicalPopulation * adoptionFraction);
    const teamPremiumSeats = Math.round(seats * premiumFraction);
    const teamStandardSeats = seats - teamPremiumSeats;

    const teamMonthly =
      teamStandardSeats * SEAT_PRICING.team_standard.monthlyBillingMonthly +
      teamPremiumSeats * SEAT_PRICING.team_premium.monthlyBillingMonthly;
    const enterpriseSeatFee = seats * SEAT_PRICING.enterprise.seatFeeFloorMonthly;
    const enterpriseMetered = seats * meteredPerSeat;

    return {
      adoptionFraction,
      seats,
      fitsTeamRange: seats >= TEAM_SEAT_RANGE.min && seats <= TEAM_SEAT_RANGE.max,
      procurementMotion: procurementMotionForSeats(seats),
      teamStandardSeats,
      teamPremiumSeats,
      // Every projection is an estimate: it rests on the tier-mix assumption and
      // the (negotiated) Enterprise seat floor, even when the mix is measured.
      teamMonthlyCost: { value: teamMonthly, kind: "estimate" },
      enterpriseSeatFeeMonthly: { value: enterpriseSeatFee, kind: "estimate" },
      enterpriseMeteredMonthly: { value: enterpriseMetered, kind: "estimate" },
      enterpriseTotalMonthly: { value: enterpriseSeatFee + enterpriseMetered, kind: "estimate" },
    };
  });

  return {
    headcount,
    technicalFraction,
    technicalPopulation,
    tierMix,
    tierMixSource,
    rows,
    openQuestions: SEAT_SIZING_OPEN_QUESTIONS,
    verifiedDate: PLAN_MECHANICS_VERIFIED_DATE,
    staleWarning: staleWarningFor(PLAN_MECHANICS_VERIFIED_DATE),
  };
}
