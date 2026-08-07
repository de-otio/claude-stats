/**
 * Lane K — outcome calibration.
 *
 * Every assertion here is written against a specific way the feature could be
 * quietly wrong, because the ways it can be quietly wrong are the whole point:
 * a calibration module that reports a plausible-looking number from a sample
 * that cannot support one is strictly worse than no calibration at all, and it
 * would discredit every other figure in the report on its way out.
 *
 * The recurring defect shapes this build has recorded are all represented:
 *  - a boundary tested only from one side (`minN` is tested at n-1, n and n+1);
 *  - a "never negative" test that only exercises positive numbers (the interval
 *    is exercised at BOTH extremes, agreed === n and agreed === 0, where the
 *    naive implementation collapses to a point);
 *  - a substring searched across a whole rendered document (the caveat tests
 *    assert which KEY was resolved, not that some text appeared somewhere);
 *  - fixtures whose values make two different computations coincide (the review
 *    fixtures deliberately use agreed ≠ disagreed ≠ unproposed, all distinct and
 *    none equal to the row count).
 */
import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  MIN_CALIBRATION_N,
  calibrate,
  reviewAttributionLinks,
  wilsonInterval,
  type TicketLinkGrade,
} from "@claude-stats/core/calibration";
import { answerBought, calibrationCaveat, calibrationEnablement, type InsightT } from "@claude-stats/core/insight";
import type { TicketCoverage } from "@claude-stats/core/types/insight";
import { Store } from "../store/index.js";
import {
  CALIBRATION_MEASURES,
  buildAttributionCalibration,
  calibrationJson,
  outcomeCalibrationFrom,
} from "../calibration/index.js";
import type { CalibrationMetrics, CalibrationReport } from "../cost-per-task/calibration.js";
import { FIXED_NOW } from "./fixtures/synthetic.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function tmpDb(): string {
  // A `mkdtempSync` SUBDIRECTORY, never `os.tmpdir()` itself — writing the
  // shared temp root has already broken this build once.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-calibration-"));
  tmpDirs.push(dir);
  return path.join(dir, "store.db");
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/** The identity translator: returns the key, so a test can see WHICH key ran. */
const idT: InsightT = (key) => key;

/** A translator that also renders the interpolated values, for value assertions. */
const echoT: InsightT = (key, options) =>
  `${key}(${Object.entries(options ?? {})
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort()
    .join(",")})`;

function grade(
  sessionId: string,
  ticketKey: string,
  source: TicketLinkGrade["source"],
  negated = false,
): TicketLinkGrade {
  return { sessionId, ticketKey, source, negated };
}

/** `ticket_links.session_id` is a foreign key — the session must exist first. */
function seedSessions(store: Store, ids: readonly string[]): void {
  for (const id of ids) {
    store.upsertSession({
      sessionId: id, projectPath: "/w/alpha", sourceFile: `/transcripts/${id}.jsonl`,
      firstTimestamp: FIXED_NOW, lastTimestamp: FIXED_NOW + 60_000, claudeVersion: "2.1.70",
      entrypoint: "claude-vscode", gitBranch: "main", permissionMode: "default",
      isInteractive: true, promptCount: 1, assistantMessageCount: 1,
      inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
      webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: ["claude-opus-4-6"],
      repoUrl: null, accountUuid: null, organizationUuid: null, subscriptionType: null,
      thinkingBlocks: 0, parentSessionId: null, isSubagent: false, sourceDeleted: false,
      throttleEvents: 0, activeDurationMs: null, medianResponseTimeMs: null,
    });
  }
}

const LOCALES = ["en", "de", "fr", "es", "pt-BR", "ja", "zh-CN", "pl", "ru", "uk"] as const;

/** Read a locale's `common` namespace straight off disk — no alias, no bundler. */
function commonJson(locale: string): {
  insight: { calibration: { measured: Record<string, string>; enablement: Record<string, string> } };
} {
  const file = path.resolve(
    __dirname, "..", "..", "..", "core", "src", "locales", locale, "common.json",
  );
  return JSON.parse(fs.readFileSync(file, "utf8")) as ReturnType<typeof commonJson>;
}

