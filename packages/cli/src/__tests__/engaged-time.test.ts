/**
 * `computeEngagedHours` — unit tests (project-hours-attribution Phase B3).
 *
 * These pin the ARITHMETIC and the boundary cases named in the plan: the
 * interval primitive [C-2], midnight splitting, the three split rules,
 * segment-anchored prefix matching [SEC-5], the assistant-only population
 * guard [D-3], and the two figures the analysis measured wrong when it used a
 * naive per-project union.
 */
import { describe, it, expect } from "vitest";
import {
  computeEngagedHours,
  normalizePathForMatch,
  matchesPrefix,
  UNGROUPED_LABEL,
  UNKNOWN_LABEL,
  type TimestampRow,
  type DayBoundary,
  type EngagedHoursOptions,
} from "@claude-stats/core/engagedTime";

const DAY_MS = 86_400_000;
/** A fixed, timezone-free day: boundaries are injected, never derived [C-1]. */
const D0 = 1_756_684_800_000; // arbitrary epoch ms used as "midnight"
const MIN = 60_000;

function day(date: string, startMs: number): DayBoundary {
  return { date, startMs, endMs: startMs + DAY_MS };
}

function row(ts: number, projectPath: string, opts: Partial<TimestampRow> = {}): TimestampRow {
  return {
    ts,
    sessionId: opts.sessionId ?? "s1",
    projectPath,
    isTurnStart: opts.isTurnStart ?? 0,
  };
}

function baseOpts(over: Partial<EngagedHoursOptions> = {}): EngagedHoursOptions {
  return {
    capMinutes: 15,
    split: "proportional",
    groups: [],
    days: [day("2026-09-01", D0)],
    caseInsensitivePaths: false,
    ...over,
  };
}

describe("computeEngagedHours — the interval primitive [C-2]", () => {
  it("a single response yields 0.0 h, not a fabricated span", () => {
    const r = computeEngagedHours([row(D0 + 10 * MIN, "/p/a")], baseOpts());
    expect(r.days[0]!.dayUnionHours).toBe(0);
    // ...but the row is still visible, so 0.0 h reads as "one-shot", not "no data".
    expect(r.days[0]!.groups[0]!.sessionCount).toBe(1);
    expect(r.coverage.daysWithNoData).toEqual([]);
  });

  it("sums gaps below the cap exactly", () => {
    const rows = [
      row(D0, "/p/a"),
      row(D0 + 5 * MIN, "/p/a"),
      row(D0 + 12 * MIN, "/p/a"),
    ];
    // 5 min + 7 min = 12 min
    expect(computeEngagedHours(rows, baseOpts()).days[0]!.dayUnionHours).toBeCloseTo(12 / 60, 9);
  });

  it("caps an over-long gap instead of dropping it", () => {
    const rows = [row(D0, "/p/a"), row(D0 + 90 * MIN, "/p/a")];
    // The shipped `active_duration_ms` DROPS a gap this size; this metric caps
    // it at 15 min. Neither dominates — that asymmetry is [D-2].
    expect(computeEngagedHours(rows, baseOpts()).days[0]!.dayUnionHours).toBeCloseTo(0.25, 9);
  });

  it("a gap straddling midnight is split at the local boundary", () => {
    const days = [day("2026-09-01", D0), day("2026-09-02", D0 + DAY_MS)];
    const rows = [
      row(D0 + DAY_MS - 5 * MIN, "/p/a"),
      row(D0 + DAY_MS + 20 * MIN, "/p/a"),
    ];
    const r = computeEngagedHours(rows, baseOpts({ days }));
    // 15-min capped interval starts 5 min before midnight: 5 min then 10 min.
    expect(r.days[0]!.dayUnionHours).toBeCloseTo(5 / 60, 9);
    expect(r.days[1]!.dayUnionHours).toBeCloseTo(10 / 60, 9);
    expect(r.totals.unionHours).toBeCloseTo(0.25, 9);
  });

  it("never lets a day exceed 24 h", () => {
    const rows: TimestampRow[] = [];
    for (let t = 0; t < DAY_MS; t += MIN) rows.push(row(D0 + t, "/p/a"));
    expect(computeEngagedHours(rows, baseOpts()).days[0]!.dayUnionHours).toBeLessThanOrEqual(24);
  });
});

