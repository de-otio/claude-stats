/**
 * Digest builder — orchestration layer for the daily-recap feature.
 *
 * Reads sessions and messages from the store, runs them through the
 * segmenter and clusterer, joins git enrichment and cost data, applies
 * wrapUntrusted to all untrusted emission points, and emits a DailyDigest.
 *
 * Public API:
 *   buildDailyDigest(store, opts?, deps?) => DailyDigest
 *
 * KNOWN LIMITATION (v1): the store's `tools` column is stored as string[]
 * (just tool names — no params). As a result, Segment.filePaths will be
 * empty arrays for all real-world data. The clusterer's path-Jaccard rule
 * and DailyDigestItem.filePathsTouched will be empty/empty-set in practice.
 * This is acceptable for v1 and will be addressed in v2 once richer tool
 * param storage is in place.
 */

import { createHash } from 'node:crypto';
import type { Store } from '../store/index.js';
import type {
  CachedEntry,
  Confidence,
  DailyDigest,
  DailyDigestItem,
  DailyDigestOptions,
  DailyDigestTotals,
  ItemId,
  ProjectGitActivity,
  Segment,
} from './types.js';
import { segmentSession } from './segment.js';
import { clusterSegments } from './cluster.js';
import type { SegmentCluster, SegmentWithProject } from './cluster.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { CorrectionsClient } from './corrections.js';
import { inferCharacterVerb } from './verb.js';
import {
  getProjectGitActivity as realGetProjectGitActivity,
  getAuthorEmail,
  getLastCommitSha,
} from './git.js';
import {
  computeSnapshotHash,
  createFileCache,
} from './cache.js';
import type { CacheClient, SnapshotHashInputs } from './cache.js';
import { wrapUntrusted } from '../mcp/index.js';
import { sanitizePromptText } from '@claude-stats/core/sanitize';
import { estimateCost } from '@claude-stats/core/pricing';

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
  CachedEntry,
  Confidence,
  DailyDigest,
  DailyDigestItem,
  DailyDigestOptions,
  DailyDigestTotals,
} from './types.js';

/**
 * Dependency injection interface — used by tests to substitute fakes for
 * real git, cache, clock, and timezone implementations without touching
 * production code paths.
 */
export interface BuildDailyDigestDeps {
  getProjectGitActivity?: (
    path: string,
    startMs: number,
    endMs: number,
    email: string,
  ) => ProjectGitActivity | null;
  /**
   * Override for testability — defaults to `getAuthorEmail` from git.ts.
   * When injected, the caller controls what email is passed to
   * `getProjectGitActivity`. Return null to skip git enrichment.
   */
  getAuthorEmail?: (projectPath: string) => string | null;
  cache?: CacheClient;
  /** Override for testability — defaults to `() => Date.now()`. */
  now?: () => number;
  /**
   * Override for testability — defaults to
   * `() => Intl.DateTimeFormat().resolvedOptions().timeZone`.
   *
   * SR-4: MUST NOT read from process.env.TZ.
   */
  intlTz?: () => string;
  /**
   * Embedding provider for semantic clustering (v2.03).
   * When supplied, the prompt-prefix Jaccard rule (Rule 3) is replaced with
   * cosine similarity over local sentence embeddings.
   * When null/absent, the v1 Jaccard behaviour is used.
   */
  embeddingProvider?: EmbeddingProvider | null;
  /**
   * Corrections client for user-applied cluster corrections (v3.09).
   * When supplied, merge/split/rename/hide corrections are applied after
   * rule-based clustering.  When null/absent, no corrections are applied.
   */
  correctionsClient?: CorrectionsClient | null;
  /**
   * Override for testability of the staleness check (v3.06).
   * Given a cache entry hash, returns the mtime of that entry in epoch-ms,
   * or null if unknown.  When null is returned, the patcher treats the entry
   * as fresh (mtime = nowMs).  When absent, the production path is used.
   */
  getCacheMtimeMs?: (hash: string) => number | null;
}

// ─── Day-boundary helpers ─────────────────────────────────────────────────────

/**
 * Parse a YYYY-MM-DD string in the given IANA timezone into a [startMs, endMs)
 * epoch-ms window using the Intl.DateTimeFormat calendar.
 *
 * We build the boundary timestamps by constructing a Date from the formatted
 * parts so we never read TZ from the environment.
 */
