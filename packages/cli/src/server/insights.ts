/**
 * The Insights tab — the answer-first surface, and the dashboard's front door.
 *
 * The dashboard grew into ten tabs, twenty-eight charts and forty-seven KPI
 * tiles, in which "what did AI cost us and was it worth it" has no single home
 * (doc/analysis/gui-redesign/01-diagnosis.md). This module renders the five
 * business questions that analysis identifies, each as a sentence with a
 * number, with depth still one click away
 * (02-answer-first-ia.md §2.2).
 *
 * Three rules shape everything here, and each is a rule because breaking it is
 * cheap and the damage is invisible:
 *
 * 1. **Never format a number locally.** Every sentence, value and caveat comes
 *    from `@claude-stats/core/insight`, so the tab, the exported justification
 *    pack and the CLI header cannot drift (03-migration-and-mechanics.md §3.4).
 *    This module chooses INPUTS and renders RESULTS; it composes no copy about
 *    a figure.
 * 2. **No composite score.** Five honest sentences, never one manufactured
 *    number — a "AI ROI: 87/100" tile would destroy the honesty property that
 *    makes the other five credible (02 §2.6).
 * 3. **No silent emptiness.** A card with nothing to say states what is missing
 *    and how to enable it. On a fresh install most cards WILL be empty, and
 *    that first impression is the product — an empty widget teaches the reader
 *    the tool is broken, a stated enablement path is how a feature is
 *    discovered.
 *
 * Everything above `renderInsightsTab` is pure: no clock, no store, no I/O.
 * That is what lets the test contract be a behaviour comparison — golden
 * `DashboardData` in, exact rendered figures out — instead of a DOM snapshot.
 */
import type { InsightAnswer, Reconciliation, TicketCoverage } from "@claude-stats/core/types/insight";
import type { CostVocabulary, SetupAutoCompactInput, SetupTtlInput } from "@claude-stats/core/insight";
import {
  answerBought,
  answerChange,
  answerCost,
  answerEfficiency,
  answerSetup,
  formatMoney,
  formatPercent,
  tLiteral,
  unavailable,
} from "@claude-stats/core/insight";
import type { TtlFitResult } from "@claude-stats/core/ttlFit";
import type { ContextCarryResult } from "@claude-stats/core/contextCarry";
import type { AutoCompactFitResult } from "@claude-stats/core/autoCompactFit";
import { outcomeCalibrationFrom } from "../calibration/index.js";
import type { DashboardData } from "../dashboard/index.js";
import type { Config } from "../config.js";
import { renderCard } from "./card.js";
import { RECONCILIATION_ANCHOR, renderReconciliationPanel } from "./reconciliationPanel.js";
import type { NavTabId } from "./nav.js";

/** Minimal translator signature — same shape `template.ts` accepts. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

// ─── The cost vocabulary for a whole dashboard ────────────────────────────────

/**
 * How the dashboard's cost vocabulary was decided. Carried alongside the
 * vocabulary itself so the surface can explain a `mixed` verdict rather than
 * leaving the reader to guess why the usual plan language vanished.
 */
export type VocabularyBasis =
  /** `config.pricing.mode` — the user declared it; nothing else is consulted. */
  | "config"
  /** Every in-scope account agrees. */
  | "accounts"
  /** In-scope accounts disagree; no single vocabulary is correct. */
  | "mixed-accounts"
  /** No per-account billing evidence at all — the plan-fee proxy decided it. */
  | "fee-proxy";

export interface VocabularyResolution {
  vocabulary: CostVocabulary;
  basis: VocabularyBasis;
  /** In-scope accounts whose billing evidence reads as a plan seat. */
  planAccounts: number;
  /** In-scope accounts whose billing evidence reads as metered. */
  meteredAccounts: number;
}

/**
 * Decide the cost vocabulary for a whole dashboard.
 *
 * `resolveAccountMode(config, subscriptionType)` (config.ts) answers this for
 * ONE account and has been implemented, unit-tested and unwired since Phase 0
 * for a genuine reason: a dashboard can span several accounts with mixed plan
 * and metered billing, and there is then no single correct mode. `template.ts`
 * meanwhile inferred the mode from the `planFee > 0` proxy. This function is
 * the missing piece — it reduces N accounts to one vocabulary, or to the
 * explicit `mixed` verdict, and reports which rule fired.
 *
 * Precedence, most authoritative first:
 *
 * 1. **`config.pricing.mode`** wins outright. The user declared the vocabulary
 *    for their reports; second-guessing a declaration with inference is how a
 *    tool loses an argument with its own user.
 * 2. **Per-account billing evidence**, when any exists. An account counts as a
 *    plan seat if it has a detected subscription type OR a plan fee is being
 *    charged for it. Both matter: a fee configured by hand under
 *    `accountFees` is real money on a real plan even when the subscription
 *    metadata never made it into the store, and treating that account as
 *    metered would relabel its equivalent-value figure "actual metered cost" —
 *    a quietly wrong claim of exactly the kind I1 forbids. If every in-scope
 *    account lands on the same answer, that is the vocabulary; if they
 *    disagree, the answer is `mixed`.
 * 3. **The plan-fee proxy** (`summary.planFee > 0`), used only when there is no
 *    per-account evidence whatsoever. That is precisely today's behaviour, so
 *    a dashboard with no account metadata keeps rendering exactly as it did.
 *
 * Pure: reads only the payload and the config.
 */
