/**
 * Lane F1 — the guard that stops the answer formatters drifting back to English.
 *
 * **The hole this closes.** `npm run locales:check` compares `en` against the
 * other nine locales. It is structurally incapable of seeing a user-facing
 * string that never became a key at all — which is exactly how every sentence,
 * caveat and enablement line in `insight.ts` shipped as a hardcoded English
 * literal onto the dashboard's DEFAULT tab, the justification pack and the CLI,
 * through three review rounds, with the parity check green the whole time.
 *
 * **The technique.** Drive every formatter through an IDENTITY translator — one
 * that returns its key unchanged. Whatever comes back is then either (a) a key,
 * (b) a number/symbol the formatters deliberately keep fixed-locale, or (c) a
 * caller-supplied string. Anything else is prose the formatter composed itself,
 * i.e. a string that will render in English no matter what locale the user
 * picked. `assertFullyKeyed` fails on exactly that residue.
 *
 * **Why it cannot go vacuous.** Three separate teeth:
 *
 *  1. `assertFullyKeyed` fails on English residue — proven by mutation below
 *     (replace one `t()` with its literal and the suite goes red).
 *  2. `EXERCISED` is checked against the module's actual exports, so a NEW
 *     `answerX` added without being driven through this file fails here rather
 *     than shipping in one language.
 *  3. Every key the identity run reveals is resolved against the real `en`
 *     bundle, so a typo'd key — which passes (1) and (2), because a typo is
 *     still shaped like a key — fails too. Without this a user would see the
 *     raw string `common:insight.cost.thisPreiod` on the card.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as insight from "@claude-stats/core/insight";
import {
  answerBought,
  answerChange,
  answerCost,
  answerEfficiency,
  answerSetup,
  calibrationCaveat,
  calibrationEnablement,
  confidenceCaveat,
  costCaveat,
  formatDevTime,
  type InsightT,
} from "@claude-stats/core/insight";
import { calibrate } from "@claude-stats/core/calibration";
import { buildPackHeadline } from "@claude-stats/core/pack";
import type { InsightAnswer, TicketCoverage } from "@claude-stats/core/types/insight";
import { t } from "../i18n.js";
import { initI18n } from "@claude-stats/core/i18n";

// A `de` instance of its own rather than re-initialising the CLI singleton:
// `initCliI18n` is process-wide, and flipping it mid-run leaks the locale into
// every other test file sharing this worker (i18n-core.test.ts documents the
// same hazard). `common` is loaded by initI18n itself, from THIS worktree's
// source tree — so this reads the locale files edited in this change, not a
// stale dist copy.
const de = await initI18n({ lng: "de", ns: ["common"] });
const deT: InsightT = (key, options) => de.t(key, options as never) as unknown as string;
const ja = await initI18n({ lng: "ja", ns: ["common"] });
const jaT: InsightT = (key, options) => ja.t(key, options as never) as unknown as string;

/**
 * Returns its key unchanged — AND the values it was handed, appended.
 *
 * The values matter as much as the key. A formatter that writes
 * `t("…caveat.x", { unit: "dev-hours" })` has delegated the SENTENCE and kept
 * the WORD, and the word renders in English in all ten locales. A translator
 * that returned only the key made that invisible: the residue check never saw
 * the interpolated text at all. (Proven by mutation — with `(key) => key`,
 * replacing `t("…efficiency.hygiene", { percent })` with
 * `{ percent: `${percent} of total spend` }` passed the entire 2,692-test
 * suite.)
 *
 * Only the values are appended, never the parameter NAMES: the names are
 * English words (`money`, `percent`, `previous`) and would themselves read as
 * residue.
 *
 * Every emission is wrapped in `|`. Formatters concatenate results with no
 * delimiter (`clauses.join(t("…clauseJoin"))`), and a key that runs straight
 * into the next one confuses `KEY_TOKEN`'s boundary — leaving half a key
 * behind as false residue. The bars cost nothing (`|` is not a letter, so it
 * never reads as prose) and make every token's edges explicit.
 */