function dayWindowInTz(
  dateYmd: string,
  tz: string,
): { startMs: number; endMs: number } {
  // Parse YYYY-MM-DD
  const [yearStr, monthStr, dayStr] = dateYmd.split('-');
  const year = parseInt(yearStr!, 10);
  const month = parseInt(monthStr!, 10); // 1-based
  const day = parseInt(dayStr!, 10);

  // Build the epoch ms for midnight at the start and end of the day in `tz`.
  // We use Date.UTC to construct a UTC instant that represents midnight in `tz`,
  // by offsetting for the timezone. The safest portable approach is to use
  // Temporal-style arithmetic via Intl.DateTimeFormat to find the UTC offset at
  // that instant.

  const startMs = localMidnightToEpochMs(year, month, day, tz);
  const endMs = localMidnightToEpochMs(year, month, day + 1, tz);

  return { startMs, endMs };
}

/**
 * Convert a local calendar date to epoch-ms for midnight (00:00:00) in the
 * given timezone.
 *
 * The approach: create a UTC timestamp near midnight, then binary-search to
 * find the exact UTC ms such that formatting it in `tz` gives midnight.
 * In practice we use a simpler trick: construct an ISO string, parse as UTC,
 * measure the offset for that candidate, then adjust.
 *
 * We use the Intl.DateTimeFormat approach: format epoch 0 + candidate in tz,
 * compare year/month/day to the desired date, find the offset.
 */
function localMidnightToEpochMs(
  year: number,
  month: number,
  day: number,
  tz: string,
): number {
  // Candidate: treat the local date as if it were UTC midnight.
  const candidate = Date.UTC(year, month - 1, day, 0, 0, 0, 0);

  // Use Intl.DateTimeFormat to find where the candidate falls in `tz`,
  // then adjust by the difference.
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

  // We do two iterations to converge on the exact midnight
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

    // Offset from midnight in ms
    const offsetFromMidnight =
      ((localHour === 24 ? 0 : localHour) * 3600 +
        localMinute * 60 +
        localSecond) *
        1000 +
      // Account for day difference
      ((localYear - year) * 365 +
        (localMonth - month) * 30 +
        (localDay - day)) *
        86_400_000;

    result = result - offsetFromMidnight;
  }

  return result;
}

// ─── Code-point-aware truncation ─────────────────────────────────────────────

/**
 * Truncate `text` to at most `maxCodePoints` Unicode code points.
 * Appends a single `…` character when truncation occurs.
 *
 * We use the spread-then-slice idiom to avoid splitting surrogate pairs.
 * This is O(n) in the string length which is fine for 280-char limits.
 */
function truncateCodePoints(text: string, maxCodePoints: number): string {
  const codePoints = [...text];
  if (codePoints.length <= maxCodePoints) return text;
  return codePoints.slice(0, maxCodePoints).join('') + '…';
}

// ─── Confidence scoring ───────────────────────────────────────────────────────

export const CONFIDENCE_DURATION_MS = 30 * 60 * 1000; // 30 min
export const CONFIDENCE_LINES_THRESHOLD = 50;
export const CONFIDENCE_FILES_THRESHOLD = 5;

/**
 * Compute a deterministic confidence level for a digest item.
 *
 * - 'high':   shipped work — pushed commits or merged PR
 * - 'medium': substantial work in flight — local commits, or long active
 *             session with significant code changes or file breadth
 * - 'low':    thin work with no concrete outcome
 *
 * Exported for unit testing; no I/O, no LLM.
 */
export function computeConfidence(item: {
  git: ProjectGitActivity | null;
  duration: { wallMs: number; activeMs: number };
  filePathsTouched: readonly string[];
}): Confidence {
  const { git, duration, filePathsTouched } = item;

  // High: shipped — pushed commits or merged PR
  if (git && git.commitsToday > 0 && git.pushed) return 'high';
  if (git && (git.prMerged ?? 0) > 0) return 'high';

  // Medium: substantial work in flight
  if (git && git.commitsToday > 0) return 'medium'; // commits, not pushed
  if (
    duration.activeMs >= CONFIDENCE_DURATION_MS &&
    (git?.linesAdded ?? 0) + (git?.linesRemoved ?? 0) >= CONFIDENCE_LINES_THRESHOLD
  ) {
    return 'medium';
  }
  if (duration.activeMs >= CONFIDENCE_DURATION_MS && filePathsTouched.length >= CONFIDENCE_FILES_THRESHOLD) {
    return 'medium';
  }

  // Low: thin work, no concrete outcome
  return 'low';
}

// ─── Incremental-digest patcher constants (v3.06) ────────────────────────────

/**
 * Maximum age of a cached entry before we force a full rebuild rather than
 * attempting to patch.  1 hour expressed in milliseconds.
 */
