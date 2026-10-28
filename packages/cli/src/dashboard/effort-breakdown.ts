/**
 * Spend by reasoning-effort tier (#125 PR 1) — the pure fold.
 *
 * ONE read in, everything out: `getMessageTotals` returns one row per
 * (model, effort), and this module folds those SAME rows into `byModel`
 * (with `byEffort` inside each), the top-level `byEffort`, `effortCoverage`
 * and the headline sums. Because every figure is a sum over the same rows,
 * the breakdowns equal the headline by construction (D4) — on the raw seek
 * path and on the `period:"all"` rollup path alike, since both feed this
 * function the same row shape.
 *
 * The tier set is open (D1): an effort is whatever short token Claude Code
 * wrote, `null` = not reported. `null` is a bucket, never a tier, and
 * `effortCoverage` says how much of the window's cost sits outside it.
 *
 * Rounding: costs are summed UNROUNDED and rounded once at each leaf, so a
 * parent is the rounded sum of its children's exact costs (it can differ from
 * the sum of its rounded children by under one cent per child).
 */
import { estimateCost, isLongContextRequest } from "@claude-stats/core/pricing";
import { compareEffort } from "@claude-stats/core/effort";
import type { MessageEffortTotalRow } from "../store/index.js";

export interface EffortBreakdownRow {
  /** Reasoning-effort tier as Claude Code wrote it; `null` = not reported. */
  effort: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Stored message rows (one API response can be several rows). */
  messages: number;
  estimatedCost: number;
}

export interface ModelEffortBreakdown {
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  byEffort: EffortBreakdownRow[];
}

export interface EffortTotalRow extends EffortBreakdownRow {
  /** This tier's share of the window's cost (0 when the window has no cost). */
  costShare: number;
}

export interface EffortCoverage {
  /** Share of the window's cost on rows that carry an effort tag. */
  taggedCostShare: number;
  /** Share of the window's message rows that carry an effort tag. */
  taggedMessageShare: number;
}

export interface EffortBreakdown {
  byModel: ModelEffortBreakdown[];
  byEffort: EffortTotalRow[];
  effortCoverage: EffortCoverage;
  /** Unrounded sums over every row — the headline the breakdowns must equal. */
  headline: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    cost: number;
    messages: number;
    anyFallbackRates: boolean;
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

interface Acc {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messages: number;
  cost: number;
}
const zero = (): Acc => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  messages: 0,
  cost: 0,
});
function add(a: Acc, r: MessageEffortTotalRow, cost: number): void {
  a.inputTokens += r.input_tokens;
  a.outputTokens += r.output_tokens;
  a.cacheReadTokens += r.cache_read_tokens;
  a.cacheCreationTokens += r.cache_creation_tokens;
  a.messages += r.msg_count;
  a.cost += cost;
}
function leaf(effort: string | null, a: Acc): EffortBreakdownRow {
  return {
    effort,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    cacheReadTokens: a.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens,
    messages: a.messages,
    estimatedCost: round2(a.cost),
  };
}

export function buildEffortBreakdown(rows: readonly MessageEffortTotalRow[]): EffortBreakdown {
  const head = zero();
  let anyFallbackRates = false;
  const models = new Map<string, { total: Acc; tiers: Map<string | null, Acc> }>();
  const tiers = new Map<string | null, Acc>();
  let taggedCost = 0;
  let taggedMessages = 0;

  for (const r of rows) {
    const priced = estimateCost(
      r.model,
      r.input_tokens,
      r.output_tokens,
      r.cache_read_tokens,
      r.cache_creation_tokens,
      undefined,
      {
        ephemeral5mCacheTokens: r.ephemeral_5m_cache_tokens,
        ephemeral1hCacheTokens: r.ephemeral_1h_cache_tokens,
      },
      { longContext: r.long_context === 1 },
    );
    if (priced.rateBasis === "first_party_fallback") anyFallbackRates = true;
    add(head, r, priced.cost);

    const m = models.get(r.model) ?? { total: zero(), tiers: new Map<string | null, Acc>() };
    add(m.total, r, priced.cost);
    const mt = m.tiers.get(r.effort) ?? zero();
    add(mt, r, priced.cost);
    m.tiers.set(r.effort, mt);
    models.set(r.model, m);

    const t = tiers.get(r.effort) ?? zero();
    add(t, r, priced.cost);
    tiers.set(r.effort, t);

    if (r.effort !== null) {
      taggedCost += priced.cost;
      taggedMessages += r.msg_count;
    }
  }

  const byModel: ModelEffortBreakdown[] = [...models.entries()].map(([model, m]) => ({
    model,
    inputTokens: m.total.inputTokens,
    outputTokens: m.total.outputTokens,
    estimatedCost: round2(m.total.cost),
    byEffort: [...m.tiers.entries()]
      .sort(([a], [b]) => compareEffort(a, b))
      .map(([effort, a]) => leaf(effort, a)),
  }));

  const byEffort: EffortTotalRow[] = [...tiers.entries()]
    .sort(([a], [b]) => compareEffort(a, b))
    .map(([effort, a]) => ({
      ...leaf(effort, a),
      costShare: head.cost > 0 ? round4(a.cost / head.cost) : 0,
    }));

  return {
    byModel,
    byEffort,
    effortCoverage: {
      taggedCostShare: head.cost > 0 ? round4(taggedCost / head.cost) : 0,
      taggedMessageShare: head.messages > 0 ? round4(taggedMessages / head.messages) : 0,
    },
    headline: {
      inputTokens: head.inputTokens,
      outputTokens: head.outputTokens,
      cacheReadTokens: head.cacheReadTokens,
      cacheCreationTokens: head.cacheCreationTokens,
      cost: head.cost,
      messages: head.messages,
      anyFallbackRates,
    },
  };
}

/** One tier's share of a single session, for `get_session_detail.effortMix`. */
export interface EffortMixRow {
  effort: string | null;
  messages: number;
  estimatedCost: number;
}

/** The slice of a stored message row `buildEffortMix` reads. */
export interface EffortMixInput {
  model: string | null;
  effort?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
}

/**
 * A session's messages grouped by effort tier (D1 order, `null` last). Costs
 * are summed unrounded and rounded once per tier, like the window breakdown.
 */
export function buildEffortMix(messages: readonly EffortMixInput[]): EffortMixRow[] {
  const tiers = new Map<string | null, { messages: number; cost: number }>();
  for (const m of messages) {
    const effort = m.effort ?? null;
    const cost = estimateCost(
      m.model ?? "unknown",
      m.input_tokens ?? 0,
      m.output_tokens ?? 0,
      m.cache_read_tokens ?? 0,
      m.cache_creation_tokens ?? 0,
      undefined,
      undefined,
      { longContext: isLongContextRequest(m.model ?? "unknown", m.input_tokens ?? 0, m.cache_read_tokens ?? 0, m.cache_creation_tokens ?? 0) },
    ).cost;
    const t = tiers.get(effort) ?? { messages: 0, cost: 0 };
    t.messages += 1;
    t.cost += cost;
    tiers.set(effort, t);
  }
  return [...tiers.entries()]
    .sort(([a], [b]) => compareEffort(a, b))
    .map(([effort, t]) => ({ effort, messages: t.messages, estimatedCost: round2(t.cost) }));
}
