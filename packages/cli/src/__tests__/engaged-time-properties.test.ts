/**
 * `computeEngagedHours` — PROPERTY tests (project-hours-attribution Phase B3).
 *
 * `engaged-time.test.ts` pins the arithmetic on fixtures. This file exists for
 * the claims that must hold across MANY inputs — the ones the plan lists as
 * acceptance criteria, and the ones a plausible-but-wrong split rule would
 * still pass on a hand-picked example:
 *
 *  - a split that double-counts contested time passes any single-project test;
 *  - a union that forgets to clip at midnight passes any within-day test;
 *  - a dedupe that is merely "good enough" passes until a session is resumed.
 *
 * Each property below is paired with the failure it is meant to catch.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  computeEngagedHours,
  RECONCILE_EPSILON,
  type TimestampRow,
  type DayBoundary,
  type SplitRule,
} from "@claude-stats/core/engagedTime";

const DAY_MS = 86_400_000;
const D0 = 1_756_684_800_000;

/** Three consecutive days; boundaries injected, so no timezone enters here [C-1]. */
const DAYS: DayBoundary[] = [
  { date: "2026-09-01", startMs: D0, endMs: D0 + DAY_MS },
  { date: "2026-09-02", startMs: D0 + DAY_MS, endMs: D0 + 2 * DAY_MS },
  { date: "2026-09-03", startMs: D0 + 2 * DAY_MS, endMs: D0 + 3 * DAY_MS },
];
const WINDOW_MS = 3 * DAY_MS;

const PROJECTS = ["/p/a", "/p/b", "/p/c"] as const;
const GROUPS = [
  { label: "alpha", prefixes: ["/p/a"] },
  { label: "beta", prefixes: ["/p/b"] },
];

const rowArb = fc.record({
  offset: fc.integer({ min: 0, max: WINDOW_MS - 1 }),
  projectPath: fc.constantFrom(...PROJECTS),
  sessionId: fc.constantFrom("s1", "s2", "s3"),
  isTurnStart: fc.constantFrom(0 as const, 1 as const),
});

const rowsArb = fc.array(rowArb, { minLength: 0, maxLength: 120 }).map((rs) =>
  rs.map<TimestampRow>((r) => ({
    ts: D0 + r.offset,
    sessionId: r.sessionId,
    projectPath: r.projectPath,
    isTurnStart: r.isTurnStart,
  })),
);

const capArb = fc.integer({ min: 1, max: 120 });
const splitArb = fc.constantFrom<SplitRule>("proportional", "duplicate", "exclusive");

function run(rows: readonly TimestampRow[], capMinutes: number, split: SplitRule) {
  return computeEngagedHours(rows, {
    capMinutes,
    split,
    groups: GROUPS,
    days: DAYS,
    caseInsensitivePaths: false,
  });
}

