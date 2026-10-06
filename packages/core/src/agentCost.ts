/**
 * Agent & skill cost — "where does the spend go: the main conversation or
 * subagents, which agent types, while which skill runs, and how deep in the
 * spawn tree?"
 *
 * Pure module, functional-core style: one flat array of already-PRICED message
 * rows in (`AgentCostRow` — the glue prices each carrier row with the shipped
 * `estimateCost`; this module never prices), an `AgentCostReport` out. No
 * store, no clock, no `Date.now()`, no I/O. The store query and the pricing
 * glue live in `packages/cli/src/agentCost/`.
 *
 * Design: `plans/agent-attribution/IMPLEMENTATION.md` §4/C2.
 *
 * Contract every consumer (CLI `agents`, MCP `get_agent_cost`, the dashboard
 * card) relies on:
 *
 *  - **Descriptive only.** Rows are ordered so the output is deterministic
 *    (cost descending, then name ascending, `null` last); the order is not a
 *    ranking and no field or doc here judges a figure. Formatters keep it that
 *    way: no "top", "waste" or similar wording.
 *  - **Conservation.** Every subagent row lands in exactly one `byAgentType`
 *    bucket and exactly one `bySpawnDepth` bucket, so
 *    `Σ byAgentType.cost + other = coverage.subagentCost` and likewise for
 *    depth; `mainCost + subagentCost = totalCost`. Floating-point sums agree to
 *    rounding (summation order differs between a total and its buckets).
 *  - **Order-independent.** Input rows are put into a canonical order before
 *    anything is summed, so a shuffled input yields an identical report, to
 *    the last bit.
 *  - **No identities out.** The input carries no session id, uuid or path, so
 *    the output cannot. Names out are agent types and skill names only.
 *  - **Prototype-safe.** Every by-name tally is a `Map`; `__proto__`,
 *    `constructor` and `toString` are valid names (see `identifiers.ts`).
 *  - **No NaN.** A share whose denominator is `0` is `0`, never `NaN`.
 *
 * Skill figures are spend DURING the run (`costDuringRun`): messages written
 * while the skill was active. Context the skill left behind that later turns
 * keep paying for is `contextCarry`'s measurement and is not added here.
 */
import { isBuiltInAgentType, validIdentifier, validSpawnDepth } from "./identifiers.js";

// ─── Input ──────────────────────────────────────────────────────────────────

/**
 * One priced CARRIER message (`messages.usage_counted = 1`) joined to its
 * session's attribution columns. Built by the cli glue; deliberately carries no
 * session id, uuid, project path or prompt text.
 */
export interface AgentCostRow {
  /** `sessions.is_subagent`. */
  isSubagent: boolean;
  /** `sessions.agent_type` (V25). `null` = not recorded. Ignored on main rows. */
  agentType: string | null;
  /** `sessions.spawn_depth` (V25). `null` = not recorded. Ignored on main rows. */
  spawnDepth: number | null;
  /** `messages.skill` (V25) — the skill running when the message was written. */
  skill: string | null;
  /** Epoch ms; `null` when the message has no timestamp. */
  timestamp: number | null;
  /** Equivalent-API dollars from `estimateCost`. `0` for an unpriced model. */
  cost: number;
  /** `false` when `estimateCost` had no rate for the model (`known: false`):
   *  the row's `0` cost is "unpriced", not "free". Counted in
   *  `coverage.unpricedMessages`. */
  priced: boolean;
}

/** Period bucket width for `coverage.byPeriod`. Both are UTC-aligned. */
export type AgentCostPeriodGranularity = "day" | "week";

export interface AgentCostOptions {
  /**
   * Maximum number of NAMED rows in each list (`byAgentType`, `bySkill`,
   * `bySpawnDepth`). Rows past it are folded into that list's `other` entry,
   * so totals still conserve. The `null` ("not recorded") row is never folded
   * — it is a coverage statement, not a name — so a list can be `limit + 1`
   * long. Omit for no limit. Must be a safe integer ≥ 1; anything else throws
   * `RangeError`.
   */
  limit?: number;
  /**
   * Overrides the span-based choice (see {@link DAY_GRANULARITY_MAX_SPAN_MS}).
   */
  periodGranularity?: AgentCostPeriodGranularity;
}

/**
 * The widest timestamp span (max − min over every dated input row) that is
 * bucketed by DAY; anything wider is bucketed by WEEK. 31 days keeps a month
 * view at one row per day, and keeps a quarter or longer at ≤ ~14 rows per
 * 90 days — few enough that the step where capture started (V25) reads as a
 * step rather than as noise.
 */
