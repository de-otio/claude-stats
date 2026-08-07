/**
 * Tier-mismatch detector (Lane D2) — pure module tests.
 *
 * The scenario: an org removes top-tier model access, developers stay on the
 * mid tier, and this detector nudges them the OTHER direction — "your own
 * history shows the mid tier does just as well on this class, so stop
 * defaulting to the top tier here." Evidentiary bar is the highest of the
 * five hygiene detectors (see `tierMismatch.ts` module doc), so this file
 * pins the null results (top-tier-favored, insufficient-data) as hard as the
 * firing case — a detector that only ever confirms "downshift" would be
 * advocacy, not measurement.
 *
 * Design: doc/analysis/constraint-impact/02-model-policy-impact.md,
 * doc/analysis/efficiency-hygiene/README.md.
 */
import { describe, it, expect } from "vitest";
import {
  runHygieneDetectors,
  computeTierParity,
  detectTierMismatch,
  DEFAULT_HYGIENE_THRESHOLDS,
  type HygieneMessageRow,
  type TierMismatchClassification,
} from "@claude-stats/core/hygiene";
import { estimateCost } from "@claude-stats/core/pricing";

const T0 = 1_767_571_200_000; // FIXED_NOW, matches fixtures/synthetic.ts
const T = DEFAULT_HYGIENE_THRESHOLDS.tierMismatch;

function row(overrides: Partial<HygieneMessageRow> & { sessionId: string; uuid: string }): HygieneMessageRow {
  return {
    projectPath: "/w/alpha",
    timestamp: T0,
    model: "claude-sonnet-5",
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolErrorCount: 0,
    ...overrides,
  };
}

/** One session's messages: `turns` messages on `model`, the i-th carrying
 *  `errorsPerTurn[i] ?? 0` tool errors. */
function session(sessionId: string, model: string, turns: number, errorsPerTurn: number[] = []): HygieneMessageRow[] {
  const rows: HygieneMessageRow[] = [];
  for (let i = 0; i < turns; i++) {
    rows.push(
      row({
        sessionId,
        uuid: `${sessionId}-m${i}`,
        timestamp: T0 + i * 1000,
        model,
        toolErrorCount: errorsPerTurn[i] ?? 0,
      }),
    );
  }
  return rows;
}

function cls(fine: TierMismatchClassification["fine"], coarse: TierMismatchClassification["coarse"], confidence: TierMismatchClassification["confidence"]): TierMismatchClassification {
  return { fine, coarse, confidence };
}

/** N top-tier + N mid-tier sessions, all with the same shape (turns, no
 *  errors) — the parity fixture every other test perturbs. */
function buildParitySessions(n: number, turnsPerSession = 5): {
  rows: HygieneMessageRow[];
  taskClassBySession: Map<string, TierMismatchClassification>;
} {
  const rows: HygieneMessageRow[] = [];
  const taskClassBySession = new Map<string, TierMismatchClassification>();
  for (let i = 0; i < n; i++) {
    const topId = `top-${i}`;
    const midId = `mid-${i}`;
    rows.push(...session(topId, "claude-opus-5", turnsPerSession));
    rows.push(...session(midId, "claude-sonnet-5", turnsPerSession));
    taskClassBySession.set(topId, cls("debug", "diagnose", "high"));
    taskClassBySession.set(midId, cls("debug", "diagnose", "high"));
  }
  return { rows, taskClassBySession };
}

// ─── computeTierParity — the full table, including null results ────────────