function coverage(over: Partial<TicketCoverage> = {}): TicketCoverage {
  return {
    attributedCost: 259.3,
    totalCost: 312.4,
    ratio: 0.83,
    byConfidence: { high: 186.7, medium: 54.5, low: 18.1 },
    ambiguousSessions: 0,
    ...over,
  };
}

function metrics(over: Partial<CalibrationMetrics> = {}): CalibrationMetrics {
  const empty = { support: 0, predicted: 0, truePositives: 0, precision: null, recall: null, f1: null };
  return {
    n: 0,
    hits: 0,
    accuracy: null,
    observableN: 0,
    perClass: { success: empty, failed: empty, in_flight: empty, unobservable: empty },
    brier: null,
    failedPrecision: null,
    meetsFailedFloor: false,
    ...over,
  };
}

// ─── wilsonInterval ───────────────────────────────────────────────────────────

describe("wilsonInterval", () => {
  it("keeps real width at a perfect score", () => {
    // THE anti-Wald assertion. The textbook normal interval returns exactly
    // [1, 1] here — "100% agreement, no uncertainty" from 30 observations —
    // which is the precise overclaim this module exists to prevent. Wilson's
    // upper bound at p̂ = 1 is genuinely 1, so the bound that carries the
    // information is the LOWER one, and it must be far from 1.
    const perfect = wilsonInterval(30, 30);
    expect(perfect.lo).toBeCloseTo(0.8865, 3);
    expect(perfect.hi - perfect.lo).toBeGreaterThan(0.1);
  });

  it("keeps real width at a perfect ZERO too", () => {
    // Symmetrically: at p̂ = 0 the lower bound is genuinely 0 and the upper
    // bound carries the information. Wald would return [0, 0] — "0% agreement,
    // certain" — which is the same overclaim pointing the other way.
    const none = wilsonInterval(0, 30);
    expect(none.hi).toBeCloseTo(0.1135, 3);
    expect(none.hi - none.lo).toBeGreaterThan(0.1);
  });

  it("spans the whole scale when there are no observations", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 1 });
    expect(wilsonInterval(5, -3)).toEqual({ lo: 0, hi: 1 });
  });

  it("agrees with an independent re-derivation of the same interval", () => {
    // The implementation uses the centre-and-half-width form. This solves the
    // SAME defining equation, |p̂ − p| = z·√(p(1−p)/n), as a quadratic in p and
    // takes its two roots — different algebra, different rounding path. A
    // transcription slip in one form (a `4n²` written `4n`, a `/2` dropped)
    // cannot survive both. A single hardcoded constant pair could not catch
    // that: it would just be the implementation's own output written down.
    const byQuadratic = (x: number, n: number, z = 1.959963984540054) => {
      const a = n + z * z;
      const b = -(2 * x + z * z);
      const c = (x * x) / n;
      const root = Math.sqrt(b * b - 4 * a * c);
      return { lo: (-b - root) / (2 * a), hi: (-b + root) / (2 * a) };
    };
    for (const [agreed, n] of [[27, 30], [0, 30], [30, 30], [45, 60], [1, 7], [500, 1000]] as const) {
      const got = wilsonInterval(agreed, n);
      const want = byQuadratic(agreed, n);
      expect(got.lo, `lo for ${agreed}/${n}`).toBeCloseTo(Math.max(0, want.lo), 9);
      expect(got.hi, `hi for ${agreed}/${n}`).toBeCloseTo(Math.min(1, want.hi), 9);
    }
  });

  it("matches the published interval for 27/30", () => {
    // The commonly cited 95% Wilson interval for 27 of 30 is (0.744, 0.965).
    const w = wilsonInterval(27, 30);
    expect(w.lo).toBeCloseTo(0.7438, 3);
    expect(w.hi).toBeCloseTo(0.9654, 3);
  });

  it("brackets the point estimate", () => {
    for (const [agreed, n] of [[27, 30], [45, 60], [1, 40], [99, 100]] as const) {
      const w = wilsonInterval(agreed, n);
      expect(w.lo, `lo ≤ p for ${agreed}/${n}`).toBeLessThanOrEqual(agreed / n);
      expect(w.hi, `p ≤ hi for ${agreed}/${n}`).toBeGreaterThanOrEqual(agreed / n);
    }
  });

  it("narrows as the sample grows at a fixed proportion", () => {
    // A width that did NOT shrink with n would mean the interval carries no
    // information about sample size — which is the only thing it is here for.
    const width = (agreed: number, n: number) => {
      const w = wilsonInterval(agreed, n);
      return w.hi - w.lo;
    };
    expect(width(27, 30)).toBeGreaterThan(width(90, 100));
    expect(width(90, 100)).toBeGreaterThan(width(900, 1000));
  });

  it("stays inside [0, 1] at the extremes", () => {
    for (const [agreed, n] of [[0, 1], [1, 1], [0, 3], [3, 3]] as const) {
      const w = wilsonInterval(agreed, n);
      expect(w.lo).toBeGreaterThanOrEqual(0);
      expect(w.hi).toBeLessThanOrEqual(1);
      expect(w.lo).toBeLessThanOrEqual(w.hi);
    }
  });
});

