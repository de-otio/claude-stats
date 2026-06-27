/**
 * Subscription-fee attribution — distribute each Claude account's monthly fee
 * across the projects that account used, for the selected period.
 *
 * Pure and deterministic: no clock, no I/O. The caller injects `periodDays`
 * (derived from the period bounds) and the per-account resolved fees. This is
 * what makes the unit tests reproducible.
 *
 * Design: doc/analysis/project-fee-attribution/03-distribution-model.md.
 *
 * Model (per-account pool, NOT a single global pool):
 *   - Each account's fee is pro-rated to the period (`fee × periodDays/30.4`)
 *     and distributed ONLY across that account's projects, weighted by
 *     API-equivalent cost (so an expensive-model project draws a larger share).
 *   - A configured pool whose account had no in-period cost is shown as `idle`,
 *     never redistributed onto active projects.
 *   - Usage we cannot attribute to a fee (the `(unknown)` bucket, or an account
 *     with no resolved fee) simply receives no share — it is not invented.
 *   - Currencies never mix: every total lives under its own `byCurrency` block,
 *     so a EUR account and a USD account are never summed.
 */

/** Weeks-per-month constant, matching the dashboard's existing 4.33 (≈30.4 days). */
const DAYS_PER_MONTH = 30.4;

/** One project's slice of a currency's fee pool. */
export interface ProjectFeeSlice {
  projectPath: string;
  /** Pro-rated fee attributed to this project, in the block's currency. Full precision. */
  amount: number;
  /** `amount / prorate` — the equivalent monthly run-rate for this project. */
  monthlyEquivalent: number;
  /** Share of this currency's pro-rated pool total (0–100), including idle. */
  percentOfTotal: number;
}

/** All fee accounting for a single currency. */
export interface CurrencyFeeBlock {
  currency: string;
  /** Sum of pro-rated pools for this currency (what the period "cost" in fees). */
  periodTotal: number;
  /** Sum of monthly fees for this currency (un-prorated run-rate). */
  monthlyTotal: number;
  /** Sum of project slices (== periodTotal − idle). */
  attributed: number;
  /** Pools whose account had no in-period usage. */
  idle: Array<{ label: string; amount: number }>;
  /** Per-project slices, sorted by amount descending (ties by projectPath). */
  perProject: ProjectFeeSlice[];
}

export interface FeeAttribution {
  /** True when at least one account resolved a fee (independent of attribution). */
  configured: boolean;
  /** periodDays / 30.4 — the pro-rate factor applied to monthly fees. */
  prorate: number;
  /** One block per currency, sorted by currency code. */
  byCurrency: CurrencyFeeBlock[];
}

export interface FeeAttributionInput {
  /** API-equivalent cost bucketed by (account, project). Built from rows × sessionCostMap. */
  costByAccountProject: ReadonlyArray<{ accountUuid: string; projectPath: string; cost: number }>;
  /** Resolved fee per account (null = no known fee → no pool). Currency already resolved. */
  fees: Readonly<Record<string, { monthlyFee: number; currency: string; label: string } | null>>;
  /** Calendar length of the selected period in days (caller-computed; clamped ≥1 here). */
  periodDays: number;
}

/** Mutable per-currency accumulator used while building the result. */
interface BlockAcc {
  currency: string;
  periodTotal: number;
  monthlyTotal: number;
  attributed: number;
  idle: Array<{ label: string; amount: number }>;
  projectAmounts: Map<string, number>;
}

export function buildFeeAttribution(input: FeeAttributionInput): FeeAttribution {
  const prorate = Math.max(input.periodDays, 1) / DAYS_PER_MONTH;

  // 1. Aggregate cost per account and per (account, project).
  const costA = new Map<string, number>();
  const costAP = new Map<string, Map<string, number>>();
  for (const { accountUuid, projectPath, cost } of input.costByAccountProject) {
    costA.set(accountUuid, (costA.get(accountUuid) ?? 0) + cost);
    let projMap = costAP.get(accountUuid);
    if (!projMap) {
      projMap = new Map<string, number>();
      costAP.set(accountUuid, projMap);
    }
    projMap.set(projectPath, (projMap.get(projectPath) ?? 0) + cost);
  }

  // 2. For each account with a resolved fee, distribute its pro-rated pool.
  const blocks = new Map<string, BlockAcc>();
  let configured = false;
  // Deterministic account ordering: fee keys first (sorted), then any cost-only
  // accounts (which have null fees and contribute nothing, but keep order stable).
  const accountKeys = Object.keys(input.fees).sort();
  for (const acct of accountKeys) {
    const fee = input.fees[acct];
    if (!fee) continue; // no pool for this account
    configured = true;

    const block = blocks.get(fee.currency) ?? {
      currency: fee.currency,
      periodTotal: 0,
      monthlyTotal: 0,
      attributed: 0,
      idle: [],
      projectAmounts: new Map<string, number>(),
    };
    blocks.set(fee.currency, block);

    const pool = fee.monthlyFee * prorate;
    block.periodTotal += pool;
    block.monthlyTotal += fee.monthlyFee;

    const total = costA.get(acct) ?? 0;
    if (total <= 0) {
      // Configured pool, no in-period usage → idle. Never redistributed.
      block.idle.push({ label: fee.label || shortId(acct), amount: pool });
      continue;
    }
    const projMap = costAP.get(acct)!;
    for (const [projectPath, c] of projMap) {
      const slice = pool * (c / total);
      block.projectAmounts.set(projectPath, (block.projectAmounts.get(projectPath) ?? 0) + slice);
      block.attributed += slice;
    }
  }

  // 3. Finalise — sort blocks by currency, projects by amount desc.
  const byCurrency: CurrencyFeeBlock[] = Array.from(blocks.values())
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((b) => {
      const perProject: ProjectFeeSlice[] = Array.from(b.projectAmounts.entries())
        .map(([projectPath, amount]) => ({
          projectPath,
          amount,
          monthlyEquivalent: prorate > 0 ? amount / prorate : 0,
          percentOfTotal: b.periodTotal > 0 ? (amount / b.periodTotal) * 100 : 0,
        }))
        .sort((x, y) => y.amount - x.amount || x.projectPath.localeCompare(y.projectPath));
      return {
        currency: b.currency,
        periodTotal: b.periodTotal,
        monthlyTotal: b.monthlyTotal,
        attributed: b.attributed,
        idle: b.idle,
        perProject,
      };
    });

  return { configured, prorate, byCurrency };
}

/** Short, display-safe account id for an idle pool with no user label. */
function shortId(accountUuid: string): string {
  if (accountUuid === "(unknown)") return "(unknown)";
  return accountUuid.length > 8 ? accountUuid.slice(0, 8) + "…" : accountUuid;
}
