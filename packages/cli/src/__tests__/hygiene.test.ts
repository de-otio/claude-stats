/**
 * Efficiency-hygiene detectors (Lane D1) — pure module tests.
 *
 * Every detector below has a matching "does NOT fire" case proving the
 * precision guard actually holds — not just that the happy path fires.
 *
 * Design: doc/analysis/efficiency-hygiene/README.md.
 */
import { describe, it, expect } from "vitest";
import {
  runHygieneDetectors,
  buildHygieneDigest,
  DEFAULT_HYGIENE_THRESHOLDS,
  type HygieneMessageRow,
} from "@claude-stats/core/hygiene";
import { estimateCost } from "@claude-stats/core/pricing";

const T0 = 1_767_571_200_000; // FIXED_NOW, matches fixtures/synthetic.ts

function row(overrides: Partial<HygieneMessageRow> & { sessionId: string; uuid: string }): HygieneMessageRow {
  return {
    projectPath: "/w/alpha",
    timestamp: T0,
    model: "claude-sonnet-5",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolErrorCount: 0,
    ...overrides,
  };
}

// ─── Cache churn ────────────────────────────────────────────────────────────

describe("detectCacheChurn", () => {
  it("fires on a multi-turn session that mostly re-writes cache instead of reading it back", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s1", uuid: "m0", timestamp: T0, cacheCreationTokens: 90_000, cacheReadTokens: 0 }),
      row({ sessionId: "s1", uuid: "m1", timestamp: T0 + 60_000, cacheCreationTokens: 90_000, cacheReadTokens: 5_000 }),
      row({ sessionId: "s1", uuid: "m2", timestamp: T0 + 120_000, cacheCreationTokens: 90_000, cacheReadTokens: 5_000 }),
    ];
    const [result] = runHygieneDetectors(rows, {});
    expect(result!.detectorId).toBe("cache-churn");
    expect(result!.findings).toHaveLength(1);
    expect(result!.findings[0]!.sessionIds).toEqual(["s1"]);
    expect(result!.findings[0]!.estimatedWaste).toBeGreaterThan(0);
    // The card must carry a checkable rule/threshold, not just an accusation.
    expect(result!.findings[0]!.rule).toMatch(/ratio/i);
    expect(result!.findings[0]!.threshold).toMatch(/cache-creation tokens/);
  });

  it("estimates only the EXCESS over the threshold ratio, never the whole cache-write bill", () => {
    // Pins the "conservative by construction" promise on HygieneFinding —
    // `estimatedWaste > 0` alone would let the figure silently inflate to the
    // full cache-creation cost, which is exactly the over-claim I1 forbids.
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s1", uuid: "m0", timestamp: T0, cacheCreationTokens: 90_000, cacheReadTokens: 0 }),
      row({ sessionId: "s1", uuid: "m1", timestamp: T0 + 60_000, cacheCreationTokens: 90_000, cacheReadTokens: 5_000 }),
      row({ sessionId: "s1", uuid: "m2", timestamp: T0 + 120_000, cacheCreationTokens: 90_000, cacheReadTokens: 5_000 }),
    ];
    const [result] = runHygieneDetectors(rows, {});
    const waste = result!.findings[0]!.estimatedWaste;

    const creation = 270_000;
    const read = 10_000;
    const creationCost = estimateCost("claude-sonnet-5", 0, 0, 0, creation).cost;
    const ratio = creation / (creation + read);
    const { ratio: threshold } = DEFAULT_HYGIENE_THRESHOLDS.cacheChurn;
    const expected = creationCost * ((ratio - threshold) / (1 - threshold));

    expect(waste).toBeLessThan(creationCost);
    expect(waste).toBeCloseTo(expected, 8);
  });

  it("does NOT fire on a single-turn session with a big first-write cache (nothing to read back yet)", () => {
    // False-positive guard: high absolute cache-creation, ratio=100% creation,
    // but it's the session's ONLY turn — there was no opportunity to read the
    // context back, so this is not churn, just a normal first write.
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s2", uuid: "m0", cacheCreationTokens: 500_000, cacheReadTokens: 0 }),
    ];
    const [result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });

  it("does NOT fire below the minimum token floor even at a bad ratio", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s3", uuid: "m0", timestamp: T0, cacheCreationTokens: 500, cacheReadTokens: 10 }),
      row({ sessionId: "s3", uuid: "m1", timestamp: T0 + 60_000, cacheCreationTokens: 500, cacheReadTokens: 10 }),
      row({ sessionId: "s3", uuid: "m2", timestamp: T0 + 120_000, cacheCreationTokens: 500, cacheReadTokens: 10 }),
    ];
    const [result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });

  it("does NOT fire when the session reads back healthily (creation meets the floor but the ratio is below threshold)", () => {
    // Same token scale as the firing case, but reads dominate — a healthy
    // session that keeps its cache warm, not churn.
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s4", uuid: "m0", timestamp: T0, cacheCreationTokens: 90_000, cacheReadTokens: 400_000 }),
      row({ sessionId: "s4", uuid: "m1", timestamp: T0 + 60_000, cacheCreationTokens: 90_000, cacheReadTokens: 400_000 }),
      row({ sessionId: "s4", uuid: "m2", timestamp: T0 + 120_000, cacheCreationTokens: 90_000, cacheReadTokens: 400_000 }),
    ];
    const [result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });
});