const rawT: InsightT = (key, options) => {
  const values = options ? Object.values(options).map((v) => String(v)) : [];
  return `|${key}${values.map((v) => ` ${v}`).join("")}|`;
};

/**
 * Caller-supplied strings. Deliberately free of ASCII letters: the residue
 * check keys off letters, so a sentinel made of them would mask exactly the
 * defect this file exists to catch.
 */
const CALLER = {
  verdict: "«verdict»",
  plan: "«plan»",
  title: "«title»",
  impact: "«impact»",
  doingWell: "«doing-well»",
  ticketKey: "«ticket»",
  date: "2026-05-01",
} as const;

const coverage = (over: Partial<TicketCoverage> = {}): TicketCoverage => ({
  attributedCost: 80,
  totalCost: 100,
  ratio: 0.8,
  byConfidence: { high: 56, medium: 16, low: 8 },
  ambiguousSessions: 0,
  ...over,
});

/** `namespace:dotted.key.path`, as the identity translator emits it. */
const KEY_TOKEN = /[a-z][a-zA-Z0-9]*:[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g;

/**
 * Fail if `text` contains prose the formatter composed rather than delegated.
 *
 * Strips the i18n keys and the caller-supplied sentinels, then looks for any
 * remaining run of letters. Numbers, currency symbols, `%`, `—`, `·`, brackets
 * and the punctuation joiners survive stripping and are all fine — none of them
 * is a word. A run of three or more letters is a word, and a word that is not
 * inside a key is untranslatable text.
 */
function assertFullyKeyed(label: string, text: string | null | undefined): void {
  if (text == null) return;
  let residue = text.replace(KEY_TOKEN, "");
  for (const sentinel of Object.values(CALLER)) residue = residue.split(sentinel).join("");
  expect(residue, `${label} contains untranslated prose: ${JSON.stringify(text)}`).not.toMatch(
    /[A-Za-z]{3,}/,
  );
}

/** Every user-facing field of an answer. `question`, `trend`, `evidenceLink`
 *  and `unavailable.reason` are machine discriminants, never shown as prose. */
function assertAnswerFullyKeyed(label: string, a: InsightAnswer): void {
  assertFullyKeyed(`${label}.answer`, a.answer);
  assertFullyKeyed(`${label}.caveat`, a.caveat);
  assertFullyKeyed(`${label}.value`, a.value);
  assertFullyKeyed(`${label}.enablement`, a.unavailable?.enablement);
}

/** Collect the keys an identity run revealed, so they can be resolved for real. */
function keysIn(text: string | null | undefined): string[] {
  return text == null ? [] : (text.match(KEY_TOKEN) ?? []);
}

// ─── The corpus: every branch of every formatter ─────────────────────────────

/**
 * Named branches, driven with the identity translator. Each entry must reach a
 * DIFFERENT composition path — an entry that duplicates another's branch adds
 * a passing assertion and no protection.
 */
function allAnswers(tr: InsightT): Array<[string, InsightAnswer]> {
  return [
    ["cost/empty", answerCost(tr, { mode: "metered", cost: 0, previousCost: null })],
    ["cost/metered", answerCost(tr, { mode: "metered", cost: 312.4, previousCost: 280 })],
    ["cost/metered+rate", answerCost(tr, { mode: "metered", cost: 720, previousCost: null, hourlyRate: 90 })],
    ["cost/metered+minutes", answerCost(tr, { mode: "metered", cost: 30, previousCost: null, hourlyRate: 90 })],
    ["cost/metered+hours", answerCost(tr, { mode: "metered", cost: 360, previousCost: null, hourlyRate: 90 })],
    [
      "cost/reconciled",
      answerCost(tr, { mode: "metered", cost: 100, previousCost: null, reconciledRatio: 0.987, reconciledWithinTolerance: true }),
    ],
    ["cost/fallback", answerCost(tr, { mode: "metered", cost: 100, previousCost: null, anyFallbackRates: true })],
    [
      "cost/reconciled+fallback",
      answerCost(tr, {
        mode: "metered",
        cost: 100,
        previousCost: null,
        reconciledRatio: 0.9,
        reconciledWithinTolerance: true,
        anyFallbackRates: true,
      }),
    ],
    [
      "cost/notReconciled",
      answerCost(tr, { mode: "metered", cost: 100, previousCost: null, reconciledRatio: 0.5, reconciledWithinTolerance: false }),
    ],
    [
      "cost/notReconciled+fallback",
      answerCost(tr, {
        mode: "metered",
        cost: 100,
        previousCost: null,
        reconciledRatio: 0.5,
        reconciledWithinTolerance: false,
        anyFallbackRates: true,
      }),
    ],
    ["cost/plan", answerCost(tr, { mode: "plan", cost: 540, previousCost: 500, planFee: 100, planMultiplier: 5.4 })],
    ["cost/mixed", answerCost(tr, { mode: "mixed", cost: 540, previousCost: null })],

    ["bought/empty", answerBought(tr, { completedTasks: 3, coverage: null, topTicket: null })],
    [
      "bought/full",
      answerBought(tr, {
        completedTasks: 41,
        coverage: coverage(),
        topTicket: { key: CALLER.ticketKey, cost: 41.2 },
      }),
    ],
    ["bought/oneTask", answerBought(tr, { completedTasks: 1, coverage: coverage(), topTicket: null })],
    ["bought/noTaskCount", answerBought(tr, { completedTasks: null, coverage: coverage(), topTicket: null })],
    ["bought/ambiguous", answerBought(tr, { completedTasks: 2, coverage: coverage({ ambiguousSessions: 2 }), topTicket: null })],
    [
      "bought/oneAmbiguous",
      answerBought(tr, { completedTasks: 2, coverage: coverage({ ambiguousSessions: 1 }), topTicket: null }),
    ],
    [
      "bought/zeroCoverage",
      answerBought(tr, {
        completedTasks: 2,
        coverage: coverage({ attributedCost: 0, ratio: 0, byConfidence: { high: 0, medium: 0, low: 0 } }),
        topTicket: null,
      }),
    ],

    ["efficiency/empty", answerEfficiency(tr, { recoverableWaste: null, cost: 100 })],
    ["efficiency/plain", answerEfficiency(tr, { recoverableWaste: 40, cost: 400 })],
    ["efficiency/hygiene", answerEfficiency(tr, { recoverableWaste: 40, cost: 400, hygieneRatio: 0.12 })],
    [
      "efficiency/hygieneDown",
      answerEfficiency(tr, { recoverableWaste: 40, cost: 400, hygieneRatio: 0.1, previousHygieneRatio: 0.2 }),
    ],
    [
      "efficiency/hygieneUp",
      answerEfficiency(tr, { recoverableWaste: 40, cost: 400, hygieneRatio: 0.2, previousHygieneRatio: 0.1 }),
    ],

    ["setup/empty", answerSetup(tr, { planVerdict: null, recommendedPlan: null, projectedSaving: null })],
    ["setup/verdict", answerSetup(tr, { planVerdict: CALLER.verdict, recommendedPlan: null, projectedSaving: null })],
    [
      "setup/verdict+saving",
      answerSetup(tr, { planVerdict: CALLER.verdict, recommendedPlan: CALLER.plan, projectedSaving: 80 }),
    ],
    [
      "setup/policy",
      answerSetup(tr, {
        planVerdict: null,
        recommendedPlan: null,
        projectedSaving: null,
        policyImpact: { date: CALLER.date, classes: 3, costPerTaskDelta: 0.28 },
      }),
    ],
    [
      "setup/policyOneClass",
      answerSetup(tr, {
        planVerdict: null,
        recommendedPlan: null,
        projectedSaving: null,
        policyImpact: { date: CALLER.date, classes: 1, costPerTaskDelta: 0.28 },
      }),
    ],

    ["change/none", answerChange(tr, { recommendations: [] })],
    ["change/doingWell", answerChange(tr, { recommendations: [], doingWell: CALLER.doingWell })],
    ["change/one", answerChange(tr, { recommendations: [{ title: CALLER.title }] })],
    ["change/oneWithImpact", answerChange(tr, { recommendations: [{ title: CALLER.title, impact: CALLER.impact }] })],
    [
      "change/manyWithImpact",
      answerChange(tr, {
        recommendations: [
          { title: CALLER.title, impact: CALLER.impact },
          { title: CALLER.title },
          { title: CALLER.title },
        ],
      }),
    ],
  ];
}

/** The standalone formatters, same treatment. */
function allFragments(tr: InsightT): Array<[string, string | null]> {
  return [
    ["devTime/minutes", formatDevTime(tr, 30, 90)],
    ["devTime/hours", formatDevTime(tr, 360, 90)],
    ["devTime/days", formatDevTime(tr, 1440, 90)],
    // hourlyRate <= 0 renders an em dash, which is not prose — included so the
    // branch is covered rather than silently exempt.
    ["devTime/noRate", formatDevTime(tr, 100, 0)],
    ["costCaveat/plan", costCaveat(tr, "plan")],
    ["costCaveat/mixed", costCaveat(tr, "mixed")],
    ["costCaveat/metered", costCaveat(tr, "metered")],
    ["costCaveat/reconciled", costCaveat(tr, "metered", { reconciledRatio: 0.98, reconciledWithinTolerance: true })],
    ["costCaveat/fallback", costCaveat(tr, "metered", { anyFallbackRates: true })],
    [
      "costCaveat/both",
      costCaveat(tr, "metered", { reconciledRatio: 0.98, reconciledWithinTolerance: true, anyFallbackRates: true }),
    ],
    ["costCaveat/notReconciled", costCaveat(tr, "metered", { reconciledRatio: 0.5, reconciledWithinTolerance: false })],
    [
      "costCaveat/notReconciledAndFallback",
      costCaveat(tr, "metered", { reconciledRatio: 0.5, reconciledWithinTolerance: false, anyFallbackRates: true }),
    ],
    ["confidenceCaveat/mix", confidenceCaveat(tr, coverage())],
    ["confidenceCaveat/ambiguous", confidenceCaveat(tr, coverage({ ambiguousSessions: 3 }))],
    [
      "confidenceCaveat/none",
      confidenceCaveat(tr, coverage({ attributedCost: 0, ratio: 0, byConfidence: { high: 0, medium: 0, low: 0 } })),
    ],
    // Lane K. Both subjects × both states × both functions — eight results from
    // eight distinct keys, so a formatter that resolved the wrong one would
    // still be caught by `calibration.test.ts`'s key-identity assertions, and a
    // formatter that stated anything in English of its own is caught here.
    ["calibration/measuredAttribution", calibrationCaveat(tr, calibrate("attribution", { agreed: 27, disagreed: 3 }))],
    ["calibration/measuredOutcome", calibrationCaveat(tr, calibrate("outcome", { agreed: 27, disagreed: 3 }))],
    ["calibration/uncalAttribution", calibrationCaveat(tr, calibrate("attribution", { agreed: 2, disagreed: 1 }))],
    ["calibration/uncalOutcome", calibrationCaveat(tr, calibrate("outcome", { agreed: 2, disagreed: 1 }))],
    ["calibration/enableAttribution", calibrationEnablement(tr, calibrate("attribution", { agreed: 2, disagreed: 1 }))],
    ["calibration/enableOutcome", calibrationEnablement(tr, calibrate("outcome", { agreed: 2, disagreed: 1 }))],
    ["calibration/enableMeasured", calibrationEnablement(tr, calibrate("outcome", { agreed: 30, disagreed: 0 }))],
  ];
}

/** The pack headline's shared strings — the pack is the surface that most
 *  needs this, because it is the artefact that leaves the machine. */
function packStrings(tr: InsightT): Array<[string, string | null]> {
  const h = buildPackHeadline(tr, {
    mode: "metered",
    currency: "USD",
    coverage: coverage(),
    hourlyRate: 100,
    anyFallbackRates: true,
  });
  return [
    ["pack/devTimeLabel", h.devTimeLabel],
    ["pack/costCaveatText", h.costCaveatText],
    ["pack/coverageCaveat", h.coverageCaveat],
  ];
}

// ─── Tooth 1: no English residue ─────────────────────────────────────────────

describe("answer formatters state nothing in English of their own", () => {
  it("composes every answer sentence, caveat and enablement line from i18n keys", () => {
    for (const [label, answer] of allAnswers(rawT)) assertAnswerFullyKeyed(label, answer);
  });

  it("composes every caveat and unit label from i18n keys", () => {
    for (const [label, text] of allFragments(rawT)) assertFullyKeyed(label, text);
  });

  it("carries the same discipline into the justification pack's headline", () => {
    for (const [label, text] of packStrings(rawT)) assertFullyKeyed(label, text);
  });
});

// ─── Tooth 2: the corpus cannot fall behind the module ───────────────────────

describe("the guard covers every formatter the module exports", () => {
  it("drives every exported answerX through the identity translator", () => {
    const exported = Object.entries(insight)
      .filter(([name, v]) => name.startsWith("answer") && typeof v === "function")
      .map(([name]) => name)
      .sort();
    // A new `answerX` must be added to `allAnswers` above, or it ships in one
    // language with nothing failing. This assertion is that requirement.
    expect(exported).toEqual(["answerBought", "answerChange", "answerCost", "answerEfficiency", "answerSetup"]);

    // ...and each of them actually appears in the corpus, so listing a name
    // here is not enough on its own.
    const covered = new Set(allAnswers(rawT).map(([label]) => label.split("/")[0]));
    expect([...covered].sort()).toEqual(["bought", "change", "cost", "efficiency", "setup"]);
  });

  it("exercises the branch that produces each honest-unavailable state", () => {
    const unavailables = allAnswers(rawT).filter(([, a]) => a.unavailable);
    // cost, bought, efficiency and setup each have one; `change` has none by
    // design (it always has something to say). Four, not "some".
    expect(unavailables.map(([label]) => label).sort()).toEqual([
      "bought/empty",
      "cost/empty",
      "efficiency/empty",
      "setup/empty",
    ]);
    for (const [, a] of unavailables) expect(a.unavailable!.enablement.length).toBeGreaterThan(0);
  });
});

// ─── Tooth 4: no surface keeps a second copy of a keyed sentence ─────────────
//
// The identity translator can only see the formatters it drives. A SURFACE that
// re-states one of these sentences as its own English literal is invisible to
// it — and that is not hypothetical: `mcp/index.ts` held two identical copies
// of "No usage recorded for this period.", Lane F1 keyed one and left the
// other, and nothing in the suite noticed (proven by mutation: reverting the
// keyed one to its literal passed all 2,692 tests). Once a sentence is a key,
// a verbatim copy of it anywhere in the source is by definition a string that
// will render in English while its twin renders translated.

describe("no surface keeps a second, un-keyed copy of a sentence that is now a key", () => {
  const SRC_ROOTS = ["packages/core/src", "packages/cli/src"];
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

  /** Every `insight.*` value that is a whole sentence with no placeholders —
   *  those are the ones a surface can copy verbatim. */
  function keyedSentences(): Array<[string, string]> {
    const bundle = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "packages/core/src/locales/en/common.json"), "utf-8"),
    ) as Record<string, unknown>;
    const out: Array<[string, string]> = [];
    const walk = (node: unknown, prefix: string): void => {
      if (typeof node === "string") {
        if (!node.includes("{{") && node.length >= 15) out.push([prefix, node]);
        return;
      }
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walk(v, prefix ? `${prefix}.${k}` : k);
      }
    };
    walk((bundle as { insight: unknown }).insight, "insight");
    return out;
  }

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Tests quote these sentences on purpose (that is what the byte-identity
      // assertions above ARE), and `locales/` is where they are supposed to be.
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "locales" || entry.name === "node_modules") continue;
        sourceFiles(full, acc);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        acc.push(full);
      }
    }
    return acc;
  }

  it("finds no keyed sentence surviving as a literal in any non-test source file", () => {
    const sentences = keyedSentences();
    // Not vacuous: the corpus it scans for must be non-trivial, and so must the
    // haystack. Both are asserted rather than assumed.
    expect(sentences.length).toBeGreaterThan(10);
    const files = SRC_ROOTS.flatMap((r) => sourceFiles(path.join(REPO_ROOT, r)));
    expect(files.length).toBeGreaterThan(50);

    const offences: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf-8");
      for (const [key, sentence] of sentences) {
        if (text.includes(sentence)) {
          offences.push(`${path.relative(REPO_ROOT, file)} still spells out "${key}" verbatim`);
        }
      }
    }
    expect(offences).toEqual([]);
  });
});