export function resolveDashboardCostVocabulary(data: DashboardData, config: Config): VocabularyResolution {
  if (config.pricing?.mode) {
    return { vocabulary: config.pricing.mode, basis: "config", planAccounts: 0, meteredAccounts: 0 };
  }

  // Per-account evidence. `planUtilization.byAccount` is the richer source —
  // it carries the detected fee as well as the subscription type, and it is
  // already narrowed to the selected account by `buildDashboard`.
  // `availableAccounts` is deliberately NOT so narrowed ("independent of the
  // account filter"), so it is filtered here before use; using it unfiltered
  // would let an account the user has filtered OUT flip the whole dashboard to
  // `mixed`.
  const evidence: Array<{ subscriptionType: string | null; fee: number | null }> =
    data.planUtilization && data.planUtilization.byAccount.length > 0
      ? data.planUtilization.byAccount.map((a) => ({
          subscriptionType: a.subscriptionType,
          fee: a.detectedPlanFee,
        }))
      : data.availableAccounts
          .filter((a) => data.selectedAccountUuid === null || a.accountUuid === data.selectedAccountUuid)
          .map((a) => ({ subscriptionType: a.subscriptionType, fee: null }));

  if (evidence.length === 0) {
    return {
      vocabulary: data.summary.planFee > 0 ? "plan" : "metered",
      basis: "fee-proxy",
      planAccounts: 0,
      meteredAccounts: 0,
    };
  }

  let planAccounts = 0;
  let meteredAccounts = 0;
  for (const acct of evidence) {
    if (acct.subscriptionType || (acct.fee ?? 0) > 0) planAccounts += 1;
    else meteredAccounts += 1;
  }

  if (planAccounts > 0 && meteredAccounts > 0) {
    return { vocabulary: "mixed", basis: "mixed-accounts", planAccounts, meteredAccounts };
  }
  return {
    vocabulary: planAccounts > 0 ? "plan" : "metered",
    basis: "accounts",
    planAccounts,
    meteredAccounts,
  };
}

// ─── Cache-TTL fit → the setup card / the alerts strip ────────────────────────

/**
 * Which TTL a `"prefer-*"` verdict names, so a caller can compare it against
 * `observedTtl` (the TTL the window was ACTUALLY recorded at) to tell a
 * same-TTL measurement from a projection/counterfactual. `null` for the two
 * verdicts that name no TTL (`"too-close-to-call"`, `"insufficient-data"`).
 */
function verdictTtl(verdict: TtlFitResult["recommendation"]["verdict"]): "5m" | "1h" | null {
  if (verdict === "prefer-5m") return "5m";
  if (verdict === "prefer-1h") return "1h";
  return null;
}

/**
 * A verdict is a PROJECTION — computed from a window recorded at the other
 * TTL, per `TtlFitResult.observedTtl`'s doc comment (plan.md §5.3) — when the
 * window's `observedTtl` is unambiguously the OTHER single TTL from the one
 * the verdict names. A `"mixed"` window (both TTLs actually recorded) counts
 * as a projection too: neither half alone is what the verdict describes.
 * `"unknown"` never reaches here — that observedTtl always forces
 * `"insufficient-data"` (`ttlFit.ts`), which `verdictTtl` maps to `null`.
 */
function isTtlProjection(fit: TtlFitResult): boolean {
  const named = verdictTtl(fit.recommendation.verdict);
  if (named === null) return false;
  return fit.observedTtl !== named;
}

/** Reduce a computed fit to exactly what `answerSetup` needs — this module
 *  reads `data.ttlFit`, it never recomputes `computeTtlFit` (plan.md C2). */
function ttlSetupInput(fit: TtlFitResult | null | undefined): SetupTtlInput | null {
  if (!fit) return null;
  return {
    verdict: fit.recommendation.verdict,
    netCostOfShortTtl: fit.totals.netCostOfShortTtl,
    isProjection: isTtlProjection(fit),
  };
}

// ─── Auto-compact-window fit → the setup card (autocompact-window-fit B2) ─────