// ─── calibrate: the gate ──────────────────────────────────────────────────────

describe("calibrate", () => {
  it("fixes the minimum sample at 30, the rule-of-three floor", () => {
    // Pinned as a literal rather than imported into its own assertion: the
    // constant is an argued choice (a perfect run of n rulings bounds the error
    // rate only at ~3/n, so 30 is the smallest n whose clean sheet says "under
    // 10%"). Changing it must be a deliberate edit to a stated number, not a
    // silent drift that this test follows.
    expect(MIN_CALIBRATION_N).toBe(30);
  });

  it("reports NO rate below the minimum, however tempting the sample looks", () => {
    // 28/29 is 96.6% — a number any surface would happily render, from a sample
    // that cannot distinguish it from 80%.
    const e = calibrate("attribution", { agreed: 28, disagreed: 1 });
    expect(e.state).toBe("uncalibrated");
    expect(e.rate).toBeNull();
    expect(e.interval).toBeNull();
    expect(e.n).toBe(29);
    expect(e.needed).toBe(1);
  });

  it("crosses at exactly minN, not one either side", () => {
    // The boundary from BOTH sides. A `<` written as `<=` passes a test that
    // only ever checks n-1 and n+1.
    expect(calibrate("outcome", { agreed: 29, disagreed: 0 }).state).toBe("uncalibrated");
    expect(calibrate("outcome", { agreed: 30, disagreed: 0 }).state).toBe("measured");
    expect(calibrate("outcome", { agreed: 30, disagreed: 1 }).state).toBe("measured");
  });

  it("counts DISAGREEMENTS toward the sample, not just agreements", () => {
    // The denominator is rulings, not endorsements. An implementation that
    // gated on `agreed` alone would report "uncalibrated" forever for a user
    // whose corrections are mostly rejections — which is most users.
    const e = calibrate("attribution", { agreed: 4, disagreed: 26 });
    expect(e.state).toBe("measured");
    expect(e.n).toBe(30);
    expect(e.rate).toBeCloseTo(4 / 30, 10);
  });

  it("computes the rate over the sample, not over the agreements", () => {
    const e = calibrate("outcome", { agreed: 27, disagreed: 13 });
    expect(e.n).toBe(40);
    expect(e.rate).toBeCloseTo(0.675, 10);
    expect(e.agreed).toBe(27);
    expect(e.disagreed).toBe(13);
    expect(e.needed).toBe(0);
    expect(e.interval).not.toBeNull();
  });

  it("reports the gap to the floor, and zero once past it", () => {
    expect(calibrate("outcome", { agreed: 0, disagreed: 0 }).needed).toBe(30);
    expect(calibrate("outcome", { agreed: 7, disagreed: 4 }).needed).toBe(19);
    expect(calibrate("outcome", { agreed: 40, disagreed: 0 }).needed).toBe(0);
  });

  it("carries the floor it was gated against", () => {
    expect(calibrate("outcome", { agreed: 1, disagreed: 0 }).minN).toBe(30);
    expect(calibrate("outcome", { agreed: 5, disagreed: 0 }, 4).minN).toBe(4);
    expect(calibrate("outcome", { agreed: 5, disagreed: 0 }, 4).state).toBe("measured");
  });

  it("keeps the subject it was asked about", () => {
    expect(calibrate("attribution", { agreed: 0, disagreed: 0 }).subject).toBe("attribution");
    expect(calibrate("outcome", { agreed: 0, disagreed: 0 }).subject).toBe("outcome");
  });

  it("floors negative and fractional counts rather than propagating them", () => {
    const e = calibrate("outcome", { agreed: -5, disagreed: 30.9 });
    expect(e.agreed).toBe(0);
    expect(e.disagreed).toBe(30);
    expect(e.n).toBe(30);
    expect(e.rate).toBe(0);
  });
});