describe("computeTierParity", () => {
  it("verdicts PARITY when top and mid tiers show identical turns and zero errors, at n === the floor", () => {
    const { rows, taskClassBySession } = buildParitySessions(T.minSessionsPerTier);
    const comparisons = computeTierParity(rows, taskClassBySession, T);
    expect(comparisons).toHaveLength(1);
    const c = comparisons[0]!;
    expect(c.classKey).toBe("debug");
    expect(c.grain).toBe("fine");
    expect(c.verdict).toBe("parity");
    expect(c.nTop).toBe(T.minSessionsPerTier);
    expect(c.nMid).toBe(T.minSessionsPerTier);
    expect(c.avgTurnsTop).toBe(5);
    expect(c.avgTurnsMid).toBe(5);
    expect(c.errorRateTop).toBe(0);
    expect(c.errorRateMid).toBe(0);
    expect(c.topSessionIds.sort()).toEqual(
      Array.from({ length: T.minSessionsPerTier }, (_, i) => `top-${i}`).sort(),
    );
  });

  it("verdicts TOP-TIER-FAVORED (not parity) when the mid tier takes meaningfully more turns", () => {
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      const midId = `mid-${i}`;
      rows.push(...session(topId, "claude-opus-5", 5)); // 5 turns, top tier
      rows.push(...session(midId, "claude-sonnet-5", 20)); // 4x the turns — clearly worse
      taskClassBySession.set(topId, cls("debug", "diagnose", "high"));
      taskClassBySession.set(midId, cls("debug", "diagnose", "high"));
    }
    const [c] = computeTierParity(rows, taskClassBySession, T);
    expect(c!.verdict).toBe("top-tier-favored");
    // The null result is REPORTED, not dropped — n and the metrics are still there.
    expect(c!.nTop).toBe(T.minSessionsPerTier);
    expect(c!.nMid).toBe(T.minSessionsPerTier);
    expect(c!.avgTurnsMid).toBe(20);
  });

  it("verdicts TOP-TIER-FAVORED when the mid tier has a meaningfully higher tool-error rate at equal turns", () => {
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      const midId = `mid-${i}`;
      rows.push(...session(topId, "claude-opus-5", 5)); // no errors
      rows.push(...session(midId, "claude-sonnet-5", 5, [1, 1, 1, 0, 0])); // 3/5 turns errored
      taskClassBySession.set(topId, cls("debug", "diagnose", "high"));
      taskClassBySession.set(midId, cls("debug", "diagnose", "high"));
    }
    const [c] = computeTierParity(rows, taskClassBySession, T);
    expect(c!.verdict).toBe("top-tier-favored");
    expect(c!.errorRateTop).toBe(0);
    expect(c!.errorRateMid).toBeCloseTo(0.6, 8);
  });

  it("computes a normal error-rate ratio when BOTH tiers have some errors — equal rates stay PARITY (not the zero-top special case)", () => {
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      const midId = `mid-${i}`;
      // Top tier: 1 errored turn in 5 (20% error rate) — nonzero, so the
      // division branch runs instead of the zero-top special case.
      rows.push(...session(topId, "claude-opus-5", 5, [1, 0, 0, 0, 0]));
      // Mid tier: same 20% error rate — ratio exactly 1, well within parity.
      rows.push(...session(midId, "claude-sonnet-5", 5, [0, 1, 0, 0, 0]));
      taskClassBySession.set(topId, cls("debug", "diagnose", "high"));
      taskClassBySession.set(midId, cls("debug", "diagnose", "high"));
    }
    const [c] = computeTierParity(rows, taskClassBySession, T);
    expect(c!.errorRateTop).toBeCloseTo(0.2, 8);
    expect(c!.errorRateMid).toBeCloseTo(0.2, 8);
    expect(c!.verdict).toBe("parity");
  });

  it("computes a normal error-rate ratio when BOTH tiers have some errors — a real gap correctly flips the verdict to TOP-TIER-FAVORED", () => {
    // Same nonzero-top-error-rate branch as above, but this time the mid
    // tier's rate is enough worse to breach `maxRelativeGap` — pins the
    // actual division, not just that SOME number came out non-crashing.
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      const midId = `mid-${i}`;
      rows.push(...session(topId, "claude-opus-5", 5, [1, 0, 0, 0, 0])); // 20% error rate
      rows.push(...session(midId, "claude-sonnet-5", 5, [1, 1, 0, 0, 0])); // 40% error rate — 2x, past the 15% tolerance
      taskClassBySession.set(topId, cls("debug", "diagnose", "high"));
      taskClassBySession.set(midId, cls("debug", "diagnose", "high"));
    }
    const [c] = computeTierParity(rows, taskClassBySession, T);
    expect(c!.errorRateTop).toBeCloseTo(0.2, 8);
    expect(c!.errorRateMid).toBeCloseTo(0.4, 8);
    expect(c!.verdict).toBe("top-tier-favored");
  });

  it("verdicts INSUFFICIENT-DATA below the per-tier sample floor, even when the shapes look identical", () => {
    const { rows, taskClassBySession } = buildParitySessions(T.minSessionsPerTier - 1);
    const [c] = computeTierParity(rows, taskClassBySession, T);
    expect(c!.verdict).toBe("insufficient-data");
    expect(c!.nTop).toBe(T.minSessionsPerTier - 1);
  });

  it("verdicts INSUFFICIENT-DATA when one tier clears the floor but the other doesn't", () => {
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      rows.push(...session(topId, "claude-opus-5", 5));
      taskClassBySession.set(topId, cls("debug", "diagnose", "high"));
    }
    // Only 2 mid-tier sessions — nTop clears the floor, nMid does not.
    for (let i = 0; i < 2; i++) {
      const midId = `mid-${i}`;
      rows.push(...session(midId, "claude-sonnet-5", 5));
      taskClassBySession.set(midId, cls("debug", "diagnose", "high"));
    }
    const [c] = computeTierParity(rows, taskClassBySession, T);
    expect(c!.verdict).toBe("insufficient-data");
  });

  it("excludes sessions the classifier never classified (session id absent from the map)", () => {
    const { rows, taskClassBySession } = buildParitySessions(T.minSessionsPerTier);
    const unclassified = session("unclassified-1", "claude-opus-5", 5);
    const comparisons = computeTierParity([...rows, ...unclassified], taskClassBySession, T);
    // Still exactly one class, and the unclassified session did not join it.
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]!.nTop).toBe(T.minSessionsPerTier);
    expect(comparisons[0]!.topSessionIds).not.toContain("unclassified-1");
  });

  it("excludes sessions where the classifier itself abstained (`fine === \"unknown\"`)", () => {
    const { rows, taskClassBySession } = buildParitySessions(T.minSessionsPerTier);
    const abstained = session("abstained-1", "claude-opus-5", 5);
    taskClassBySession.set("abstained-1", cls("unknown", "unknown", "low"));
    const comparisons = computeTierParity([...rows, ...abstained], taskClassBySession, T);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]!.topSessionIds).not.toContain("abstained-1");
  });

  it("excludes low-tier (haiku) and unknown-model sessions from a top-vs-mid comparison entirely", () => {
    const { rows, taskClassBySession } = buildParitySessions(T.minSessionsPerTier);
    const haikuId = "haiku-1";
    rows.push(...session(haikuId, "claude-haiku-4-5", 5));
    taskClassBySession.set(haikuId, cls("debug", "diagnose", "high"));
    const unknownId = "unknownmodel-1";
    rows.push(...session(unknownId, "some-other-vendor-model", 5));
    taskClassBySession.set(unknownId, cls("debug", "diagnose", "high"));

    const [c] = computeTierParity(rows, taskClassBySession, T);
    // Neither joined top or mid — counts are unchanged from the base fixture.
    expect(c!.nTop).toBe(T.minSessionsPerTier);
    expect(c!.nMid).toBe(T.minSessionsPerTier);
  });

  it("routes a LOW-confidence session to the COARSE class, not the fine one", () => {
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      const midId = `mid-${i}`;
      rows.push(...session(topId, "claude-opus-5", 5));
      rows.push(...session(midId, "claude-sonnet-5", 5));
      // LOW confidence: must NOT accumulate under the fine class "debug".
      taskClassBySession.set(topId, cls("debug", "diagnose", "low"));
      taskClassBySession.set(midId, cls("debug", "diagnose", "low"));
    }
    const comparisons = computeTierParity(rows, taskClassBySession, T);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]!.grain).toBe("coarse");
    expect(comparisons[0]!.classKey).toBe("coarse:diagnose");
  });

  it("keeps LOW-confidence and HIGH-confidence sessions of the same fine class in SEPARATE buckets (fine vs coarse), never merged", () => {
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topHi = `top-hi-${i}`;
      const midHi = `mid-hi-${i}`;
      rows.push(...session(topHi, "claude-opus-5", 5));
      rows.push(...session(midHi, "claude-sonnet-5", 5));
      taskClassBySession.set(topHi, cls("debug", "diagnose", "high"));
      taskClassBySession.set(midHi, cls("debug", "diagnose", "high"));

      const topLo = `top-lo-${i}`;
      const midLo = `mid-lo-${i}`;
      rows.push(...session(topLo, "claude-opus-5", 5));
      rows.push(...session(midLo, "claude-sonnet-5", 5));
      taskClassBySession.set(topLo, cls("debug", "diagnose", "low"));
      taskClassBySession.set(midLo, cls("debug", "diagnose", "low"));
    }
    const comparisons = computeTierParity(rows, taskClassBySession, T);
    const keys = comparisons.map((c) => c.classKey).sort();
    expect(keys).toEqual(["coarse:diagnose", "debug"]);
    for (const c of comparisons) {
      expect(c.nTop).toBe(T.minSessionsPerTier);
      expect(c.nMid).toBe(T.minSessionsPerTier);
    }
  });

  it("returns results in deterministic classKey order regardless of input order", () => {
    const a = buildParitySessions(T.minSessionsPerTier);
    const zRows: HygieneMessageRow[] = [];
    const zMap = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `ztop-${i}`;
      const midId = `zmid-${i}`;
      zRows.push(...session(topId, "claude-opus-5", 5));
      zRows.push(...session(midId, "claude-sonnet-5", 5));
      zMap.set(topId, cls("refactor-multi-file", "build", "high"));
      zMap.set(midId, cls("refactor-multi-file", "build", "high"));
    }
    const merged = [...zRows, ...a.rows];
    const mergedMap = new Map([...zMap, ...a.taskClassBySession]);
    const comparisons = computeTierParity(merged, mergedMap, T);
    expect(comparisons.map((c) => c.classKey)).toEqual(["debug", "refactor-multi-file"]);
  });
});