// ─── Retry loop ─────────────────────────────────────────────────────────────

describe("detectRetryLoop", () => {
  it("fires on 3+ CONSECUTIVE messages with tool errors", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s1", uuid: "m0", timestamp: T0, toolErrorCount: 1 }),
      row({ sessionId: "s1", uuid: "m1", timestamp: T0 + 1000, toolErrorCount: 1 }),
      row({ sessionId: "s1", uuid: "m2", timestamp: T0 + 2000, toolErrorCount: 2 }),
    ];
    const [, result] = runHygieneDetectors(rows, {});
    expect(result!.detectorId).toBe("retry-loop");
    expect(result!.findings).toHaveLength(1);
    expect(result!.findings[0]!.sessionIds).toEqual(["s1"]);
  });

  it("picks the longer of two separate qualifying runs and pluralizes the detail correctly", () => {
    // Two runs so the `qualifying.reduce` comparator actually executes (a
    // single-element array never calls its reduce callback) and the "runs"
    // plural branch fires. A `model: null` message is folded into the cost
    // sum here too, exercising `messageCost`'s unpriced-model branch.
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s1", uuid: "a0", timestamp: T0, toolErrorCount: 1, model: null }),
      row({ sessionId: "s1", uuid: "a1", timestamp: T0 + 1000, toolErrorCount: 1 }),
      row({ sessionId: "s1", uuid: "a2", timestamp: T0 + 2000, toolErrorCount: 1 }),
      row({ sessionId: "s1", uuid: "clean", timestamp: T0 + 3000, toolErrorCount: 0 }),
      row({ sessionId: "s1", uuid: "b0", timestamp: T0 + 4000, toolErrorCount: 1 }),
      row({ sessionId: "s1", uuid: "b1", timestamp: T0 + 5000, toolErrorCount: 1 }),
      row({ sessionId: "s1", uuid: "b2", timestamp: T0 + 6000, toolErrorCount: 1 }),
      row({ sessionId: "s1", uuid: "b3", timestamp: T0 + 7000, toolErrorCount: 1 }), // makes run B the longer one
    ];
    const [, result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(1);
    expect(result!.findings[0]!.detail).toContain("Longest run: 4");
    expect(result!.findings[0]!.detail).toContain("2 runs");
    // model:null on a0 must not throw and must not silently inflate the sum —
    // its cost contributes 0, same convention `estimateCost` uses everywhere.
    expect(result!.findings[0]!.estimatedWaste).toBeGreaterThan(0);
  });

  it("keeps the earlier run when a later one is not strictly longer (reduce's false branch)", () => {
    // Three runs so the `reduce` comparator fires twice: run A (len 4) vs run
    // B (len 3, NOT longer — exercises the ternary's false/"keep a" branch)
    // vs run C (len 5, longer — exercises the true branch in the same pass).
    const run = (label: string, start: number, len: number): HygieneMessageRow[] =>
      Array.from({ length: len }, (_, i) => row({ sessionId: "s1", uuid: `${label}${i}`, timestamp: T0 + start + i * 1000, toolErrorCount: 1 }));
    const clean = (uuid: string, ts: number): HygieneMessageRow => row({ sessionId: "s1", uuid, timestamp: ts, toolErrorCount: 0 });
    const rows: HygieneMessageRow[] = [
      ...run("a", 0, 4),
      clean("gap1", T0 + 10_000),
      ...run("b", 11_000, 3),
      clean("gap2", T0 + 20_000),
      ...run("c", 21_000, 5),
    ];
    const [, result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(1);
    expect(result!.findings[0]!.detail).toContain("Longest run: 5");
    expect(result!.findings[0]!.detail).toContain("3 runs");
  });

  it("respects a custom threshold override (mergeThresholds's truthy path)", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s1", uuid: "m0", timestamp: T0, toolErrorCount: 1 }),
      row({ sessionId: "s1", uuid: "m1", timestamp: T0 + 1000, toolErrorCount: 1 }),
    ];
    // Default threshold (3) would not fire on a run of 2; override it to 2.
    const [, result] = runHygieneDetectors(rows, { thresholds: { retryLoop: { minRunLength: 2 } } });
    expect(result!.findings).toHaveLength(1);
  });

  it("does NOT fire on isolated, non-consecutive errors even if the session has many", () => {
    // False-positive guard: 3 total errors, same as the firing case above, but
    // each is separated by a clean turn — never a dense run.
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s2", uuid: "m0", timestamp: T0, toolErrorCount: 1 }),
      row({ sessionId: "s2", uuid: "m1", timestamp: T0 + 1000, toolErrorCount: 0 }),
      row({ sessionId: "s2", uuid: "m2", timestamp: T0 + 2000, toolErrorCount: 1 }),
      row({ sessionId: "s2", uuid: "m3", timestamp: T0 + 3000, toolErrorCount: 0 }),
      row({ sessionId: "s2", uuid: "m4", timestamp: T0 + 4000, toolErrorCount: 1 }),
    ];
    const [, result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });

  it("does NOT fire on a run of only 2 (below the default threshold of 3)", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s3", uuid: "m0", timestamp: T0, toolErrorCount: 1 }),
      row({ sessionId: "s3", uuid: "m1", timestamp: T0 + 1000, toolErrorCount: 1 }),
    ];
    const [, result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });
});

