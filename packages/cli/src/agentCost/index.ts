/**
 * Agent & skill cost — glue between the store and the pure `computeAgentCost`
 * in `@claude-stats/core/agentCost`.
 *
 * Same shape as `../contextCarry/index.ts`: one store seek
 * (`getMessagesForAgentCost` — carrier rows only, same filter route as
 * `getMessagesForHygiene`), a mapping from store snake_case to the core row,
 * and the core call. The one step the core module must not do — pricing — is
 * done here, per message, with the shipped `estimateCost` and the TTL split,
 * exactly as the dashboard headline prices its per-model totals. Pricing is
 * linear in the token counts, so the per-message sum equals the dashboard's
 * per-model sum for the same window up to floating-point rounding.
 *
 * Consumers: `claude-stats agents`, MCP `get_agent_cost`, the dashboard card.
 * The report carries no session id, uuid or path (the store row has none).
 *
 * Design: `plans/agent-attribution/IMPLEMENTATION.md` §4/C2.
 */
import {
  computeAgentCost,
  type AgentCostPeriodGranularity,
  type AgentCostReport,
  type AgentCostRow,
} from "@claude-stats/core/agentCost";
import { estimateCost, nonNegativeFiniteInt, type RateOverrides } from "@claude-stats/core/pricing";
import type { AgentCostMessageStoreRow, Store } from "../store/index.js";

export type {
  AgentCostCoverage,
  AgentCostOther,
  AgentCostPeriodGranularity,
  AgentCostPeriodRow,
  AgentCostReport,
  AgentCostRow,
  AgentTypeCostRow,
  SkillCostOther,
  SkillCostRow,
  SpawnDepthCostRow,
} from "@claude-stats/core/agentCost";

/**
 * Options for {@link buildAgentCostReport}. The filter fields mirror
 * `ContextCarryFilters` / `MessageFilter` exactly (undefined = no narrowing;
 * `includeCI` / `includeDeleted` narrow only on an explicit `false`), so a
 * caller can pass the same values it passes the dashboard and get the same
 * message set.
 */
export interface AgentCostFilters {
  /** Epoch ms, inclusive, on the MESSAGE timestamp. */
  since?: number;
  /** Epoch ms, exclusive, on the MESSAGE timestamp. */
  until?: number;
  projectPath?: string;
  repoUrl?: string;
  accountUuid?: string;
  /** Explicit `false` excludes non-interactive (CI) sessions. */
  includeCI?: boolean;
  /** Explicit `false` excludes sessions whose transcript was deleted. */
  includeDeleted?: boolean;
  /** Passed to `estimateCost`; omit for the shipped/cached rates (what the
   *  dashboard headline uses). */
  rateOverrides?: RateOverrides;
  /** Passed to `computeAgentCost`: named rows per list before the rest is
   *  folded into `other`. Safe integer ≥ 1, else `RangeError`. */
  limit?: number;
  /** Passed to `computeAgentCost`: overrides the span-based day/week choice. */
  periodGranularity?: AgentCostPeriodGranularity;
}

/**
 * Price one carrier row. A row with no model costs `0` and is reported as
 * unpriced (same rule as `hygiene/util.ts#messageCost`). Token columns are
 * coerced through `nonNegativeFiniteInt`, as the context-carry glue does, so a
 * hand-edited or synced non-numeric value degrades to `0` instead of `NaN`.
 */
function toAgentCostRow(row: AgentCostMessageStoreRow, overrides: RateOverrides | undefined): AgentCostRow {
  let cost = 0;
  let priced = false;
  if (row.model) {
    const r = estimateCost(
      row.model,
      nonNegativeFiniteInt(row.input_tokens),
      nonNegativeFiniteInt(row.output_tokens),
      nonNegativeFiniteInt(row.cache_read_tokens),
      nonNegativeFiniteInt(row.cache_creation_tokens),
      overrides,
      {
        ephemeral5mCacheTokens: row.ephemeral_5m_cache_tokens,
        ephemeral1hCacheTokens: row.ephemeral_1h_cache_tokens,
      },
    );
    cost = r.cost;
    priced = r.known;
  }
  return {
    isSubagent: row.is_subagent === 1,
    agentType: row.agent_type ?? null,
    spawnDepth: row.spawn_depth ?? null,
    skill: row.skill ?? null,
    timestamp: row.timestamp ?? null,
    cost,
    priced,
  };
}

/**
 * Cost by main vs subagent, agent type, skill (during the run) and spawn
 * depth over a window. One store seek, per-message pricing, then
 * `computeAgentCost`.
 */
export function buildAgentCostReport(store: Store, opts: AgentCostFilters = {}): AgentCostReport {
  const storeRows = store.getMessagesForAgentCost({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    since: opts.since,
    until: opts.until,
    includeCI: opts.includeCI,
    includeDeleted: opts.includeDeleted,
  });
  const rows = storeRows.map((r) => toAgentCostRow(r, opts.rateOverrides));
  return computeAgentCost(rows, { limit: opts.limit, periodGranularity: opts.periodGranularity });
}