// ─── detectTierMismatch — the subset that becomes a card ────────────────────

describe("detectTierMismatch", () => {
  it("fires exactly one finding for a PARITY class, naming the top-tier sessions as downshift candidates", () => {
    const { rows, taskClassBySession } = buildParitySessions(T.minSessionsPerTier);
    const findings = detectTierMismatch(rows, taskClassBySession, T);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.detectorId).toBe("tier-mismatch");
    expect(f.sessionIds.sort()).toEqual(
      Array.from({ length: T.minSessionsPerTier }, (_, i) => `top-${i}`).sort(),
    );
    expect(f.rule).toMatch(/comparable/i);
    expect(f.remedy).toMatch(/mid tier/i);
    expect(f.detail).toContain(`n(top)=${T.minSessionsPerTier}`);
    expect(f.detail).toContain(`n(mid)=${T.minSessionsPerTier}`);
    // The classifier's own §5.10 caveat travels with every per-class figure.
    expect(f.detail).toMatch(/§5\.10|generated corpus/);
  });

  it("fires with a COARSE-grain label when confidence didn't support the fine class", () => {
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      const midId = `mid-${i}`;
      rows.push(...session(topId, "claude-opus-5", 5));
      rows.push(...session(midId, "claude-sonnet-5", 5));
      taskClassBySession.set(topId, cls("debug", "diagnose", "low"));
      taskClassBySession.set(midId, cls("debug", "diagnose", "low"));
    }
    const findings = detectTierMismatch(rows, taskClassBySession, T);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.rule).toContain("diagnose (coarse class)");
    expect(f.remedy).toContain("diagnose (coarse class)");
    expect(f.detail).not.toContain("coarse:"); // the raw classKey prefix must not leak into rendered text
  });

  it("computes estimatedWaste as n(top) × (avg top-tier cost − avg mid-tier cost), never negative", () => {
    const { rows, taskClassBySession } = buildParitySessions(T.minSessionsPerTier, 5);
    const findings = detectTierMismatch(rows, taskClassBySession, T);
    const waste = findings[0]!.estimatedWaste;

    const perTopCost = estimateCost("claude-opus-5", 1000, 200, 0, 0).cost * 5; // 5 turns/session
    const perMidCost = estimateCost("claude-sonnet-5", 1000, 200, 0, 0).cost * 5;
    const expected = T.minSessionsPerTier * (perTopCost - perMidCost);
    expect(waste).toBeCloseTo(expected, 8);
    expect(waste).toBeGreaterThan(0); // opus costs more per token than sonnet for identical usage
  });

  it("does NOT fire for a TOP-TIER-FAVORED class — the null result produces no card", () => {
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      const midId = `mid-${i}`;
      rows.push(...session(topId, "claude-opus-5", 5));
      rows.push(...session(midId, "claude-sonnet-5", 20)); // clearly worse
      taskClassBySession.set(topId, cls("debug", "diagnose", "high"));
      taskClassBySession.set(midId, cls("debug", "diagnose", "high"));
    }
    expect(detectTierMismatch(rows, taskClassBySession, T)).toEqual([]);
  });

  it("does NOT fire below the sample-size floor, even on an otherwise-parity shape — abstains rather than asserting on noise", () => {
    const { rows, taskClassBySession } = buildParitySessions(T.minSessionsPerTier - 1);
    expect(detectTierMismatch(rows, taskClassBySession, T)).toEqual([]);
  });

  it("does NOT fire for a class with zero top-tier sessions (nothing to name as downshift-eligible)", () => {
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    // Only mid-tier usage in this class — parity is moot with nothing to downshift.
    for (let i = 0; i < T.minSessionsPerTier * 2; i++) {
      const midId = `mid-${i}`;
      rows.push(...session(midId, "claude-sonnet-5", 5));
      taskClassBySession.set(midId, cls("debug", "diagnose", "high"));
    }
    // `computeTierParity` itself refuses to call nTop=0 "parity" (a
    // zero-vs-N comparison is not data), even with the floor relaxed to 0 —
    // so this is `insufficient-data`, not a false "parity" slipping through.
    // `detectTierMismatch`'s own `nTop === 0` guard is defense-in-depth on
    // top of that; both are asserted.
    const zeroFloor = { ...T, minSessionsPerTier: 0 };
    const [c] = computeTierParity(rows, taskClassBySession, zeroFloor);
    expect(c!.nTop).toBe(0);
    expect(c!.verdict).toBe("insufficient-data");
    expect(detectTierMismatch(rows, taskClassBySession, zeroFloor)).toEqual([]);
  });
});

