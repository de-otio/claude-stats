/**
 * `computeAgentCost` (`@claude-stats/core/agentCost`) — pure-core tests.
 *
 * Properties (fast-check, seeded): conservation of every split against the
 * coverage totals, with and without `limit`; shuffle invariance of the whole
 * report; prototype-key names (`__proto__`, `constructor`, `toString`,
 * `hasOwnProperty`) drawn into every generated name position.
 *
 * Examples pin the coverage line, the period step, the `(unrecorded)` bucket,
 * the `builtIn` flag, skill and depth rows, folding into `other`, and the
 * empty/degenerate inputs (shares are 0, never NaN).
 *
 * Fixture names: `my-reviewer`, `acme-critic`, `example-skill`, plus the
 * built-in agent types `Explore` / `general-purpose`.
 *
 * Design: plans/agent-attribution/IMPLEMENTATION.md §4/C2.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  computeAgentCost,
  DAY_GRANULARITY_MAX_SPAN_MS,
  type AgentCostReport,
  type AgentCostRow,
} from "@claude-stats/core/agentCost";

const DAY = 86_400_000;
/** 2026-01-05T00:00:00Z — a Monday. */
const T0 = Date.UTC(2026, 0, 5);
const SEED = 20261006;

function row(overrides: Partial<AgentCostRow> = {}): AgentCostRow {
  return {
    isSubagent: false,
    agentType: null,
    spawnDepth: null,
    skill: null,
    timestamp: T0,
    cost: 1,
    priced: true,
    ...overrides,
  };
}

function sub(agentType: string | null, cost: number, overrides: Partial<AgentCostRow> = {}): AgentCostRow {
  return row({ isSubagent: true, agentType, spawnDepth: 1, cost, ...overrides });
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

// ─── Generators ─────────────────────────────────────────────────────────────

const NAMES = [
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  "my-reviewer",
  "acme-critic",
  "example-skill",
  "Explore",
  "general-purpose",
] as const;

const nameArb = fc.option(fc.constantFrom(...NAMES), { nil: null });

const rowArb: fc.Arbitrary<AgentCostRow> = fc.record({
  isSubagent: fc.boolean(),
  agentType: nameArb,
  spawnDepth: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }),
  skill: nameArb,
  timestamp: fc.option(fc.integer({ min: T0 - 120 * DAY, max: T0 + 120 * DAY }), { nil: null }),
  cost: fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true }),
  priced: fc.boolean(),
});

const rowsArb = fc.array(rowArb, { maxLength: 60 });
const limitArb = fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined });

function assertConserves(report: AgentCostReport, rows: readonly AgentCostRow[]): void {
  const c = report.coverage;
  const o = report.other;

  expect(close(c.mainCost + c.subagentCost, c.totalCost)).toBe(true);
  expect(close(c.totalCost, sum(rows.map((r) => r.cost)))).toBe(true);
  expect(c.mainMessages + c.subagentMessages).toBe(rows.length);
  expect(c.messages).toBe(rows.length);

  const typeCost = sum(report.byAgentType.map((r) => r.cost)) + (o.byAgentType?.cost ?? 0);
  const typeMsgs = sum(report.byAgentType.map((r) => r.messages)) + (o.byAgentType?.messages ?? 0);
  expect(close(typeCost, c.subagentCost)).toBe(true);
  expect(typeMsgs).toBe(c.subagentMessages);

  const depthCost = sum(report.bySpawnDepth.map((r) => r.cost)) + (o.bySpawnDepth?.cost ?? 0);
  const depthMsgs = sum(report.bySpawnDepth.map((r) => r.messages)) + (o.bySpawnDepth?.messages ?? 0);
  expect(close(depthCost, c.subagentCost)).toBe(true);
  expect(depthMsgs).toBe(c.subagentMessages);

  const periodCost = sum(c.byPeriod.map((p) => p.subagentCost)) + c.undatedSubagentCost;
  expect(close(periodCost, c.subagentCost)).toBe(true);

  const skilled = rows.filter((r) => r.skill !== null);
  const skillCost = sum(report.bySkill.map((r) => r.costDuringRun)) + (o.bySkill?.costDuringRun ?? 0);
  const skillMsgs = sum(report.bySkill.map((r) => r.messages)) + (o.bySkill?.messages ?? 0);
  expect(close(skillCost, sum(skilled.map((r) => r.cost)))).toBe(true);
  expect(skillMsgs).toBe(skilled.length);

  // Independent per-name recomputation — a `{}` tally keyed by `__proto__`
  // would lose this bucket's spend and fail here.
  for (const t of report.byAgentType) {
    const expected = rows.filter((r) => r.isSubagent && r.agentType === t.agentType);
    expect(t.messages).toBe(expected.length);
    expect(close(t.cost, sum(expected.map((r) => r.cost)))).toBe(true);
  }
}