// ─── Tooth 3: every key revealed must actually resolve ───────────────────────

describe("every key the formatters reach for exists in `en`", () => {
  it("resolves each one against the real bundle rather than rendering the raw key", () => {
    const keys = new Set<string>();
    for (const [, a] of allAnswers(rawT)) {
      for (const text of [a.answer, a.caveat, a.value, a.unavailable?.enablement]) {
        for (const k of keysIn(text)) keys.add(k);
      }
    }
    for (const [, text] of [...allFragments(rawT), ...packStrings(rawT)]) {
      for (const k of keysIn(text)) keys.add(k);
    }

    expect(keys.size).toBeGreaterThan(20);
    for (const key of keys) {
      // i18next echoes the key back when it cannot resolve one — but it echoes
      // it with the NAMESPACE STRIPPED ("insight.setup.foo", not
      // "common:insight.setup.foo"). Comparing against the full key alone made
      // this assertion pass for a deliberately typo'd key; both forms are
      // checked. `count` is passed so plural keys select the same way the
      // formatters select them.
      const bare = key.slice(key.indexOf(":") + 1);
      const resolved = t(key, { count: 2 });
      expect(resolved, `missing en translation for "${key}"`).not.toBe(key);
      expect(resolved, `missing en translation for "${key}"`).not.toBe(bare);
      expect(resolved.length, `empty en translation for "${key}"`).toBeGreaterThan(0);
    }
  });
});

