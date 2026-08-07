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
 * Pure by construction: no clock, no I/O, no locale lookup. Time is always
 * passed in, so a pack regenerated tomorrow from the same store is byte-
 * identical to today's — the determinism the pack's credibility depends on.
 *
 * LOCALIZATION — deliberately deferred, and this is the seam.
 * These sentences are English source strings today because nothing renders them
 * yet; Phase 0 ships the contract, not a surface. The first lane to put them on
 * screen (the Insights tab) owns translating them, and should do it by
 * injecting a translator rather than by moving the composition into the
 * renderer — the moment two surfaces compose their own sentences, the pack and
 * the dashboard are free to disagree, which is the entire failure this module
 * exists to prevent. The structured return shape (answer / value / caveat as
 * separate fields, not one blob) is what makes that injection tractable.
 *
 * Design: doc/analysis/gui-redesign/02 §2.2, 03 §3.4;
 *         doc/analysis/ticket-attribution/05 §5.3.
 */
import type {
  AccountMode,
  Confidence,
  InsightAnswer,
  InsightQuestion,
  TicketCoverage,
} from "./types/insight.js";

// ─── Primitives ───────────────────────────────────────────────────────────────

/** Fixed-locale money formatting. Deliberately not `toLocaleString` with a
 *  runtime locale — the pack must not change shape with the machine it ran on. */
export function formatMoney(amount: number, currency = "USD"): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `;
  const rounded = Math.abs(amount) >= 100 ? Math.round(amount).toString() : amount.toFixed(2);
  const withSeparators = rounded.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${symbol}${withSeparators}`;
}

/** Percentage with no decimals; null renders as an em dash, never as "0%". */
export function formatPercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

/**
 * Express a cost as developer time. The lever that turns a token bill into a
 * number a manager already has intuitions about — a month of heavy usage is
 * typically a low single-digit percentage of one salary.
 */
