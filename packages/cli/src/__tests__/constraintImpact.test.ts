/**
 * Constraint before/after engine (Lane M) — pure module tests.
 *
 * Design: doc/analysis/constraint-impact/. Every honesty gate gets a
 * "does NOT fire / does NOT invent a number" case beside the happy path —
 * the lesson this build keeps re-learning is that a green suite over the
 * happy path alone lets a mutation through.
 */
import { describe, it, expect } from "vitest";
import {
  compareConstraintImpact,
  parsePolicyEventBoundaryMs,
  renderConstraintImpactCsv,
  DEFAULT_MIN_SESSIONS_PER_CLASS,
  NOT_MEASURED,
  type ConstraintImpactSessionRow,
  type ConstraintImpactClassification,
} from "@claude-stats/core/constraintImpact";
import type { PolicyEvent } from "@claude-stats/core/types/insight";

const POLICY: PolicyEvent = { date: "2026-05-01", kind: "model-removal", detail: "opus", scope: "org" };

function session(
  overrides: Partial<ConstraintImpactSessionRow> & { sessionId: string },
): ConstraintImpactSessionRow {
  return {
    cost: 1,
    tokensTotal: 1000,
    turns: 4,
    toolErrors: 0,
    activeDurationMs: 5 * 60_000,
    medianResponseTimeMs: 2000,
    models: ["claude-sonnet-5"],
    ...overrides,
  };
}

/** N sessions in a class, cost/turns/errors/activeMinutes uniform across them
 *  unless overridden per-index. */
function classOf(
  prefix: string,
  n: number,
  build: (i: number) => Partial<ConstraintImpactSessionRow>,
): ConstraintImpactSessionRow[] {
  return Array.from({ length: n }, (_, i) => session({ sessionId: `${prefix}-${i}`, ...build(i) }));
}

function classify(
  rows: readonly ConstraintImpactSessionRow[],
  fine: ConstraintImpactClassification["fine"] = "debug",
  confidence: ConstraintImpactClassification["confidence"] = "high",
): ReadonlyMap<string, ConstraintImpactClassification> {
  const map = new Map<string, ConstraintImpactClassification>();
  for (const r of rows) map.set(r.sessionId, { fine, coarse: "diagnose", confidence });
  return map;
}

describe("parsePolicyEventBoundaryMs", () => {
  it("parses as UTC midnight regardless of host timezone", () => {
    expect(parsePolicyEventBoundaryMs("2026-05-01")).toBe(Date.UTC(2026, 4, 1, 0, 0, 0, 0));
  });
});

describe("compareConstraintImpact — sample-size gate", () => {
  it("abstains (insufficient-data) when either side is below the floor, even with a huge delta", () => {
    const before = classOf("b", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ cost: 10 }));
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS - 1, () => ({ cost: 0.01 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    expect(report.classes).toHaveLength(1);
    const [c] = report.classes;
    expect(c!.verdict).toBe("insufficient-data");
    expect(c!.nBefore).toBe(DEFAULT_MIN_SESSIONS_PER_CLASS);
    expect(c!.nAfter).toBe(DEFAULT_MIN_SESSIONS_PER_CLASS - 1);
    // No number invented on a class that abstained — I1.
    expect(c!.tokenSavingsAtAfterVolume).toBeNull();
    expect(c!.netEffectAtAfterVolume).toBeNull();
    expect(c!.direction).toBe("unknown");
    expect(report.classesCompared).toBe(0);
    expect(report.classesInsufficientData).toBe(1);
    expect(report.totalTokenSavings).toBeNull();
  });

  it("compares once both sides clear the floor", () => {
    const before = classOf("b", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ cost: 10 }));
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ cost: 5 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    const [c] = report.classes;
    expect(c!.verdict).toBe("compared");
    expect(c!.avgCostBefore).toBe(10);
    expect(c!.avgCostAfter).toBe(5);
  });

  it("a custom minSessionsPerClass changes the gate", () => {
    const before = classOf("b", 3, () => ({ cost: 10 }));
    const after = classOf("a", 3, () => ({ cost: 5 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY, {
      minSessionsPerClass: 3,
    });
    expect(report.classes[0]!.verdict).toBe("compared");
    expect(report.classes[0]!.minSessionsPerClass).toBe(3);
  });
});

