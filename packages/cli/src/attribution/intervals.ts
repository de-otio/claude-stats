/**
 * CLI observation intervals (Phase 2 A) — PURE.
 *
 * Builds a disjoint, time-sorted timeline of which account was active on a CLI
 * surface over time, from the append-only `account_observations` log. Each
 * interval `[start, end)` means "account `accountUuid` was the active CLI
 * account from `start` (inclusive) until `end` (exclusive)". The final
 * interval's `end` is `Infinity` (still active).
 *
 * Only CLI-surface observations are considered (the caller is expected to pass
 * observations already filtered to CLI surfaces, but we defensively filter on
 * `surface ∈ CLI_SURFACES` here too so the function is correct for any input).
 *
 * No clock, no I/O — observations in, intervals out.
 */
import { CLI_SURFACES } from "@claude-stats/core/types";
import type { AccountObservation } from "@claude-stats/core/types";

export interface AccountInterval {
  /** Inclusive start (epoch-ms). */
  start: number;
  /** Exclusive end (epoch-ms); `Infinity` for the still-open final interval. */
  end: number;
  accountUuid: string;
}

const CLI_SURFACE_SET = new Set<string>(CLI_SURFACES);

/** True when an observation's surface is one of the CLI surfaces. */
function isCliSurface(surface: string | null): boolean {
  return surface !== null && CLI_SURFACE_SET.has(surface);
}

/**
 * Build disjoint, contiguous intervals from CLI-surface observations.
 *
 * - Observations are sorted by `observedAt` ascending (ties broken by
 *   `accountUuid` for determinism).
 * - Consecutive observations of the SAME account are deduped (collapsed into
 *   one interval) — an account stays active until a DIFFERENT account is
 *   observed.
 * - Each interval ends exactly where the next begins (the boundary is the
 *   `observedAt` of the next account switch), so the timeline is gap-free from
 *   the first observation onward.
 * - The final interval's `end` is `Infinity`.
 *
 * Returns `[]` when there are no CLI-surface observations.
 */
export function buildCliIntervals(obs: AccountObservation[]): AccountInterval[] {
  const cli = obs
    .filter((o) => isCliSurface(o.surface))
    .slice()
    .sort((a, b) => {
      if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
      return a.accountUuid < b.accountUuid ? -1 : a.accountUuid > b.accountUuid ? 1 : 0;
    });

  if (cli.length === 0) return [];

  // Dedupe consecutive same-account observations into switch points.
  const switches: Array<{ at: number; accountUuid: string }> = [];
  for (const o of cli) {
    const last = switches[switches.length - 1];
    if (!last || last.accountUuid !== o.accountUuid) {
      switches.push({ at: o.observedAt, accountUuid: o.accountUuid });
    }
    // same account as previous switch → no new interval boundary
  }

  const intervals: AccountInterval[] = [];
  for (let i = 0; i < switches.length; i++) {
    const cur = switches[i]!;
    const next = switches[i + 1];
    intervals.push({
      start: cur.at,
      end: next ? next.at : Infinity,
      accountUuid: cur.accountUuid,
    });
  }
  return intervals;
}

/**
 * Find the interval covering timestamp `ts` (`start <= ts < end`). Returns
 * `null` when `ts` precedes the first interval or no interval matches.
 * Intervals are assumed disjoint + sorted (as produced by buildCliIntervals).
 */
export function intervalAt(
  intervals: AccountInterval[],
  ts: number,
): AccountInterval | null {
  for (const iv of intervals) {
    if (ts >= iv.start && ts < iv.end) return iv;
  }
  return null;
}
