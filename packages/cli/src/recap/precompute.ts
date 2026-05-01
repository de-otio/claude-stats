/**
 * Background pre-computation for the daily-recap cache (v3.05).
 *
 * Walks a lookback window (default 7 days: yesterday + 6 prior days) and
 * builds the daily digest for any date that is not already in the cache.
 * Cache-hit dates are skipped.  Errors on individual dates are caught and
 * logged as a single-line warning (no sensitive content) — `precomputeDigests`
 * never throws.
 */
import type { Store } from '../store/index.js';
import { buildDailyDigest } from './index.js';
import { computeSnapshotHash, createFileCache } from './cache.js';
import type { CacheClient, SnapshotHashInputs } from './cache.js';
import { getLastCommitSha } from './git.js';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PrecomputeOptions {
  /** Days to walk backwards from yesterday (default 7). */
  lookbackDays?: number;
  /** Override target date (YYYY-MM-DD); builds only that single date. */
  date?: string;
  /** IANA timezone (overrides system TZ). */
  tz?: string;
}

export interface PrecomputeResult {
  precomputed: number;
  skipped: number;
  failures: number;
}

// ─── Deps injection (for tests) ────────────────────────────────────────────

export interface PrecomputeDeps {
  cache?: CacheClient;
  now?: () => number;
  intlTz?: () => string;
}

// ─── Implementation ────────────────────────────────────────────────────────

/**
 * Pre-compute daily digests for the lookback window.
 *
 * For each date:
 * 1. Build snapshot-hash inputs.
 * 2. If cache.read(hash) returns a hit → increment `skipped`.
 * 3. Otherwise run buildDailyDigest for that date → increment `precomputed`.
 * 4. On error: log a single warning line → increment `failures`. Never throw.
 */
export async function precomputeDigests(
  store: Store,
  opts?: PrecomputeOptions,
  deps?: PrecomputeDeps,
): Promise<PrecomputeResult> {
  const result: PrecomputeResult = { precomputed: 0, skipped: 0, failures: 0 };

  // Resolve TZ
  const intlTz = deps?.intlTz ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const tz = opts?.tz ?? intlTz();

  const nowMs = (deps?.now ?? (() => Date.now()))();
  const cacheClient = deps?.cache ?? createFileCache();

  // Build the list of dates to process
  let dates: string[];

  if (opts?.date) {
    dates = [opts.date];
  } else {
    const lookbackDays = opts?.lookbackDays ?? 7;
    dates = buildDateWindow(nowMs, tz, lookbackDays);
  }

  for (const date of dates) {
    try {
      // Build snapshot hash inputs to check cache
      const hashInputs = await buildHashInputs(store, date, tz);
      const hash = computeSnapshotHash(hashInputs);

      const cached = cacheClient.read(hash);
      if (cached !== null) {
        result.skipped++;
        continue;
      }

      // Build the digest (this writes to cache internally)
      await buildDailyDigest(store, { date, tz }, { cache: cacheClient, intlTz: () => tz });
      result.precomputed++;
    } catch (err) {
      // Log a single safe warning line — no sensitive content (SR rules)
      const msg = err instanceof Error ? err.message.slice(0, 80) : 'unknown error';
      console.warn(`recap precompute: failed for ${date}: ${msg}`);
      result.failures++;
    }
  }

  return result;
}

// ─── Date window helpers ────────────────────────────────────────────────────

/**
 * Build a list of YYYY-MM-DD strings from (today - lookbackDays) through
 * yesterday, inclusive, all in the given timezone.
 */
function buildDateWindow(nowMs: number, tz: string, lookbackDays: number): string[] {
  const dates: string[] = [];

  // Compute "today" in the TZ
  const todayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(nowMs);

  // Walk from (today - lookbackDays) through yesterday
  for (let offset = lookbackDays; offset >= 1; offset--) {
    const ms = nowMs - offset * 24 * 3600 * 1000;
    const dateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(ms);
    // Avoid including "today" — only go up to yesterday
    if (dateStr !== todayStr) {
      dates.push(dateStr);
    }
  }

  // Deduplicate (DST transitions can cause duplicates at boundaries)
  return [...new Set(dates)];
}

/**
 * Build SnapshotHashInputs for the given date.
 * Mirrors the logic in buildDailyDigest (index.ts) so we can check the
 * cache without running the full digest builder.
 */
async function buildHashInputs(
  store: Store,
  date: string,
  tz: string,
): Promise<SnapshotHashInputs> {
  const { startMs, endMs } = dayWindowInTz(date, tz);

  const sessions = store.getSessions({
    since: startMs,
    until: endMs,
    includeCI: false,
    includeDeleted: false,
  });

  // Build sorted unique project paths
  const projectPathSet = new Set<string>();
  for (const s of sessions) {
    projectPathSet.add(s.project_path);
  }
  const sortedProjectPaths = [...projectPathSet].sort();

  // maxMessageUuid
  let maxMessageUuid: string | null = null;
  for (const session of sessions) {
    const msgs = store.getSessionMessages(session.session_id);
    for (const msg of msgs) {
      if (
        msg.timestamp !== null &&
        msg.timestamp >= startMs &&
        msg.timestamp < endMs
      ) {
        if (maxMessageUuid === null || msg.uuid > maxMessageUuid) {
          maxMessageUuid = msg.uuid;
        }
      }
    }
  }

  // Per-project last commit SHA
  const perProjectLastCommit: Record<string, string | null> = {};
  for (const p of sortedProjectPaths) {
    try {
      perProjectLastCommit[p] = getLastCommitSha(p);
    } catch {
      perProjectLastCommit[p] = null;
    }
  }

  return {
    date,
    tz,
    sortedProjectPaths,
    maxMessageUuid,
    perProjectLastCommit,
  };
}

// ─── Day-boundary helper (mirrors index.ts) ─────────────────────────────────

function localMidnightToEpochMs(year: number, month: number, day: number, tz: string): number {
  const candidate = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  let result = candidate;
  for (let i = 0; i < 2; i++) {
    const parts = fmt.formatToParts(result);
    const get = (type: string): number =>
      parseInt(parts.find((p) => p.type === type)!.value, 10);

    const localYear = get('year');
    const localMonth = get('month');
    const localDay = get('day');
    const localHour = get('hour');
    const localMinute = get('minute');
    const localSecond = get('second');

    const offsetFromMidnight =
      ((localHour === 24 ? 0 : localHour) * 3600 + localMinute * 60 + localSecond) * 1000 +
      ((localYear - year) * 365 + (localMonth - month) * 30 + (localDay - day)) * 86_400_000;

    result = result - offsetFromMidnight;
  }
  return result;
}

function dayWindowInTz(dateYmd: string, tz: string): { startMs: number; endMs: number } {
  const [yearStr, monthStr, dayStr] = dateYmd.split('-');
  const year = parseInt(yearStr!, 10);
  const month = parseInt(monthStr!, 10);
  const day = parseInt(dayStr!, 10);

  const startMs = localMidnightToEpochMs(year, month, day, tz);
  const endMs = localMidnightToEpochMs(year, month, day + 1, tz);
  return { startMs, endMs };
}