describe("compareConstraintImpact — classification join", () => {
  it("excludes sessions with no stored classification", () => {
    const before = classOf("b", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({}));
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({}));
    // Only classify the "before" sessions — "after" sessions are unclassified.
    const taskClassBySession = classify(before);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    const [c] = report.classes;
    expect(c!.nBefore).toBe(DEFAULT_MIN_SESSIONS_PER_CLASS);
    expect(c!.nAfter).toBe(0);
    expect(c!.verdict).toBe("insufficient-data");
  });

  it("excludes sessions the classifier abstained on (fine === 'unknown')", () => {
    const before = classOf("b", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({}));
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({}));
    const taskClassBySession = classify([...before, ...after], "unknown");
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);
    expect(report.classes).toHaveLength(0);
  });

  it("routes a low-confidence session to the coarse bucket, not the fine one", () => {
    const before = classOf("b", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({}));
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({}));
    const taskClassBySession = classify([...before, ...after], "debug", "low");
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    expect(report.classes).toHaveLength(1);
    expect(report.classes[0]!.classKey).toBe("coarse:diagnose");
    expect(report.classes[0]!.grain).toBe("coarse");
  });
});

describe("compareConstraintImpact — the metric channels", () => {
  it("computes tokenSavingsAtAfterVolume as (avgBefore - avgAfter) * nAfter, signed toward savings", () => {
    const before = classOf("b", 10, () => ({ cost: 10 }));
    const after = classOf("a", 8, () => ({ cost: 6 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    const [c] = report.classes;
    // (10 - 6) * 8 = 32
    expect(c!.tokenSavingsAtAfterVolume).toBeCloseTo(32, 6);
    expect(c!.costTrend).toBe("down");
  });

  it("reports a NEGATIVE tokenSavingsAtAfterVolume when the after period costs MORE", () => {
    const before = classOf("b", 10, () => ({ cost: 4 }));
    const after = classOf("a", 8, () => ({ cost: 10 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);
    expect(report.classes[0]!.tokenSavingsAtAfterVolume).toBeLessThan(0);
    expect(report.classes[0]!.costTrend).toBe("up");
  });

  it("computes the tool-error rate as Σerrors/Σturns, not a mean of per-session rates", () => {
    // One busy, error-free session (20 turns, 0 errors) beside one small,
    // all-error session (2 turns, 2 errors). A mean-of-rates would average
    // 0% and 100% to 50%; the pooled rate is 2/22 ≈ 9.1%.
    const before = [
      session({ sessionId: "b0", turns: 20, toolErrors: 0 }),
      session({ sessionId: "b1", turns: 2, toolErrors: 2 }),
      ...classOf("b-extra", DEFAULT_MIN_SESSIONS_PER_CLASS - 2, () => ({ turns: 5, toolErrors: 0 })),
    ];
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ turns: 5, toolErrors: 0 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    const totalTurns = 20 + 2 + 5 * (DEFAULT_MIN_SESSIONS_PER_CLASS - 2);
    expect(report.classes[0]!.toolErrorRateBefore).toBeCloseTo(2 / totalTurns, 10);
  });

  it("excludes null activeDurationMs from the average rather than treating it as zero", () => {
    const before = [
      ...classOf("b-known", DEFAULT_MIN_SESSIONS_PER_CLASS - 1, () => ({ activeDurationMs: 10 * 60_000 })),
      session({ sessionId: "b-null", activeDurationMs: null }),
    ];
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ activeDurationMs: 10 * 60_000 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    const [c] = report.classes;
    // If the null had been treated as 0, the average would be pulled well
    // below 10 minutes; it must stay exactly 10 (computed only over coverage).
    expect(c!.avgActiveMinutesBefore).toBeCloseTo(10, 6);
    expect(c!.activeMinutesCoverageBefore).toBe(DEFAULT_MIN_SESSIONS_PER_CLASS - 1);
    expect(c!.nBefore).toBe(DEFAULT_MIN_SESSIONS_PER_CLASS);
  });

  it("reports median alongside mean as the distribution signal", () => {
    const before = [
      session({ sessionId: "b0", cost: 1 }),
      session({ sessionId: "b1", cost: 1 }),
      session({ sessionId: "b2", cost: 1 }),
      session({ sessionId: "b3", cost: 1 }),
      session({ sessionId: "b4", cost: 1 }),
      session({ sessionId: "b5", cost: 1 }),
      session({ sessionId: "b6", cost: 1 }),
      session({ sessionId: "b-outlier", cost: 1000 }), // one pathological session
    ];
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ cost: 1 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    const [c] = report.classes;
    expect(c!.medianCostBefore).toBe(1); // unmoved by the outlier
    expect(c!.avgCostBefore).toBeGreaterThan(1); // the mean IS moved by it
  });

  it("carries distinct, sorted model ids per side as the confound annotation", () => {
    const before = [
      session({ sessionId: "b0", models: ["claude-opus-5"] }),
      ...classOf("b-extra", DEFAULT_MIN_SESSIONS_PER_CLASS - 1, () => ({ models: ["claude-opus-5"] })),
    ];
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ models: ["claude-sonnet-5"] }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    expect(report.classes[0]!.modelsBefore).toEqual(["claude-opus-5"]);
    expect(report.classes[0]!.modelsAfter).toEqual(["claude-sonnet-5"]);
  });
});

describe("compareConstraintImpact — the salary denominator (Gap 4)", () => {
  it("never prices dev-time without a configured hourly rate", () => {
    const before = classOf("b", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ activeDurationMs: 5 * 60_000 }));
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ activeDurationMs: 30 * 60_000 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    const [c] = report.classes;
    // The minutes delta IS known even without a rate...
    expect(c!.devTimeDeltaMinutesAtAfterVolume).toBeGreaterThan(0);
    // ...but nothing prices it, and the net effect is unavailable.
    expect(c!.devTimeCostAtAfterVolume).toBeNull();
    expect(c!.netEffectAtAfterVolume).toBeNull();
    expect(c!.direction).toBe("unknown");
    expect(report.netEffectAvailable).toBe(false);
    expect(report.totalDevTimeCost).toBeNull();
    expect(report.totalNetEffect).toBeNull();
  });

  it("prices the dev-time delta and nets it against token savings once a rate is configured", () => {
    const before = classOf("b", 10, () => ({ cost: 10, activeDurationMs: 5 * 60_000 }));
    const after = classOf("a", 10, () => ({ cost: 6, activeDurationMs: 30 * 60_000 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY, { hourlyRate: 60 });

    const [c] = report.classes;
    // tokenSavings = (10-6)*10 = 40. devTimeDeltaMinutes = (30-5)*10 = 250min
    // = 250/60 h * $60/h = $250. net = 40 - 250 = -210 (unfavorable).
    expect(c!.tokenSavingsAtAfterVolume).toBeCloseTo(40, 6);
    expect(c!.devTimeDeltaMinutesAtAfterVolume).toBeCloseTo(250, 6);
    expect(c!.devTimeCostAtAfterVolume).toBeCloseTo(250, 6);
    expect(c!.netEffectAtAfterVolume).toBeCloseTo(-210, 6);
    expect(c!.direction).toBe("unfavorable");
    expect(report.totalNetEffect).toBeCloseTo(-210, 6);
  });

  it("classifies a near-zero net effect as negligible, not favorable/unfavorable", () => {
    const before = classOf("b", 10, () => ({ cost: 10, activeDurationMs: 10 * 60_000 }));
    // Barely any change on either channel.
    const after = classOf("a", 10, () => ({ cost: 10.01, activeDurationMs: 10 * 60_000 + 100 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY, { hourlyRate: 60 });
    expect(report.classes[0]!.direction).toBe("negligible");
  });

  it("classifies a large favorable net effect correctly (the two-sided report's good-news case)", () => {
    const before = classOf("b", 10, () => ({ cost: 10, activeDurationMs: 20 * 60_000 }));
    const after = classOf("a", 10, () => ({ cost: 2, activeDurationMs: 21 * 60_000 })); // trivial dev-time cost
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY, { hourlyRate: 60 });
    expect(report.classes[0]!.direction).toBe("favorable");
    expect(report.totalNetEffect).toBeGreaterThan(0);
  });
});

describe("compareConstraintImpact — two-sided reporting", () => {
  it("reports EVERY class touched on either side, including insufficient-data ones — never drops a class silently", () => {
    const goodBefore = classOf("gb", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({}));
    const goodAfter = classOf("ga", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({}));
    const sparseBefore = classOf("sb", 2, () => ({}));
    const sparseAfter = classOf("sa", 2, () => ({}));

    const taskClassBySession = new Map<string, ConstraintImpactClassification>();
    for (const r of [...goodBefore, ...goodAfter]) {
      taskClassBySession.set(r.sessionId, { fine: "debug", coarse: "diagnose", confidence: "high" });
    }
    for (const r of [...sparseBefore, ...sparseAfter]) {
      taskClassBySession.set(r.sessionId, { fine: "greenfield", coarse: "build", confidence: "high" });
    }

    const report = compareConstraintImpact(
      [...goodBefore, ...sparseBefore],
      [...goodAfter, ...sparseAfter],
      taskClassBySession,
      POLICY,
    );

    expect(report.classes.map((c) => c.classKey).sort()).toEqual(["debug", "greenfield"]);
    expect(report.classesCompared).toBe(1);
    expect(report.classesInsufficientData).toBe(1);
  });

  it("carries a confound caveat and the not-measured scope list on every report", () => {
    const report = compareConstraintImpact([], [], new Map(), POLICY);
    expect(report.confoundNote.length).toBeGreaterThan(0);
    expect(report.notMeasured).toEqual(NOT_MEASURED);
    expect(report.classes).toHaveLength(0);
  });

  it("carries the policy event and boundary through untouched", () => {
    const report = compareConstraintImpact([], [], new Map(), POLICY);
    expect(report.policyEvent).toEqual(POLICY);
    expect(report.boundaryMs).toBe(parsePolicyEventBoundaryMs(POLICY.date));
  });
});

describe("renderConstraintImpactCsv", () => {
  it("emits a header row and one data row per class, including insufficient-data ones", () => {
    const compared = classOf("b", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ cost: 10 }));
    const comparedAfter = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ cost: 5 }));
    const sparseBefore = classOf("sb", 2, () => ({}));
    const sparseAfter = classOf("sa", 2, () => ({}));

    const taskClassBySession = new Map<string, ConstraintImpactClassification>();
    for (const r of [...compared, ...comparedAfter]) {
      taskClassBySession.set(r.sessionId, { fine: "debug", coarse: "diagnose", confidence: "high" });
    }
    for (const r of [...sparseBefore, ...sparseAfter]) {
      taskClassBySession.set(r.sessionId, { fine: "greenfield", coarse: "build", confidence: "high" });
    }
    const report = compareConstraintImpact(
      [...compared, ...sparseBefore],
      [...comparedAfter, ...sparseAfter],
      taskClassBySession,
      POLICY,
    );

    const csv = renderConstraintImpactCsv(report);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3); // header + 2 classes
    expect(lines[0]).toBe(
      "classKey,grain,verdict,nBefore,nAfter,avgCostBefore,avgCostAfter,avgTokensBefore,avgTokensAfter," +
        "avgTurnsBefore,avgTurnsAfter,toolErrorRateBefore,toolErrorRateAfter,avgActiveMinutesBefore," +
        "avgActiveMinutesAfter,medianResponseMsBefore,medianResponseMsAfter,tokenSavingsAtAfterVolume," +
        "devTimeDeltaMinutesAtAfterVolume,devTimeCostAtAfterVolume,netEffectAtAfterVolume,direction," +
        "modelsBefore,modelsAfter",
    );
    // The sparse (insufficient-data) row: blank numeric cells, never "0".
    const sparseLine = lines.find((l) => l.startsWith("greenfield,"))!;
    expect(sparseLine).toContain(",,"); // at least one blank numeric field
    expect(sparseLine.split(",")[3]).toBe("2"); // nBefore
  });

  it("joins per-session model lists with a semicolon", () => {
    const before = classOf("b", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ models: ["claude-opus-5", "claude-sonnet-5"] }));
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ models: ["claude-sonnet-5"] }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);
    const csv = renderConstraintImpactCsv(report);
    expect(csv).toContain("claude-opus-5;claude-sonnet-5");
  });
});