// ─── Context bloat ──────────────────────────────────────────────────────────

describe("detectContextBloat", () => {
  it("fires on 3+ oversized, low-yield turns", () => {
    const bloated = (uuid: string, ts: number): HygieneMessageRow =>
      row({ sessionId: "s1", uuid, timestamp: ts, inputTokens: 200_000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const rows = [bloated("m0", T0), bloated("m1", T0 + 60_000), bloated("m2", T0 + 120_000)];
    const [, , , result] = runHygieneDetectors(rows, {});
    expect(result!.detectorId).toBe("context-bloat");
    expect(result!.findings).toHaveLength(1);
  });

  it("does NOT fire on a single oversized turn (one big legitimate load)", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s2", uuid: "m0", inputTokens: 200_000, outputTokens: 200 }),
      row({ sessionId: "s2", uuid: "m1", timestamp: T0 + 60_000, inputTokens: 400, outputTokens: 300 }),
      row({ sessionId: "s2", uuid: "m2", timestamp: T0 + 120_000, inputTokens: 400, outputTokens: 300 }),
    ];
    const [, , , result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });

  it("does NOT fire when output keeps pace with input (a legitimately large, productive turn)", () => {
    const productive = (uuid: string, ts: number): HygieneMessageRow =>
      row({ sessionId: "s3", uuid, timestamp: ts, inputTokens: 200_000, outputTokens: 100_000 });
    const rows = [productive("m0", T0), productive("m1", T0 + 60_000), productive("m2", T0 + 120_000)];
    const [, , , result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });

  it("does not divide by zero when a threshold override sets minTurnInputTokens to 0", () => {
    // Defensive-guard test: with the floor at 0, an all-zero-token turn
    // reaches the division; the explicit `totalInput <= 0` guard must skip it
    // rather than computing 0/0 = NaN and comparing NaN against maxOutputRatio.
    const empty = (uuid: string, ts: number): HygieneMessageRow =>
      row({ sessionId: "s4", uuid, timestamp: ts, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
    const rows = [empty("m0", T0), empty("m1", T0 + 60_000), empty("m2", T0 + 120_000)];
    const [, , , result] = runHygieneDetectors(rows, { thresholds: { contextBloat: { minTurnInputTokens: 0 } } });
    expect(result!.findings).toHaveLength(0);
  });
});

// ─── Re-entry burn ──────────────────────────────────────────────────────────

describe("detectReEntryBurn", () => {
  it("fires when a message after a long idle gap rebuilds a large cache", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s1", uuid: "m0", timestamp: T0, cacheCreationTokens: 0 }),
      row({ sessionId: "s1", uuid: "m1", timestamp: T0 + 40 * 60_000, cacheCreationTokens: 100_000 }),
    ];
    const [, , , , result] = runHygieneDetectors(rows, {});
    expect(result!.detectorId).toBe("re-entry-burn");
    expect(result!.findings).toHaveLength(1);
  });

  it("does NOT fire when the gap is long but the cache stayed warm (no rebuild)", () => {
    // False-positive guard: same 40-minute gap as the firing case, but the
    // resuming message needed almost no cache-creation — the prefix was
    // still valid, so nothing was actually rebuilt/wasted.
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s2", uuid: "m0", timestamp: T0, cacheCreationTokens: 0 }),
      row({ sessionId: "s2", uuid: "m1", timestamp: T0 + 40 * 60_000, cacheCreationTokens: 100 }),
    ];
    const [, , , , result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });

  it("does NOT fire on a short gap even with a big cache-creation spike (that's cache-churn's territory, not this one)", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s3", uuid: "m0", timestamp: T0, cacheCreationTokens: 0 }),
      row({ sessionId: "s3", uuid: "m1", timestamp: T0 + 60_000, cacheCreationTokens: 100_000 }),
    ];
    const [, , , , result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });

  it("skips pairs with a null timestamp on either side, and pluralizes correctly across two real spikes", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s4", uuid: "m0", timestamp: T0, cacheCreationTokens: 0 }),
      row({ sessionId: "s4", uuid: "m1", timestamp: T0 + 40 * 60_000, cacheCreationTokens: 100_000 }), // spike A (m0→m1)
      // A null-timestamp message poisons BOTH the pair before it (cur null)
      // and the pair after it (prev null) — neither may count as a re-entry.
      row({ sessionId: "s4", uuid: "m2", timestamp: null, cacheCreationTokens: 100_000 }),
      row({ sessionId: "s4", uuid: "m3", timestamp: T0 + 40 * 60_000 + 1_000, cacheCreationTokens: 100_000 }),
      row({ sessionId: "s4", uuid: "m4", timestamp: T0 + 40 * 60_000 + 1_000 + 40 * 60_000, cacheCreationTokens: 100_000 }), // spike B (m3→m4)
    ];
    const [, , , , result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(1);
    expect(result!.findings[0]!.detail).toContain("2 re-entry spikes");
  });
});

