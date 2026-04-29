// Branded ID types - construct via the `as` cast at trusted sites only
// (e.g. inside the segmenter and digest builder where IDs are computed
// from sha256 of trusted inputs).
export type SegmentId = string & { readonly __brand: 'SegmentId' };
export type ItemId = string & { readonly __brand: 'ItemId' };

export interface DailyDigestOptions {
  date?: string;
  tz?: string;
  includeUnpushed?: boolean;
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