// ─── reviewAttributionLinks ───────────────────────────────────────────────────

describe("reviewAttributionLinks", () => {
  it("counts an affirmed automatic proposal as agreement", () => {
    const r = reviewAttributionLinks([grade("s1", "PROJ-1", "branch"), grade("s1", "PROJ-1", "tag")]);
    expect(r).toEqual({ agreed: 1, disagreed: 0, unproposed: 0 });
  });

  it("counts a tombstoned automatic proposal as disagreement", () => {
    const r = reviewAttributionLinks([grade("s1", "PROJ-1", "branch"), grade("s1", "PROJ-1", "tag", true)]);
    expect(r).toEqual({ agreed: 0, disagreed: 1, unproposed: 0 });
  });

  it("does NOT read silence as agreement", () => {
    // The load-bearing exclusion. An automatic link the user never ruled on is
    // not an endorsement — counting it would bias the rate UPWARD and leave the
    // net bias direction unknowable, which would make the figure
    // uninterpretable rather than merely conservative.
    const r = reviewAttributionLinks([
      grade("s1", "PROJ-1", "branch"),
      grade("s2", "PROJ-2", "commit"),
      grade("s3", "PROJ-3", "prompt"),
    ]);
    expect(r).toEqual({ agreed: 0, disagreed: 0, unproposed: 0 });
  });

  it("classes a manual link the pass never proposed as a MISS, not a disagreement", () => {
    // Recall, not precision. Folding it into `disagreed` would drag the rate
    // down with a quantity it is not a rate of.
    const r = reviewAttributionLinks([grade("s9", "PROJ-9", "tag")]);
    expect(r.unproposed).toBe(1);
    expect(r.disagreed).toBe(0);
    expect(r.agreed).toBe(0);
  });

  it("ignores a pre-emptive tombstone on a pair the pass never proposed", () => {
    // It rules on nothing: there was no claim to strike out. Counting it as a
    // disagreement would let a user manufacture an arbitrarily bad calibration
    // figure by negating keys the tool never suggested.
    const r = reviewAttributionLinks([grade("s9", "PROJ-9", "tag", true)]);
    expect(r).toEqual({ agreed: 0, disagreed: 0, unproposed: 0 });
  });

  it("collapses several automatic sources on one pair into ONE ruling", () => {
    // branch + commit + prompt is one claim about one pair, not three. Counting
    // rows would triple-weight exactly the links the ladder is most confident
    // about, inflating the rate.
    const r = reviewAttributionLinks([
      grade("s1", "PROJ-1", "branch"),
      grade("s1", "PROJ-1", "commit"),
      grade("s1", "PROJ-1", "prompt"),
      grade("s1", "PROJ-1", "tag"),
    ]);
    expect(r.agreed).toBe(1);
  });

  it("does not treat a negated automatic row as a claim to uphold", () => {
    const r = reviewAttributionLinks([grade("s1", "PROJ-1", "branch", true), grade("s1", "PROJ-1", "tag")]);
    expect(r.agreed).toBe(0);
    expect(r.unproposed).toBe(1);
  });

  it("keys rulings by (session, key), not by key alone", () => {
    // PROJ-1 is proposed on s1 and affirmed on s2. Keying by ticket key alone
    // would score that as agreement; they are statements about different work.
    const r = reviewAttributionLinks([grade("s1", "PROJ-1", "branch"), grade("s2", "PROJ-1", "tag")]);
    expect(r.agreed).toBe(0);
    expect(r.unproposed).toBe(1);
  });

  it("keys rulings by key, not by session alone", () => {
    const r = reviewAttributionLinks([grade("s1", "PROJ-1", "branch"), grade("s1", "PROJ-2", "tag")]);
    expect(r.agreed).toBe(0);
    expect(r.unproposed).toBe(1);
  });

  it("separates the three outcomes on a mixed corpus", () => {
    // Deliberately all-distinct counts (2 agreed, 3 disagreed, 1 unproposed,
    // 11 rows). Every pair of these computations differs, so a fixture where
    // two of them coincided cannot hide a swap.
    const r = reviewAttributionLinks([
      grade("a", "PROJ-1", "branch"), grade("a", "PROJ-1", "tag"),          // agreed
      grade("b", "PROJ-2", "commit"), grade("b", "PROJ-2", "tag"),          // agreed
      grade("c", "PROJ-3", "branch"), grade("c", "PROJ-3", "tag", true),    // disagreed
      grade("d", "PROJ-4", "prompt"), grade("d", "PROJ-4", "tag", true),    // disagreed
      grade("e", "PROJ-5", "branch"), grade("e", "PROJ-5", "tag", true),    // disagreed
      grade("f", "PROJ-6", "tag"),                                          // unproposed
    ]);
    expect(r).toEqual({ agreed: 2, disagreed: 3, unproposed: 1 });
  });

  it("is order-independent", () => {
    const rows = [
      grade("a", "PROJ-1", "tag"), grade("a", "PROJ-1", "branch"),
      grade("c", "PROJ-3", "tag", true), grade("c", "PROJ-3", "branch"),
    ];
    expect(reviewAttributionLinks(rows)).toEqual(reviewAttributionLinks([...rows].reverse()));
  });
});