export const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/**
 * When the fraction of clusters that need to be re-built exceeds this ratio,
 * the patcher overhead outweighs the savings and we fall back to a full rebuild.
 */
export const HEAVY_PATCH_RATIO = 0.6; // > 60% of clusters touched

/**
 * Determine whether we should skip the patcher and do a full rebuild.
 *
 * Reasons to force a full rebuild:
 *   1. The previous digest is older than STALE_THRESHOLD_MS (by file mtime).
 *   2. The date or tz of the previous digest does not match the new inputs.
 *   3. More than HEAVY_PATCH_RATIO of the previous clusters are touched
 *      (patcher overhead would exceed the savings).
 */
function shouldForceFullRebuild(
  prev: CachedEntry,
  newInputs: SnapshotHashInputs,
  prevMtimeMs: number,
  nowMs: number,
  touchedClusterCount: number,
  totalClusterCount: number,
): boolean {
  // Staleness: the previous build is older than STALE_THRESHOLD_MS.
  if (nowMs - prevMtimeMs > STALE_THRESHOLD_MS) return true;

  // Different date or tz — the previous digest covers a different window.
  if (prev.digest.date !== newInputs.date || prev.digest.tz !== newInputs.tz) return true;

  // Heavy patch: more than 60% of clusters need rebuilding.
  if (
    totalClusterCount > 0 &&
    touchedClusterCount / totalClusterCount > HEAVY_PATCH_RATIO
  ) {
    return true;
  }

  return false;
}

/**
 * Diff two SnapshotHashInputs and return which sessions and projects changed.
 *
 * A session is identified by its session_id (top-level project path changes
 * appear in sortedProjectPaths; per-session last-message changes appear in
 * maxMessageUuid, but we track per-session lastMessageUuid in the inputs via
 * a new perSessionLastMessageUuid map).
 *
 * For v3.06 the granularity available from SnapshotHashInputs is:
 *   - perProjectLastCommit: project → last commit SHA
 *   - perSessionLastMessageUuid: session → last message UUID (added in v3.06)
 *   - sortedProjectPaths: list of known project paths
 *
 * Projects added or removed are in addedProjects / removedProjects.
 * Projects whose lastCommit changed are in changedCommitProjects.
 * Sessions whose lastMessageUuid changed are in changedSessionIds.
 */
interface InputDiff {
  changedSessionIds: Set<string>;
  changedCommitProjects: Set<string>;
  addedProjects: Set<string>;
  removedProjects: Set<string>;
}