describe("computeEngagedHours — invariants", () => {
  it("engaged hours never exceed the wall-clock span of the data", () => {
    // Catches a split rule that credits the same segment twice into the UNION,
    // and an interval that runs past its successor.
    fc.assert(
      fc.property(rowsArb, capArb, splitArb, (rows, cap, split) => {
        const r = run(rows, cap, split);
        if (rows.length < 2) {
          expect(r.totals.unionHours).toBe(0);
          return;
        }
        const ts = rows.map((x) => x.ts);
        const wallHours = (Math.max(...ts) - Math.min(...ts)) / 3_600_000;
        expect(r.totals.unionHours).toBeLessThanOrEqual(wallHours + 1e-9);
      }),
      { numRuns: 300 },
    );
  });

  it("no day ever exceeds 24 h", () => {
    fc.assert(
      fc.property(rowsArb, capArb, splitArb, (rows, cap, split) => {
        for (const d of run(rows, cap, split).days) {
          expect(d.dayUnionHours).toBeLessThanOrEqual(24 + 1e-9);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("under proportional, per-group hours sum to the day union", () => {
    // THE test that catches a broken split. Hardcoding `reconciles: true`
    // would delete it, which is why [C-4] makes the field computed.
    fc.assert(
      fc.property(rowsArb, capArb, (rows, cap) => {
        const r = run(rows, cap, "proportional");
        for (const d of r.days) {
          const sum = d.groups.reduce((t, g) => t + g.hours, 0);
          expect(Math.abs(sum - d.dayUnionHours)).toBeLessThanOrEqual(1e-9);
        }
        expect(r.coverage.reconciles).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("under exclusive, per-group hours also sum to the day union", () => {
    fc.assert(
      fc.property(rowsArb, capArb, (rows, cap) => {
        const r = run(rows, cap, "exclusive");
        const sum = r.totals.byGroup.reduce((t, g) => t + g.hours, 0);
        expect(Math.abs(sum - r.totals.unionHours)).toBeLessThanOrEqual(RECONCILE_EPSILON);
      }),
      { numRuns: 300 },
    );
  });

  it("under duplicate, per-group hours are >= the union and never less", () => {
    fc.assert(
      fc.property(rowsArb, capArb, (rows, cap) => {
        const r = run(rows, cap, "duplicate");
        const sum = r.totals.byGroup.reduce((t, g) => t + g.hours, 0);
        expect(sum).toBeGreaterThanOrEqual(r.totals.unionHours - 1e-9);
      }),
      { numRuns: 200 },
    );
  });

  it("is idempotent under replayed rows [D-9]", () => {
    // Resumes and compaction replay earlier turns verbatim. The uuid PRIMARY
    // KEY collapses them today — this proves the METRIC does not depend on
    // that, so a dedupe regression cannot silently inflate anyone's hours.
    fc.assert(
      fc.property(rowsArb, capArb, splitArb, (rows, cap, split) => {
        const once = run(rows, cap, split);
        const twice = run([...rows, ...rows], cap, split);
        expect(twice.totals.unionHours).toBeCloseTo(once.totals.unionHours, 12);
        expect(twice.days.map((d) => d.dayUnionHours.toFixed(9))).toEqual(
          once.days.map((d) => d.dayUnionHours.toFixed(9)),
        );
        expect(twice.totals.byGroup.map((g) => `${g.label}:${g.hours.toFixed(9)}`)).toEqual(
          once.totals.byGroup.map((g) => `${g.label}:${g.hours.toFixed(9)}`),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("is invariant to row order", () => {
    // The store returns rows ORDER BY timestamp; nothing may depend on that.
    fc.assert(
      fc.property(rowsArb, capArb, splitArb, (rows, cap, split) => {
        const asGiven = run(rows, cap, split);
        const reversed = run([...rows].reverse(), cap, split);
        expect(reversed.totals.unionHours).toBeCloseTo(asGiven.totals.unionHours, 12);
      }),
      { numRuns: 200 },
    );
  });

  it("union hours are monotone non-decreasing in the cap", () => {
    // Catches a cap applied to the wrong side of the min(), which would make a
    // larger cap credit LESS time.
    fc.assert(
      fc.property(rowsArb, fc.integer({ min: 1, max: 60 }), (rows, cap) => {
        const small = run(rows, cap, "proportional").totals.unionHours;
        const large = run(rows, cap * 2, "proportional").totals.unionHours;
        expect(large).toBeGreaterThanOrEqual(small - 1e-9);
      }),
      { numRuns: 200 },
    );
  });

  it("overlapHours never exceeds the day union and is split-rule invariant", () => {
    fc.assert(
      fc.property(rowsArb, capArb, (rows, cap) => {
        const rules: SplitRule[] = ["proportional", "duplicate", "exclusive"];
        const perRule = rules.map((s) => run(rows, cap, s).days.map((d) => d.overlapHours));
        for (const d of run(rows, cap, "proportional").days) {
          expect(d.overlapHours).toBeLessThanOrEqual(d.dayUnionHours + 1e-9);
        }
        for (const other of perRule.slice(1)) {
          expect(other.map((h) => h.toFixed(9))).toEqual(perRule[0]!.map((h) => h.toFixed(9)));
        }
      }),
      { numRuns: 200 },
    );
  });

  it("promptCount and sessionCount are conserved across the grouping", () => {
    fc.assert(
      fc.property(rowsArb, capArb, (rows, cap) => {
        const r = run(rows, cap, "proportional");
        const totalPrompts = r.totals.byGroup.reduce((t, g) => t + g.promptCount, 0);
        expect(totalPrompts).toBe(rows.reduce((t, x) => t + x.isTurnStart, 0));
      }),
      { numRuns: 200 },
    );
  });

  it("a day with no rows can only hold time CARRIED IN across midnight [D-5]", () => {
    // `daysWithNoData` means "no rows", not "no hours" — a gap straddling
    // midnight is credited to both days, so a day whose transcript is entirely
    // absent can still show a sliver carried in from the previous day's last
    // response. That sliver is bounded by the cap (an interval is never longer
    // than that), and it carries no prompts and no sessions, because those are
    // counted from ROWS. Asserting `=== 0` here is what the first draft of this
    // property did; a generated 1 ms straddle falsified it.
    fc.assert(
      fc.property(rowsArb, capArb, (rows, cap) => {
        const r = run(rows, cap, "proportional");
        for (const d of r.days) {
          if (!r.coverage.daysWithNoData.includes(d.date)) continue;
          expect(d.dayUnionHours).toBeLessThanOrEqual(cap / 60 + 1e-9);
          for (const g of d.groups) {
            expect(g.promptCount).toBe(0);
            expect(g.sessionCount).toBe(0);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