function assertSorted<T>(xs: readonly T[], cost: (x: T) => number, key: (x: T) => string | number | null): void {
  for (let i = 1; i < xs.length; i++) {
    const a = xs[i - 1]!;
    const b = xs[i]!;
    if (cost(a) !== cost(b)) {
      expect(cost(a)).toBeGreaterThan(cost(b));
      continue;
    }
    const ka = key(a);
    const kb = key(b);
    expect(ka).not.toBeNull(); // null sorts last among equal costs
    if (kb !== null) expect(ka! < kb!).toBe(true);
  }
}

// ─── Properties ─────────────────────────────────────────────────────────────

describe("computeAgentCost — properties", () => {
  it("conserves every split against the coverage totals (no limit)", () => {
    fc.assert(
      fc.property(rowsArb, (rows) => {
        assertConserves(computeAgentCost(rows), rows);
      }),
      { numRuns: 300, seed: SEED },
    );
  });

  it("conserves with `limit`, folding the rest into `other`", () => {
    fc.assert(
      fc.property(rowsArb, fc.integer({ min: 1, max: 4 }), (rows, limit) => {
        const report = computeAgentCost(rows, { limit });
        assertConserves(report, rows);
        const named = report.byAgentType.filter((r) => r.agentType !== null);
        expect(named.length).toBeLessThanOrEqual(limit);
        expect(report.bySkill.length).toBeLessThanOrEqual(limit);
        expect(report.bySpawnDepth.filter((r) => r.depth !== null).length).toBeLessThanOrEqual(limit);
        // `other` exists exactly when something was folded.
        const distinctTypes = new Set(rows.filter((r) => r.isSubagent && r.agentType !== null).map((r) => r.agentType));
        expect(report.other.byAgentType !== null).toBe(distinctTypes.size > limit);
        if (report.other.byAgentType) expect(report.other.byAgentType.buckets).toBe(distinctTypes.size - limit);
      }),
      { numRuns: 300, seed: SEED },
    );
  });

  it("is shuffle-invariant: a permuted input gives an identical report", () => {
    const arb = rowsArb.chain((rows) =>
      fc.tuple(fc.constant(rows), fc.shuffledSubarray(rows, { minLength: rows.length, maxLength: rows.length }), limitArb),
    );
    fc.assert(
      fc.property(arb, ([rows, shuffled, limit]) => {
        expect(computeAgentCost(shuffled, { limit })).toEqual(computeAgentCost(rows, { limit }));
      }),
      { numRuns: 300, seed: SEED },
    );
  });

  it("orders every list by cost desc, then name asc with null last", () => {
    fc.assert(
      fc.property(rowsArb, limitArb, (rows, limit) => {
        const r = computeAgentCost(rows, { limit });
        assertSorted(r.byAgentType, (x) => x.cost, (x) => x.agentType);
        assertSorted(r.bySkill, (x) => x.costDuringRun, (x) => x.skill);
        assertSorted(r.bySpawnDepth, (x) => x.cost, (x) => x.depth);
        for (let i = 1; i < r.coverage.byPeriod.length; i++) {
          expect(r.coverage.byPeriod[i]!.start).toBeGreaterThan(r.coverage.byPeriod[i - 1]!.start);
        }
      }),
      { numRuns: 200, seed: SEED },
    );
  });

  it("never emits NaN or Infinity anywhere in the report", () => {
    fc.assert(
      fc.property(rowsArb, limitArb, (rows, limit) => {
        const json = JSON.stringify(computeAgentCost(rows, { limit }), (_k, v: unknown) => {
          if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`non-finite ${String(v)}`);
          return v;
        });
        expect(json.length).toBeGreaterThan(0);
      }),
      { numRuns: 200, seed: SEED },
    );
  });
});