/**
 * Narrow, structural view of `data.contextCarry.autoCompactFit`.
 *
 * B1 (`cli/src/dashboard/index.ts`) owns widening `DashboardContextCarry` to
 * carry `AutoCompactFitResult` in the TYPE, and this module does not touch
 * that file (sibling lane, mid-flight — see the task handoff). Reading the
 * field through this local, structurally-typed accessor rather than through
 * `DashboardContextCarry` itself means this module compiles against B1's
 * eventual widened type without depending on the edit landing first: once B1
 * lands, `data.contextCarry.autoCompactFit` is exactly this shape (it IS
 * `AutoCompactFitResult`), so the cast below stays sound.
 */
type ContextCarryWithFit = { autoCompactFit?: AutoCompactFitResult | null };

/**
 * Reduce the already-computed fit to exactly what `answerSetup` needs — this
 * module reads `data.contextCarry.autoCompactFit`, it never recomputes
 * `computeAutoCompactFit` (autocompact-window-fit B2 deliverable 1).
 *
 * The `netSaving`/`medianCycleRequests` pair comes off the RECOMMENDED
 * candidate specifically (the one at `recommendation.recommendedTokens`),
 * never the aggressive end's — `candidates[]` is ascending by
 * `windowTokens` and un-keyed by token count, so it is looked up by value.
 *
 * SR-7 (pre-existing, not this lane's to fix): `data.contextCarry` — and so
 * this fit's `candidates[]`/`droppedCandidates[]` — reaches the embedded
 * `window.__DASHBOARD__` payload (`server/template.ts`) regardless of what
 * this function reduces to, because the whole object is serialised there.
 * Nothing here widens or narrows that condition.
 */
function autoCompactSetupInput(contextCarry: ContextCarryWithFit | null | undefined): SetupAutoCompactInput | null {
  const fit = contextCarry?.autoCompactFit;
  if (!fit) return null;
  const { verdict, recommendedTokens } = fit.recommendation;
  const recommended =
    recommendedTokens === null ? null : (fit.candidates.find((c) => c.windowTokens === recommendedTokens) ?? null);
  return {
    verdict,
    recommendedTokens,
    netSaving: recommended?.netSaving ?? null,
    medianCycleRequests: recommended?.medianCycleRequests ?? null,
    observedMedianCycleRequests: fit.observedMedianCycleRequests,
  };
}

// ─── Building the five answers ────────────────────────────────────────────────

/** Everything the answers need that does not live on `DashboardData`. */
export interface InsightBuildOptions {
  /**
   * The translator the formatters compose their sentences with.
   *
   * Carried in the options bag rather than as a positional argument so it sits
   * beside the other per-render context (currency, rate, vocabulary) — all of
   * which come from the same place at the one call site in `template.ts`. It is
   * required, not optional-with-a-default: a default would let a caller render
   * the default tab in English by forgetting a field, which is precisely the
   * defect this lane exists to remove.
   */
  t: TranslateFn;
  vocabulary: CostVocabulary;
  /** `config.rate.hourly`, or null — never invented. */
  hourlyRate: number | null;
  /** `config.rate.currency`, default USD. */
  currency: string;
  /**
   * The plan verdict as a full, localized sentence. `answerSetup` renders the
   * verdict verbatim, and `planUtilization.currentPlanVerdict` is a bare code
   * (`"good-value"`), so the caller translates it. Null when there is no
   * verdict to state — the card then renders its honest-unavailable branch.
   */
  verdictSentence: string | null;
}

/**
 * The five answers, always five, always in this order.
 *
 * A question with no data still produces an answer object — its honest
 * `unavailable` variant — so the tab's shape never changes with data
 * availability. Conditional cards are the same defect as the conditional tabs
 * the diagnosis calls out: a mental map that moves teaches mistrust
 * (01 §1.5, 03 §3.3 item 5).
 */