// ─── The store seam ───────────────────────────────────────────────────────────

describe("buildAttributionCalibration", () => {
  it("reads tombstones, which the ACTIVE-links query would have filtered away", () => {
    // If this read `getActiveTicketLinks` instead, every disagreement would be
    // invisible and the rate would be 100% by construction — the single most
    // dangerous way this feature could be wrong.
    const store = new Store(tmpDb());
    try {
      seedSessions(store, ["s1"]);
      store.addTicketLink({ sessionId: "s1", ticketKey: "PROJ-1", source: "branch", confidence: "high" });
      store.negateTicketLink("s1", "PROJ-1");

      const { estimate, review } = buildAttributionCalibration(store);
      expect(review).toEqual({ agreed: 0, disagreed: 1, unproposed: 0 });
      expect(estimate.n).toBe(1);
      expect(estimate.state).toBe("uncalibrated");
    } finally {
      store.close();
    }
  });

  it("scores affirmations and rejections from a real store", () => {
    const store = new Store(tmpDb());
    try {
      seedSessions(store, ["s1", "s2", "s3", "s4"]);
      store.addTicketLink({ sessionId: "s1", ticketKey: "PROJ-1", source: "branch", confidence: "high" });
      store.addTicketLink({ sessionId: "s1", ticketKey: "PROJ-1", source: "tag", confidence: "high" });
      store.addTicketLink({ sessionId: "s2", ticketKey: "PROJ-2", source: "commit", confidence: "medium" });
      store.negateTicketLink("s2", "PROJ-2");
      store.addTicketLink({ sessionId: "s3", ticketKey: "PROJ-3", source: "tag", confidence: "high" });
      // Never ruled on — must not enter the denominator.
      store.addTicketLink({ sessionId: "s4", ticketKey: "PROJ-4", source: "branch", confidence: "high" });

      const { estimate, review } = buildAttributionCalibration(store);
      expect(review).toEqual({ agreed: 1, disagreed: 1, unproposed: 1 });
      expect(estimate.n).toBe(2);
    } finally {
      store.close();
    }
  });

  it("returns the honest empty state for a store with no links at all", () => {
    const store = new Store(tmpDb());
    try {
      const { estimate } = buildAttributionCalibration(store);
      expect(estimate.state).toBe("uncalibrated");
      expect(estimate.n).toBe(0);
      expect(estimate.rate).toBeNull();
      expect(estimate.needed).toBe(MIN_CALIBRATION_N);
    } finally {
      store.close();
    }
  });

  it("drops a row whose source this build cannot grade", () => {
    // `source` is a TEXT column. A row written by a future version must not be
    // silently treated as an automatic proposal a manual row could "uphold".
    const store = new Store(tmpDb());
    try {
      seedSessions(store, ["s1"]);
      store.addTicketLink({ sessionId: "s1", ticketKey: "PROJ-1", source: "oracle", confidence: "high" });
      store.addTicketLink({ sessionId: "s1", ticketKey: "PROJ-1", source: "tag", confidence: "high" });

      const { review } = buildAttributionCalibration(store);
      expect(review.agreed).toBe(0);
      expect(review.unproposed).toBe(1);
    } finally {
      store.close();
    }
  });
});