// ─── Examples ───────────────────────────────────────────────────────────────

describe("computeAgentCost — coverage line", () => {
  it("pins main vs subagent shares and the known-type share", () => {
    const report = computeAgentCost([
      row({ cost: 1 }),
      row({ cost: 3 }),
      sub("Explore", 2),
      sub("my-reviewer", 4),
      sub(null, 2),
    ]);
    expect(report.coverage).toMatchObject({
      totalCost: 12,
      mainCost: 4,
      subagentCost: 8,
      messages: 5,
      mainMessages: 2,
      subagentMessages: 3,
      knownTypeCost: 6,
      unpricedMessages: 0,
      undatedSubagentCost: 0,
    });
    expect(report.coverage.mainShare).toBeCloseTo(4 / 12, 12);
    expect(report.coverage.subagentShare).toBeCloseTo(8 / 12, 12);
    expect(report.coverage.knownTypeShare).toBe(0.75);
  });

  it("shows the capture step: known-type share 0 before, 1 after, by day", () => {
    const rows = [
      sub(null, 5, { timestamp: T0 + 0 * DAY + 1000 }),
      sub(null, 5, { timestamp: T0 + 1 * DAY + 1000 }),
      sub("my-reviewer", 2, { timestamp: T0 + 2 * DAY + 1000 }),
      sub("Explore", 3, { timestamp: T0 + 3 * DAY + 1000 }),
      row({ timestamp: T0 + 3 * DAY + 2000, cost: 100 }), // main only: no bucket of its own
    ];
    const c = computeAgentCost(rows).coverage;
    expect(c.periodGranularity).toBe("day");
    expect(c.byPeriod.map((p) => p.start)).toEqual([T0, T0 + DAY, T0 + 2 * DAY, T0 + 3 * DAY]);
    expect(c.byPeriod.map((p) => p.knownTypeShare)).toEqual([0, 0, 1, 1]);
    expect(c.byPeriod.map((p) => p.subagentCost)).toEqual([5, 5, 2, 3]);
    expect(c.byPeriod.map((p) => p.subagentMessages)).toEqual([1, 1, 1, 1]);
  });

  it("buckets by Monday-aligned UTC week when the span exceeds 31 days", () => {
    const rows = [
      sub(null, 1, { timestamp: T0 + 2 * DAY }), // Wed of week 0
      sub("acme-critic", 1, { timestamp: T0 + 40 * DAY }),
    ];
    const c = computeAgentCost(rows).coverage;
    expect(c.periodGranularity).toBe("week");
    for (const p of c.byPeriod) {
      expect(new Date(p.start).getUTCDay()).toBe(1);
      expect(p.start % DAY).toBe(0);
    }
    expect(c.byPeriod[0]!.start).toBe(T0);
    expect(c.byPeriod[1]!.start).toBe(T0 + 35 * DAY);
  });

  it("picks day at exactly the threshold span and week one ms past it", () => {
    const at = [sub(null, 1, { timestamp: T0 }), sub(null, 1, { timestamp: T0 + DAY_GRANULARITY_MAX_SPAN_MS })];
    const past = [sub(null, 1, { timestamp: T0 }), sub(null, 1, { timestamp: T0 + DAY_GRANULARITY_MAX_SPAN_MS + 1 })];
    expect(computeAgentCost(at).coverage.periodGranularity).toBe("day");
    expect(computeAgentCost(past).coverage.periodGranularity).toBe("week");
    // The span counts main rows too; an explicit option overrides it.
    expect(computeAgentCost(past, { periodGranularity: "day" }).coverage.periodGranularity).toBe("day");
  });

  it("keeps undated subagent spend out of the periods but in the total", () => {
    const c = computeAgentCost([sub("my-reviewer", 2, { timestamp: null }), sub(null, 3)]).coverage;
    expect(c.undatedSubagentCost).toBe(2);
    expect(c.byPeriod).toEqual([{ start: T0, subagentCost: 3, subagentMessages: 1, knownTypeCost: 0, knownTypeShare: 0 }]);
    expect(c.subagentCost).toBe(5);
  });

  it("counts unpriced rows", () => {
    const c = computeAgentCost([row({ cost: 0, priced: false }), sub("Explore", 0, { priced: false }), row()]).coverage;
    expect(c.unpricedMessages).toBe(2);
    expect(c.messages).toBe(3);
  });
});