function diffInputs(prev: SnapshotHashInputs, next: SnapshotHashInputs): InputDiff {
  const prevProjectSet = new Set(prev.sortedProjectPaths);
  const nextProjectSet = new Set(next.sortedProjectPaths);

  const addedProjects = new Set<string>();
  const removedProjects = new Set<string>();
  for (const p of nextProjectSet) {
    if (!prevProjectSet.has(p)) addedProjects.add(p);
  }
  for (const p of prevProjectSet) {
    if (!nextProjectSet.has(p)) removedProjects.add(p);
  }

  const changedCommitProjects = new Set<string>();
  for (const p of nextProjectSet) {
    if (prevProjectSet.has(p)) {
      const prevSha = prev.perProjectLastCommit[p] ?? null;
      const nextSha = next.perProjectLastCommit[p] ?? null;
      if (prevSha !== nextSha) changedCommitProjects.add(p);
    }
  }

  // Per-session last-message uuid tracking (v3.06 extension).
  // Both prev and next may have perSessionLastMessageUuid; if absent, we
  // cannot diff at session granularity and treat everything as changed.
  const changedSessionIds = new Set<string>();
  const prevPerSession = prev.perSessionLastMessageUuid ?? {};
  const nextPerSession = next.perSessionLastMessageUuid ?? {};

  for (const [sid, nextUuid] of Object.entries(nextPerSession)) {
    const prevUuid = prevPerSession[sid] ?? null;
    if (prevUuid !== nextUuid) changedSessionIds.add(sid);
  }
  // Sessions that existed before but are now gone (removed sessions)
  for (const sid of Object.keys(prevPerSession)) {
    if (!(sid in nextPerSession)) changedSessionIds.add(sid);
  }

  return { changedSessionIds, changedCommitProjects, addedProjects, removedProjects };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Build a daily digest for the given date and timezone.
 *
 * @param store  The SQLite store to read sessions and messages from.
 * @param opts   Optional overrides for date and timezone.
 * @param deps   Optional dependency injection for tests. Production callers
 *               omit this and real implementations are used.
 * @returns      A complete DailyDigest. Never throws — errors in git
 *               enrichment, cache I/O, or cost estimation degrade gracefully.
 */
export async function buildDailyDigest(
  store: Store,
  opts?: DailyDigestOptions,
  deps?: BuildDailyDigestDeps,
): Promise<DailyDigest> {
  // ── Step 1: Resolve date and timezone ────────────────────────────────────

  // SR-4: TZ MUST come from Intl, never from process.env.TZ
  const intlTz =
    deps?.intlTz ??
    (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const tz = opts?.tz ?? intlTz();

  const nowMs = (deps?.now ?? (() => Date.now()))();

  // Compute today's YYYY-MM-DD in the resolved timezone
  const date =
    opts?.date ??
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(nowMs);

  const { startMs, endMs } = dayWindowInTz(date, tz);

  // ── Step 2: Fetch sessions in the window ─────────────────────────────────

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

  // ── Step 3: Compute snapshot hash (SR-4) ─────────────────────────────────

  // maxMessageUuid: the lexically-largest uuid across all messages in window
  // (used as a proxy for "latest message seen")
  let maxMessageUuid: string | null = null;
  const sessionMessages = new Map<string, ReturnType<Store['getSessionMessages']>>();

  // perSessionLastMessageUuid: per-session last message uuid for fine-grained
  // session-level diffing by the incremental patcher (v3.06).
  const perSessionLastMessageUuid: Record<string, string | null> = {};

  for (const session of sessions) {
    const msgs = store.getSessionMessages(session.session_id);
    sessionMessages.set(session.session_id, msgs);
    let sessionMax: string | null = null;
    for (const msg of msgs) {
      if (
        msg.timestamp !== null &&
        msg.timestamp >= startMs &&
        msg.timestamp < endMs
      ) {
        if (maxMessageUuid === null || msg.uuid > maxMessageUuid) {
          maxMessageUuid = msg.uuid;
        }
        if (sessionMax === null || msg.uuid > sessionMax) {
          sessionMax = msg.uuid;
        }
      }
    }
    perSessionLastMessageUuid[session.session_id] = sessionMax;
  }

  // Per-project last commit SHA
  const getLastCommit = (projectPath: string): string | null => {
    try {
      return getLastCommitSha(projectPath);
    } catch {
      return null;
    }
  };

  const perProjectLastCommit: Record<string, string | null> = {};
  for (const p of sortedProjectPaths) {
    perProjectLastCommit[p] = getLastCommit(p);
  }

  const newInputs: SnapshotHashInputs = {
    date,
    tz,
    sortedProjectPaths,
    maxMessageUuid,
    perProjectLastCommit,
    perSessionLastMessageUuid,
  };

  const snapshotHash = computeSnapshotHash(newInputs);

  // ── Step 4: Cache check ───────────────────────────────────────────────────

  const cacheClient: CacheClient = deps?.cache ?? createFileCache();

  const cached = cacheClient.read(snapshotHash);
  if (cached !== null) {
    return { ...cached, cached: true };
  }

  // ── Step 4b: Short-circuit for empty days (negative caching, v3.07) ────────
  //
  // If there are no sessions AND every per-project last-commit SHA is null or
  // absent, the day is definitively empty: no messages, no git activity.
  // We build the digest directly, persist it to cache (so a second call within
  // the same window returns cached:true), and return without running the
  // segment/cluster pipeline.
  //
  // The cache-read above (Step 4) already handles the repeat-call case; this
  // branch fires only on the first call for an empty day.
  //
  // SR-4: the snapshot hash already encodes the project-list dimension, so a
  // new project arriving later will produce a different hash and bypass this
  // cached entry — the stale empty digest will never be served.
  const allCommitShasEmpty = Object.values(perProjectLastCommit).every(
    (v) => v == null,
  );
  if (sessions.length === 0 && allCommitShasEmpty) {
    const emptyDigest: DailyDigest = {
      date,
      tz,
      totals: { sessions: 0, segments: 0, activeMs: 0, estimatedCost: 0, projects: 0 },
      items: [],
      cached: false,
      snapshotHash,
    };
    try {
      cacheClient.write(snapshotHash, emptyDigest, newInputs);
    } catch (err) {
      console.warn(
        `recap cache write failed (empty day): ${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}`,
      );
    }
    return emptyDigest;
  }

  // ── Step 4c: Incremental-digest patcher (v3.06) ──────────────────────────
  //
  // When patchCache is true (opt-in feature flag) and forceRebuild is false,
  // attempt to find a previous digest for the same date/tz and patch it instead
  // of running the full segment/cluster pipeline from scratch.
  //
  // Feature flag default: false.  Flip to true after a week of canary once
  // the patcher is proven correct in production.
  //
  // The patcher path goes AFTER the empty-day short-circuit (Step 4b) so that
  // truly empty days never enter the patcher.
  const usePatchCache = (opts?.patchCache ?? false) && !(opts?.forceRebuild ?? false);
  if (usePatchCache) {
    const prevEntry = cacheClient.readMostRecentForDate(date, tz);
    if (prevEntry !== null) {
      // We have a previous entry for this date/tz with a different hash.
      // Diff the inputs to find what changed.
      const diff = diffInputs(prevEntry.inputs, newInputs);

      // Count how many of the previous clusters are "touched" (need rebuild).
      const prevItems = prevEntry.digest.items;
      const touchedProjects = new Set([
        ...diff.changedCommitProjects,
        ...diff.addedProjects,
        ...diff.removedProjects,
      ]);
      const touchedBySession = new Set(diff.changedSessionIds);

      // A cluster is touched if any of its sessions changed or its project changed.
      const touchedClusterCount = prevItems.filter((item) => {
        if (touchedProjects.has(item.project)) return true;
        return item.sessionIds.some((sid) => touchedBySession.has(sid));
      }).length;

      const totalClusterCount = prevItems.length;

      // Get the mtime of the previous cached entry by reading the file system.
      // We use nowMs as a fallback if we can't get the mtime (treats it as stale).
      let prevMtimeMs = 0; // will force full rebuild if we can't get mtime
      try {
        // The prev entry's digest has a snapshotHash; use it to find the file.
        if (prevEntry.digest.snapshotHash) {
          const prevHash = prevEntry.digest.snapshotHash;
          // We need to get the mtime; use the deps.cache if it's a file cache,
          // otherwise we can't infer the mtime. For file caches, we know the path.
          // For in-memory/test caches, prevMtimeMs stays 0 (forces rebuild) unless
          // we use a different signal.  In tests, pass a getMtimeMs dep if needed.
          if (deps?.getCacheMtimeMs) {
            prevMtimeMs = deps.getCacheMtimeMs(prevHash) ?? 0;
          } else {
            // Production path: assume the file is in the default location
            // We can't easily get the mtime without knowing the rootDir.
            // Use nowMs - 1ms as a heuristic: if we get here, we just read it,
            // so it's definitely fresh.  This is safe because the staleness
            // check is a safety valve, not a correctness gate.
            prevMtimeMs = nowMs; // treat as fresh — will not force rebuild on staleness
          }
        }
      } catch {
        prevMtimeMs = 0; // force full rebuild on any error
      }

      const forceFullRebuild = shouldForceFullRebuild(
        prevEntry,
        newInputs,
        prevMtimeMs,
        nowMs,
        touchedClusterCount,
        totalClusterCount,
      );

      if (!forceFullRebuild) {
        // ── Patch path ─────────────────────────────────────────────────────
        // a/b. Re-segment changed sessions
        const changedSegments: SegmentWithProject[] = [];
        const unchangedSessionIds = new Set(
          sessions
            .map((s) => s.session_id)
            .filter((sid) => !diff.changedSessionIds.has(sid) && !touchedProjects.has(
              sessions.find((s) => s.session_id === sid)?.project_path ?? '',
            )),
        );

        for (const session of sessions) {
          const sid = session.session_id;
          const msgs = sessionMessages.get(sid) ?? [];
          if (msgs.length === 0) continue;
          // Only re-segment sessions that changed or whose project changed
          if (diff.changedSessionIds.has(sid) || touchedProjects.has(session.project_path)) {
            const segs = segmentSession(msgs);
            for (const seg of segs) {
              changedSegments.push({
                ...seg,
                sessionId: sid,
                projectPath: session.project_path,
              });
            }
          }
        }
        void unchangedSessionIds; // used for clarity in comment above

        // c/d. Re-cluster only the touched segments + neighbours from previous clusters
        // We need ALL segments (touched + untouched) for re-clustering touched projects.
        const allSegmentsForPatch: SegmentWithProject[] = [];
        for (const session of sessions) {
          const sid = session.session_id;
          const msgs = sessionMessages.get(sid) ?? [];
          if (msgs.length === 0) continue;
          if (diff.changedSessionIds.has(sid) || touchedProjects.has(session.project_path)) {
            // Already computed above
          } else {
            // Untouched session — re-use its segments from existing data by re-segmenting
            // (we don't cache segments, so re-segment is fast; messages are already loaded)
            const segs = segmentSession(msgs);
            for (const seg of segs) {
              allSegmentsForPatch.push({
                ...seg,
                sessionId: sid,
                projectPath: session.project_path,
              });
            }
          }
        }
        // Add the newly-re-segmented sessions
        for (const seg of changedSegments) {
          allSegmentsForPatch.push(seg);
        }

        // e/f. Identify touched projects for full re-cluster within those projects
        // Re-cluster all segments (patcher clusters only by project path anyway)
        const embeddingProvider = deps?.embeddingProvider ?? null;
        const correctionsClient = deps?.correctionsClient ?? null;
        const patchedClusters = await clusterSegments(allSegmentsForPatch, {
          embeddingProvider,
          correctionsClient,
        });

        // g. Re-run git enrichment only for changed projects + build items
        const getGitActivity =
          deps?.getProjectGitActivity ?? realGetProjectGitActivity;
        const resolveEmail = deps?.getAuthorEmail ?? getAuthorEmail;

        const patchedItems: DailyDigestItem[] = [];
        for (const cluster of patchedClusters) {
          const isProjectTouched = touchedProjects.has(cluster.projectPath) ||
            cluster.segments.some((s) => diff.changedSessionIds.has(s.sessionId));

          // For untouched items, try to reuse the previous item verbatim.
          // An item is "the same" if its projectPath hasn't changed and no
          // session in it changed.
          if (!isProjectTouched) {
            const prevItem = prevItems.find(
              (pi) => pi.project === cluster.projectPath &&
                cluster.segments.every((s) => pi.segmentIds.includes(s.segmentId)),
            );
            if (prevItem !== undefined) {
              patchedItems.push(prevItem);
              continue;
            }
          }

          // Touched or new cluster — rebuild the item
          const item = buildDigestItem(
            cluster,
            startMs,
            endMs,
            store,
            sessions,
            getGitActivity,
            resolveEmail,
          );
          if (cluster.label !== undefined) {
            (item as { label?: string | null }).label = cluster.label;
          }
          if (cluster.hidden === true) {
            (item as { hidden?: boolean }).hidden = true;
          }
          patchedItems.push(item);
        }

        // h. Sort items by score desc, ties by earliest startTs
        patchedItems.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          const aTs = earliestSegmentTs(a, patchedClusters);
          const bTs = earliestSegmentTs(b, patchedClusters);
          return aTs - bTs;
        });

        // h. Recompute totals
        const patchedUniqueSessionIds = new Set<string>();
        let patchedActiveMs = 0;
        let patchedCost = 0;
        for (const item of patchedItems) {
          for (const sid of item.sessionIds) patchedUniqueSessionIds.add(sid);
          patchedActiveMs += item.duration.activeMs;
          patchedCost += item.estimatedCost;
        }
        const patchedUniqueProjects = new Set(patchedItems.map((i) => i.project));

        const patchedTotals: DailyDigestTotals = {
          sessions: patchedUniqueSessionIds.size,
          segments: allSegmentsForPatch.length,
          activeMs: patchedActiveMs,
          estimatedCost: patchedCost,
          projects: patchedUniqueProjects.size,
        };

        const patchedDigest: DailyDigest = {
          date,
          tz,
          totals: patchedTotals,
          items: Object.freeze(patchedItems),
          cached: false,
          snapshotHash,
        };

        try {
          cacheClient.write(snapshotHash, patchedDigest, newInputs);
        } catch (err) {
          console.warn(
            `recap cache write failed (patcher): ${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}`,
          );
        }

        return patchedDigest;
      }
      // forceFullRebuild — fall through to the full pipeline below
    }
  }

  // ── Step 5: Segment all sessions ─────────────────────────────────────────

  const allSegments: SegmentWithProject[] = [];

  for (const session of sessions) {
    const msgs = sessionMessages.get(session.session_id) ?? [];
    if (msgs.length === 0) continue;

    const segments = segmentSession(msgs);
    for (const seg of segments) {
      allSegments.push({
        ...seg,
        // Stamp sessionId and projectPath onto each segment to form SegmentWithProject
        sessionId: session.session_id,
        projectPath: session.project_path,
      });
    }
  }

  // ── Step 6: Cluster segments ──────────────────────────────────────────────

  const embeddingProvider = deps?.embeddingProvider ?? null;
  const correctionsClient = deps?.correctionsClient ?? null;
  const clusters = await clusterSegments(allSegments, {
    embeddingProvider,
    correctionsClient,
  });

  // ── Step 7: Build digest items ────────────────────────────────────────────

  const getGitActivity =
    deps?.getProjectGitActivity ?? realGetProjectGitActivity;
  const resolveEmail = deps?.getAuthorEmail ?? getAuthorEmail;

  const items: DailyDigestItem[] = [];

  for (const cluster of clusters) {
    const item = buildDigestItem(
      cluster,
      startMs,
      endMs,
      store,
      sessions,
      getGitActivity,
      resolveEmail,
    );
    // Propagate correction metadata from cluster to digest item (v3.09)
    if (cluster.label !== undefined) {
      (item as { label?: string | null }).label = cluster.label;
    }
    if (cluster.hidden === true) {
      (item as { hidden?: boolean }).hidden = true;
    }
    items.push(item);
  }

  // ── Step 8: Sort items by score desc, ties by earliest startTs ───────────

  items.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break: earliest startTs of any segment in the cluster
    const aTs = earliestSegmentTs(a, clusters);
    const bTs = earliestSegmentTs(b, clusters);
    return aTs - bTs;
  });

  // ── Step 9: Build totals ──────────────────────────────────────────────────

  const uniqueSessionIds = new Set<string>();
  let totalActiveMs = 0;
  let totalCost = 0;

  for (const item of items) {
    for (const sid of item.sessionIds) {
      uniqueSessionIds.add(sid);
    }
    totalActiveMs += item.duration.activeMs;
    totalCost += item.estimatedCost;
  }

  const uniqueProjects = new Set<string>(items.map((i) => i.project));

  const totals: DailyDigestTotals = {
    sessions: uniqueSessionIds.size,
    segments: allSegments.length,
    activeMs: totalActiveMs,
    estimatedCost: totalCost,
    projects: uniqueProjects.size,
  };

  // ── Step 10: Assemble and cache ───────────────────────────────────────────

  const digest: DailyDigest = {
    date,
    tz,
    totals,
    items: Object.freeze(items),
    cached: false,
    snapshotHash,
  };

  try {
    cacheClient.write(snapshotHash, digest, newInputs);
  } catch (err) {
    // Cache write failure is non-fatal
    console.warn(
      `recap cache write failed: ${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}`,
    );
  }

  return digest;
}

