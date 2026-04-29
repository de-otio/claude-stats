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
import type { CacheClient } from './cache.js';
import { wrapUntrusted } from '../mcp/index.js';
import { sanitizePromptText } from '@claude-stats/core/sanitize';
import { estimateCost } from '@claude-stats/core/pricing';

// ─── Types ────────────────────────────────────────────────────────────────────

export type {
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
export function buildDailyDigest(
  store: Store,
  opts?: DailyDigestOptions,
  deps?: BuildDailyDigestDeps,
): DailyDigest {
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

  for (const session of sessions) {
    const msgs = store.getSessionMessages(session.session_id);
    sessionMessages.set(session.session_id, msgs);
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

  const snapshotHash = computeSnapshotHash({
    date,
    tz,
    sortedProjectPaths,
    maxMessageUuid,
    perProjectLastCommit,
  });

  // ── Step 4: Cache check ───────────────────────────────────────────────────

  const cacheClient: CacheClient = deps?.cache ?? createFileCache();

  const cached = cacheClient.read(snapshotHash);
  if (cached !== null) {
    return { ...cached, cached: true };
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

  const clusters = clusterSegments(allSegments);

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
    cacheClient.write(snapshotHash, digest);
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