export function buildInsightAnswers(data: DashboardData, opts: InsightBuildOptions): InsightAnswer[] {
  const cpt = data.costPerTask;
  const ins = data.insights;
  const coverage: TicketCoverage | null = ins?.ticketCoverage ?? null;

  const cost = answerCost(opts.t, {
    mode: opts.vocabulary,
    cost: data.summary.estimatedCost,
    // The preceding window of EQUAL LENGTH under identical filters — see
    // `DashboardInsights.previousCost`. Null whenever there is nothing honest
    // to compare against (all-time window, or no spend before this one), and
    // the trend then renders "unknown", which is the formatter's own state for
    // a missing comparison rather than a manufactured flat line.
    previousCost: ins?.previousCost ?? null,
    currency: opts.currency,
    hourlyRate: opts.hourlyRate,
    // Passed unconditionally: these are facts about the payload, and whether
    // the plan clause is APPROPRIATE for the vocabulary is the formatter's
    // decision, not the caller's. Gating them here instead would make
    // `answerCost`'s own guard unreachable from this call site — so the pack
    // and the CLI header, which build their own inputs, would be free to
    // render a multiplier the dashboard suppresses. (Verified by mutation:
    // with the gate here, breaking the formatter's guard changed nothing.)
    planFee: data.summary.planFee,
    planMultiplier: data.summary.planMultiplier,
    anyFallbackRates: data.summary.anyFallbackRates,
    // `attachInsights` computes this over the SAME window/filters as the rest
    // of this call — see `Reconciliation`'s doc comment for why it is
    // metered-only and null on a period with no local spend (Lane R).
    reconciledRatio: ins?.reconciliation?.ratio ?? null,
    reconciledWithinTolerance: ins?.reconciliation?.withinTolerance,
    // Read straight from the STRIPPED `DashboardData.contextCarry` projection
    // (context-carry-cost B1/C2) — `totalCarryCost` is the one field
    // `answerCost`'s D11 clause needs, and it is never recomputed here.
    contextCarry: data.contextCarry ? { totalCarryCost: data.contextCarry.totalCarryCost } : null,
  });

  // Calibration for exactly the mechanisms this card quotes, and only when the
  // card is quoting them: a caveat for a number that isn't on the card reads as
  // if some other number were the one being qualified.
  //
  // `completedTasks` is outcome detection's output and is rendered only when
  // `costPerTask` exists, so the outcome estimate is gated on the same thing.
  //
  // The attribution estimate needs NO matching `coverage` guard, and one is
  // deliberately not written: `answerBought` returns its honest-unavailable
  // branch — caveat and all — whenever coverage is absent or zero-valued, so a
  // guard here could never change what renders. It was written first and a
  // mutation proved it dead: deleting it left the whole suite green. A line that
  // cannot fail is the verification theatre this build is trying to stop
  // shipping, so it is gone rather than pinned by a test that would pass anyway.
  //
  // The outcome estimate is additionally gated on `calibrationScope`: that field
  // is the window `data.calibration` was actually gathered over, and without it
  // the caveat could only guess. `attachCalibration` sets the two together, so
  // in practice the gate never fires — but a guess here would be a scope claim
  // with no basis, on the one figure whose subject IS the scope of a claim.
  const calibration = [
    ...(ins?.attributionCalibration ? [ins.attributionCalibration] : []),
    ...(cpt && data.calibration && data.calibrationScope
      ? [outcomeCalibrationFrom(data.calibration, data.calibrationScope)]
      : []),
  ];

  // `ticketUiHidden` outranks the data: coverage was nulled BECAUSE the
  // per-ticket UI is off (`tickets.showUi`), so letting `answerBought` fall
  // into its "no spend attributed yet" branch would (a) be false for a store
  // that holds links, and (b) point at a Settings block this build does not
  // render. Say what is actually the case — hidden pending validation — with
  // the real enablement path.
  const bought = ins?.ticketUiHidden
    ? unavailable("bought", opts.t("common:insight.bought.hidden"), {
        reason: "not-enabled",
        enablement: opts.t("common:insight.bought.hiddenEnablement"),
      })
    : answerBought(opts.t, {
        // Successes, not attempts: "what it bought" is work that landed.
        completedTasks: cpt ? cpt.successCount : null,
        coverage,
        topTicket: ins?.topTicket ?? null,
        currency: opts.currency,
        calibration,
      });

  const efficiency = answerEfficiency(opts.t, {
    recoverableWaste: cpt?.efficiency ? cpt.efficiency.recoverableWaste : null,
    cost: data.summary.estimatedCost,
    currency: opts.currency,
  });

  const setup = answerSetup(opts.t, {
    planVerdict: opts.verdictSentence,
    // Lane E (pricing-model comparison) computes the projected saving; until it
    // lands there is no defensible figure, and a plausible-looking invented one
    // is the worst possible placeholder on a card a manager reads.
    recommendedPlan: null,
    projectedSaving: null,
    currency: opts.currency,
    // A TTL verdict alone must be able to make this card available — see
    // `answerSetup`'s doc comment. `data.ttlFit` is already computed
    // (`cli/src/ttlFit/`, populated by `attachInsights`); this module never
    // recomputes it.
    ttl: ttlSetupInput(data.ttlFit),
    // Same rule for the auto-compact-window fit: `data.contextCarry
    // .autoCompactFit` is already computed by the glue's second
    // `computeContextCarry` pass (D13); this module only reduces it.
    autoCompact: autoCompactSetupInput(data.contextCarry),
    // Pre-translated from the `dashboard` namespace this module's translator
    // has loaded — NEVER `AutoCompactFitResult.savingCaveat`, which is
    // English source text composed in core for a CLI/log context
    // (autocompact-window-fit D5; see `SetupAnswerInput.autoCompactCaveat`'s
    // doc comment in `@claude-stats/core/insight`). `answerSetup` renders it
    // only when the clause actually has a dollar figure to qualify, so
    // translating it unconditionally here costs nothing on the common path
    // where the card has nothing to say.
    autoCompactCaveat: opts.t("dashboard:autoCompactFit.caveat"),
  });

  const change = answerChange(opts.t, {
    recommendations: data.recommendations.map((r) => ({
      title: r.title,
      impact: r.impact ?? null,
      severity: r.severity,
    })),
  });

  return [cost, bought, efficiency, setup, change];
}

