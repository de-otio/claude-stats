// Branded ID types - construct via the `as` cast at trusted sites only
// (e.g. inside the segmenter and digest builder where IDs are computed
// from sha256 of trusted inputs).
export type SegmentId = string & { readonly __brand: 'SegmentId' };
export type ItemId = string & { readonly __brand: 'ItemId' };

export interface DailyDigestOptions {
  date?: string;
  tz?: string;
  includeUnpushed?: boolean;
  /**
   * When true, attempt to patch a previous digest rather than doing a full
   * rebuild when the snapshot hash changes.  Defaults false (feature flag:
   * ship with false, flip to true after a week of canary).
   */
  patchCache?: boolean;
  /**
   * When true, always skip the patcher path and do a full rebuild.
   * Useful for tests and emergency recovery.
   */
  forceRebuild?: boolean;
}

/**
 * A cache entry that carries both the stored DailyDigest and the
 * SnapshotHashInputs that produced it.  Used by the incremental-digest
 * patcher (v3.06) to diff the previous inputs against the new ones and
 * decide which sessions / projects need to be re-processed.
 *
 * Back-compat: entries written by v1/v2 (without inputs) will not
 * satisfy this type.  Use CacheClient.readWithInputs which returns null
 * for legacy entries.
 */
export interface CachedEntry {
  digest: DailyDigest;
  /** The SnapshotHashInputs that were used to build this digest. */
  inputs: import('./cache.js').SnapshotHashInputs;
}

export interface DailyDigestTotals {
  sessions: number;
  segments: number;
  activeMs: number;
  estimatedCost: number;
  projects: number;
}

export interface ProjectGitActivity {
  commitsToday: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  subjects: readonly string[];
  pushed: boolean;
  prMerged: number | null;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface DailyDigestItem {
  id: ItemId;
  project: string;
  repoUrl: string | null;
  sessionIds: readonly string[];
  segmentIds: readonly SegmentId[];
  // firstPrompt MUST be passed through wrapUntrusted before being assigned.
  // Null when the underlying segment had no user prompt text.
  firstPrompt: string | null;
  characterVerb: string;
  duration: { wallMs: number; activeMs: number };
  estimatedCost: number;
  toolHistogram: Readonly<Record<string, number>>;
  filePathsTouched: readonly string[];
  git: ProjectGitActivity | null;
  score: number;
  confidence: Confidence;
  /**
   * User-supplied label from a 'rename' correction (v3.09).
   * Rendered inside backticks per SR-2. Null/undefined = use default firstPrompt heading.
   */
  label?: string | null;
  /**
   * When true, this item was hidden by a user correction (v3.09).
   * Still included in the digest payload (for MCP callers) but reporters
   * skip it by default unless --all is passed.
   */
  hidden?: boolean;
}

export interface DailyDigest {
  date: string;
  tz: string;
  totals: DailyDigestTotals;
  items: readonly DailyDigestItem[];
  cached: boolean;
  snapshotHash: string;
}

export interface Segment {
  segmentId: SegmentId;
  sessionId: string;
  index: number;
  startTs: number;
  endTs: number;
  openingPromptText: string | null;
  messageUuids: readonly string[];
  toolHistogram: Readonly<Record<string, number>>;
  filePaths: readonly string[];
}

export interface ShiftWeights {
  gap: number;
  path: number;
  vocab: number;
  marker: number;
  commit: number;
  threshold: number;
}

export const DEFAULT_SHIFT_WEIGHTS = {
  gap: 0.4,
  path: 0.25,
  vocab: 0.15,
  marker: 0.15,
  commit: 0.30,
  threshold: 0.5,
} as const satisfies ShiftWeights;