describe("computeAgentCost — by agent type", () => {
  it("puts untyped subagent spend in the (unrecorded) null bucket", () => {
    const report = computeAgentCost([sub(null, 2), sub(null, 1), sub("my-reviewer", 1)]);
    const unrecorded = report.byAgentType.find((r) => r.agentType === null);
    expect(unrecorded).toEqual({ agentType: null, builtIn: false, cost: 3, share: 0.75, messages: 2 });
  });

  it("flags built-in agent types (Explore) apart from user-named ones (my-reviewer)", () => {
    const report = computeAgentCost([sub("Explore", 1), sub("my-reviewer", 2), sub("acme-critic", 3), sub("general-purpose", 4)]);
    const flags = new Map(report.byAgentType.map((r) => [r.agentType, r.builtIn]));
    expect(flags.get("Explore")).toBe(true);
    expect(flags.get("general-purpose")).toBe(true);
    expect(flags.get("my-reviewer")).toBe(false);
    expect(flags.get("acme-critic")).toBe(false);
  });

  it("ignores agent type and depth on main-conversation rows", () => {
    const report = computeAgentCost([row({ agentType: "my-reviewer", spawnDepth: 2, cost: 5 })]);
    expect(report.byAgentType).toEqual([]);
    expect(report.bySpawnDepth).toEqual([]);
    expect(report.coverage.mainCost).toBe(5);
  });

  it("treats prototype-key names as ordinary names", () => {
    const report = computeAgentCost([sub("__proto__", 1), sub("constructor", 2), sub("toString", 3), sub("__proto__", 1)]);
    expect(report.byAgentType.map((r) => [r.agentType, r.cost, r.messages])).toEqual([
      ["toString", 3, 1],
      ["__proto__", 2, 2],
      ["constructor", 2, 1],
    ]);
  });

  it("breaks cost ties by name ascending, null last", () => {
    const report = computeAgentCost([sub(null, 1), sub("my-reviewer", 1), sub("acme-critic", 1)]);
    expect(report.byAgentType.map((r) => r.agentType)).toEqual(["acme-critic", "my-reviewer", null]);
  });

  it("reads a value that fails identifier validation as not recorded", () => {
    const report = computeAgentCost([sub("<img src=x onerror=alert(1)>", 2), sub("=cmd", 1)]);
    expect(report.byAgentType).toEqual([{ agentType: null, builtIn: false, cost: 3, share: 1, messages: 2 }]);
    expect(report.coverage.knownTypeCost).toBe(0);
  });
});

describe("computeAgentCost — by skill (during the run)", () => {
  it("sums main and subagent rows while a skill runs; rows without one are not listed", () => {
    const report = computeAgentCost([
      row({ skill: "example-skill", cost: 2 }),
      sub("my-reviewer", 3, { skill: "example-skill" }),
      row({ cost: 5 }),
    ]);
    expect(report.bySkill).toEqual([{ skill: "example-skill", costDuringRun: 5, share: 0.5, messages: 2 }]);
  });
});

