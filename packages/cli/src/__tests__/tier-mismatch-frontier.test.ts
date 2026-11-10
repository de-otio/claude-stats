/**
 * Tier-mismatch detector after the `frontier` split (plan P1, section 3.4).
 *
 * Fable and Mythos are `frontier`, Opus is `top`, Sonnet is `mid`. Before the
 * split Opus and Fable were both `top`, so a history with 8 Opus sessions and 8
 * Fable sessions on one task class had no mid-tier sessions: the class was
 * `insufficient-data` and the detector said nothing about the most expensive
 * routing choice a developer makes. These tests pin that it now sees the
 * Opus/Fable boundary, and that it did not lose the boundaries it had.
 */
import { describe, it, expect } from "vitest";
import {
  computeTierParity,
  detectTierMismatch,
  DEFAULT_HYGIENE_THRESHOLDS,
  type HygieneMessageRow,
  type TierMismatchClassification,
} from "@claude-stats/core/hygiene";

const T0 = 1_767_571_200_000;
const T = DEFAULT_HYGIENE_THRESHOLDS.tierMismatch;
const N = T.minSessionsPerTier;

const OPUS = "claude-opus-5-5"; // $4 / $20
const FABLE = "claude-fable-5-2"; // $8 / $40
const SONNET = "claude-sonnet-5-5";

function session(sessionId: string, model: string, turns: number, errorsPerTurn: number[] = []): HygieneMessageRow[] {
  return Array.from({ length: turns }, (_, i) => ({
    sessionId,
    projectPath: "/w/alpha",
    uuid: `${sessionId}-m${i}`,
    timestamp: T0 + i * 1000,
    model,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    toolErrorCount: errorsPerTurn[i] ?? 0,
    tools: [],
    outputPlaceholder: false,
    effort: null,
    isSubagent: false,
    claudeVersion: null,
    speed: null,
    inferenceGeo: null,
  }));
}

const CLS: TierMismatchClassification = { fine: "debug", coarse: "diagnose", confidence: "high" };

/** `n` sessions per (model, turns) group, all classified the same. */
function history(groups: Array<{ prefix: string; model: string; turns: number; n?: number; errors?: number[] }>) {
  const rows: HygieneMessageRow[] = [];
  const map = new Map<string, TierMismatchClassification>();
  for (const g of groups) {
    for (let i = 0; i < (g.n ?? N); i++) {
      const id = `${g.prefix}-${i}`;
      rows.push(...session(id, g.model, g.turns, g.errors));
      map.set(id, CLS);
    }
  }
  return { rows, map };
}

describe("the Opus/Fable boundary (frontier-vs-top)", () => {
  it("fires when Opus sessions match Fable sessions on the same class (and said nothing before the split)", () => {
    const { rows, map } = history([
      { prefix: "fable", model: FABLE, turns: 5 },
      { prefix: "opus", model: OPUS, turns: 5 },
    ]);
    const findings = detectTierMismatch(rows, map, T);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.detectorId).toBe("tier-mismatch");
    // The sessions named as downshift-eligible are the Fable ones.
    expect(f.sessionIds.sort()).toEqual(Array.from({ length: N }, (_, i) => `fable-${i}`).sort());
    expect(f.rule).toContain("Top-tier sessions classified as \"debug\"");
    expect(f.rule).toContain("than frontier-tier sessions");
    expect(f.remedy).toContain("top tier");
    expect(f.detail).toContain(`n(frontier)=${N}, n(top)=${N}`);
    // Waste: per session 5 turns of 1000 in / 200 out. Fable 0.016/turn, Opus 0.008/turn.
    expect(f.estimatedWaste).toBeCloseTo(N * (5 * 0.016 - 5 * 0.008), 10);
  });

  it("the comparison row says which tiers it compares", () => {
    const { rows, map } = history([
      { prefix: "fable", model: FABLE, turns: 5 },
      { prefix: "opus", model: OPUS, turns: 5 },
    ]);
    const rowsOut = computeTierParity(rows, map, T);
    // The class also gets the insufficient-data rows the legacy rule gives a
    // one-sided class (top-vs-mid has no mid sessions; frontier-vs-mid likewise).
    expect(rowsOut.map((c) => [c.boundary, c.verdict])).toEqual([
      ["top-vs-mid", "insufficient-data"],
      ["frontier-vs-top", "parity"],
      ["frontier-vs-mid", "insufficient-data"],
    ]);
    expect(rowsOut.find((c) => c.boundary === "frontier-vs-top")).toMatchObject({
      boundary: "frontier-vs-top",
      higherTier: "frontier",
      lowerTier: "top",
      verdict: "parity",
      nTop: N,
      nMid: N,
    });
  });

  it("does NOT fire when Fable clearly beats Opus (the null result is reported)", () => {
    const { rows, map } = history([
      { prefix: "fable", model: FABLE, turns: 5 },
      { prefix: "opus", model: OPUS, turns: 20 }, // 4x the turns
    ]);
    expect(detectTierMismatch(rows, map, T)).toEqual([]);
    expect(computeTierParity(rows, map, T).find((c) => c.boundary === "frontier-vs-top")).toMatchObject({ verdict: "top-tier-favored" });
  });

  it("does NOT fire below the per-tier sample floor", () => {
    const { rows, map } = history([
      { prefix: "fable", model: FABLE, turns: 5, n: N },
      { prefix: "opus", model: OPUS, turns: 5, n: N - 1 },
    ]);
    expect(detectTierMismatch(rows, map, T)).toEqual([]);
    expect(computeTierParity(rows, map, T).find((c) => c.boundary === "frontier-vs-top")!.verdict).toBe("insufficient-data");
  });

  it("two Opus models are one tier: no frontier boundary, so no finding", () => {
    const { rows, map } = history([
      { prefix: "a", model: "claude-opus-5-5", turns: 5 },
      { prefix: "b", model: "claude-opus-5", turns: 5 },
    ]);
    expect(detectTierMismatch(rows, map, T)).toEqual([]);
    // Only a top-vs-mid row (insufficient: no mid sessions), no frontier row.
    expect(computeTierParity(rows, map, T).map((c) => c.boundary)).toEqual(["top-vs-mid"]);
  });
});