// ─── The outcome adapter ──────────────────────────────────────────────────────

describe("outcomeCalibrationFrom", () => {
  const report = (proxy: CalibrationMetrics, signals: CalibrationMetrics): CalibrationReport => ({
    n: proxy.n,
    floor: 0.7,
    proxyOnly: proxy,
    withSignals: signals,
  });

  it("reads the UNAIDED proxy, not the opt-in signals path", () => {
    // The signals combiner is behind `config.experimentalSignals` and most
    // stores do not run it. Calibrating it would describe a mechanism that
    // never produced the success counts the dashboard actually quotes. The two
    // hit counts differ here on purpose, so reading the wrong one changes the
    // answer.
    const e = outcomeCalibrationFrom(
      report(metrics({ n: 40, hits: 27 }), metrics({ n: 40, hits: 38 })),
    );
    expect(e.agreed).toBe(27);
    expect(e.disagreed).toBe(13);
    expect(e.rate).toBeCloseTo(0.675, 10);
  });

  it("degrades to the honest empty state when no report exists", () => {
    for (const absent of [null, undefined]) {
      const e = outcomeCalibrationFrom(absent);
      expect(e.subject).toBe("outcome");
      expect(e.state).toBe("uncalibrated");
      expect(e.n).toBe(0);
      expect(e.rate).toBeNull();
    }
  });

  it("uses the exact hit COUNT, not a figure recovered from the accuracy float", () => {
    // 1/3 cannot round-trip through a float ratio. `round(accuracy * n)` would
    // usually land back on the same integer — but "usually" is not a property,
    // and the denominator of an honesty figure does not get to be approximate.
    const e = outcomeCalibrationFrom(report(metrics({ n: 33, hits: 11, accuracy: 1 / 3 }), metrics()));
    expect(e.agreed).toBe(11);
    expect(e.disagreed).toBe(22);
    expect(e.n).toBe(33);
  });

  it("gates the outcome subject on the same floor as attribution", () => {
    expect(outcomeCalibrationFrom(report(metrics({ n: 29, hits: 29 }), metrics())).state).toBe("uncalibrated");
    expect(outcomeCalibrationFrom(report(metrics({ n: 30, hits: 29 }), metrics())).state).toBe("measured");
  });
});

// ─── The sentences ────────────────────────────────────────────────────────────

