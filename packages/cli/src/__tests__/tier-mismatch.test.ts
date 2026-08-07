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

  it("verdicts PARITY (one-sided, D2-1) when the mid tier is DRAMATICALLY BETTER than the top tier on both metrics", () => {
    // Adversarial review D2-1's exact repro: avgTurnsTop 25 vs avgTurnsMid 5
    // (mid takes a fifth of the turns), errorRateTop 20% vs errorRateMid 0%
    // (top errors, mid never does). The band only rejects the mid tier being
    // WORSE than the top tier by more than `maxRelativeGap` — it does not
    // require the two to be close, so this passes. That is intentional (see
    // the `parity` comment in tierMismatch.ts): the mid tier outperforming
    // answers "does the top tier's cost buy anything here" even more
    // strongly than an exact tie would. What must NOT happen is the finding
    // claiming the tiers were "comparable" — see the `rule`-text assertion
    // in `detectTierMismatch` below.
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      const midId = `mid-${i}`;
      // Top: 25 turns, 1 in 5 turns errors (20% error rate).
      rows.push(...session(topId, "claude-opus-5", 25, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0]));
      // Mid: 5 turns, never errors.
      rows.push(...session(midId, "claude-sonnet-5", 5));
      taskClassBySession.set(topId, cls("debug", "diagnose", "high"));
      taskClassBySession.set(midId, cls("debug", "diagnose", "high"));
    }
    const [c] = computeTierParity(rows, taskClassBySession, T);
    expect(c!.avgTurnsTop).toBe(25);
    expect(c!.avgTurnsMid).toBe(5);
    expect(c!.errorRateTop).toBeCloseTo(0.2, 8);
    expect(c!.errorRateMid).toBe(0);
    expect(c!.verdict).toBe("parity");

    // MUTATION CHECK (documented, not asserted here): flipping the band to
    // two-sided (`Math.abs(turnsRatio - 1) <= gap`) makes this assert
    // "top-tier-favored" instead — proving this test actually pins the
    // one-sided behavior rather than passing vacuously either way.
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

    const comparisons = computeTierParity(rows, taskClassBySession, T);
    // Neither joined top or mid — counts are unchanged from the base fixture.
    expect(comparisons[0]!.nTop).toBe(T.minSessionsPerTier);
    expect(comparisons[0]!.nMid).toBe(T.minSessionsPerTier);
    // ...and they produced no comparison ROW of their own either. Without this
    // length assertion the "entirely" in the test name was unverified: a class
    // made up only of haiku/unknown sessions would appear in the public table
    // as a phantom `insufficient-data` row and nothing would notice.
    expect(comparisons).toHaveLength(1);
  });

  it("produces NO comparison row at all for a class made up only of low-tier / unknown-model sessions", () => {
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const haikuId = `haiku-${i}`;
      rows.push(...session(haikuId, "claude-haiku-4-5", 5));
      taskClassBySession.set(haikuId, cls("config-chore", "build", "high"));
    }
    // "config-chore" has usage, but none of it is top- or mid-tier: the class is
    // outside this detector's question entirely, so it gets no row — not an
    // `insufficient-data` row implying the comparison was attempted.
    expect(computeTierParity(rows, taskClassBySession, T)).toEqual([]);
  });

  it("tiers a MIXED-model session by its dominant (cost-weighted) model, not by whichever model appears first", () => {
    // Adversarial review D2-R1: every fixture used single-model sessions, so
    // `dominantTier`'s cost-weighted argmax was never exercised — replacing it
    // with "first model seen" passed the whole suite. Real sessions switch
    // models mid-flight, and which tier a session is attributed to is the
    // single most load-bearing decision this detector makes (I1: no forced
    // attribution). Each top session OPENS with a cheap sonnet turn and then
    // spends the rest of its budget on opus.
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      rows.push(
        row({ sessionId: topId, uuid: `${topId}-m0`, timestamp: T0, model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1 }),
      );
      for (let j = 1; j < 5; j++) {
        rows.push(
          row({ sessionId: topId, uuid: `${topId}-m${j}`, timestamp: T0 + j * 1000, model: "claude-opus-5" }),
        );
      }
      taskClassBySession.set(topId, cls("debug", "diagnose", "high"));

      const midId = `mid-${i}`;
      rows.push(...session(midId, "claude-sonnet-5", 5));
      taskClassBySession.set(midId, cls("debug", "diagnose", "high"));
    }
    const [c] = computeTierParity(rows, taskClassBySession, T);
    expect(c!.nTop).toBe(T.minSessionsPerTier);
    expect(c!.nMid).toBe(T.minSessionsPerTier);
    expect(c!.topSessionIds.sort()).toEqual(
      Array.from({ length: T.minSessionsPerTier }, (_, i) => `top-${i}`).sort(),
    );
  });

  it("compares AVERAGE turns per session, not raw totals, when the two tiers have unequal session counts", () => {
    // Adversarial review D2-R1: every fixture had nTop === nMid, which makes
    // avg-based and total-based ratios numerically identical — so swapping
    // `avgTurnsMid/avgTurnsTop` for `turnsMid/turnsTop` survived the suite.
    // Unequal n is the normal case in real history, and under the totals form
    // this fixture (identical per-session shapes) would read as 2x worse on the
    // mid tier and wrongly verdict `top-tier-favored`.
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      rows.push(...session(topId, "claude-opus-5", 5));
      taskClassBySession.set(topId, cls("debug", "diagnose", "high"));
    }
    for (let i = 0; i < T.minSessionsPerTier * 2; i++) {
      const midId = `mid-${i}`;
      rows.push(...session(midId, "claude-sonnet-5", 5));
      taskClassBySession.set(midId, cls("debug", "diagnose", "high"));
    }
    const [c] = computeTierParity(rows, taskClassBySession, T);
    expect(c!.nTop).toBe(T.minSessionsPerTier);
    expect(c!.nMid).toBe(T.minSessionsPerTier * 2);
    expect(c!.avgTurnsTop).toBe(5);
    expect(c!.avgTurnsMid).toBe(5);
    expect(c!.verdict).toBe("parity");
  });

  it("routes a MEDIUM-confidence session to the FINE class (the grain boundary is low-vs-rest, not high-vs-rest)", () => {
    // Adversarial review D2-R1: the module doc's grain rule says fine when
    // confidence is medium OR high. Only `high` and `low` were exercised, so
    // narrowing `supportsFine` to `confidence === "high"` — which would push
    // every medium-confidence session into the coarse bucket and silently
    // re-key every comparison — passed the whole suite. This pins `medium`.
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      const midId = `mid-${i}`;
      rows.push(...session(topId, "claude-opus-5", 5));
      rows.push(...session(midId, "claude-sonnet-5", 5));
      taskClassBySession.set(topId, cls("debug", "diagnose", "medium"));
      taskClassBySession.set(midId, cls("debug", "diagnose", "medium"));
    }
    const comparisons = computeTierParity(rows, taskClassBySession, T);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]!.grain).toBe("fine");
    expect(comparisons[0]!.classKey).toBe("debug");
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

  it("counts EVERY stored message as a turn, including model-less (user) rows, on both sides of the comparison", () => {
    // Adversarial review D2-R1: `getMessagesForHygiene` returns user rows too
    // (`model` is NULL on them), so the turn proxy's denominator — and the
    // tool-error-rate denominator built from it — depends on a definition
    // nothing pinned: narrowing `turns` to model-bearing rows only passed the
    // whole suite because every fixture row carried a model. The definition is
    // "message count" (module doc, PROXY paragraph); this holds it there, and
    // holds the error rate to the same denominator.
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      for (const [id, model] of [[`top-${i}`, "claude-opus-5"], [`mid-${i}`, "claude-sonnet-5"]] as const) {
        // 1 model-less user row + 4 assistant rows = 5 turns, 1 tool error.
        rows.push(row({ sessionId: id, uuid: `${id}-u0`, timestamp: T0, model: null }));
        for (let j = 1; j < 5; j++) {
          rows.push(
            row({ sessionId: id, uuid: `${id}-m${j}`, timestamp: T0 + j * 1000, model, toolErrorCount: j === 1 ? 1 : 0 }),
          );
        }
        taskClassBySession.set(id, cls("debug", "diagnose", "high"));
      }
    }
    const [c] = computeTierParity(rows, taskClassBySession, T);
    expect(c!.avgTurnsTop).toBe(5);
    expect(c!.avgTurnsMid).toBe(5);
    expect(c!.errorRateTop).toBeCloseTo(0.2, 8); // 1 error / 5 turns, not 1/4
    expect(c!.errorRateMid).toBeCloseTo(0.2, 8);
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
    const [c0] = computeTierParity(rows, taskClassBySession, T);
    const findings = detectTierMismatch(rows, taskClassBySession, T);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.detectorId).toBe("tier-mismatch");
    expect(f.sessionIds.sort()).toEqual(
      Array.from({ length: T.minSessionsPerTier }, (_, i) => `top-${i}`).sort(),
    );
    // D2-1: the rule text must describe what the one-sided test actually
    // establishes (mid tier not measurably worse), not an unsupported
    // two-sided "comparable" claim.
    expect(f.rule).toMatch(/not measurably worse|no meaningfully more/i);
    expect(f.rule).not.toMatch(/\bcomparable\b/i);
    expect(f.remedy).toMatch(/mid tier/i);
    expect(f.detail).toContain(`n(top)=${T.minSessionsPerTier}`);
    expect(f.detail).toContain(`n(mid)=${T.minSessionsPerTier}`);
    // Rates render through the shared `insight.ts#formatPercent`, same as every
    // other percent in the product (adversarial review D2-R1 — the local
    // hand-rolled formatter this replaced rendered a null as "n/a" where the
    // rest of the product renders "—").
    expect(f.detail).toContain("tool-error rate top 0.0% vs mid 0.0%");
    // The sessionIds list and the n(top) figure are the same quantity rendered
    // twice — they must not be able to disagree.
    expect(f.sessionIds).toHaveLength(c0!.nTop);
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

  it("floors estimatedWaste at 0 when the mid tier actually costs MORE per session (no negative 'waste')", () => {
    // Adversarial review D2-R1: the sibling test's name claimed "never
    // negative" but only ever exercised a positive delta, so deleting the
    // `Math.max(0, …)` floor survived. This is a reachable shape: parity is a
    // constraint on TURNS and ERROR RATE, not on tokens, so a mid-tier session
    // with a heavy cache-creation profile can cost more than a lean top-tier
    // one at identical turn counts. A negative figure here would silently
    // subtract from `HygieneDigest.totalEstimatedWaste`.
    const rows: HygieneMessageRow[] = [];
    const taskClassBySession = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < T.minSessionsPerTier; i++) {
      const topId = `top-${i}`;
      rows.push(...session(topId, "claude-opus-5", 5));
      taskClassBySession.set(topId, cls("debug", "diagnose", "high"));

      const midId = `mid-${i}`;
      for (let j = 0; j < 5; j++) {
        rows.push(
          row({
            sessionId: midId,
            uuid: `${midId}-m${j}`,
            timestamp: T0 + j * 1000,
            model: "claude-sonnet-5",
            cacheCreationTokens: 2_000_000,
          }),
        );
      }
      taskClassBySession.set(midId, cls("debug", "diagnose", "high"));
    }

    // The fixture really is the negative-delta case (guard against the test
    // silently degenerating into the positive one if rates change).
    const perTopCost = estimateCost("claude-opus-5", 1000, 200, 0, 0).cost * 5;
    const perMidCost = estimateCost("claude-sonnet-5", 1000, 200, 0, 2_000_000).cost * 5;
    expect(perMidCost).toBeGreaterThan(perTopCost);

    const [c] = computeTierParity(rows, taskClassBySession, T);
    expect(c!.verdict).toBe("parity"); // turns and errors are identical
    const findings = detectTierMismatch(rows, taskClassBySession, T);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.estimatedWaste).toBe(0);
  });

  it("prints the thresholds it actually applied, so a reader can check the claim (I1)", () => {
    // Adversarial review D2-R1: `threshold` was only ever asserted to EXIST.
    // Multiplying the displayed gap by 200 instead of 100 — i.e. a card telling
    // the reader a 30% tolerance while a 15% one decided the verdict — survived
    // the whole suite. The displayed number and the applied number must agree.
    const { rows, taskClassBySession } = buildParitySessions(T.minSessionsPerTier);
    const def = detectTierMismatch(rows, taskClassBySession, T)[0]!;
    expect(def.threshold).toContain(`≥${T.minSessionsPerTier} sessions per tier`);
    expect(def.threshold).toContain(`${Math.round(T.maxRelativeGap * 100)}%`);

    // And it tracks a caller's override rather than echoing the defaults.
    const custom = { minSessionsPerTier: 2, maxRelativeGap: 0.4 };
    const { rows: r2, taskClassBySession: m2 } = buildParitySessions(2);
    const f2 = detectTierMismatch(r2, m2, custom)[0]!;
    expect(f2.threshold).toContain("≥2 sessions per tier");
    expect(f2.threshold).toContain("40%");
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
  it("reports NOT COMPUTED (not a zero-finding pass) when taskClassBySession is omitted (D2-2: the classifier has never run) — never a silent 'no mismatch'", () => {
    const { rows } = buildParitySessions(T.minSessionsPerTier);
    const results = runHygieneDetectors(rows, {});
    const tierMismatch = results.find((r) => r.detectorId === "tier-mismatch");
    expect(tierMismatch).toBeDefined();
    expect(tierMismatch!.findings).toEqual([]);
    // D2-2: `findings: []` alone is indistinguishable from "ran, found
    // nothing" — `computed` is the bit that must say "didn't run at all".
    expect(tierMismatch!.computed).toBe(false);
    expect(tierMismatch!.enablementPath).toMatch(/task-class/);

    // MUTATION CHECK: reverting `computed` to always-`true` (dropping the
    // `undefined`-map branch) makes this `expect(tierMismatch!.computed).toBe(false)`
    // fail — confirmed manually, then reverted; not left in the suite as a
    // no-op assertion.
  });

  it("reports COMPUTED with zero findings when taskClassBySession is an empty (but DEFINED) map — the classifier ran, this window just has no matches", () => {
    // The other half of D2-2's distinction: a defined-but-empty map means
    // the classifier DID run — this is a real "computed, found nothing"
    // result, not "never ran". Must not collapse into the same `computed:
    // false` as the omitted case above.
    const { rows } = buildParitySessions(T.minSessionsPerTier);
    const results = runHygieneDetectors(rows, { taskClassBySession: new Map() });
    const tierMismatch = results.find((r) => r.detectorId === "tier-mismatch");
    expect(tierMismatch!.findings).toEqual([]);
    expect(tierMismatch!.computed).toBe(true);
    expect(tierMismatch!.enablementPath).toBeUndefined();
  });

  it("surfaces a tier-mismatch finding once taskClassBySession is supplied, on the same parity fixture", () => {
    const { rows, taskClassBySession } = buildParitySessions(T.minSessionsPerTier);
    const results = runHygieneDetectors(rows, { taskClassBySession });
    const tierMismatch = results.find((r) => r.detectorId === "tier-mismatch");
    expect(tierMismatch).toBeDefined();
    expect(tierMismatch!.findings).toHaveLength(1);
    expect(tierMismatch!.title).toBe("Tier mismatch");
    expect(tierMismatch!.computed).toBe(true);
  });

  it("the other five detectors are always `computed: true` — they only need message rows, never the classifier map", () => {
    const { rows } = buildParitySessions(T.minSessionsPerTier);
    const results = runHygieneDetectors(rows, {}); // no taskClassBySession at all
    for (const r of results) {
      if (r.detectorId === "tier-mismatch") continue;
      expect(r.computed).toBe(true);
      expect(r.enablementPath).toBeUndefined();
    }
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