// ─── The alerts strip ─────────────────────────────────────────────────────────

/** One line of the alerts strip: a stated condition plus where to act on it. */
export interface InsightAlert {
  /** Stable id — the rule that fired, for suppression and for tests. */
  id: string;
  severity: "critical" | "warning";
  /** The sentence. Already localized by the builder's translator. */
  text: string;
  /** Tab to open for the evidence. */
  tab: NavTabId;
  /**
   * DOM id of the element the evidence actually is, when it is a specific
   * element rather than a whole tab.
   *
   * Exists because an alert that names a destination has to be able to reach it.
   * `reconciliation-drift` says "see the reconciliation panel"; without this the
   * action link could only offer a tab, and the reader would arrive at a screen
   * and still have to hunt. The `tab` above stays set regardless — the anchor is
   * where to land, the tab is what must be showing for it to be visible.
   */
  anchor?: string;
}

/**
 * The things that genuinely warrant attention now — and nothing else.
 *
 * **Precision over recall is the whole design.** An alert that fires on noise
 * trains the reader to ignore the strip, and a strip that is ignored is worse
 * than no strip, because it also consumes the top of the default screen. Every
 * rule below therefore fires on a fact or a thresholded dollar figure, never on
 * a heuristic that a fresh install would trip.
 *
 * Deliberately NOT alerts, and why:
 *  - **Low ticket coverage.** Zero coverage is the default state before Lane A
 *    is configured; it would fire for every new user forever. It belongs on
 *    Q2's caveat, which is where `confidenceCaveat` already puts it with its
 *    enablement path.
 *  - **Uncalibrated success rate.** Same shape: below the minimum label count
 *    is the normal starting condition, not an incident.
 *  - **A mixed cost vocabulary.** Real, but it is a property of the headline
 *    figure, so it belongs on that figure's caveat. Saying it twice would make
 *    the strip look busy on an ordinary two-account setup.
 *  - **Hygiene findings, policy damage.** Their inputs (Lanes D1, M) have not
 *    landed on this tab yet. A rule with no data is a rule that cannot be
 *    tested, so none is written.
 *
 * Reconciliation drift (Lane R) IS an alert, unlike the "not yet" list above:
 * it fires only when the user configured an invoice figure AND the tolerance
 * band was crossed — never on a fresh install with nothing configured, so it
 * meets the same "fact or thresholded dollar figure" bar every other rule
 * here does.
 *
 * The cache-TTL mismatch (cache-ttl-fit C2) is the same shape again: it fires
 * only when `computeTtlFit` reached a `"prefer-*"` verdict — which, by
 * `ttlFit.ts`'s own construction, already cleared BOTH margins (5% of window
 * cost AND the near-boundary sensitivity band) before it stopped saying
 * `"too-close-to-call"` — AND the window's OWN recorded TTL is the one the
 * verdict says is the more expensive of the two. `"too-close-to-call"` and
 * `"insufficient-data"` are excluded by construction (neither is a
 * `"prefer-*"` verdict), and a window already on the cheaper TTL never
 * matches the mismatch condition — nothing here is a heuristic that a fresh
 * install (no ephemeral-TTL columns yet, hence `observedTtl: "unknown"`,
 * hence always `"insufficient-data"`) could trip.
 */
// ─── Phase 3: the per-project session-start baseline step-change (D6) ────────

/** The session-start baseline series this module consumes. Structurally the
 *  intersection of `ContextCarryResult.preludeByProject`'s row (keyed by an
 *  absolute `projectPath`) and `DashboardProjectPrelude`'s (keyed by an
 *  already-shortened `projectLabel`): the detector needs only the series and
 *  SOME stable identifier, so it accepts either and never learns which it got.
 *  `shortProjectLabel` is idempotent, which is what makes that safe. */
type ProjectPrelude = {
  projectPath?: string;
  projectLabel?: string;
  sessions: ContextCarryResult["preludeByProject"][number]["sessions"];
};