describe("calibrationCaveat", () => {
  it("resolves a DIFFERENT key per subject and per state", () => {
    // Four keys, four distinct results. Asserting "contains 'calibration'"
    // would pass with all four collapsed onto one sentence.
    const keys = new Set([
      calibrationCaveat(idT, calibrate("attribution", { agreed: 1, disagreed: 0 })),
      calibrationCaveat(idT, calibrate("outcome", { agreed: 1, disagreed: 0 })),
      calibrationCaveat(idT, calibrate("attribution", { agreed: 30, disagreed: 0 })),
      calibrationCaveat(idT, calibrate("outcome", { agreed: 30, disagreed: 0 })),
    ]);
    expect(keys.size).toBe(4);
    expect(keys).toContain("common:insight.calibration.uncalibrated.attribution");
    expect(keys).toContain("common:insight.calibration.uncalibrated.outcome");
    expect(keys).toContain("common:insight.calibration.measured.attribution");
    expect(keys).toContain("common:insight.calibration.measured.outcome");
  });

  it("carries the denominator and the interval into the measured sentence", () => {
    // A rate without its `n` is the exact defect I1 exists to stop, and an
    // interval dropped on the way to the sentence takes the sample-size
    // information with it.
    const text = calibrationCaveat(echoT, calibrate("attribution", { agreed: 27, disagreed: 3 }));
    expect(text).toContain("n=30");
    expect(text).toContain("percent=90%");
    expect(text).toContain("lo=74%");
    expect(text).toContain("hi=97%");
  });

  it("carries the gap to the floor into the uncalibrated sentence", () => {
    const text = calibrationCaveat(echoT, calibrate("outcome", { agreed: 4, disagreed: 2 }));
    expect(text).toContain("n=6");
    expect(text).toContain("minN=30");
    // No percentage may appear: there is no rate to state.
    expect(text).not.toContain("percent=");
  });

  it("states the selection bias in every locale, not only in English", () => {
    // The bias clause is the difference between an honest figure and a claim
    // that "attribution is 90% accurate". A locale that dropped it would ship
    // the overclaim to that language alone — invisible to an English reader.
    for (const locale of LOCALES) {
      const json = commonJson(locale);
      for (const subject of ["attribution", "outcome"]) {
        const s = json.insight.calibration.measured[subject]!;
        expect(s, `${locale}/${subject} keeps the denominator`).toContain("{{n}}");
        expect(s, `${locale}/${subject} keeps the interval`).toContain("{{lo}}");
        expect(s, `${locale}/${subject} keeps the interval`).toContain("{{hi}}");
        // Long enough to still contain the qualifying clause after the figures:
        // the shortest honest form in any of these languages is well over 80
        // characters, and a translator who dropped the clause would land far
        // under it.
        expect(s.length, `${locale}/${subject} keeps the bias clause`).toBeGreaterThan(80);
      }
    }
  });
});

describe("calibrationEnablement", () => {
  it("names the action while uncalibrated and falls silent once measured", () => {
    expect(calibrationEnablement(idT, calibrate("attribution", { agreed: 3, disagreed: 0 }))).toBe(
      "common:insight.calibration.enablement.attribution",
    );
    expect(calibrationEnablement(idT, calibrate("outcome", { agreed: 3, disagreed: 0 }))).toBe(
      "common:insight.calibration.enablement.outcome",
    );
    expect(calibrationEnablement(idT, calibrate("attribution", { agreed: 30, disagreed: 0 }))).toBeNull();
    expect(calibrationEnablement(idT, calibrate("outcome", { agreed: 30, disagreed: 0 }))).toBeNull();
  });

  it("names only CLI verbs the program actually registers", () => {
    // A nudge that tells the user to run a command that does not exist is worse
    // than no nudge: it costs them a failed invocation and the tool its
    // credibility. `ticket` and `task-outcome` are both registered in cli/index.ts.
    const verbs = new Set<string>();
    for (const s of Object.values(commonJson("en").insight.calibration.enablement)) {
      for (const m of s.matchAll(/claude-stats ([a-z][a-z-]*)/g)) verbs.add(m[1]!);
    }
    expect([...verbs].sort()).toEqual(["task-outcome", "ticket"]);

    // ...and the same verbs survive translation. A locale that "helpfully"
    // localized a command name would print an invocation that cannot run.
    for (const locale of LOCALES) {
      const found = new Set<string>();
      for (const s of Object.values(commonJson(locale).insight.calibration.enablement)) {
        for (const m of s.matchAll(/claude-stats ([a-z][a-z-]*)/g)) found.add(m[1]!);
      }
      expect([...found].sort(), `${locale} keeps the verbs`).toEqual(["task-outcome", "ticket"]);
    }
  });
});

// ─── Q2's caveat ──────────────────────────────────────────────────────────────

