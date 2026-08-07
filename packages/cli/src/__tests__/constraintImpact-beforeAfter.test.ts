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

  it("a floor that is not a number cannot DISABLE the gate (NaN < NaN is false)", () => {
    // Regression: `--min-sessions abc` → `Number("abc")` → NaN → `n < NaN` is
    // false for every n, so a one-session-per-side class was reported
    // `verdict: "compared"` with a delta computed on n=1, while the
    // `minSessionsPerClass` that "travels with the figure" serialised to
    // JSON `null`. A gate that vanishes on bad input still claims to have
    // gated — the exact I1 failure this report is built to avoid.
    const before = classOf("b", 1, () => ({ cost: 100 }));
    const after = classOf("a", 1, () => ({ cost: 1 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY, {
      minSessionsPerClass: Number("abc"),
    });

    const [c] = report.classes;
    expect(c!.verdict).toBe("insufficient-data");
    expect(c!.tokenSavingsAtAfterVolume).toBeNull();
    expect(report.minSessionsPerClass).toBe(DEFAULT_MIN_SESSIONS_PER_CLASS);
    expect(Number.isFinite(report.minSessionsPerClass)).toBe(true);
  });

  it("a floor below one is not a floor — falls back to the default rather than gating on nothing", () => {
    const before = classOf("b", 1, () => ({ cost: 100 }));
    const after = classOf("a", 1, () => ({ cost: 1 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY, {
      minSessionsPerClass: 0,
    });
    expect(report.classes[0]!.verdict).toBe("insufficient-data");
    expect(report.minSessionsPerClass).toBe(DEFAULT_MIN_SESSIONS_PER_CLASS);
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

  it("reports a real tool-error-rate trend when both sides have a denominator", () => {
    const before = classOf("b", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ turns: 10, toolErrors: 5 }));
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ turns: 10, toolErrors: 1 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    const [c] = report.classes;
    expect(c!.toolErrorRateBefore).toBeCloseTo(0.5, 10);
    expect(c!.toolErrorRateAfter).toBeCloseTo(0.1, 10);
    expect(c!.toolErrorRateTrend).toBe("down");
  });

  it("abstains on the tool-error-rate trend when a side has no denominator, rather than reading it as zero", () => {
    // Zero turns on the after side means there is no rate to compare — not a
    // rate of 0%. Treating the missing denominator as 0 would manufacture a
    // "down" (improved) trend out of absent data.
    const before = classOf("b", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ turns: 10, toolErrors: 5 }));
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ turns: 0, toolErrors: 0 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    const [c] = report.classes;
    expect(c!.toolErrorRateAfter).toBeNull();
    expect(c!.toolErrorRateTrend).toBe("unknown");
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

  it("M-1: medianResponseMsBefore/After is the actual median, not a mean of medians", () => {
    // Same outlier shape as the cost case above: seven ordinary sessions at
    // 2000ms beside one pathological session at 100_000ms. A median of the
    // per-session medians stays at 2000 (unmoved by the outlier); a MEAN of
    // those same values would be pulled well above it. The field is named
    // `medianResponseMs*` — if it silently reported a mean, this assertion
    // catches it directly instead of relying on the name alone.
    const before = [
      session({ sessionId: "b0", medianResponseTimeMs: 2000 }),
      session({ sessionId: "b1", medianResponseTimeMs: 2000 }),
      session({ sessionId: "b2", medianResponseTimeMs: 2000 }),
      session({ sessionId: "b3", medianResponseTimeMs: 2000 }),
      session({ sessionId: "b4", medianResponseTimeMs: 2000 }),
      session({ sessionId: "b5", medianResponseTimeMs: 2000 }),
      session({ sessionId: "b6", medianResponseTimeMs: 2000 }),
      session({ sessionId: "b-outlier", medianResponseTimeMs: 100_000 }),
    ];
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ medianResponseTimeMs: 2000 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    const [c] = report.classes;
    expect(c!.medianResponseMsBefore).toBe(2000); // unmoved by the outlier
    // A mean-of-medians would land at (7*2000 + 100000) / 8 = 14250 — well
    // above the true median. Guard against that regression explicitly.
    expect(c!.medianResponseMsBefore).toBeLessThan(14250);
  });

  it("M-1: medianResponseMsBefore/After is null, not NaN, with no data on that side", () => {
    const before = classOf("b", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ medianResponseTimeMs: null }));
    const after = classOf("a", DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({ medianResponseTimeMs: 2000 }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    const [c] = report.classes;
    expect(c!.medianResponseMsBefore).toBeNull();
    expect(c!.medianResponseTrend).toBe("unknown");
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

  it("orders classes deterministically by classKey, whatever order the rows arrive in", () => {
    const build = (prefix: string) => classOf(prefix, DEFAULT_MIN_SESSIONS_PER_CLASS, () => ({}));
    const keys: Array<[string, ConstraintImpactClassification["fine"]]> = [
      ["z", "review"],
      ["a", "debug"],
      ["m", "greenfield"],
    ];
    const taskClassBySession = new Map<string, ConstraintImpactClassification>();
    const before: ConstraintImpactSessionRow[] = [];
    const after: ConstraintImpactSessionRow[] = [];
    for (const [prefix, fine] of keys) {
      const b = build(`${prefix}b`);
      const a = build(`${prefix}a`);
      for (const r of [...b, ...a]) taskClassBySession.set(r.sessionId, { fine, coarse: "build", confidence: "high" });
      before.push(...b);
      after.push(...a);
    }
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);
    // NOT `.sort()`ed by the assertion — the ordering under test is the
    // report's own, so a dropped sort in the engine has to show up here.
    expect(report.classes.map((c) => c.classKey)).toEqual(["debug", "greenfield", "review"]);
  });

  it("publishes the active-minutes coverage denominator on an ABSTAINING class too", () => {
    // The abstaining row still reports how many of its sessions had a usable
    // `active_duration_ms` — the denominator a reader needs to judge why the
    // class abstained, and the one place a coverage count is computed on a
    // path the compared-row assertions never touch.
    const before = [
      ...classOf("b-known", 2, () => ({ activeDurationMs: 60_000 })),
      session({ sessionId: "b-null", activeDurationMs: null }),
    ];
    const after = classOf("a", 1, () => ({ activeDurationMs: null }));
    const taskClassBySession = classify([...before, ...after]);
    const report = compareConstraintImpact(before, after, taskClassBySession, POLICY);

    const [c] = report.classes;
    expect(c!.verdict).toBe("insufficient-data");
    expect(c!.nBefore).toBe(3);
    expect(c!.activeMinutesCoverageBefore).toBe(2);
    expect(c!.activeMinutesCoverageAfter).toBe(0);
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
