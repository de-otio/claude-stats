/**
 * Engaged time — "how many hours was a human actually working on this project?"
 *
 * Pure module, functional-core style: timestamp rows in, hours out. No store,
 * no clock, no `Date.now()`, no `Intl`, no `os.homedir()`, no `process.env`,
 * no I/O. Same input, same output, always. Design: `plans/project-hours-
 * attribution/PLAN.md` §3; the corrections [C-n] and drift findings [D-n] it
 * records are named at the lines that implement them.
 *
 * Five things a reader should know before trusting a number from here:
 *
 *  1. **The timestamps are ASSISTANT RESPONSES, not "messages"** [D-1]. The
 *     `messages` table is populated from `type === "assistant"` transcript
 *     entries only — there is exactly one `messages.push` in the parser and it
 *     sits inside that branch. A human's read/think/type time before a day's
 *     first response is invisible here. That makes this a FLOOR on working
 *     time, and a lower one than "union of message timestamps" suggests.
 *  2. **It is a floor, never a ceiling, and never billable hours.** Time spent
 *     thinking with the terminal closed does not exist in this data. Time when
 *     an agent worked alone and nobody was at the keyboard DOES — read
 *     `promptCount` beside the hours to tell those apart.
 *  3. **A single-response day is 0.0 h** [C-2]. An interval needs a successor;
 *     one timestamp has none. That is correct for a floor metric and is an
 *     asserted test case, not an accident.
 *  4. **Per-group intervals are disjoint by construction** (see
 *     `buildIntervals`), which collapses the `proportional` weighting to an
 *     equal division among the groups active at that instant. Documented at
 *     `creditSegment` — the spec's per-message weights can only ever be 0 or 1.
 *  5. **`capMinutes` is a policy choice, not a measurement.** It bounds how
 *     much credit one silent gap earns. Changing it changes every figure; the
 *     caller echoes it beside the result for exactly that reason.
 */

/** One assistant-response timestamp, already narrowed and NOT NULL [C-6]. */
export interface TimestampRow {
  /** Epoch ms. Never null — the SQL filters `timestamp IS NOT NULL`. */
  readonly ts: number;
  /** Needed for `sessionCount`; the analysis's row shape omitted it [C-3]. */
  readonly sessionId: string;
  /** `sessions.project_path`; empty/missing lands in `(unknown)`. */
  readonly projectPath: string;
  /** `1` when this response answered a real human turn. */
  readonly isTurnStart: 0 | 1;
}

/** A declared bucket of project paths. */
export interface ProjectGroup {
  readonly label: string;
  /**
   * ALREADY `~`-expanded by the caller — core never sees a home-relative path
   * and never calls `os.homedir()`. Normalisation happens here so that the
   * prefix and the path are normalised the same way.
   */
  readonly prefixes: readonly string[];
}

/**
 * One local calendar day, computed by the caller [C-1]. Core takes boundaries
 * rather than a timezone string so that `Intl` stays out of `packages/core`
 * and property tests do not depend on the machine's zone.
 */
export interface DayBoundary {
  /** `YYYY-MM-DD`, local to the caller's timezone. */
  readonly date: string;
  readonly startMs: number;
  /** Exclusive. */
  readonly endMs: number;
}

export type SplitRule = "proportional" | "duplicate" | "exclusive";

export interface EngagedHoursOptions {
  readonly capMinutes: number;
  readonly split: SplitRule;
  readonly groups: readonly ProjectGroup[];
  readonly days: readonly DayBoundary[];
  /** Path comparison folds case on darwin/win32. Injected, never sniffed [SEC-5]. */
  readonly caseInsensitivePaths: boolean;
}

export interface EngagedHoursDayGroup {
  readonly label: string;
  readonly hours: number;
  /** Human turn-starts — the attended-vs-autonomous signal. */
  readonly promptCount: number;
  /** Scanned sessions contributing, subagents included [M-8]/[D-12]. */
  readonly sessionCount: number;
  /** What fed this group, for auditability. Absolute — the MCP boundary relativises [SEC-4]. */
  readonly projectPaths: readonly string[];
}