export const DAY_GRANULARITY_MAX_SPAN_MS = 31 * 86_400_000;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** 1970-01-01 was a Thursday; the first Monday 00:00 UTC is 4 days later. */
const MONDAY_EPOCH_OFFSET_MS = 4 * DAY_MS;

// ─── Output ─────────────────────────────────────────────────────────────────

/** One period bucket of the known-agent-type coverage line. */
export interface AgentCostPeriodRow {
  /** UTC epoch ms of the bucket start: midnight UTC for `"day"`, Monday
   *  00:00 UTC for `"week"`. */
  start: number;
  subagentCost: number;
  subagentMessages: number;
  /** Subagent cost whose session has a recorded agent type. */
  knownTypeCost: number;
  /** `knownTypeCost / subagentCost`; `0` when `subagentCost` is `0`. */
  knownTypeShare: number;
}

export interface AgentCostCoverage {
  totalCost: number;
  mainCost: number;
  subagentCost: number;
  /** `mainCost / totalCost`; `0` when `totalCost` is `0`. */
  mainShare: number;
  /** `subagentCost / totalCost`; `0` when `totalCost` is `0`. */
  subagentShare: number;
  messages: number;
  mainMessages: number;
  subagentMessages: number;
  /** Rows whose model had no rate — their cost is counted as `0`. */
  unpricedMessages: number;
  /** Subagent cost whose session has a recorded agent type. */
  knownTypeCost: number;
  /** `knownTypeCost / subagentCost`; `0` when `subagentCost` is `0`. */
  knownTypeShare: number;
  /** Width of the `byPeriod` buckets. `"day"` when the input's dated span is
   *  ≤ {@link DAY_GRANULARITY_MAX_SPAN_MS} (or there are no dated rows),
   *  else `"week"`, unless `AgentCostOptions.periodGranularity` overrides. */
  periodGranularity: AgentCostPeriodGranularity;
  /** One row per bucket that has at least one subagent message, ascending by
   *  `start`. Buckets without subagent messages are absent, not zero-filled.
   *  Subagent rows with no timestamp are in `undatedSubagentCost` instead, so
   *  `Σ byPeriod.subagentCost + undatedSubagentCost = subagentCost`. */
  byPeriod: AgentCostPeriodRow[];
  undatedSubagentCost: number;
}

export interface AgentTypeCostRow {
  /** `null` = "(unrecorded)": subagent spend whose session has no agent type
   *  (captured before V25, or the value failed validation). */
  agentType: string | null;
  /** Ships with Claude Code (`isBuiltInAgentType`). `false` for `null`. */
  builtIn: boolean;
  cost: number;
  /** `cost / coverage.subagentCost`; `0` when that is `0`. */
  share: number;
  messages: number;
}

export interface SkillCostRow {
  skill: string;
  /** Spend on messages written while this skill ran. Excludes the carry
   *  afterwards (that is `contextCarry`'s measurement). */
  costDuringRun: number;
  /** `costDuringRun / coverage.totalCost`; `0` when that is `0`. */
  share: number;
  messages: number;
}

export interface SpawnDepthCostRow {
  /** `null` = depth not recorded. */
  depth: number | null;
  cost: number;
  /** `cost / coverage.subagentCost`; `0` when that is `0`. */
  share: number;
  messages: number;
}

/** Named rows folded past `AgentCostOptions.limit`. */
export interface AgentCostOther {
  /** How many named rows were folded in. */
  buckets: number;
  cost: number;
  /** Same denominator as the list it was folded from. */
  share: number;
  messages: number;
}

/** {@link AgentCostOther} for `bySkill`, with that list's field name. */
export interface SkillCostOther {
  buckets: number;
  costDuringRun: number;
  share: number;
  messages: number;
}

export interface AgentCostReport {
  coverage: AgentCostCoverage;
  /** Every subagent row, by agent type. Includes the `null` bucket when any
   *  subagent row lacks a type. */
  byAgentType: AgentTypeCostRow[];
  /** Spend while a skill runs, main and subagent rows alike. Rows with no
   *  skill are not listed (they are `totalCost − Σ costDuringRun − other`). */
  bySkill: SkillCostRow[];
  /** Every subagent row, by spawn depth. */
  bySpawnDepth: SpawnDepthCostRow[];
  /** Remainders past `limit`; each `null` when nothing was folded. */
  other: {
    byAgentType: AgentCostOther | null;
    bySkill: SkillCostOther | null;
    bySpawnDepth: AgentCostOther | null;
  };
}