// ─── runHygieneDetectors wiring ──────────────────────────────────────────────

describe("runHygieneDetectors — tier-mismatch wiring", () => {
  it("reports an honest empty result when taskClassBySession is omitted (classifier hasn't run / not wired) — never guesses", () => {
    const { rows } = buildParitySessions(T.minSessionsPerTier);
    const results = runHygieneDetectors(rows, {});
    const tierMismatch = results.find((r) => r.detectorId === "tier-mismatch");
    expect(tierMismatch).toBeDefined();
    expect(tierMismatch!.findings).toEqual([]);
  });

  it("surfaces a tier-mismatch finding once taskClassBySession is supplied, on the same parity fixture", () => {
    const { rows, taskClassBySession } = buildParitySessions(T.minSessionsPerTier);
    const results = runHygieneDetectors(rows, { taskClassBySession });
    const tierMismatch = results.find((r) => r.detectorId === "tier-mismatch");
    expect(tierMismatch).toBeDefined();
    expect(tierMismatch!.findings).toHaveLength(1);
    expect(tierMismatch!.title).toBe("Tier mismatch");
  });

  it("honors tierMismatch threshold overrides (a looser minSessionsPerTier fires below the default floor)", () => {
    const { rows, taskClassBySession } = buildParitySessions(2);
    const default_ = runHygieneDetectors(rows, { taskClassBySession });
    expect(default_.find((r) => r.detectorId === "tier-mismatch")!.findings).toEqual([]);

    const loosened = runHygieneDetectors(rows, {
      taskClassBySession,
      thresholds: { tierMismatch: { minSessionsPerTier: 2 } },
    });
    expect(loosened.find((r) => r.detectorId === "tier-mismatch")!.findings).toHaveLength(1);
  });

  it("is suppressible via config.hygiene.suppressions like every other detector", () => {
    const { rows, taskClassBySession } = buildParitySessions(T.minSessionsPerTier);
    const results = runHygieneDetectors(rows, { taskClassBySession, suppressions: ["tier-mismatch"] });
    const tierMismatch = results.find((r) => r.detectorId === "tier-mismatch");
    expect(tierMismatch!.suppressed).toBe(true);
    // Still computed under the hood (so a digest can say "1 suppressed"), only withheld from `active`.
    expect(tierMismatch!.findings).toHaveLength(1);
  });
});