describe("split rules", () => {
  const days = [day("2026-09-01", D0)];
  const groups = [
    { label: "alpha", prefixes: ["/p/a"] },
    { label: "beta", prefixes: ["/p/b"] },
  ];
  // Two projects fully overlapping for 10 minutes.
  const rows = [
    row(D0, "/p/a"),
    row(D0 + 10 * MIN, "/p/a"),
    row(D0, "/p/b"),
    row(D0 + 10 * MIN, "/p/b"),
  ];

  it("proportional reconciles per-group hours to the day union", () => {
    const r = computeEngagedHours(rows, baseOpts({ days, groups, split: "proportional" }));
    expect(r.days[0]!.dayUnionHours).toBeCloseTo(10 / 60, 9);
    expect(r.days[0]!.overlapHours).toBeCloseTo(10 / 60, 9);
    for (const g of r.days[0]!.groups) expect(g.hours).toBeCloseTo(5 / 60, 9);
    expect(r.coverage.reconciles).toBe(true);
  });

  it("duplicate exceeds the day total and says so", () => {
    const r = computeEngagedHours(rows, baseOpts({ days, groups, split: "duplicate" }));
    for (const g of r.days[0]!.groups) expect(g.hours).toBeCloseTo(10 / 60, 9);
    // 1.99x over-attribution is exactly what the analysis measured; the flag is
    // what stops a caller summing these and calling it a day's work.
    expect(r.coverage.reconciles).toBe(false);
  });

  it("exclusive assigns one owner and still reconciles", () => {
    const r = computeEngagedHours(rows, baseOpts({ days, groups, split: "exclusive" }));
    const withHours = r.days[0]!.groups.filter((g) => g.hours > 0);
    expect(withHours).toHaveLength(1);
    expect(withHours[0]!.hours).toBeCloseTo(10 / 60, 9);
    expect(r.coverage.reconciles).toBe(true);
  });

  it("overlapHours is measured before the split rule, so it is rule-invariant", () => {
    const seen = (["proportional", "duplicate", "exclusive"] as const).map(
      (split) => computeEngagedHours(rows, baseOpts({ days, groups, split })).days[0]!.overlapHours,
    );
    expect(new Set(seen.map((h) => h.toFixed(9))).size).toBe(1);
  });
});

describe("grouping and prefix matching [SEC-5]", () => {
  it("does NOT put /repos/foobar into the /repos/foo group", () => {
    const groups = [{ label: "foo", prefixes: ["/repos/foo"] }];
    const rows = [row(D0, "/repos/foobar"), row(D0 + 5 * MIN, "/repos/foobar")];
    const r = computeEngagedHours(rows, baseOpts({ groups }));
    // The bare-startsWith bug would silently bill this to another client.
    expect(r.days[0]!.groups.map((g) => g.label)).toEqual([UNGROUPED_LABEL]);
  });

  it("matches the prefix directory itself and its descendants", () => {
    expect(matchesPrefix("/repos/foo", "/repos/foo")).toBe(true);
    expect(matchesPrefix("/repos/foo/bar", "/repos/foo")).toBe(true);
    expect(matchesPrefix("/repos/foobar", "/repos/foo")).toBe(false);
  });

  it("longest prefix wins regardless of declaration order", () => {
    const groups = [
      { label: "broad", prefixes: ["/repos"] },
      { label: "narrow", prefixes: ["/repos/x/y"] },
    ];
    const rows = [row(D0, "/repos/x/y/z"), row(D0 + 5 * MIN, "/repos/x/y/z")];
    const r = computeEngagedHours(rows, baseOpts({ groups }));
    expect(r.days[0]!.groups[0]!.label).toBe("narrow");
  });

  it("folds case only when told to", () => {
    const groups = [{ label: "g", prefixes: ["/Repos/App"] }];
    const rows = [row(D0, "/repos/app"), row(D0 + 5 * MIN, "/repos/app")];
    expect(
      computeEngagedHours(rows, baseOpts({ groups })).days[0]!.groups[0]!.label,
    ).toBe(UNGROUPED_LABEL);
    expect(
      computeEngagedHours(rows, baseOpts({ groups, caseInsensitivePaths: true })).days[0]!
        .groups[0]!.label,
    ).toBe("g");
  });

  it("normalises redundant separators and dot segments", () => {
    expect(normalizePathForMatch("/a//b/./c/", false)).toBe("/a/b/c");
    expect(normalizePathForMatch("/a/b/../c", false)).toBe("/a/c");
  });

  it("sessions with no project_path land in (unknown), not (ungrouped)", () => {
    const groups = [{ label: "g", prefixes: ["/p"] }];
    const rows = [row(D0, ""), row(D0 + 5 * MIN, "")];
    const r = computeEngagedHours(rows, baseOpts({ groups }));
    expect(r.days[0]!.groups[0]!.label).toBe(UNKNOWN_LABEL);
    expect(r.coverage.attributedHours).toBe(0);
    expect(r.coverage.ungroupedHours).toBeGreaterThan(0);
  });

  it("with no configured groups, each project is its own group", () => {
    const rows = [row(D0, "/p/a"), row(D0 + 5 * MIN, "/p/a"), row(D0, "/p/b")];
    const r = computeEngagedHours(rows, baseOpts());
    expect(r.days[0]!.groups.map((g) => g.label).sort()).toEqual(["/p/a", "/p/b"]);
  });
});

