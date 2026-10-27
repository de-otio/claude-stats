/**
 * `high-effort-low-output` hygiene detector (#125 PR 3, B3).
 *
 * Every "silent" case changes exactly ONE thing from a baseline that fires, so
 * dropping any single condition from the detector fails at least one test.
 * Thresholds: V5(b) — N >= 20, tool share >= 0.8, median output <= 500, and no
 * Edit/Write/MultiEdit/NotebookEdit/Agent/StructuredOutput call in the run.
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
  return {
    sessionId: "s1",
    projectPath: "/w/alpha",
    uuid: `${o.sessionId ?? "s1"}-m${i}`,
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

/** `n` rows from a per-index override function. */
const rows = (n: number, f: (i: number) => Partial<HygieneMessageRow> = () => ({})) =>
  Array.from({ length: n }, (_, i) => row(i, f(i)));

const fire = (r: HygieneMessageRow[]) => detectHighEffortLowOutput(r, TH);

describe("high-effort-low-output: baseline", () => {
  it("fires on a 30-turn xhigh polling session; estimatedWaste is 0 (Q1 option a)", () => {
    const f = fire(rows(30));
    expect(f).toHaveLength(1);
    expect(f[0]!.detectorId).toBe("high-effort-low-output");
    expect(f[0]!.sessionIds).toEqual(["s1"]);
    expect(f[0]!.estimatedWaste).toBe(0);
    expect(f[0]!.detail).toContain("30 turns at xhigh");
    expect(f[0]!.detail).toContain("median output 80 tokens");
    expect(f[0]!.threshold).toContain("≥20 turns");
  });

  it("detail carries the run's measured cost", () => {
    const f = fire(rows(20));
    const one = estimateCost("claude-sonnet-5", 1_000, 80, 0, 0).cost;
    expect(one).toBeGreaterThan(0);
    const expected = `$${(one * 20).toFixed(2)}`;
    expect(f[0]!.detail).toContain(`run cost ${expected}`);
  });

  it("is registered in runHygieneDetectors with a title", () => {
    const res = runHygieneDetectors(rows(30)).find((r) => r.detectorId === "high-effort-low-output")!;
    expect(res.title).toBe("High effort, low output");
    expect(res.computed).toBe(true);
    expect(res.findings).toHaveLength(1);
  });

  it("thresholds can be overridden", () => {
    const res = runHygieneDetectors(rows(10), { thresholds: { highEffortLowOutput: { minRunTurns: 10 } } }).find(
      (r) => r.detectorId === "high-effort-low-output",
    )!;
    expect(res.findings).toHaveLength(1);
  });
});

describe("high-effort-low-output: threshold boundaries", () => {
  it("19 turns is silent, 20 fires", () => {
    expect(fire(rows(19))).toHaveLength(0);
    expect(fire(rows(20))).toHaveLength(1);
  });

  it("tool share 0.79 is silent, 0.8 fires (100 turns)", () => {
    // 79 tool turns of 100 = 0.79; 80 of 100 = 0.8
    expect(fire(rows(100, (i) => (i < 79 ? {} : { tools: [] })))).toHaveLength(0);
    expect(fire(rows(100, (i) => (i < 80 ? {} : { tools: [] })))).toHaveLength(1);
  });

  it("median output 501 is silent, 500 fires", () => {
    expect(fire(rows(21, () => ({ outputTokens: 501 })))).toHaveLength(0);
    expect(fire(rows(21, () => ({ outputTokens: 500 })))).toHaveLength(1);
  });

  it("uses the median, not the mean: a few huge turns do not hide a polling run", () => {
    // 21 turns, 3 of them 20,000 tokens: mean >> 500, median 80.
    expect(fire(rows(21, (i) => (i < 3 ? { outputTokens: 20_000 } : {})))).toHaveLength(1);
  });

  it("uses the median, not the mean: a few tiny turns do not trigger a design run", () => {
    // 21 turns, 10 tiny and 11 at 2,000: mean ~1,050, median 2,000.
    expect(fire(rows(21, (i) => ({ outputTokens: i < 10 ? 5 : 2_000 })))).toHaveLength(0);
  });

  it("the median of an even run averages the two middle values", () => {
    // 20 turns: ten at 400, ten at 700 -> median 550 (> 500): silent.
    expect(fire(rows(20, (i) => ({ outputTokens: i < 10 ? 400 : 700 })))).toHaveLength(0);
    // ten at 400, ten at 600 -> median 500: fires.
    expect(fire(rows(20, (i) => ({ outputTokens: i < 10 ? 400 : 600 })))).toHaveLength(1);
  });
});