describe("the boundaries it had are kept", () => {
  it("Fable vs Sonnet still compares (frontier-vs-mid), as Fable did when it was 'top'", () => {
    const { rows, map } = history([
      { prefix: "fable", model: FABLE, turns: 5 },
      { prefix: "sonnet", model: SONNET, turns: 5 },
    ]);
    const c = computeTierParity(rows, map, T).find((x) => x.boundary === "frontier-vs-mid")!;
    expect(c).toMatchObject({ verdict: "parity", higherTier: "frontier", lowerTier: "mid", nTop: N, nMid: N });
    const f = detectTierMismatch(rows, map, T).find((x) => x.rule.startsWith("Mid-tier sessions"))!;
    expect(f.rule).toContain("than frontier-tier sessions");
    expect(f.remedy).toContain("mid tier");
  });

  it("Opus vs Sonnet is unchanged: one top-vs-mid row, the original wording", () => {
    const { rows, map } = history([
      { prefix: "opus", model: OPUS, turns: 5 },
      { prefix: "sonnet", model: SONNET, turns: 5 },
    ]);
    const out = computeTierParity(rows, map, T);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ boundary: "top-vs-mid", higherTier: "top", lowerTier: "mid", verdict: "parity" });
    const [f] = detectTierMismatch(rows, map, T);
    expect(f!.rule).toContain("Mid-tier sessions classified as \"debug\" took no meaningfully more turns");
    expect(f!.rule).toContain("than top-tier sessions on the same class");
    expect(f!.detail).toContain(`n(top)=${N}, n(mid)=${N}`);
  });

  it("all three tiers on one class yield three rows, in boundary order", () => {
    const { rows, map } = history([
      { prefix: "fable", model: FABLE, turns: 5 },
      { prefix: "opus", model: OPUS, turns: 5 },
      { prefix: "sonnet", model: SONNET, turns: 5 },
    ]);
    expect(computeTierParity(rows, map, T).map((c) => c.boundary)).toEqual(["top-vs-mid", "frontier-vs-top", "frontier-vs-mid"]);
    expect(detectTierMismatch(rows, map, T)).toHaveLength(3);
  });

  it("a class that only ever used Haiku still opens no row", () => {
    const { rows, map } = history([{ prefix: "haiku", model: "claude-haiku-5-5", turns: 5 }]);
    expect(computeTierParity(rows, map, T)).toEqual([]);
  });

  it("a session is assigned the tier that carries most of its cost", () => {
    // 1 Fable turn costs as much as 2 Opus turns: 3 Opus + 1 Fable turn is Opus-dominant (0.024 vs 0.016).
    const rows: HygieneMessageRow[] = [];
    const map = new Map<string, TierMismatchClassification>();
    for (let i = 0; i < N; i++) {
      const id = `mixed-${i}`;
      rows.push(...session(id, OPUS, 3), ...session(id, FABLE, 1).map((r) => ({ ...r, uuid: `${r.uuid}-f`, timestamp: T0 + 9_000 })));
      map.set(id, CLS);
    }
    const out = computeTierParity(rows, map, T);
    // Opus-dominant sessions and nothing else: a top-vs-mid row with no mid sessions, no frontier row.
    expect(out.map((c) => [c.boundary, c.nTop, c.nMid])).toEqual([["top-vs-mid", N, 0]]);
  });
});