describe("counts and coverage", () => {
  it("promptCount counts turn-starts, sessionCount counts distinct sessions", () => {
    const rows = [
      row(D0, "/p/a", { sessionId: "s1", isTurnStart: 1 }),
      row(D0 + 3 * MIN, "/p/a", { sessionId: "s1", isTurnStart: 0 }),
      row(D0 + 6 * MIN, "/p/a", { sessionId: "s2", isTurnStart: 1 }),
    ];
    const g = computeEngagedHours(rows, baseOpts()).days[0]!.groups[0]!;
    expect(g.promptCount).toBe(2);
    expect(g.sessionCount).toBe(2);
  });

  it("a day with zero rows is flagged, not reported as 0.0 h of work [D-5]", () => {
    const days = [day("2026-09-01", D0), day("2026-09-02", D0 + DAY_MS)];
    const rows = [row(D0, "/p/a"), row(D0 + 5 * MIN, "/p/a")];
    const r = computeEngagedHours(rows, baseOpts({ days }));
    expect(r.coverage.daysWithNoData).toEqual(["2026-09-02"]);
  });

  it("attributedFraction is 0, not NaN, when there are no hours", () => {
    expect(computeEngagedHours([], baseOpts()).coverage.attributedFraction).toBe(0);
  });

  it("rejects an unusable cap instead of returning NaN hours [SEC-7]", () => {
    expect(() => computeEngagedHours([], baseOpts({ capMinutes: Number.NaN }))).toThrow(RangeError);
    expect(() => computeEngagedHours([], baseOpts({ capMinutes: 0 }))).toThrow(RangeError);
    expect(() => computeEngagedHours([], baseOpts({ capMinutes: -5 }))).toThrow(RangeError);
  });

  it("orders groups by hours desc then label, deterministically [M-5]", () => {
    const groups = [
      { label: "zzz", prefixes: ["/p/z"] },
      { label: "aaa", prefixes: ["/p/a"] },
    ];
    const rows = [
      row(D0, "/p/z"), row(D0 + 10 * MIN, "/p/z"),
      row(D0 + 20 * MIN, "/p/a"), row(D0 + 25 * MIN, "/p/a"),
    ];
    const r = computeEngagedHours(rows, baseOpts({ groups }));
    expect(r.days[0]!.groups.map((g) => g.label)).toEqual(["zzz", "aaa"]);
  });
});

describe("cross-group interaction is a property of the split rule, not a leak", () => {
  const groups = [{ label: "a", prefixes: ["/p/a"] }];
  const core = [row(D0, "/p/a"), row(D0 + 10 * MIN, "/p/a")];
  const withConcurrent = [
    ...core,
    row(D0 + 2 * MIN, "/p/other"),
    row(D0 + 4 * MIN, "/p/other"),
  ];

  it("under duplicate, a group's hours depend ONLY on its own rows", () => {
    const before = computeEngagedHours(core, baseOpts({ groups, split: "duplicate" }));
    const after = computeEngagedHours(withConcurrent, baseOpts({ groups, split: "duplicate" }));
    const pick = (r: ReturnType<typeof computeEngagedHours>) =>
      r.days[0]!.groups.find((g) => g.label === "a")!.hours;
    expect(pick(after)).toBeCloseTo(pick(before), 12);
  });

  it("under proportional, concurrent work REDISTRIBUTES contested time — by design", () => {
    // Not a leak: proportional is zero-sum over the day union, which is the
    // whole reason it reconciles. The consequence a reader must know is that a
    // group's figure can move when an UNRELATED project runs at the same time.
    const before = computeEngagedHours(core, baseOpts({ groups, split: "proportional" }));
    const after = computeEngagedHours(withConcurrent, baseOpts({ groups, split: "proportional" }));
    const aBefore = before.days[0]!.groups.find((g) => g.label === "a")!.hours;
    const aAfter = after.days[0]!.groups.find((g) => g.label === "a")!.hours;
    // 10 min, of which 2 min are now shared 50/50 => 9 min.
    expect(aBefore).toBeCloseTo(10 / 60, 9);
    expect(aAfter).toBeCloseTo(9 / 60, 9);
    // ...and nothing is lost: the redistributed minute went to (ungrouped).
    expect(after.coverage.reconciles).toBe(true);
    const sum = after.days[0]!.groups.reduce((t, g) => t + g.hours, 0);
    expect(sum).toBeCloseTo(after.days[0]!.dayUnionHours, 9);
  });
});