export interface EngagedHoursDay {
  readonly date: string;
  /** Ceiling for the day: engaged time across ALL groups, counted once. */
  readonly dayUnionHours: number;
  /** Contested time, measured BEFORE the split rule is applied. */
  readonly overlapHours: number;
  readonly groups: readonly EngagedHoursDayGroup[];
}

export interface EngagedHoursTotals {
  /** NOT the sum of per-group hours under `duplicate`. */
  readonly unionHours: number;
  readonly byGroup: readonly {
    readonly label: string;
    readonly hours: number;
    readonly promptCount: number;
  }[];
}

export interface EngagedHoursCoverage {
  readonly attributedHours: number;
  readonly ungroupedHours: number;
  /** 0..1; `0` when there are no hours at all rather than NaN. */
  readonly attributedFraction: number;
  /** COMPUTED, never inferred from the split rule [C-4]. */
  readonly reconciles: boolean;
  /**
   * Days inside the window with zero rows [D-5]. "No work" and "no surviving
   * transcript" are different claims and this field refuses to merge them —
   * it flags the ambiguity, it does not resolve it (that needs the sidecar
   * aggregate, deliberately out of scope [D-6]).
   *
   * "Zero ROWS", not "zero hours": a gap straddling local midnight is credited
   * to both days, so a flagged day can still report a sliver carried in from
   * the previous day's last response. That sliver is bounded by `capMinutes`
   * and carries no prompts and no sessions. Renderers should therefore say
   * "no recorded activity" rather than "no time".
   */
  readonly daysWithNoData: readonly string[];
}

export interface EngagedHours {
  readonly days: readonly EngagedHoursDay[];
  readonly totals: EngagedHoursTotals;
  readonly coverage: EngagedHoursCoverage;
}

/** Matched no declared prefix. Always rendered — silence would hide work. */
export const UNGROUPED_LABEL = "(ungrouped)";
/** Session carried no `project_path`. */
export const UNKNOWN_LABEL = "(unknown)";
/** Config may not claim these; a group named `(ungrouped)` could hide the
 *  unattributed slice by absorbing it. Enforced by the config validator [SEC-1]. */
export const RESERVED_GROUP_LABELS: readonly string[] = [UNGROUPED_LABEL, UNKNOWN_LABEL];

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
/** Float tolerance for the reconciliation assertion [M-4]. */
export const RECONCILE_EPSILON = 1e-6;

interface Interval {
  readonly start: number;
  readonly end: number;
}

/**
 * Platform-independent path normalisation.
 *
 * Deliberately NOT `path.normalize` (which the plan's §3.3 named): that helper
 * is platform-dependent — on posix a Windows path keeps its backslashes and
 * would never segment-match — which would make this module's behaviour, and
 * its property tests, depend on the host OS. That is the same objection [C-1]
 * raised against taking a timezone string. Both separators are treated as
 * separators on every platform; the cost is a posix directory whose NAME
 * contains a backslash, which is not a real path in this data set.
 */