// ─── Implementation ─────────────────────────────────────────────────────────

interface CleanRow {
  isSubagent: boolean;
  agentType: string | null;
  spawnDepth: number | null;
  skill: string | null;
  timestamp: number | null;
  cost: number;
  priced: boolean;
}

/**
 * Defence in depth: the store holds values validated at every entry point,
 * but this module's output reaches MCP and the dashboard, so it re-applies the
 * same validators. A value that fails reads as "not recorded" — the same rule
 * `identifiers.ts` applies at entry. A non-finite or negative cost reads as
 * `0`, so one bad row cannot poison every total containing it.
 */
function clean(row: AgentCostRow): CleanRow {
  const cost = typeof row.cost === "number" && Number.isFinite(row.cost) && row.cost > 0 ? row.cost : 0;
  const ts = typeof row.timestamp === "number" && Number.isFinite(row.timestamp) ? row.timestamp : null;
  return {
    isSubagent: row.isSubagent === true,
    agentType: validIdentifier(row.agentType),
    spawnDepth: validSpawnDepth(row.spawnDepth),
    skill: validIdentifier(row.skill),
    timestamp: ts,
    cost,
    priced: row.priced !== false,
  };
}

/** Ascending, `null` last. Code-unit order for strings — never
 *  `localeCompare`, so the order does not depend on the host locale. */
function compareNullable<T extends string | number>(a: T | null, b: T | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** A total order over cleaned rows; two rows it calls equal are
 *  interchangeable for every sum below. */
function compareRows(a: CleanRow, b: CleanRow): number {
  return (
    Number(a.isSubagent) - Number(b.isSubagent) ||
    compareNullable(a.agentType, b.agentType) ||
    compareNullable(a.spawnDepth, b.spawnDepth) ||
    compareNullable(a.skill, b.skill) ||
    compareNullable(a.timestamp, b.timestamp) ||
    a.cost - b.cost ||
    Number(a.priced) - Number(b.priced)
  );
}

function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

interface Tally {
  cost: number;
  messages: number;
}

function add<K>(map: Map<K, Tally>, key: K, cost: number): void {
  const t = map.get(key);
  if (t) {
    t.cost += cost;
    t.messages += 1;
  } else {
    map.set(key, { cost, messages: 1 });
  }
}

/** Cost descending, then key ascending with `null` last. */
function byCostThenKey<K extends string | number>(
  a: { key: K | null; cost: number },
  b: { key: K | null; cost: number },
): number {
  return b.cost - a.cost || compareNullable(a.key, b.key);
}

interface Folded<K> {
  kept: Array<{ key: K | null; cost: number; messages: number }>;
  other: { buckets: number; cost: number; messages: number } | null;
}

/**
 * Sort a tally and fold named entries past `limit` into one remainder. The
 * `null` entry is always kept. Folded entries are summed in their sorted
 * order, so the remainder is deterministic too.
 */
function sortAndFold<K extends string | number>(map: Map<K | null, Tally>, limit: number | undefined): Folded<K> {
  const entries = [...map.entries()].map(([key, t]) => ({ key, cost: t.cost, messages: t.messages }));
  entries.sort(byCostThenKey);
  if (limit === undefined) return { kept: entries, other: null };

  const kept: Folded<K>["kept"] = [];
  let named = 0;
  let other: Folded<K>["other"] = null;
  for (const e of entries) {
    if (e.key === null || named < limit) {
      kept.push(e);
      if (e.key !== null) named++;
      continue;
    }
    other ??= { buckets: 0, cost: 0, messages: 0 };
    other.buckets++;
    other.cost += e.cost;
    other.messages += e.messages;
  }
  return { kept, other };
}

function periodStart(ts: number, granularity: AgentCostPeriodGranularity): number {
  if (granularity === "day") return Math.floor(ts / DAY_MS) * DAY_MS;
  return Math.floor((ts - MONDAY_EPOCH_OFFSET_MS) / WEEK_MS) * WEEK_MS + MONDAY_EPOCH_OFFSET_MS;
}

function chooseGranularity(rows: readonly CleanRow[]): AgentCostPeriodGranularity {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    if (r.timestamp === null) continue;
    if (r.timestamp < min) min = r.timestamp;
    if (r.timestamp > max) max = r.timestamp;
  }
  if (min === Infinity) return "day";
  return max - min <= DAY_GRANULARITY_MAX_SPAN_MS ? "day" : "week";
}