describe("high-effort-low-output: work that is not polling", () => {
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "StructuredOutput"]) {
    it(`one ${tool} call anywhere in the run disqualifies it`, () => {
      expect(fire(rows(30, (i) => (i === 17 ? { tools: ["Bash", tool] } : {})))).toHaveLength(0);
    });
  }

  it("an Edit-free run with other tools still fires (Read, Grep, Bash)", () => {
    expect(fire(rows(30, (i) => ({ tools: [["Read"], ["Grep"], ["Bash"]][i % 3]! })))).toHaveLength(1);
  });
});

describe("high-effort-low-output: effort handling", () => {
  it("fires at high and at max, not only xhigh", () => {
    expect(fire(rows(20, () => ({ effort: "high" })))).toHaveLength(1);
    expect(fire(rows(20, () => ({ effort: "max" })))).toHaveLength(1);
  });

  it("is silent at medium and low", () => {
    expect(fire(rows(30, () => ({ effort: "medium" })))).toHaveLength(0);
    expect(fire(rows(30, () => ({ effort: "low" })))).toHaveLength(0);
  });

  it("null effort never fires (no inference from absence)", () => {
    expect(fire(rows(30, () => ({ effort: null })))).toHaveLength(0);
  });

  it("an unknown tier does not count as >= high", () => {
    expect(fire(rows(30, () => ({ effort: "turbo" })))).toHaveLength(0);
  });

  it("a lower-effort turn ends a run: 15 + medium + 15 high turns is two runs of 15, silent", () => {
    expect(fire(rows(31, (i) => (i === 15 ? { effort: "medium" } : {})))).toHaveLength(0);
  });

  it("a null-effort turn ends a run the same way", () => {
    expect(fire(rows(31, (i) => (i === 15 ? { effort: null } : {})))).toHaveLength(0);
  });

  it("a long run beside a short one yields one finding for the long run", () => {
    const r = rows(45, (i) => (i === 20 ? { effort: "low" } : {}));
    // runs: 0..19 (20 turns) and 21..44 (24 turns): both qualify
    expect(fire(r)).toHaveLength(2);
  });

  it("mixed high tiers form one run", () => {
    const f = fire(rows(24, (i) => ({ effort: i % 2 ? "xhigh" : "high" })));
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain("24 turns at high/xhigh");
  });
});

describe("high-effort-low-output: design session stays silent", () => {
  it("30 turns at high, median output ~2,000, half the turns tool calls", () => {
    const r = rows(30, (i) => ({ effort: "high", outputTokens: 2_000, tools: i % 2 ? ["Read"] : [] }));
    expect(fire(r)).toHaveLength(0);
  });
});

describe("high-effort-low-output: pre-2.1.307 subagent rows are excluded", () => {
  const sub = (v: string | null, extra: Partial<HygieneMessageRow> = {}) =>
    rows(30, () => ({ isSubagent: true, claudeVersion: v, ...extra }));

  it("a 2.1.306 subagent run that would otherwise fire is ignored", () => {
    expect(fire(sub("2.1.306"))).toHaveLength(0);
  });

  it("the same run on 2.1.307 fires", () => {
    expect(fire(sub("2.1.307"))).toHaveLength(1);
  });

  it("a non-subagent 2.1.300 run fires", () => {
    expect(fire(rows(30, () => ({ claudeVersion: "2.1.300" })))).toHaveLength(1);
  });

  it("excludes every pre-2.1.307 subagent row, not only those with an empty stop reason (outputPlaceholder false)", () => {
    expect(fire(sub("2.1.250", { outputPlaceholder: false }))).toHaveLength(0);
  });

  it("a flagged placeholder subagent row is ignored too", () => {
    expect(fire(sub("2.1.306", { outputPlaceholder: true }))).toHaveLength(0);
  });

  it("an unparseable or missing version is not excluded (isVersionBefore -> false)", () => {
    expect(fire(sub(null))).toHaveLength(1);
    expect(fire(sub("not-a-version"))).toHaveLength(1);
  });

  it("excluded rows are dropped, not counted: 15 qualifying + 15 pre-fix subagent rows is silent", () => {
    const r = rows(30, (i) => (i < 15 ? {} : { isSubagent: true, claudeVersion: "2.1.306" }));
    expect(fire(r)).toHaveLength(0);
  });

  it("another session's rows do not leak into the run", () => {
    const a = rows(12, () => ({ sessionId: "a" }));
    const b = rows(12, () => ({ sessionId: "b" }));
    expect(fire([...a, ...b])).toHaveLength(0);
  });
});

describe("high-effort-low-output: remedy", () => {
  it("a main-conversation run says switch at session start", () => {
    expect(fire(rows(30))[0]!.remedy).toMatch(/switch at session start/);
  });
  it("a subagent run says to pass `effort` on the Agent call", () => {
    const f = fire(rows(30, () => ({ isSubagent: true })));
    expect(f[0]!.remedy).toMatch(/pass `effort` on the Agent call/);
  });
});