// ─── The English output still reads correctly ────────────────────────────────

describe("the real `en` translator reproduces the sentences these formatters shipped with", () => {
  it("keeps the answer wording byte-identical to the pre-localization literals", () => {
    // Behaviour comparison, not a snapshot: these exact strings are what the
    // hardcoded literals produced, so an en-locale regression during the key
    // extraction shows up as a diff here rather than as silent copy drift.
    expect(answerCost(t, { mode: "metered", cost: 312.4, previousCost: 280, hourlyRate: 90 }).answer).toBe(
      "$312 this period — ≈ 3.5 dev-hours at your configured rate.",
    );
    expect(answerCost(t, { mode: "plan", cost: 540, previousCost: 500, planFee: 100, planMultiplier: 5.4 }).caveat).toBe(
      "Equivalent API cost — not what your plan charges.",
    );
    expect(costCaveat(t, "metered", { reconciledRatio: 0.987, reconciledWithinTolerance: true })).toBe(
      "Reconciles with the invoice at 99%.",
    );
    expect(costCaveat(t, "metered", { anyFallbackRates: true })).toBe(
      "Some usage priced at first-party rates — configure partner rates for exact figures.",
    );
    expect(
      costCaveat(t, "metered", { reconciledRatio: 0.987, reconciledWithinTolerance: true, anyFallbackRates: true }),
    ).toBe(
      "Reconciles with the invoice at 99%; some usage priced at first-party rates — configure partner rates for exact figures.",
    );
    expect(costCaveat(t, "metered", { reconciledRatio: 0.5, reconciledWithinTolerance: false })).toBe(
      "Does not reconcile with the invoice — bottom-up is 50% of the imported total.",
    );
    expect(
      costCaveat(t, "metered", { reconciledRatio: 0.5, reconciledWithinTolerance: false, anyFallbackRates: true }),
    ).toBe(
      "Does not reconcile with the invoice — bottom-up is 50% of the imported total; some usage also priced at " +
        "first-party rates — configure partner rates for exact figures.",
    );
    expect(confidenceCaveat(t, coverage({ ambiguousSessions: 1 }))).toBe(
      "70% high · 20% medium · 10% low confidence · 1 session ambiguous.",
    );
    expect(confidenceCaveat(t, coverage({ ambiguousSessions: 2 }))).toBe(
      "70% high · 20% medium · 10% low confidence · 2 sessions ambiguous.",
    );
    expect(
      answerBought(t, { completedTasks: 1, coverage: coverage(), topTicket: { key: "PROJ-123", cost: 41.2 } }).answer,
    ).toBe("1 task completed, 80% of spend attributed to work items, biggest: PROJ-123 ($41.20).");
    expect(
      answerSetup(t, { planVerdict: "Your plan fits", recommendedPlan: "Max 5x", projectedSaving: 80 }).answer,
    ).toBe("Your plan fits — switching to Max 5x would save about $80.00/mo.");
    expect(
      answerSetup(t, {
        planVerdict: null,
        recommendedPlan: null,
        projectedSaving: null,
        policyImpact: { date: "2026-05-01", classes: 1, costPerTaskDelta: 0.28 },
      }).answer,
    ).toBe("Since the policy change on 2026-05-01, cost per successful task is up 28% in 1 task class.");
  });

  // ── The seam actually carries a second language ────────────────────────────
  //
  // Keys existing and prose being absent are both necessary; neither is
  // sufficient. This is the test that would have failed on the shipped build:
  // a German user asking "what did AI cost?" and getting an English sentence.
  it("renders the same answers in German when handed a German translator", () => {
    const cost = answerCost(deT, { mode: "plan", cost: 540, previousCost: 500, planFee: 100, planMultiplier: 5.4 });
    expect(cost.answer).toBe("$540 in diesem Zeitraum — 5.4× Ihres Abos von $100/Monat.");
    expect(cost.caveat).toBe("Entspricht den API-Kosten — nicht das, was Ihr Abo berechnet.");

    const empty = answerCost(deT, { mode: "metered", cost: 0, previousCost: null });
    expect(empty.answer).toBe("Für diesen Zeitraum wurde keine Nutzung erfasst.");
    expect(empty.unavailable!.enablement).toBe(
      "Führen Sie eine Claude-Code-Sitzung aus und aktualisieren Sie dann — die Erfassung läuft automatisch.",
    );

    expect(confidenceCaveat(deT, coverage())).toBe("70% hoch · 20% mittel · 10% niedrig Konfidenz.");
    expect(formatDevTime(deT, 360, 90)).toBe("4.0 Entwicklerstunden");

    // The pack — the artefact that leaves the machine — carries the same
    // translator through, so the document and the screen agree in ONE language.
    const h = buildPackHeadline(deT, { mode: "metered", currency: "USD", coverage: coverage(), hourlyRate: 100 });
    expect(h.devTimeLabel).toBe("1.0 Entwicklerstunden");
    expect(h.costCaveatText).toBe("Tatsächlich abgerechnete Kosten.");
    expect(h.coverageCaveat).toBe("70% hoch · 20% mittel · 10% niedrig Konfidenz.");
  });

  it("uses the locale's own sentence punctuation, not ASCII furniture", () => {
    // ja terminates with "。" and joins clauses with "、". A hardcoded "." in
    // the formatter is invisible in de/fr/es — it only shows up here.
    const a = answerCost(jaT, { mode: "metered", cost: 720, previousCost: null, hourlyRate: 90 });
    expect(a.answer.endsWith("。")).toBe(true);
    expect(a.answer).not.toContain(" — ");
    expect(a.answer).toContain("、");
  });

  // There are FOUR punctuation keys and `answerCost` reaches only two of them.
  // Checking one formatter certified the other two: hardcoding `", "` in
  // `answerBought`'s join passed the whole 2,692-test suite, and a Japanese
  // reader would have seen an ASCII comma splicing two Japanese clauses. Each
  // key gets a formatter that actually exercises it.
  it("carries that discipline into the list and dot joiners too, not just the clause joiner", () => {
    // listJoin — `answerBought` joins its clauses with it. ja: "、", not ", ".
    const bought = answerBought(jaT, {
      completedTasks: 41,
      coverage: coverage(),
      topTicket: { key: "PROJ-123", cost: 41.2 },
    });
    expect(bought.answer).toContain("、");
    expect(bought.answer).not.toContain(", ");
    expect(bought.answer.endsWith("。")).toBe(true);

    // dotJoin — `confidenceCaveat` separates the confidence tiers with it.
    // ja: "・", not " · ".
    const caveat = confidenceCaveat(jaT, coverage());
    expect(caveat).toContain("・");
    expect(caveat).not.toContain(" · ");
  });

  // ── Caller text is data, not a template ────────────────────────────────────
  //
  // Regression, found by running the feature rather than by a test: routing
  // caller-supplied strings through `t()` made them templates, because
  // i18next's interpolator rescans the string it is building. A recommendation
  // titled "{{count}} injected" rendered as "1 injected — x (+{{count}} more)."
  // — the title ate the count and the real count leaked as a raw placeholder,
  // on the default tab. Before localization this was impossible (template
  // literals), so it is a defect this change introduced and must not reintroduce.
  it("treats caller-supplied text as data, never as an interpolation template", () => {
    const hostile = answerChange(t, {
      recommendations: [{ title: "{{count}} injected", impact: "{{lead}} too" }, { title: "second" }],
    });
    // The title survives verbatim...
    expect(hostile.answer).toContain("{{count}} injected");
    expect(hostile.answer).toContain("{{lead}} too");
    // ...and the sentence's OWN count is still resolved, not left raw.
    expect(hostile.answer).toContain("+1 more");
    expect(hostile.answer).toBe("{{count}} injected — {{lead}} too (+1 more).");

    // Same rule on the other two formatters that take caller text.
    const setup = answerSetup(t, {
      planVerdict: "{{saving}} verdict",
      recommendedPlan: "{{plan}}",
      projectedSaving: 80,
    });
    expect(setup.answer).toBe("{{saving}} verdict — switching to {{plan}} would save about $80.00/mo.");

    const bought = answerBought(t, {
      completedTasks: null,
      coverage: coverage(),
      topTicket: { key: "{{cost}}", cost: 41.2 },
    });
    expect(bought.answer).toBe(
      "80% of spend attributed to work items, biggest: {{cost}} ($41.20).",
    );

    // A caller cannot forge the internal slot marker to displace a value.
    // Built with fromCharCode so a NUL never has to survive a source file.
    const NUL = String.fromCharCode(0);
    const forged = answerChange(t, {
      recommendations: [{ title: `${NUL}0${NUL} forged` }, { title: "second" }],
    });
    expect(forged.answer).not.toContain(NUL);
    expect(forged.answer).toBe("0 forged (+1 more).");
  });

  it("pluralizes the singular cases rather than emitting a bare '1 sessions'", () => {
    // Each pair differs ONLY in the count, so a key whose `_one` form was
    // copied from `_other` (a common fill-locales failure) fails here.
    const one = answerBought(t, { completedTasks: 1, coverage: coverage(), topTicket: null }).answer;
    const many = answerBought(t, { completedTasks: 2, coverage: coverage(), topTicket: null }).answer;
    expect(one).toContain("1 task completed");
    expect(many).toContain("2 tasks completed");
    expect(one).not.toBe(many);
  });
});