/** One project whose session-start baseline shifted, and by how much. */
export interface ProjectContextStepChange {
  projectPath: string;
  beforeMedianTokens: number;
  afterMedianTokens: number;
  /** `(after - before) / before`, always `>= STEP_CHANGE_MIN_SHIFT` here. */
  shift: number;
}

/** D6: never below 10 sessions for the project. */
const STEP_CHANGE_MIN_SESSIONS = 10;
/** D6: at least 5 sessions on each side of the step. */
const STEP_CHANGE_MIN_SIDE = 5;
/** D6: at least a 25% jump. */
const STEP_CHANGE_MIN_SHIFT = 0.25;

function medianOf(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * D6's sustained-shift detector, per project: the median session-start
 * (first-request) context on the FIRST half of the window's sessions for
 * that project against the SECOND half, ordered by `startedAt` (the order
 * `preludeByProject` is already sorted in). Fires ONLY when both halves have
 * at least `STEP_CHANGE_MIN_SIDE` sessions — which by construction requires
 * at least `STEP_CHANGE_MIN_SESSIONS` total for the project — and the shift
 * clears `STEP_CHANGE_MIN_SHIFT`.
 *
 * Splits at the MIDPOINT rather than searching every candidate split point
 * for the largest jump: a search finds the single most dramatic-looking
 * point in the series, which is exactly the one-outlier shape D6 excludes by
 * construction (the measured max first-request context, 175.9K, was a
 * legitimately RESUMED session — a restored conversation, not a prelude). A
 * fixed midpoint treats "before" and "after" symmetrically instead of
 * hunting for the biggest single reset.
 *
 * A MEDIAN, not a mean, on each side — same reason `ContextCarryResult.
 * prelude.medianFirstRequestTokens` uses one (review A-8): one resumed
 * session among nine fresh ones must not move either half's figure enough to
 * manufacture a step that is not there.
 *
 * **Wiring note (context-carry-cost C2 / F8 follow-up):** the series reaches
 * `buildAlerts` off `data.contextCarry.preludeByProject`, which
 * `attachInsights` re-keys to a SHORTENED `projectLabel` at attach time — the
 * absolute path never enters the embedded HTML payload at all, which is a
 * stronger guarantee than F8's original strip (that removed the alert's input
 * while leaving absolute paths on `data.projects[]` regardless). `opts
 * .contextPreludeByProject` remains an explicit override so a caller holding
 * the FULL `ContextCarryResult` — the CLI, a test — can pass it directly;
 * either keying works, because `shortProjectLabel` is idempotent.
 */
export function detectContextStepChanges(
  projects: readonly ProjectPrelude[],
): ProjectContextStepChange[] {
  const out: ProjectContextStepChange[] = [];
  for (const project of projects) {
    const n = project.sessions.length;
    if (n < STEP_CHANGE_MIN_SESSIONS) continue;
    const mid = Math.floor(n / 2);
    const before = project.sessions.slice(0, mid);
    const after = project.sessions.slice(mid);
    if (before.length < STEP_CHANGE_MIN_SIDE || after.length < STEP_CHANGE_MIN_SIDE) continue;
    const beforeMedian = medianOf(before.map((s) => s.firstRequestTokens));
    const afterMedian = medianOf(after.map((s) => s.firstRequestTokens));
    if (beforeMedian === null || afterMedian === null || beforeMedian <= 0) continue;
    const shift = (afterMedian - beforeMedian) / beforeMedian;
    if (shift >= STEP_CHANGE_MIN_SHIFT) {
      out.push({
        projectPath: project.projectPath ?? project.projectLabel ?? "",
        beforeMedianTokens: beforeMedian,
        afterMedianTokens: afterMedian,
        shift,
      });
    }
  }
  return out.sort((a, b) => b.shift - a.shift);
}

/**
 * Last-two-segments project label — mirrors `template.ts`'s own `projShort`
 * exactly (a separate copy rather than an import: `template.ts` imports FROM
 * this module, so importing back would cycle). Project identifiers here are
 * ABSOLUTE FILESYSTEM PATHS, and escaping does not help — `escapeHtml("/Users/
 * alice/repos/client-x")` is still the path. The alerts strip is the most
 * screenshot-and-paste-prone element on the page (review F5), so the alert
 * text carries only this, never the raw path.
 */
function shortProjectLabel(projectPath: string): string {
  const parts = projectPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : (parts[parts.length - 1] ?? projectPath);
}

