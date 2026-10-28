/**
 * Pins run semantics, threshold overrides, ordering and finding shape for
 * `high-effort-low-output` (#125 PR 3). Synthetic rows only.
 */
import { describe, it, expect } from "vitest";
import {
  detectHighEffortLowOutput,
  runHygieneDetectors,
  DEFAULT_HYGIENE_THRESHOLDS,
  type HygieneMessageRow,
} from "@claude-stats/core/hygiene";
import { estimateCost } from "@claude-stats/core/pricing";

const T0 = 1_767_571_200_000;
const TH = DEFAULT_HYGIENE_THRESHOLDS.highEffortLowOutput;

function row(i: number, o: Partial<HygieneMessageRow> = {}): HygieneMessageRow {
  const sessionId = o.sessionId ?? "s1";
  return {
    sessionId,
    projectPath: "/w/alpha",
    uuid: `${sessionId}-m${String(i).padStart(4, "0")}`,
    timestamp: T0 + i * 60_000,
    model: "claude-sonnet-5",
    inputTokens: 1_000,
    outputTokens: 80,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    toolErrorCount: 0,
    tools: ["Bash"],
    outputPlaceholder: false,
    effort: "xhigh",
    isSubagent: false,
    claudeVersion: "2.1.311",
    ...o,
  };
}
const rows = (n: number, f: (i: number) => Partial<HygieneMessageRow> = () => ({})) =>
  Array.from({ length: n }, (_, i) => row(i, f(i)));
const fire = (r: HygieneMessageRow[]) => detectHighEffortLowOutput(r, TH);
const money = (n: number) => `$${n.toFixed(2)}`;
const cost = (input: number) => estimateCost("claude-sonnet-5", input, 80, 0, 0).cost;

describe("excluded rows are removed before runs form", () => {
  it("12 qualifying + 1 excluded + 12 qualifying is ONE run of 24 turns", () => {
    const r = rows(25, (i) => (i === 12 ? { isSubagent: true, claudeVersion: "2.1.306" } : { isSubagent: true, claudeVersion: "2.1.307" }));
    const f = fire(r);
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain("24 turns");
  });
});

describe("remedy on a mixed run", () => {
  it("a run with main and subagent rows gets the main-conversation remedy", () => {
    const f = fire(rows(30, (i) => ({ isSubagent: i % 2 === 0 })));
    expect(f).toHaveLength(1);
    expect(f[0]!.remedy).toMatch(/switch at session start/);
    expect(f[0]!.remedy).not.toMatch(/Agent call/);
  });
});

describe("threshold overrides reach the detector", () => {
  const run = (rs: HygieneMessageRow[], o: Partial<typeof TH>) =>
    runHygieneDetectors(rs, { thresholds: { highEffortLowOutput: o } }).find((d) => d.detectorId === "high-effort-low-output")!
      .findings;

  it("maxMedianOutputTokens: 50 on 80-token rows is silent; 80 fires and shows 80", () => {
    expect(run(rows(30), { maxMedianOutputTokens: 50 })).toHaveLength(0);
    const f = run(rows(30), { maxMedianOutputTokens: 80 });
    expect(f).toHaveLength(1);
    expect(f[0]!.threshold).toContain("median output ≤80 tokens");
  });

  it("minToolTurnShare: 1 with one tool-less turn is silent; default fires; threshold shows 100%", () => {
    const r = rows(30, (i) => (i === 5 ? { tools: [] } : {}));
    expect(run(r, {})).toHaveLength(1);
    expect(run(r, { minToolTurnShare: 1 })).toHaveLength(0);
    expect(run(rows(30), { minToolTurnShare: 1 })[0]!.threshold).toContain("≥100% of turns");
  });

  it("minRunTurns override: 31 silences a 30-turn run; 30 fires and shows 30", () => {
    expect(run(rows(30), { minRunTurns: 31 })).toHaveLength(0);
    expect(run(rows(30), { minRunTurns: 30 })[0]!.threshold).toContain("≥30 turns");
  });

  it("defaults show 20 / 80% / 500", () => {
    expect(run(rows(30), {})[0]!.threshold).toBe("≥20 turns; ≥80% of turns call a tool; median output ≤500 tokens");
  });
});