describe("computeAgentCost — by spawn depth", () => {
  it("splits subagent spend by depth with a null bucket for unrecorded depth", () => {
    const report = computeAgentCost([
      sub("Explore", 4, { spawnDepth: 1 }),
      sub("my-reviewer", 2, { spawnDepth: 2 }),
      sub("my-reviewer", 2, { spawnDepth: null }),
      sub(null, 1, { spawnDepth: 99 }), // fails validSpawnDepth → null
    ]);
    expect(report.bySpawnDepth).toEqual([
      { depth: 1, cost: 4, share: 4 / 9, messages: 1 },
      { depth: null, cost: 3, share: 3 / 9, messages: 2 },
      { depth: 2, cost: 2, share: 2 / 9, messages: 1 },
    ]);
  });
});

describe("computeAgentCost — limit and other", () => {
  it("keeps the null bucket and folds named rows past the limit", () => {
    const report = computeAgentCost(
      [sub("my-reviewer", 5), sub("acme-critic", 4), sub("Explore", 3), sub("general-purpose", 2), sub(null, 1)],
      { limit: 2 },
    );
    expect(report.byAgentType.map((r) => r.agentType)).toEqual(["my-reviewer", "acme-critic", null]);
    expect(report.other.byAgentType).toEqual({ buckets: 2, cost: 5, share: 5 / 15, messages: 2 });
    expect(report.other.bySkill).toBeNull();
    expect(report.other.bySpawnDepth).toBeNull();
  });

  it("folds skills using that list's field name and total-cost share", () => {
    const report = computeAgentCost(
      [row({ skill: "example-skill", cost: 3 }), row({ skill: "my-reviewer", cost: 1 }), row({ cost: 6 })],
      { limit: 1 },
    );
    expect(report.bySkill.map((r) => r.skill)).toEqual(["example-skill"]);
    expect(report.other.bySkill).toEqual({ buckets: 1, costDuringRun: 1, share: 0.1, messages: 1 });
  });

  it("rejects a limit that is not a safe integer >= 1", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => computeAgentCost([], { limit: bad })).toThrow(RangeError);
    }
  });
});

describe("computeAgentCost — degenerate inputs", () => {
  it("empty input: all zeros, empty lists, no NaN", () => {
    const report = computeAgentCost([]);
    expect(report).toEqual({
      coverage: {
        totalCost: 0,
        mainCost: 0,
        subagentCost: 0,
        mainShare: 0,
        subagentShare: 0,
        messages: 0,
        mainMessages: 0,
        subagentMessages: 0,
        unpricedMessages: 0,
        knownTypeCost: 0,
        knownTypeShare: 0,
        periodGranularity: "day",
        byPeriod: [],
        undatedSubagentCost: 0,
      },
      byAgentType: [],
      bySkill: [],
      bySpawnDepth: [],
      other: { byAgentType: null, bySkill: null, bySpawnDepth: null },
    });
  });

  it("zero-cost subagents: shares are 0, not NaN", () => {
    const report = computeAgentCost([sub("my-reviewer", 0), sub(null, 0)]);
    expect(report.coverage.knownTypeShare).toBe(0);
    expect(report.coverage.subagentShare).toBe(0);
    expect(report.byAgentType.every((r) => r.share === 0)).toBe(true);
    expect(report.coverage.byPeriod[0]!.knownTypeShare).toBe(0);
  });

  it("a NaN, infinite or negative cost reads as 0", () => {
    const report = computeAgentCost([
      sub("my-reviewer", Number.NaN),
      sub("my-reviewer", Number.POSITIVE_INFINITY),
      sub("my-reviewer", -5),
      sub("my-reviewer", 2),
    ]);
    expect(report.coverage.subagentCost).toBe(2);
    expect(report.byAgentType[0]!.messages).toBe(4);
  });

  it("uses no ranking or judgement words in any field name", () => {
    const report = computeAgentCost([sub("my-reviewer", 1, { skill: "example-skill" })], { limit: 1 });
    const keys: string[] = [];
    JSON.stringify(report, (k, v: unknown) => {
      keys.push(k);
      return v;
    });
    expect(keys.filter((k) => /top|waste|offend|rank|worst|best/i.test(k))).toEqual([]);
  });
});