describe("answerBought carries calibration on the figures it qualifies", () => {
  it("appends the calibration sentence to the confidence caveat", () => {
    const a = answerBought(idT, {
      completedTasks: 12,
      coverage: coverage(),
      topTicket: null,
      calibration: [calibrate("attribution", { agreed: 2, disagreed: 0 })],
    });
    expect(a.caveat).toContain("common:insight.coverage.mix");
    expect(a.caveat).toContain("common:insight.calibration.uncalibrated.attribution");
  });

  it("appends BOTH subjects when the card quotes both figures", () => {
    const a = answerBought(idT, {
      completedTasks: 12,
      coverage: coverage(),
      topTicket: null,
      calibration: [
        calibrate("attribution", { agreed: 2, disagreed: 0 }),
        calibrate("outcome", { agreed: 40, disagreed: 0 }),
      ],
    });
    expect(a.caveat).toContain("common:insight.calibration.uncalibrated.attribution");
    expect(a.caveat).toContain("common:insight.calibration.measured.outcome");
  });

  it("leaves the caveat exactly as it was when no calibration is supplied", () => {
    // A caller that has not gathered calibration must not be made to imply it
    // has, and the pre-Lane-K rendering must be byte-identical.
    const before = answerBought(idT, { completedTasks: 12, coverage: coverage(), topTicket: null });
    for (const absent of [undefined, null, []]) {
      const after = answerBought(idT, {
        completedTasks: 12,
        coverage: coverage(),
        topTicket: null,
        calibration: absent,
      });
      expect(after.caveat).toBe(before.caveat);
    }
  });

  it("joins with the locale's own separator, not a hardcoded space", () => {
    // ja and zh-CN set this to the empty string — a space between sentences is
    // an English typographic rule, and the auto-fill got this key wrong once
    // already (it produced the literal two characters `""`).
    const a = answerBought((key) => (key === "common:insight.punctuation.caveatJoin" ? "|SEP|" : key), {
      completedTasks: 12,
      coverage: coverage(),
      topTicket: null,
      calibration: [calibrate("attribution", { agreed: 2, disagreed: 0 })],
    });
    expect(a.caveat).toContain("|SEP|");
  });

  it("has no separator to leak when there is only one caveat part", () => {
    const a = answerBought((key) => (key === "common:insight.punctuation.caveatJoin" ? "|SEP|" : key), {
      completedTasks: 12,
      coverage: coverage(),
      topTicket: null,
    });
    expect(a.caveat).not.toContain("|SEP|");
  });

  it("does not silently change the honest-unavailable branch", () => {
    const a = answerBought(idT, {
      completedTasks: 3,
      coverage: null,
      topTicket: null,
      calibration: [calibrate("attribution", { agreed: 30, disagreed: 0 })],
    });
    expect(a.unavailable?.reason).toBe("not-enabled");
    expect(a.caveat).toBeNull();
  });
});

// ─── The machine-readable shape ───────────────────────────────────────────────

describe("calibrationJson", () => {
  it("labels what the rate is a rate OF, as a token a caller can branch on", () => {
    const j = calibrationJson(idT, calibrate("outcome", { agreed: 27, disagreed: 3 }));
    expect(j.measures).toBe("agreement-on-reviewed-subset");
    expect(CALIBRATION_MEASURES).toBe("agreement-on-reviewed-subset");
  });

  it("never emits a rate or an interval in the uncalibrated state", () => {
    const j = calibrationJson(idT, calibrate("attribution", { agreed: 10, disagreed: 5 }));
    expect(j.state).toBe("uncalibrated");
    expect(j.rate).toBeNull();
    expect(j.interval).toBeNull();
    expect(j.needed).toBe(15);
    expect(j.enablement).not.toBeNull();
  });

  it("carries the recall miss count only when one was supplied", () => {
    const withMisses = calibrationJson(idT, calibrate("attribution", { agreed: 1, disagreed: 0 }), {
      unproposed: 7,
    });
    expect(withMisses.unproposed).toBe(7);
    expect(calibrationJson(idT, calibrate("outcome", { agreed: 1, disagreed: 0 }))).not.toHaveProperty(
      "unproposed",
    );
  });

  it("keeps the recall misses OUT of the precision figures", () => {
    // n, agreed and disagreed must be untouched by `unproposed`. Adding misses
    // into the denominator would turn the rate into a quantity that is neither
    // precision nor recall.
    const j = calibrationJson(idT, calibrate("attribution", { agreed: 20, disagreed: 10 }), { unproposed: 99 });
    expect(j.n).toBe(30);
    expect(j.agreed).toBe(20);
    expect(j.disagreed).toBe(10);
    expect(j.rate).toBeCloseTo(2 / 3, 10);
  });
});
