/**
 * Agreement measurement for the task-class classifier (spec §5.8).
 *
 * This file is the classifier's falsification harness, not a unit test. It runs
 * the rules over the labelled corpus and asserts the RELEASE THRESHOLDS the
 * spec fixed BEFORE the rules existed:
 *
 *   fine    ≥ 0.80 overall on decidable recipes, no emitted class below 0.60 recall
 *   coarse  ≥ 0.90 overall on decidable recipes
 *   abstain ≥ 0.70 of ambiguous recipes returned as `unknown`
 *
 * If a future rule change drops below any of them, this fails — and the correct
 * response is to ship the coarse grain and say so, not to move the threshold.
 * The thresholds are duplicated here as literals on purpose: importing them
 * from the classifier would let one edit move both the bar and the thing being
 * measured.
 *
 * It also PRINTS the measured figures, because the number quoted in the spec
 * has to come from a run rather than from a recollection.
 */
import { describe, it, expect } from "vitest";
import { classifySession, COARSE_OF } from "@claude-stats/core/taskClass";
import type { TaskClass, CoarseTaskClass } from "@claude-stats/core/types/insight";
import { buildTaskClassCorpus, RECIPES, type RecipeLabel } from "./fixtures/task-class-corpus.js";

const FINE_FLOOR = 0.8;
const PER_CLASS_RECALL_FLOOR = 0.6;
const COARSE_FLOOR = 0.9;
const ABSTAIN_FLOOR = 0.7;

interface Measurement {
  fineAgreement: number;
  coarseAgreement: number;
  abstainRate: number;
  perClassRecall: Map<TaskClass, { hit: number; n: number }>;
  decidable: number;
  ambiguous: number;
  /** What ambiguous sessions were mislabelled as, when they were. */
  falseConfident: Map<TaskClass, number>;
  /**
   * Of the decidable sessions the fine grain did NOT recover: how many
   * abstained vs. how many were given a confidently wrong class. This is the
   * distinction the whole design turns on — an abstention costs coverage, a
   * wrong label costs credibility — so it is measured, not assumed.
   */
  missAbstained: number;
  missWrongClass: number;
}

function measure(perRecipe: number): Measurement {
  const corpus = buildTaskClassCorpus(perRecipe);
  const perClassRecall = new Map<TaskClass, { hit: number; n: number }>();
  const falseConfident = new Map<TaskClass, number>();
  let fineHit = 0;
  let coarseHit = 0;
  let decidable = 0;
  let ambiguous = 0;
  let abstained = 0;
  let missAbstained = 0;
  let missWrongClass = 0;

  for (const s of corpus) {
    const got = classifySession(s.messages);
    if (s.expect === "ambiguous") {
      ambiguous++;
      if (got.fine === "unknown") abstained++;
      else falseConfident.set(got.fine, (falseConfident.get(got.fine) ?? 0) + 1);
      continue;
    }
    decidable++;
    const want = s.expect as TaskClass;
    const wantCoarse: CoarseTaskClass = COARSE_OF[want];
    const slot = perClassRecall.get(want) ?? { hit: 0, n: 0 };
    slot.n++;
    if (got.fine === want) {
      fineHit++;
      slot.hit++;
    } else if (got.fine === "unknown") {
      missAbstained++;
    } else {
      missWrongClass++;
    }
    perClassRecall.set(want, slot);
    if (got.coarse === wantCoarse) coarseHit++;
  }

  return {
    fineAgreement: decidable > 0 ? fineHit / decidable : 0,
    coarseAgreement: decidable > 0 ? coarseHit / decidable : 0,
    abstainRate: ambiguous > 0 ? abstained / ambiguous : 0,
    perClassRecall,
    decidable,
    ambiguous,
    falseConfident,
    missAbstained,
    missWrongClass,
  };
}

describe("task-class classifier — agreement against the labelled corpus", () => {
  const m = measure(20);

  it("reports the measured figures", () => {
    const lines = [
      `corpus: ${RECIPES.length} recipes, ${m.decidable} decidable + ${m.ambiguous} ambiguous sessions`,
      `fine agreement:   ${m.fineAgreement.toFixed(3)} (floor ${FINE_FLOOR})`,
      `coarse agreement: ${m.coarseAgreement.toFixed(3)} (floor ${COARSE_FLOOR})`,
      `abstention rate:  ${m.abstainRate.toFixed(3)} (floor ${ABSTAIN_FLOOR})`,
      `fine misses:      ${m.missAbstained} abstained, ${m.missWrongClass} wrong class`,
    ];
    for (const [cls, r] of [...m.perClassRecall].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`  recall ${cls.padEnd(20)} ${(r.hit / r.n).toFixed(3)}  (${r.hit}/${r.n})`);
    }
    for (const [cls, n] of m.falseConfident) {
      lines.push(`  ambiguous mislabelled as ${cls}: ${n}`);
    }
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
    expect(m.decidable).toBeGreaterThan(0);
    expect(m.ambiguous).toBeGreaterThan(0);
  });

  it("meets the fine-grain agreement floor the spec fixed in advance", () => {
    expect(m.fineAgreement).toBeGreaterThanOrEqual(FINE_FLOOR);
  });

  it("meets the per-class recall floor for every emitted class", () => {
    for (const [cls, r] of m.perClassRecall) {
      expect(r.n, `class ${cls} has no corpus coverage`).toBeGreaterThan(0);
      expect(r.hit / r.n, `recall for ${cls}`).toBeGreaterThanOrEqual(PER_CLASS_RECALL_FLOOR);
    }
  });

  it("fails by abstaining far more often than by mislabelling", () => {
    // The design premise: a confidently-wrong class survives into a per-class
    // delta with no way for the reader to audit it, while an abstention only
    // costs coverage. If that ever inverts, the rules have started guessing and
    // the coarse-grain fallback is the correct response.
    expect(m.missWrongClass).toBeLessThanOrEqual(m.missAbstained);
  });

  it("meets the coarse-grain agreement floor", () => {
    expect(m.coarseAgreement).toBeGreaterThanOrEqual(COARSE_FLOOR);
  });

  it("abstains on the deliberately ambiguous recipes", () => {
    expect(m.abstainRate).toBeGreaterThanOrEqual(ABSTAIN_FLOOR);
  });

  it("covers every class the classifier can emit", () => {
    // A corpus that never exercises a class cannot falsify it, and a recall
    // table with a missing row reads as "perfect" to a skimming reader.
    const emitted = new Set<TaskClass>(["debug", "greenfield", "config-chore", "refactor-multi-file", "explore"]);
    for (const cls of emitted) {
      expect(m.perClassRecall.has(cls), `no corpus recipe labelled ${cls}`).toBe(true);
    }
  });

  it("is stable across corpus sizes — not tuned to one draw", () => {
    // A threshold set fitted to exactly 20 sessions per recipe would pass here
    // and mean nothing. Re-measuring at a different size uses different seeded
    // draws, so agreement holding is evidence the rules generalise past the
    // sample that was in front of the author.
    for (const size of [7, 35]) {
      const other = measure(size);
      expect(other.fineAgreement, `fine agreement at ${size}/recipe`).toBeGreaterThanOrEqual(FINE_FLOOR);
      expect(other.coarseAgreement, `coarse agreement at ${size}/recipe`).toBeGreaterThanOrEqual(COARSE_FLOOR);
      expect(other.abstainRate, `abstention at ${size}/recipe`).toBeGreaterThanOrEqual(ABSTAIN_FLOOR);
    }
  });
});