export function formatDevTime(cost: number, hourlyRate: number): string {
  if (hourlyRate <= 0) return "—";
  const hours = cost / hourlyRate;
  if (hours < 1) return `${Math.round(hours * 60)} dev-minutes`;
  if (hours < 8) return `${hours.toFixed(1)} dev-hours`;
  const days = hours / 8;
  return `${days.toFixed(1)} dev-days`;
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
 * The caveat chip is load-bearing, not decoration: it is where the confidence
 * mix, the calibration state, and the estimate-vs-actual distinction live. A
 * figure rendered without its caveat is a figure that has quietly dropped the
 * thing that makes it defensible.
 */
export function costCaveat(mode: AccountMode, opts: { reconciledRatio?: number | null; anyFallbackRates?: boolean } = {}): string {
  if (mode === "plan") return "Equivalent API cost — not what your plan charges.";
  const parts: string[] = [];
  if (opts.reconciledRatio != null && Number.isFinite(opts.reconciledRatio)) {
    parts.push(`reconciles with the invoice at ${formatPercent(opts.reconciledRatio)}`);
  }
  if (opts.anyFallbackRates) {
    parts.push("some usage priced at first-party rates — configure partner rates for exact figures");
  }
  return parts.length > 0 ? capitalize(parts.join("; ")) + "." : "Actual metered cost.";
}

/** Confidence-tier summary, e.g. "72% high · 21% medium · 7% low confidence". */
export function confidenceCaveat(coverage: TicketCoverage): string | null {
  if (coverage.attributedCost <= 0) return null;
  const order: Confidence[] = ["high", "medium", "low"];
  const parts = order
    .filter((c) => (coverage.byConfidence[c] ?? 0) > 0)
    .map((c) => `${formatPercent((coverage.byConfidence[c] ?? 0) / coverage.attributedCost)} ${c}`);
  if (parts.length === 0) return null;
  const ambiguity =
    coverage.ambiguousSessions > 0
      ? ` · ${coverage.ambiguousSessions} session${coverage.ambiguousSessions === 1 ? "" : "s"} ambiguous`
      : "";
  return `${parts.join(" · ")} confidence${ambiguity}.`;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

// ─── The five answers ─────────────────────────────────────────────────────────

/** Inputs for Q1 — "What did AI cost?" */
export interface CostAnswerInput {
  mode: AccountMode;
  cost: number;
  previousCost: number | null;
  currency?: string;
  hourlyRate?: number | null;
  /** Plan accounts only: monthly fee and the resulting multiplier. */
  planFee?: number | null;
  planMultiplier?: number | null;
  reconciledRatio?: number | null;
  anyFallbackRates?: boolean;
}

export function answerCost(input: CostAnswerInput): InsightAnswer {
  const currency = input.currency ?? "USD";
  const money = formatMoney(input.cost, currency);

  if (input.cost <= 0) {
    return unavailable("cost", "No usage recorded for this period.", {
      reason: "no-data",
      enablement: "Run a Claude Code session, then refresh — collection is automatic.",
    });
  }

  const clauses: string[] = [`${money} this period`];
  if (input.hourlyRate && input.hourlyRate > 0) {
    clauses.push(`≈ ${formatDevTime(input.cost, input.hourlyRate)} at your configured rate`);
  }
  if (input.mode === "plan" && input.planFee && input.planMultiplier) {
    clauses.push(`${input.planMultiplier.toFixed(1)}× your ${formatMoney(input.planFee, currency)}/mo plan`);
  }

  return {
    question: "cost",
    answer: `${clauses.join(" — ")}.`,
    value: money,
    trend: trendOf(input.cost, input.previousCost),
    caveat: costCaveat(input.mode, {
      reconciledRatio: input.reconciledRatio ?? null,
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
}

export function answerBought(input: BoughtAnswerInput): InsightAnswer {
  if (!input.coverage || input.coverage.totalCost <= 0) {
    return unavailable("bought", "No spend attributed to work items yet.", {
      reason: "not-enabled",
      enablement: "Add your project keys under Settings → Tickets to attribute spend automatically.",
    });
  }
  const currency = input.currency ?? "USD";
  const clauses: string[] = [];
  if (input.completedTasks !== null) {
    clauses.push(`${input.completedTasks} task${input.completedTasks === 1 ? "" : "s"} completed`);
  }
  clauses.push(`${formatPercent(input.coverage.ratio)} of spend attributed to work items`);
  if (input.topTicket) {
    clauses.push(`biggest: ${input.topTicket.key} (${formatMoney(input.topTicket.cost, currency)})`);
  }

  return {
    question: "bought",
    answer: `${capitalize(clauses.join(", "))}.`,
    value: formatPercent(input.coverage.ratio),
    trend: trendOf(input.coverage.ratio ?? 0, input.previousCoverageRatio ?? null),
    caveat: confidenceCaveat(input.coverage),
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

export function answerEfficiency(input: EfficiencyAnswerInput): InsightAnswer {
  if (input.recoverableWaste === null) {
    return unavailable("efficiency", "Not enough completed work to measure efficiency.", {
      reason: "no-data",
      enablement: "Efficiency needs a few completed tasks in the period — check back after more usage.",
    });
  }
  const currency = input.currency ?? "USD";
  const share = input.cost > 0 ? input.recoverableWaste / input.cost : 0;
  const clauses = [
    `${formatMoney(input.recoverableWaste, currency)} recoverable (${formatPercent(share)} of spend)`,
  ];
  if (input.hygieneRatio != null) {
    const dir =
      input.previousHygieneRatio != null
        ? input.hygieneRatio < input.previousHygieneRatio
          ? "down from"
          : "up from"
        : null;
    clauses.push(
      dir
        ? `self-audited waste ${formatPercent(input.hygieneRatio)}, ${dir} ${formatPercent(input.previousHygieneRatio!)}`
        : `self-audited waste ${formatPercent(input.hygieneRatio)}`,
    );
  }

  return {
    question: "efficiency",
    answer: `${capitalize(clauses.join(" — "))}.`,
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

export function answerSetup(input: SetupAnswerInput): InsightAnswer {
  const currency = input.currency ?? "USD";
  if (input.policyImpact) {
    const pct = formatPercent(input.policyImpact.costPerTaskDelta);
    return {
      question: "setup",
      answer: `Since the policy change on ${input.policyImpact.date}, cost per successful task is up ${pct} in ${input.policyImpact.classes} task class${input.policyImpact.classes === 1 ? "" : "es"}.`,
      value: pct,
      trend: "up",
      caveat: "Evidence, not proof — compared within task classes across the boundary.",
      evidenceLink: "plan-and-policy",
    };
  }
  if (!input.planVerdict) {
    return unavailable("setup", "Not enough data to judge your plan fit.", {
      reason: "no-data",
      enablement: "Plan fit needs a few weeks of usage to be meaningful.",
    });
  }
  const saving =
    input.projectedSaving && input.recommendedPlan
      ? ` — switching to ${input.recommendedPlan} would save about ${formatMoney(input.projectedSaving, currency)}/mo`
      : "";
  return {
    question: "setup",
    answer: `${input.planVerdict}${saving}.`,
    value: input.recommendedPlan,
    trend: "unknown",
    caveat: saving ? "Estimated from your own usage replayed against plan limits." : null,
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

export function answerChange(input: ChangeAnswerInput): InsightAnswer {
  if (input.recommendations.length === 0) {
    return {
      question: "change",
      answer: input.doingWell ?? "Nothing needs attention right now.",
      value: null,
      trend: "flat",
      caveat: null,
      evidenceLink: "efficiency-and-hygiene",
    };
  }
  const top = input.recommendations.slice(0, 3);
  const lead = top[0]!;
  const rest = top.length > 1 ? ` (+${top.length - 1} more)` : "";
  const impact = lead.impact ? ` — ${lead.impact}` : "";
  return {
    question: "change",
    answer: `${lead.title}${impact}${rest}.`,
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