export function normalizePathForMatch(raw: string, caseInsensitive: boolean): string {
  const isAbsolute = /^[\\/]/.test(raw);
  const parts: string[] = [];
  for (const seg of raw.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const joined = (isAbsolute ? "/" : "") + parts.join("/");
  return caseInsensitive ? joined.toLowerCase() : joined;
}

/**
 * Segment-anchored prefix match [SEC-5].
 *
 * A bare `startsWith` files `~/repos/foobar` under the `~/repos/foo` group —
 * silently mis-attributing one client's work to another. Both arguments must
 * already be normalised by `normalizePathForMatch` with the same folding.
 */
export function matchesPrefix(normPath: string, normPrefix: string): boolean {
  if (normPrefix === "") return false;
  if (normPath === normPrefix) return true;
  const boundary = normPrefix.endsWith("/") ? normPrefix : normPrefix + "/";
  return normPath.startsWith(boundary);
}

interface CompiledPrefix {
  readonly label: string;
  readonly normPrefix: string;
}

/** Longest prefix wins; ties broken by label so the result is deterministic [M-5]. */
function compilePrefixes(
  groups: readonly ProjectGroup[],
  caseInsensitive: boolean,
): CompiledPrefix[] {
  const compiled: CompiledPrefix[] = [];
  for (const g of groups) {
    for (const p of g.prefixes) {
      const normPrefix = normalizePathForMatch(p, caseInsensitive);
      if (normPrefix === "") continue;
      compiled.push({ label: g.label, normPrefix });
    }
  }
  compiled.sort((a, b) =>
    b.normPrefix.length - a.normPrefix.length ||
    (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
  return compiled;
}

/**
 * Adjacent timestamps contribute ONE half-open interval each [C-2]:
 *
 *     interval(tᵢ, tᵢ₊₁) = [tᵢ, tᵢ + min(tᵢ₊₁ − tᵢ, capMs))
 *
 * Because `min(gap, cap) ≤ gap`, interval `i` ends at or before `tᵢ₊₁`, where
 * interval `i+1` begins: **a group's intervals are disjoint and sorted**. Two
 * consequences the rest of this module leans on — the sweep never needs to
 * merge overlaps within a group, and a group's per-instant "weight" can only
 * be 0 or 1 (see `creditSegment`).
 *
 * Duplicate timestamps are collapsed first, which is what makes the whole
 * computation idempotent under replayed rows [D-9] — resumes and compaction
 * replay earlier turns verbatim, and the metric must not care.
 */
function buildIntervals(sortedUniqueTs: readonly number[], capMs: number): Interval[] {
  const out: Interval[] = [];
  for (let i = 0; i + 1 < sortedUniqueTs.length; i++) {
    const start = sortedUniqueTs[i]!;
    const gap = sortedUniqueTs[i + 1]! - start;
    const len = gap < capMs ? gap : capMs;
    if (len > 0) out.push({ start, end: start + len });
  }
  return out;
}

/** Index of the first day whose `endMs` is strictly greater than `ms`. */
function firstDayAfter(days: readonly DayBoundary[], ms: number): number {
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid]!.endMs > ms) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

interface DayGroupAccumulator {
  hoursMs: number;
  promptCount: number;
  readonly sessions: Set<string>;
  readonly paths: Set<string>;
  rowCount: number;
}

function emptyAccumulator(): DayGroupAccumulator {
  return { hoursMs: 0, promptCount: 0, sessions: new Set(), paths: new Set(), rowCount: 0 };
}

interface ActiveGroup {
  count: number;
  /** Start of the currently-covering interval — the `exclusive` tiebreak. */
  start: number;
}

/**
 * Credit one atomic segment, over which the active group set is constant.
 *
 * `proportional` is an EQUAL division, not a weighted one. The spec defines the
 * weight as "the number of the group's messages that generated an interval
 * covering this segment", but `buildIntervals` proves a group's intervals are
 * disjoint, so that count is always exactly 1 for an active group and 0 for an
 * inactive one. Equal division is therefore the weighted division, not an
 * approximation of it — and it is what makes per-group hours reconcile to the
 * day union [C-4].
 */
function creditSegment(
  lenMs: number,
  active: ReadonlyMap<string, ActiveGroup>,
  split: SplitRule,
  credit: (label: string, ms: number) => void,
): void {
  if (split === "duplicate") {
    for (const label of active.keys()) credit(label, lenMs);
    return;
  }
  if (split === "exclusive") {
    let winner: string | null = null;
    let winnerStart = Number.POSITIVE_INFINITY;
    for (const [label, g] of active) {
      if (g.start < winnerStart || (g.start === winnerStart && winner !== null && label < winner)) {
        winner = label;
        winnerStart = g.start;
      }
    }
    if (winner !== null) credit(winner, lenMs);
    return;
  }
  const share = lenMs / active.size;
  for (const label of active.keys()) credit(label, share);
}

/**
 * Engaged hours per group per local day.
 *
 * Throws `RangeError` on an unusable `capMinutes` rather than propagating NaN
 * into an hours figure — a NaN that renders as a number is precisely the
 * "confidently wrong" failure this tool exists to avoid. Callers validate at
 * the boundary and turn this into a clean error message [SEC-7]/[SEC-8].
 */
export function computeEngagedHours(
  rows: readonly TimestampRow[],
  opts: EngagedHoursOptions,
): EngagedHours {
  if (!Number.isFinite(opts.capMinutes) || opts.capMinutes <= 0) {
    throw new RangeError(
      `capMinutes must be a positive finite number, got ${String(opts.capMinutes)}`,
    );
  }
  const capMs = opts.capMinutes * MS_PER_MINUTE;
  const days = [...opts.days].sort((a, b) => a.startMs - b.startMs);
  const autoGroup = opts.groups.length === 0;
  const compiled = autoGroup ? [] : compilePrefixes(opts.groups, opts.caseInsensitivePaths);

  // ---- 1. label every row -------------------------------------------------
  const labelCache = new Map<string, string>();
  const labelFor = (projectPath: string): string => {
    if (projectPath === "") return UNKNOWN_LABEL;
    const cached = labelCache.get(projectPath);
    if (cached !== undefined) return cached;
    // No configured groups: every distinct project is its own group, which is
    // the useful default before `projectGroups` has been set up.
    let label = autoGroup ? projectPath : UNGROUPED_LABEL;
    if (!autoGroup) {
      const norm = normalizePathForMatch(projectPath, opts.caseInsensitivePaths);
      for (const c of compiled) {
        if (matchesPrefix(norm, c.normPrefix)) {
          label = c.label;
          break;
        }
      }
    }
    labelCache.set(projectPath, label);
    return label;
  };

  const tsByLabel = new Map<string, number[]>();
  // dayIndex -> label -> accumulator
  const perDay: Map<string, DayGroupAccumulator>[] = days.map(() => new Map());
  const rowsPerDay: number[] = days.map(() => 0);

  for (const row of rows) {
    if (!Number.isFinite(row.ts)) continue;
    const label = labelFor(row.projectPath);
    let bucket = tsByLabel.get(label);
    if (bucket === undefined) {
      bucket = [];
      tsByLabel.set(label, bucket);
    }
    bucket.push(row.ts);

    const di = firstDayAfter(days, row.ts);
    const day = days[di];
    if (day === undefined || row.ts < day.startMs) continue; // outside every day
    rowsPerDay[di]! += 1;
    const dayMap = perDay[di]!;
    let acc = dayMap.get(label);
    if (acc === undefined) {
      acc = emptyAccumulator();
      dayMap.set(label, acc);
    }
    acc.rowCount += 1;
    acc.promptCount += row.isTurnStart === 1 ? 1 : 0;
    acc.sessions.add(row.sessionId);
    if (row.projectPath !== "") acc.paths.add(row.projectPath);
  }

  // ---- 2. per-group intervals, then clip into days ------------------------
  // Events per day, bucketed via binary search so a 366-day window does not
  // cost O(days × intervals) [SEC-6].
  interface Ev { pos: number; delta: number; label: string; start: number }
  const eventsPerDay: Ev[][] = days.map(() => []);

  for (const [label, tsList] of tsByLabel) {
    tsList.sort((a, b) => a - b);
    const unique: number[] = [];
    for (const t of tsList) {
      if (unique.length === 0 || unique[unique.length - 1] !== t) unique.push(t);
    }
    for (const iv of buildIntervals(unique, capMs)) {
      for (let di = firstDayAfter(days, iv.start); di < days.length; di++) {
        const day = days[di]!;
        if (day.startMs >= iv.end) break;
        const start = iv.start > day.startMs ? iv.start : day.startMs;
        const end = iv.end < day.endMs ? iv.end : day.endMs;
        if (end <= start) continue;
        // A gap straddling local midnight is split at the boundary and credited
        // to both days — the analysis's midnight case.
        eventsPerDay[di]!.push({ pos: start, delta: 1, label, start });
        eventsPerDay[di]!.push({ pos: end, delta: -1, label, start });
      }
    }
  }

  // ---- 3. sweep each day --------------------------------------------------
  const dayResults: EngagedHoursDay[] = [];
  const daysWithNoData: string[] = [];
  let unionMsTotal = 0;

  for (let di = 0; di < days.length; di++) {
    const day = days[di]!;
    if (rowsPerDay[di] === 0) daysWithNoData.push(day.date);

    const dayMap = perDay[di]!;
    const events = eventsPerDay[di]!;
    events.sort((a, b) => a.pos - b.pos);

    const active = new Map<string, ActiveGroup>();
    const creditTo = (label: string, ms: number): void => {
      let acc = dayMap.get(label);
      if (acc === undefined) {
        acc = emptyAccumulator();
        dayMap.set(label, acc);
      }
      acc.hoursMs += ms;
    };

    let unionMs = 0;
    let overlapMs = 0;
    let cursor: number | null = null;
    let i = 0;
    while (i < events.length) {
      const pos = events[i]!.pos;
      if (cursor !== null && active.size > 0 && pos > cursor) {
        const len = pos - cursor;
        unionMs += len;
        if (active.size > 1) overlapMs += len;
        creditSegment(len, active, opts.split, creditTo);
      }
      // Apply every event at this position before measuring the next segment;
      // intervals are half-open, so an end at `pos` is already inactive there.
      while (i < events.length && events[i]!.pos === pos) {
        const ev = events[i]!;
        const cur = active.get(ev.label);
        if (ev.delta === 1) {
          if (cur === undefined) active.set(ev.label, { count: 1, start: ev.start });
          else cur.count += 1;
        } else if (cur !== undefined) {
          cur.count -= 1;
          if (cur.count <= 0) active.delete(ev.label);
        }
        i++;
      }
      cursor = pos;
    }

    unionMsTotal += unionMs;

    const groups: EngagedHoursDayGroup[] = [];
    for (const [label, acc] of dayMap) {
      if (acc.rowCount === 0 && acc.hoursMs === 0) continue;
      groups.push({
        label,
        hours: acc.hoursMs / MS_PER_HOUR,
        promptCount: acc.promptCount,
        sessionCount: acc.sessions.size,
        projectPaths: [...acc.paths].sort(),
      });
    }
    // Stable order: hours desc, then label. Purity does not imply order [M-5].
    groups.sort((a, b) => b.hours - a.hours || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

    dayResults.push({
      date: day.date,
      dayUnionHours: unionMs / MS_PER_HOUR,
      overlapHours: overlapMs / MS_PER_HOUR,
      groups,
    });
  }

  // ---- 4. totals and coverage --------------------------------------------
  const totalsByLabel = new Map<string, { hours: number; promptCount: number }>();
  for (const day of dayResults) {
    for (const g of day.groups) {
      const t = totalsByLabel.get(g.label) ?? { hours: 0, promptCount: 0 };
      t.hours += g.hours;
      t.promptCount += g.promptCount;
      totalsByLabel.set(g.label, t);
    }
  }
  const byGroup = [...totalsByLabel.entries()]
    .map(([label, t]) => ({ label, hours: t.hours, promptCount: t.promptCount }))
    .sort((a, b) => b.hours - a.hours || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  const unionHours = unionMsTotal / MS_PER_HOUR;
  let attributedHours = 0;
  let ungroupedHours = 0;
  for (const g of byGroup) {
    if (g.label === UNGROUPED_LABEL || g.label === UNKNOWN_LABEL) ungroupedHours += g.hours;
    else attributedHours += g.hours;
  }
  const denom = attributedHours + ungroupedHours;
  const sumOfGroups = byGroup.reduce((s, g) => s + g.hours, 0);

  return {
    days: dayResults,
    totals: { unionHours, byGroup },
    coverage: {
      attributedHours,
      ungroupedHours,
      attributedFraction: denom > 0 ? attributedHours / denom : 0,
      reconciles: Math.abs(sumOfGroups - unionHours) <= RECONCILE_EPSILON,
      daysWithNoData,
    },
  };
}