export function buildAlerts(
  data: DashboardData,
  t: TranslateFn,
  currency = "USD",
  opts: {
    /** Override for the series read off `data.contextCarry.preludeByProject`.
     *  See `detectContextStepChanges`' wiring note: a caller holding the full
     *  `ContextCarryResult` may pass its absolute-path-keyed rows here. */
    contextPreludeByProject?: readonly ProjectPrelude[];
  } = {},
): InsightAlert[] {
  const alerts: InsightAlert[] = [];

  // A partner platform (Bedrock/Vertex) priced at first-party rates because no
  // partner rate table is configured. A FACT, not an inference: the store
  // recorded that at least one priced message fell back. It leads the strip
  // because it qualifies every other money figure on the page.
  if (data.summary.anyFallbackRates) {
    alerts.push({
      id: "fallback-rates",
      severity: "warning",
      text: t("dashboard:insights.alerts.fallbackRates"),
      tab: "settings",
    });
  }

  // Opt-in (a configured invoice figure) and tolerance-thresholded — never
  // fires for a user who hasn't set `reconciliation.invoiceTotal`.
  //
  // The destination is the reconciliation panel on THIS tab, not Settings. The
  // sentence used to promise "the cost card's caveat", which carried the ratio
  // and none of what it named; the panel is where the residual, the tolerance
  // band and the candidate causes now actually render, and the anchor takes the
  // reader there rather than to the screen where the invoice figure is typed in.
  if (data.insights?.reconciliation && !data.insights.reconciliation.withinTolerance) {
    alerts.push({
      id: "reconciliation-drift",
      severity: "warning",
      text: t("dashboard:insights.alerts.reconciliationDrift"),
      tab: "insights",
      anchor: RECONCILIATION_ANCHOR,
    });
  }

  // Cache-TTL mismatch: the fit recommends the OTHER TTL from the one this
  // window was actually recorded at, by a margin `computeTtlFit` already
  // proved clears both its own thresholds (see the doc comment above).
  if (data.ttlFit) {
    const verdict = data.ttlFit.recommendation.verdict;
    const named = verdictTtl(verdict);
    if (named !== null && data.ttlFit.observedTtl !== "unknown" && data.ttlFit.observedTtl !== named) {
      const money = formatMoney(Math.abs(data.ttlFit.totals.netCostOfShortTtl ?? 0), currency);
      alerts.push({
        id: "ttl-mismatch",
        severity: "warning",
        text: t(
          verdict === "prefer-5m"
            ? "dashboard:insights.alerts.ttlPrefer5m"
            : "dashboard:insights.alerts.ttlPrefer1h",
          { money },
        ),
        tab: "plan",
      });
    }
  }

  // Phase 3 (context-carry-cost, D6): a per-project session-start baseline
  // that shifted and STAYED shifted — never a single session (see
  // `detectContextStepChanges`' doc for why a resumed session's 175.9K must
  // not read as a defect). Only the largest sustained shift is promoted, same
  // "lead item, not one row per finding" rule the recommendation strip below
  // follows — the alert names the SHORTENED project label only (review F5).
  const stepChanges = detectContextStepChanges(
    opts.contextPreludeByProject ?? data.contextCarry?.preludeByProject ?? [],
  );
  if (stepChanges.length > 0) {
    const top = stepChanges[0]!;
    alerts.push({
      id: "context-step-change",
      severity: "warning",
      text: tLiteral(
        t,
        "dashboard:insights.alerts.contextStepChange",
        { percent: formatPercent(top.shift) },
        { project: shortProjectLabel(top.projectPath) },
      ),
      tab: "spending",
    });
  }

  // The recommendation engine's own top tier. Only its dollar-thresholded rules
  // reach `critical` (model-tier waste at >= $25 saveable), so this inherits a
  // real floor rather than adding a new guess on top of one.
  for (const rec of data.recommendations) {
    if (rec.severity !== "critical") continue;
    alerts.push({
      id: `rec:${rec.id}`,
      severity: "critical",
      text: rec.impact ? `${rec.title} — ${rec.impact}` : rec.title,
      tab: "efficiency",
    });
  }

  return alerts;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Which SECTION holds each answer's evidence.
 *
 * The formatters return domain-view ids (`"cost-and-controlling"`) because that
 * is the destination the IA describes. Those views now exist — but this map
 * deliberately still resolves to a section, not to the view id, because a
 * section is the more precise landing place: `#spending` opens Cost &
 * Controlling AND scrolls to the Spending half of it, where `#cost-and-
 * controlling` would drop the reader at the top of a two-section screen and
 * leave them to hunt. The page's `resolveHashTarget` maps the section hash back
 * to its owning view, so both forms work; this one is the better of the two.
 *
 * The canonical domain id stays on the element as `data-evidence-link`.
 */
export const EVIDENCE_TAB: Readonly<Record<string, NavTabId>> = {
  "cost-and-controlling": "spending",
  // The `tickets` section, not `projects`: Q2's "what did it buy?" card quotes a
  // ticket coverage figure and a top ticket, and its evidence is the per-ticket
  // table. It pointed at `projects` only because no ticket surface existed to
  // point at — so the one link on the page that promised ticket evidence landed
  // the reader on per-project charts.
  "tickets-and-value": "tickets",
  "efficiency-and-hygiene": "efficiency",
  "plan-and-policy": "plan",
};

/** i18n key for each question's card title, in `buildInsightAnswers` order. */
const QUESTION_TITLE_KEY: Readonly<Record<InsightAnswer["question"], string>> = {
  cost: "dashboard:insights.cards.cost",
  bought: "dashboard:insights.cards.bought",
  efficiency: "dashboard:insights.cards.efficiency",
  setup: "dashboard:insights.cards.setup",
  change: "dashboard:insights.cards.change",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Detail blocks rendered beneath the card grid — the evidence a card's caveat
 *  refers to, on the same screen as the claim. */
export interface InsightsTabDetails {
  /** The period's reconciliation, or null/absent when no invoice is configured. */
  reconciliation?: Reconciliation | null;
  /** `config.rate.currency` — the same one the answers were formatted with. */
  currency?: string;
}

/**
 * Render the Insights tab body: the alerts strip (only when non-empty —
 * absence is information), the five cards, then the detail panels a card's
 * caveat points at.
 *
 * Takes the already-built answers and alerts rather than the payload, so the
 * assembly above stays independently testable and this function stays a
 * string-builder with no decisions in it.
 */
export function renderInsightsTab(
  answers: readonly InsightAnswer[],
  alerts: readonly InsightAlert[],
  t: TranslateFn,
  details: InsightsTabDetails = {},
): string {
  const alertsHtml =
    alerts.length === 0
      ? ""
      : `<div class="cs-alerts" role="status">
      ${alerts
        .map(
          (a) =>
            `<div class="cs-alert cs-alert-${escapeHtml(a.severity)}" data-alert-id="${escapeHtml(a.id)}">
        <span class="cs-alert-text">${escapeHtml(a.text)}</span>
        <a class="cs-alert-action" href="#${escapeHtml(a.anchor ?? a.tab)}" data-evidence-link="${escapeHtml(a.tab)}">${escapeHtml(t("dashboard:insights.alerts.action"))}</a>
      </div>`,
        )
        .join("\n      ")}
    </div>`;

  const cardsHtml = answers
    .map((answer) => {
      const domainId = answer.evidenceLink;
      const tab = domainId ? EVIDENCE_TAB[domainId] : undefined;
      return renderCard(answer, {
        id: `insight-${answer.question}`,
        title: t(QUESTION_TITLE_KEY[answer.question]),
        evidenceHref: tab ? `#${tab}` : undefined,
      });
    })
    .join("\n      ");

  return `
    <p class="cs-insights-lede">${escapeHtml(t("dashboard:insights.lede"))}</p>
    ${alertsHtml}
    <div class="cs-insights-grid">
      ${cardsHtml}
    </div>${renderReconciliationPanel(details.reconciliation, t, details.currency)}`;
}

/**
 * Layout CSS for the tab. Card-level styling stays in `CARD_CSS`.
 *
 * `--cs-alert-warning` is declared here rather than in `CARD_TOKENS_CSS`
 * because it has exactly one consumer and `card.ts`'s token contract is
 * "every `--cs-card-*` token is used by `CARD_CSS`" — a card token consumed
 * only from this file would quietly break that. A literal dark-palette value
 * for the same reason the card tokens are literals (see `CARD_TOKENS_CSS`): the
 * alert sits on `--cs-card-bg`, which is unconditionally dark in both hosts, so
 * a theme-derived colour would be a contrast lottery.
 */
export const INSIGHTS_CSS = `
    :root {
      --cs-alert-warning: #f28e2b;
    }
    .cs-insights-lede {
      font-size: 0.75rem; color: var(--cs-card-fg-muted); margin: 0 0 0.75rem;
    }
    .cs-insights-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 0.75rem; align-items: start;
    }
    .cs-alerts { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.9rem; }
    .cs-alert {
      display: flex; align-items: baseline; gap: 0.6rem; font-size: 0.78rem;
      padding: 0.45rem 0.7rem; border-radius: 5px; border-left: 3px solid;
      background: var(--cs-card-bg); color: var(--cs-card-fg);
    }
    .cs-alert-critical { border-left-color: var(--cs-card-down); }
    .cs-alert-warning { border-left-color: var(--cs-alert-warning); }
    .cs-alert-text { flex: 1; }
    .cs-alert-action { color: var(--cs-card-accent); text-decoration: none; white-space: nowrap; }`;
