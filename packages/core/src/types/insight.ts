/**
 * Shared domain vocabulary for the insight suite — ticket attribution,
 * constraint impact, efficiency hygiene, and the answer-first dashboard.
 *
 * Type-only by design (no runtime), so every lane compiles against the same
 * names without importing each other's implementations. Runtime validators and
 * formatters live beside this file in `../tickets.ts` and `../insight.ts`.
 *
 * Design: doc/analysis/{ticket-attribution,constraint-impact,
 * efficiency-hygiene,gui-redesign}/.
 */

// ─── Ticket attribution ───────────────────────────────────────────────────────

/**
 * A validated Jira-style work-item key (`PROJ-123`). Branded so an unvalidated
 * string cannot reach the store or a sync shape by accident — construct via
 * `parseTicketKey` / `isTicketKey` in `../tickets.ts`.
 */
export type TicketKey = string & { readonly __brand: "TicketKey" };

/**
 * Where an attribution came from. Ordering here is NOT the confidence order —
 * confidence is assigned per-source by the extractor and can be upgraded when
 * independent sources agree (doc/analysis/ticket-attribution/01 §1.2).
 */
export type AttributionSource = "tag" | "branch" | "commit" | "prompt";

/** Evidence grade carried by every attributed figure. Never dropped in a report. */
export type Confidence = "high" | "medium" | "low";

/**
 * Whether a link covers a whole session or a message range within it. A session
 * with links to two tickets and only session-granular evidence is AMBIGUOUS and
 * must be reported as such — never silently split (01 §1.3).
 */
export type LinkGranularity = "session" | "messages";

/** One row of `ticket_links` (schema V19). */
export interface TicketLink {
  sessionId: string;
  ticketKey: TicketKey;
  source: AttributionSource;
  confidence: Confidence;
  granularity: LinkGranularity;
  /** Message-range bounds when `granularity === "messages"`. */
  firstUuid: string | null;
  lastUuid: string | null;
  /** Matched branch name / commit subject. LOCAL-ONLY — never syncs. */
  evidence: string | null;
  /** User tombstone: suppresses this key for this session regardless of other rows. */
  negated: boolean;
  createdAt: number;
}

/**
 * The denominator that makes a per-ticket report honest. A per-ticket table
 * without this implies a completeness it does not have (01 §1.4).
 */
export interface TicketCoverage {
  attributedCost: number;
  totalCost: number;
  /** attributedCost / totalCost, or null when totalCost is 0. */
  ratio: number | null;
  /** Attributed cost split by evidence grade; sums to `attributedCost`. */
  byConfidence: Record<Confidence, number>;
  /** Sessions carrying links to more than one key with no message-level evidence. */
  ambiguousSessions: number;
}

// ─── Task classes (constraint impact) ─────────────────────────────────────────

/**
 * Coarse, deterministic work-kind taxonomy. Before/after comparisons run WITHIN
 * a class, so a workload shift can't masquerade as policy damage
 * (constraint-impact/02 §2.2).
 *
 * `unknown` is a first-class member: a session the classifier cannot place is
 * reported as unclassified rather than forced into the nearest bucket.
 */
export type TaskClass =
  | "debug"
  | "refactor-multi-file"
  | "greenfield"
  | "review"
  | "config-chore"
  | "explore"
  | "unknown";

/** The reduced taxonomy used when the full one misses its agreement threshold. */
export type CoarseTaskClass = "build" | "diagnose" | "support" | "unknown";

// ─── Constraint impact ────────────────────────────────────────────────────────

/**
 * A declared policy boundary. DECLARED, never inferred: letting the tool detect
 * its own boundaries would let it manufacture the split that maximises apparent
 * damage (constraint-impact/03 §3.1).
 */
export interface PolicyEvent {
  /** ISO date (YYYY-MM-DD) the policy took effect. */
  date: string;
  kind: "model-removal" | "budget-cap" | "quota-change" | "other";
  /** Free-form local detail, e.g. `"opus"` or `"usd:1500/mo"`. LOCAL-ONLY. */
  detail?: string;
  scope?: "org" | "team" | "self";
}

// ─── Pricing source (metered vs plan) ─────────────────────────────────────────

/**
 * Which price sheet applies. Bedrock and Vertex are partner-operated and priced
 * SEPARATELY from first-party rates — reusing first-party numbers for a Bedrock
 * account produces wrong money, which would invalidate the invoice
 * reconciliation the justification pack rests on.
 */
export type PricingSource = "first_party" | "bedrock" | "vertex";

/**
 * How to talk about cost for an account.
 *  - `plan`: flat-rate seat; cost is an equivalent-API-value counterfactual.
 *  - `metered`: per-token billing; cost is actual money and is reconcilable.
 *
 * The two vocabularies must never be mixed in one report — a Bedrock user shown
 * "5-hour window" language, or a plan user shown pseudo-dollar precision, each
 * discredits the tool with its actual reader (constraint-impact/01 §1.1).
 */
export type AccountMode = "plan" | "metered";

// ─── Answer-first presentation (GUI + pack + CLI) ─────────────────────────────

/** The five business questions the Insights layer answers (gui-redesign/02 §2.2). */
export type InsightQuestion = "cost" | "bought" | "efficiency" | "setup" | "change";

/**
 * Why an answer can't be given yet. Rendered as the card's own voice — an
 * unavailable answer states its enablement path and never renders as an empty
 * widget (gui-redesign/02 §2.6).
 */
export interface InsightUnavailable {
  reason: "no-data" | "not-enabled" | "uncalibrated" | "coverage-low";
  /** One sentence telling the user how to make this answer possible. */
  enablement: string;
}

/**
 * One rendered answer. The uniform grammar across every surface: answer
 * sentence → number → trend → caveat → evidence link. Produced by the shared
 * formatters so the dashboard and the exported pack cannot drift.
 */
export interface InsightAnswer {
  question: InsightQuestion;
  /** The sentence. Always a sentence — never a bare number. */
  answer: string;
  /** Pre-formatted headline figure, or null when unavailable. */
  value: string | null;
  /** Direction vs the previous comparable period. */
  trend: "up" | "down" | "flat" | "unknown";
  /** Honesty obligation for this figure (confidence mix, calibration, mode). */
  caveat: string | null;
  /** Where the supporting evidence lives (a domain view / pack section id). */
  evidenceLink: string | null;
  /** Set when the answer cannot be given; `value` is null whenever this is set. */
  unavailable?: InsightUnavailable;
}