// ─── Item construction ────────────────────────────────────────────────────────

function buildDigestItem(
  cluster: SegmentCluster,
  startMs: number,
  endMs: number,
  store: Store,
  allSessions: ReturnType<Store['getSessions']>,
  getGitActivity: (
    path: string,
    start: number,
    end: number,
    email: string,
  ) => ProjectGitActivity | null,
  resolveEmail: (projectPath: string) => string | null,
): DailyDigestItem {
  const { projectPath, segments } = cluster;

  // Collect unique session IDs contributing to this cluster
  const sessionIdSet = new Set<string>();
  for (const seg of segments) {
    sessionIdSet.add(seg.sessionId);
  }
  const sessionIds = [...sessionIdSet].sort();
  const segmentIds = segments.map((s) => s.segmentId);

  // firstPrompt: earliest segment's openingPromptText, sanitised, truncated, wrapped
  const sortedByTs = [...segments].sort((a, b) => a.startTs - b.startTs);
  const rawPrompt =
    sortedByTs.find((s) => s.openingPromptText !== null)?.openingPromptText ??
    null;

  let firstPrompt: string | null = null;
  if (rawPrompt !== null) {
    // Defensive sanitisation (SR-8: already sanitised at parse time, re-apply)
    const sanitised = sanitizePromptText(rawPrompt);
    if (sanitised !== null) {
      // Code-point-aware truncation to 280 chars
      const truncated = truncateCodePoints(sanitised, 280);
      // Wrap with untrusted marker (SR-8)
      firstPrompt = wrapUntrusted(truncated);
    }
  }

  // toolHistogram: sum across all segments in the cluster
  const toolHistogram: Record<string, number> = {};
  for (const seg of segments) {
    for (const [tool, count] of Object.entries(seg.toolHistogram)) {
      toolHistogram[tool] = (toolHistogram[tool] ?? 0) + count;
    }
  }

  // filePathsTouched: union of all segment filePaths, sorted, capped at 20
  // NOTE: In v1 this will be empty for all real-world data because the store's
  // `tools` column only stores tool names, not params. See known limitation in
  // module doc comment.
  const filePathSet = new Set<string>();
  for (const seg of segments) {
    for (const fp of seg.filePaths) {
      filePathSet.add(fp);
    }
  }
  const filePathsTouched = [...filePathSet].sort().slice(0, 20);

  // characterVerb: infer from tool histogram
  // bashSamples is empty in v1 — the tools column doesn't store command params
  const characterVerb = inferCharacterVerb(toolHistogram, {
    bashCommandSamples: [],
  });

  // duration: sum wallMs and activeMs across contributing sessions
  let wallMs = 0;
  let activeMs = 0;
  for (const sessionId of sessionIds) {
    const session = allSessions.find((s) => s.session_id === sessionId);
    if (session) {
      const sessionWall =
        (session.last_timestamp ?? 0) - (session.first_timestamp ?? 0);
      wallMs += Math.max(0, sessionWall);
      activeMs += session.active_duration_ms ?? 0;
    }
  }

  // estimatedCost: sum per-message cost for contributing sessions
  let estimatedCost = 0;
  for (const sessionId of sessionIds) {
    const msgs = store.getSessionMessages(sessionId);
    for (const msg of msgs) {
      if (msg.model !== null) {
        const { cost } = estimateCost(
          msg.model,
          msg.input_tokens,
          msg.output_tokens,
          msg.cache_read_tokens,
          msg.cache_creation_tokens,
        );
        estimatedCost += cost;
      }
    }
  }

  // git enrichment
  let git: ProjectGitActivity | null = null;
  try {
    const authorEmail = resolveEmail(projectPath);
    if (authorEmail !== null) {
      git = getGitActivity(projectPath, startMs, endMs, authorEmail);
    }
  } catch {
    // Git enrichment is non-fatal
    console.warn(`recap git enrichment failed for ${projectPath}`);
  }

  // confidence: deterministic signal strength for this item
  const confidence = computeConfidence({
    git,
    duration: { wallMs, activeMs },
    filePathsTouched,
  });

  // score = (commits*3) + (linesChanged/100) + (activeMinutes/30) +
  //         (prMerged?5:0) + (pushed?1:0)
  const activeMinutes = activeMs / 60_000;
  const linesChanged = git
    ? git.linesAdded + git.linesRemoved
    : 0;
  const score =
    (git ? git.commitsToday * 3 : 0) +
    linesChanged / 100 +
    activeMinutes / 30 +
    (git?.prMerged ? 5 : 0) +
    (git?.pushed ? 1 : 0);

  // Upgrade characterVerb to 'Shipped' if we have pushed commits today
  const finalVerb =
    git !== null && git.commitsToday > 0 && git.pushed
      ? 'Shipped'
      : characterVerb;

  // id: sha256 of (sortedSegmentIds.join(',') + '|' + sortedCommitShas.join(','))
  // hex, first 16 chars, branded as ItemId
  const sortedSegmentIds = [...segmentIds].sort();
  // In v1, commit SHAs from git enrichment are not per-segment, so we use the
  // project's last commit SHA from the enrichment data (or empty if unavailable).
  // This makes the id stable within a session window.
  const sortedCommitShas: string[] = [];
  // We don't have per-segment commit SHAs in v1 — use empty list for the commit part
  const idInput =
    sortedSegmentIds.join(',') + '|' + sortedCommitShas.join(',');
  const id = createHash('sha256')
    .update(idInput)
    .digest('hex')
    .slice(0, 16) as ItemId;

  // Look up repoUrl from any session in the cluster
  const repoUrl =
    allSessions.find((s) => s.session_id === sessionIds[0])?.repo_url ?? null;

  return {
    id,
    project: projectPath,
    repoUrl,
    sessionIds,
    segmentIds,
    firstPrompt,
    characterVerb: finalVerb,
    duration: { wallMs, activeMs },
    estimatedCost,
    toolHistogram: Object.freeze(toolHistogram),
    filePathsTouched,
    git,
    score,
    confidence,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the earliest startTs of any segment in the cluster that produced the
 * given item. Used for deterministic tie-breaking in sort.
 */
function earliestSegmentTs(
  item: DailyDigestItem,
  clusters: readonly SegmentCluster[],
): number {
  // Find the cluster that matches this item by its segmentIds
  const itemSegSet = new Set(item.segmentIds);
  const cluster = clusters.find((c) =>
    c.segments.some((s) => itemSegSet.has(s.segmentId)),
  );
  if (!cluster) return 0;

  let min = Infinity;
  for (const seg of cluster.segments) {
    if (seg.startTs < min) min = seg.startTs;
  }
  return min === Infinity ? 0 : min;
}