/**
 * Build the agent/skill cost report from priced carrier rows. See the module
 * doc for the contract; see each output type for its fields.
 *
 * @throws RangeError when `options.limit` is given and is not a safe integer ≥ 1.
 */
export function computeAgentCost(rows: readonly AgentCostRow[], options: AgentCostOptions = {}): AgentCostReport {
  const { limit } = options;
  if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 1)) {
    throw new RangeError(`agentCost: limit must be a safe integer >= 1, got ${String(limit)}`);
  }

  // Canonical order first: every sum below then runs in the same order
  // whatever order the caller supplied, which is what makes the report
  // shuffle-invariant to the last bit rather than to rounding.
  const sorted = rows.map(clean).sort(compareRows);
  const granularity = options.periodGranularity ?? chooseGranularity(sorted);

  let totalCost = 0;
  let mainCost = 0;
  let subagentCost = 0;
  let mainMessages = 0;
  let subagentMessages = 0;
  let unpricedMessages = 0;
  let knownTypeCost = 0;
  let undatedSubagentCost = 0;

  const byType = new Map<string | null, Tally>();
  const bySkill = new Map<string | null, Tally>();
  const byDepth = new Map<number | null, Tally>();
  const byPeriod = new Map<number, { subagentCost: number; subagentMessages: number; knownTypeCost: number }>();

  for (const r of sorted) {
    totalCost += r.cost;
    if (!r.priced) unpricedMessages++;
    if (r.skill !== null) add(bySkill, r.skill, r.cost);

    if (!r.isSubagent) {
      mainCost += r.cost;
      mainMessages++;
      continue;
    }

    subagentCost += r.cost;
    subagentMessages++;
    if (r.agentType !== null) knownTypeCost += r.cost;
    add(byType, r.agentType, r.cost);
    add(byDepth, r.spawnDepth, r.cost);

    if (r.timestamp === null) {
      undatedSubagentCost += r.cost;
    } else {
      const start = periodStart(r.timestamp, granularity);
      const p = byPeriod.get(start) ?? { subagentCost: 0, subagentMessages: 0, knownTypeCost: 0 };
      p.subagentCost += r.cost;
      p.subagentMessages++;
      if (r.agentType !== null) p.knownTypeCost += r.cost;
      byPeriod.set(start, p);
    }
  }

  const periods: AgentCostPeriodRow[] = [...byPeriod.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, p]) => ({
      start,
      subagentCost: p.subagentCost,
      subagentMessages: p.subagentMessages,
      knownTypeCost: p.knownTypeCost,
      knownTypeShare: share(p.knownTypeCost, p.subagentCost),
    }));

  const types = sortAndFold(byType, limit);
  const skills = sortAndFold(bySkill, limit);
  const depths = sortAndFold(byDepth, limit);

  return {
    coverage: {
      totalCost,
      mainCost,
      subagentCost,
      mainShare: share(mainCost, totalCost),
      subagentShare: share(subagentCost, totalCost),
      messages: mainMessages + subagentMessages,
      mainMessages,
      subagentMessages,
      unpricedMessages,
      knownTypeCost,
      knownTypeShare: share(knownTypeCost, subagentCost),
      periodGranularity: granularity,
      byPeriod: periods,
      undatedSubagentCost,
    },
    byAgentType: types.kept.map((e) => ({
      agentType: e.key,
      builtIn: e.key !== null && isBuiltInAgentType(e.key),
      cost: e.cost,
      share: share(e.cost, subagentCost),
      messages: e.messages,
    })),
    // `bySkill` never holds a `null` key (only rows with a skill are added),
    // so the cast only narrows the type.
    bySkill: skills.kept.map((e) => ({
      skill: e.key as string,
      costDuringRun: e.cost,
      share: share(e.cost, totalCost),
      messages: e.messages,
    })),
    bySpawnDepth: depths.kept.map((e) => ({
      depth: e.key,
      cost: e.cost,
      share: share(e.cost, subagentCost),
      messages: e.messages,
    })),
    other: {
      byAgentType: types.other && { ...types.other, share: share(types.other.cost, subagentCost) },
      bySkill: skills.other && {
        buckets: skills.other.buckets,
        costDuringRun: skills.other.cost,
        share: share(skills.other.cost, totalCost),
        messages: skills.other.messages,
      },
      bySpawnDepth: depths.other && { ...depths.other, share: share(depths.other.cost, subagentCost) },
    },
  };
}