// ─── Abandoned spend ────────────────────────────────────────────────────────

describe("detectAbandonedSpend", () => {
  it("fires on a costly session ending in a tool error with no same-project follow-up", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s1", uuid: "m0", timestamp: T0, inputTokens: 500_000, outputTokens: 50_000 }),
      row({ sessionId: "s1", uuid: "m1", timestamp: T0 + 60_000, toolErrorCount: 1, inputTokens: 1_000, outputTokens: 100 }),
    ];
    const [, , result] = runHygieneDetectors(rows, {});
    expect(result!.detectorId).toBe("abandoned-spend");
    expect(result!.findings).toHaveLength(1);
    expect(result!.findings[0]!.sessionIds).toEqual(["s1"]);
  });

  it("does NOT fire when a same-project session starts again within the grace window (continuation, not abandonment)", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s2", uuid: "m0", timestamp: T0, inputTokens: 500_000, outputTokens: 50_000 }),
      row({ sessionId: "s2", uuid: "m1", timestamp: T0 + 60_000, toolErrorCount: 1, inputTokens: 1_000, outputTokens: 100 }),
      // A fresh session in the SAME project starting 10 minutes later.
      row({ sessionId: "s2-followup", uuid: "f0", timestamp: T0 + 60_000 + 10 * 60_000, inputTokens: 100, outputTokens: 50 }),
    ];
    const [, , result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });

  it("STILL fires when the only follow-up in the grace window is in a DIFFERENT project", () => {
    // The rule text promises a "same-project" successor check. Without this
    // case, a successor scan that ignores `projectPath` passes every other
    // test — and would silently swallow real abandoned spend whenever the
    // developer happened to open any other project within the grace window.
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s6", uuid: "m0", timestamp: T0, inputTokens: 500_000, outputTokens: 50_000 }),
      row({ sessionId: "s6", uuid: "m1", timestamp: T0 + 60_000, toolErrorCount: 1, inputTokens: 1_000, outputTokens: 100 }),
      row({ sessionId: "other-project", uuid: "o0", projectPath: "/w/beta", timestamp: T0 + 60_000 + 10 * 60_000, inputTokens: 100, outputTokens: 50 }),
    ];
    const [, , result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(1);
    expect(result!.findings[0]!.sessionIds).toEqual(["s6"]);
  });

  it("does NOT fire on a session that ends cleanly, however costly and however isolated", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s3", uuid: "m0", timestamp: T0, inputTokens: 500_000, outputTokens: 50_000 }),
      row({ sessionId: "s3", uuid: "m1", timestamp: T0 + 60_000, toolErrorCount: 0, inputTokens: 1_000, outputTokens: 500 }),
    ];
    const [, , result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });

  it("does NOT fire below the minimum cost threshold", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s4", uuid: "m0", timestamp: T0, toolErrorCount: 1, inputTokens: 10, outputTokens: 5 }),
    ];
    const [, , result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });

  it("does NOT fire when the session's last message has no timestamp (nothing to gap-check a successor against)", () => {
    const rows: HygieneMessageRow[] = [
      row({ sessionId: "s5", uuid: "m0", timestamp: null, toolErrorCount: 1, inputTokens: 500_000, outputTokens: 50_000 }),
    ];
    const [, , result] = runHygieneDetectors(rows, {});
    expect(result!.findings).toHaveLength(0);
  });
});