describe("sessions and caller ordering", () => {
  it("two interleaved sessions a,b,a,b (25 rows each) give two findings, one sessionId each", () => {
    const a = rows(25, () => ({ sessionId: "a" }));
    const b = rows(25, () => ({ sessionId: "b" }));
    const inter = a.flatMap((x, i) => [x, b[i]!]);
    const f = fire(inter);
    expect(f).toHaveLength(2);
    expect(f.map((x) => x.sessionIds).sort()).toEqual([["a"], ["b"]]);
  });

  it("a medium row in session a splits a's run only (b's 25-turn run survives)", () => {
    const a = rows(25, (i) => ({ sessionId: "a", ...(i === 12 ? { effort: "medium" } : {}) }));
    const b = rows(25, () => ({ sessionId: "b" }));
    const f = fire(a.flatMap((x, i) => [x, b[i]!]));
    expect(f).toHaveLength(1);
    expect(f[0]!.sessionIds).toEqual(["b"]);
    expect(f[0]!.detail).toContain("25 turns");
  });

  it("shuffled input gives the same findings as ordered input", () => {
    const ordered = rows(30);
    // deterministic shuffle: stride permutation (7 is coprime with 30)
    const shuffled = ordered.map((_, i) => ordered[(i * 7) % 30]!);
    expect(shuffled).not.toEqual(ordered);
    expect(fire(shuffled)).toEqual(fire(ordered));
    // and a shuffled run split by a medium row is still split
    const split = rows(31, (i) => (i === 15 ? { effort: "medium" } : {}));
    expect(fire(split.map((_, i) => split[(i * 7) % 31]!))).toHaveLength(0);
  });
});

describe("cost and detail", () => {
  it("15 high + 1 medium + 20 high: cost covers only the 20-turn run; each finding states its own turns and cost", () => {
    // 36 rows; per-row input grows so costs differ.
    const r = rows(36, (i) => ({ inputTokens: 1_000 + i * 50_000, ...(i === 15 ? { effort: "medium" } : {}) }));
    const f = fire(r);
    expect(f).toHaveLength(1); // the 15-turn run is below N
    let c20 = 0;
    for (let i = 16; i < 36; i++) c20 += cost(1_000 + i * 50_000);
    let c15 = 0;
    for (let i = 0; i < 15; i++) c15 += cost(1_000 + i * 50_000);
    expect(money(c20)).not.toBe(money(c15 + c20));
    expect(f[0]!.detail).toContain("20 turns at xhigh");
    expect(f[0]!.detail).toContain(`run cost ${money(c20)}`);
  });

  it("two findings in one session each carry their own turn count and cost", () => {
    // run 1: 0..19 (20 turns), medium at 20, run 2: 21..45 (25 turns)
    const r = rows(46, (i) => ({ inputTokens: 1_000 + i * 50_000, ...(i === 20 ? { effort: "medium" } : {}) }));
    const f = fire(r);
    expect(f).toHaveLength(2);
    let c1 = 0;
    for (let i = 0; i < 20; i++) c1 += cost(1_000 + i * 50_000);
    let c2 = 0;
    for (let i = 21; i < 46; i++) c2 += cost(1_000 + i * 50_000);
    expect(f[0]!.detail).toContain("20 turns");
    expect(f[0]!.detail).toContain(`run cost ${money(c1)}`);
    expect(f[1]!.detail).toContain("25 turns");
    expect(f[1]!.detail).toContain(`run cost ${money(c2)}`);
    expect(money(c1)).not.toBe(money(c2));
  });

  it("tool-turn share is shown rounded to a whole percent", () => {
    // 25 turns, 21 with tools = 84%
    const f = fire(rows(25, (i) => (i < 4 ? { tools: [] } : {})));
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain("84% tool turns");
    // 26 turns, 21 tool turns = 80.77% -> 81%
    expect(fire(rows(26, (i) => (i < 5 ? { tools: [] } : {})))[0]!.detail).toContain("81% tool turns");
  });
});

describe("finding shape", () => {
  it("carries no project path or uuid", () => {
    const f = fire(rows(30))[0]!;
    expect(Object.keys(f).sort()).toEqual(
      ["detail", "detectorId", "estimatedWaste", "remedy", "rule", "sessionIds", "threshold"].sort(),
    );
    const json = JSON.stringify(f);
    expect(json).not.toContain("/w/alpha");
    expect(json).not.toContain("s1-m0");
  });
});