// ─── Suppression + digest ───────────────────────────────────────────────────

describe("suppression and digest", () => {
  const errorRun: HygieneMessageRow[] = [
    row({ sessionId: "s1", uuid: "m0", timestamp: T0, toolErrorCount: 1 }),
    row({ sessionId: "s1", uuid: "m1", timestamp: T0 + 1000, toolErrorCount: 1 }),
    row({ sessionId: "s1", uuid: "m2", timestamp: T0 + 2000, toolErrorCount: 1 }),
  ];

  it("suppresses one detector's active output but still reports it in suppressedIds", () => {
    const results = runHygieneDetectors(errorRun, { suppressions: ["retry-loop"] });
    const digest = buildHygieneDigest(results);
    expect(digest.active.find((r) => r.detectorId === "retry-loop")).toBeUndefined();
    expect(digest.suppressedIds).toEqual(["retry-loop"]);
    // Suppressed still means COMPUTED (never skipped), just withheld —
    // otherwise a suppression list is unauditable.
    const raw = results.find((r) => r.detectorId === "retry-loop")!;
    expect(raw.suppressed).toBe(true);
    expect(raw.findings).toHaveLength(1);
  });

  it("an unsuppressed detector still shows up in the digest", () => {
    const results = runHygieneDetectors(errorRun, { suppressions: ["cache-churn"] });
    const digest = buildHygieneDigest(results);
    expect(digest.active.find((r) => r.detectorId === "retry-loop")).toBeDefined();
    expect(digest.totalFindings).toBe(1);
  });

  it("sorts active detectors by total estimated waste, descending", () => {
    const rows: HygieneMessageRow[] = [
      ...errorRun, // retry-loop, small waste (few tokens)
      row({ sessionId: "s2", uuid: "big0", timestamp: T0, inputTokens: 600_000, outputTokens: 60_000, toolErrorCount: 1 }),
      row({ sessionId: "s2", uuid: "big1", timestamp: T0 + 1000, toolErrorCount: 1, inputTokens: 10, outputTokens: 5 }),
    ];
    const results = runHygieneDetectors(rows, {});
    const digest = buildHygieneDigest(results);
    // abandoned-spend's finding (large session cost) should outrank
    // retry-loop's (a few hundred cheap tokens) once both are present.
    const wasteFor = (id: string) =>
      digest.active.find((r) => r.detectorId === id)!.findings.reduce((n, f) => n + f.estimatedWaste, 0);
    // Assert the precondition rather than guarding on it: wrapped in an `if`,
    // this whole test goes silently vacuous the moment the fixture stops
    // firing both detectors.
    expect(digest.active.map((r) => r.detectorId)).toEqual(
      expect.arrayContaining(["abandoned-spend", "retry-loop"]),
    );
    expect(wasteFor("abandoned-spend")).toBeGreaterThan(wasteFor("retry-loop"));
    const abandonedIdx = digest.active.findIndex((r) => r.detectorId === "abandoned-spend");
    const retryIdx = digest.active.findIndex((r) => r.detectorId === "retry-loop");
    expect(abandonedIdx).toBeLessThan(retryIdx);
  });

  it("excludes a suppressed detector's waste from totalEstimatedWaste, not just from `active`", () => {
    const results = runHygieneDetectors(errorRun, { suppressions: ["retry-loop"] });
    const digest = buildHygieneDigest(results);
    // retry-loop is the only detector that fires on this fixture, so once it
    // is suppressed the headline total must be exactly 0 — a total that still
    // counted withheld findings would quote a number the reader cannot see.
    expect(results.find((r) => r.detectorId === "retry-loop")!.findings[0]!.estimatedWaste).toBeGreaterThan(0);
    expect(digest.totalEstimatedWaste).toBe(0);
    expect(digest.totalFindings).toBe(0);
  });
});

// ─── Threshold sanity ───────────────────────────────────────────────────────

describe("DEFAULT_HYGIENE_THRESHOLDS", () => {
  it("are all positive, non-degenerate numbers", () => {
    expect(DEFAULT_HYGIENE_THRESHOLDS.cacheChurn.minCacheCreationTokens).toBeGreaterThan(0);
    expect(DEFAULT_HYGIENE_THRESHOLDS.cacheChurn.ratio).toBeGreaterThan(0);
    expect(DEFAULT_HYGIENE_THRESHOLDS.cacheChurn.ratio).toBeLessThan(1);
    expect(DEFAULT_HYGIENE_THRESHOLDS.retryLoop.minRunLength).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_HYGIENE_THRESHOLDS.contextBloat.minOccurrences).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_HYGIENE_THRESHOLDS.reEntryBurn.minGapMs).toBeGreaterThan(0);
    expect(DEFAULT_HYGIENE_THRESHOLDS.abandonedSpend.minCost).toBeGreaterThan(0);
  });
});
