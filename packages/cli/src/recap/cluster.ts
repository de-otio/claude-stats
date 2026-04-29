/**
 * Cluster topic-segments across sessions into digest items.
 *
 * Pure function — no LLM, no embeddings (those land in v2), no I/O.
 * Only imports from types.ts within the recap module.
 */

import type { Segment } from './types.js';

// ─── Public API ────────────────────────────────────────────────────────────

export interface SegmentWithProject extends Segment {
  projectPath: string;
}

export interface SegmentCluster {
  projectPath: string;
  segments: readonly SegmentWithProject[];
}

/**
 * Cluster segments into digest items using file-path overlap, prompt-prefix
 * similarity, and time-window proximity (with shared file paths).
 *
 * Rules applied in order within each project bucket:
 *  1. Group by projectPath.
 *  2. Merge when filePaths Jaccard similarity ≥ 0.3 (union-find, transitive).
 *  3. Merge when normalised openingPromptText prefixes share ≥ 40% similarity.
 *  4. Merge when time windows overlap (within 5 min tolerance) AND share ≥ 1 file.
 *
 * Output sorted by (projectPath, earliestStartTs).
 * Segments within a cluster sorted by startTs.
 */
export function clusterSegments(
  segments: readonly SegmentWithProject[],
): readonly SegmentCluster[] {
  if (segments.length === 0) return [];

  // Step 1: group by projectPath
  const byProject = new Map<string, SegmentWithProject[]>();
  for (const seg of segments) {
    let bucket = byProject.get(seg.projectPath);
    if (bucket === undefined) {
      bucket = [];
      byProject.set(seg.projectPath, bucket);
    }
    bucket.push(seg);
  }

  const allClusters: SegmentCluster[] = [];

  for (const [projectPath, projectSegs] of byProject) {
    const clusters = clusterWithinProject(projectSegs);
    for (const segs of clusters) {
      allClusters.push({ projectPath, segments: segs });
    }
  }

  // Sort clusters by (projectPath, earliestStartTs)
  allClusters.sort((a, b) => {
    const projCmp = a.projectPath.localeCompare(b.projectPath);
    if (projCmp !== 0) return projCmp;
    return earliestTs(a.segments) - earliestTs(b.segments);
  });

  return allClusters;
}

// ─── Clustering within a single project ────────────────────────────────────

function clusterWithinProject(
  segs: readonly SegmentWithProject[],
): readonly SegmentWithProject[][] {
  const n = segs.length;
  const uf = new UnionFind(n);

  // Rule 2: file-path Jaccard ≥ 0.3
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (jaccardFilePaths(segs[i]!.filePaths, segs[j]!.filePaths) >= 0.3) {
        uf.union(i, j);
      }
    }
  }

  // Rule 3: normalised prompt-prefix similarity ≥ 0.4
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (promptPrefixSimilarity(segs[i]!.openingPromptText, segs[j]!.openingPromptText) >= 0.4) {
        uf.union(i, j);
      }
    }
  }

  // Rule 4: overlapping time windows (within 5-min tolerance) AND ≥1 shared file
  const FIVE_MIN_MS = 5 * 60 * 1000;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (
        timeWindowsOverlap(segs[i]!, segs[j]!, FIVE_MIN_MS) &&
        shareAtLeastOneFile(segs[i]!.filePaths, segs[j]!.filePaths)
      ) {
        uf.union(i, j);
      }
    }
  }

  // Collect groups
  const groupMap = new Map<number, SegmentWithProject[]>();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    let group = groupMap.get(root);
    if (group === undefined) {
      group = [];
      groupMap.set(root, group);
    }
    group.push(segs[i]!);
  }

  // Sort segments within each cluster by startTs
  const result: SegmentWithProject[][] = [];
  for (const group of groupMap.values()) {
    group.sort((a, b) => a.startTs - b.startTs);
    result.push(group);
  }

  return result;
}

// ─── Union-Find (disjoint-set with path compression + union by rank) ────────

class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array<number>(n).fill(0);
  }

  find(x: number): number {
    // Path compression
    if (this.parent[x] !== x) {
      // Non-null assertion safe: parent is always initialised to valid indices
      this.parent[x] = this.find(this.parent[x]!);
    }
    return this.parent[x]!;
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    // Union by rank
    const rankX = this.rank[rx] ?? 0;
    const rankY = this.rank[ry] ?? 0;
    if (rankX < rankY) {
      this.parent[rx] = ry;
    } else if (rankX > rankY) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx] = rankX + 1;
    }
  }
}

// ─── Similarity helpers ─────────────────────────────────────────────────────

/**
 * Jaccard similarity over two file-path sets.
 * Returns 0 when both sets are empty (no signal to merge).
 */
function jaccardFilePaths(
  a: readonly string[],
  b: readonly string[],
): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const path of setA) {
    if (setB.has(path)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Stop-word list — MUST match the segmenter's list.
 * Source: v1.02 spec and v1.03 spec (same list).
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'is', 'was',
  'in', 'on', 'for', 'with', 'this', 'that', 'my', 'your',
  'please', 'can', 'could', 'will',
]);

const PUNCTUATION_RE = /[^\p{L}\p{N}\s]/gu;

/**
 * Normalise a prompt string: lowercase, strip punctuation, drop stop-words,
 * take first 80 chars.
 */
function normalisePrompt(text: string): string {
  return text
    .toLowerCase()
    .replace(PUNCTUATION_RE, '')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .join(' ')
    .slice(0, 80);
}

/**
 * Compute similarity between two normalised prompt prefixes using a
 * character-level Jaccard over their bigram sets.
 *
 * TODO(v3-C1): Replace this heuristic with LLM-as-judge tuning once
 * the corrections dataset is available.
 *
 * Returns 0 when either string normalises to empty.
 */
function promptPrefixSimilarity(
  a: string | null,
  b: string | null,
): number {
  if (a === null || b === null) return 0;
  const na = normalisePrompt(a);
  const nb = normalisePrompt(b);
  if (na.length === 0 || nb.length === 0) return 0;
  return bigramJaccard(na, nb);
}

/** Build a multiset-free bigram set from a string. */
function buildBigrams(s: string): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) {
    bigrams.add(s.slice(i, i + 2));
  }
  return bigrams;
}

/** Jaccard similarity over bigram sets. */
function bigramJaccard(a: string, b: string): number {
  const ba = buildBigrams(a);
  const bb = buildBigrams(b);
  if (ba.size === 0 && bb.size === 0) return 0;
  let intersection = 0;
  for (const bg of ba) {
    if (bb.has(bg)) intersection++;
  }
  const union = ba.size + bb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Returns true if the two segments' time windows overlap or touch within
 * `toleranceMs` milliseconds.
 * Overlap condition: max(startA, startB) <= min(endA, endB) + toleranceMs
 */
function timeWindowsOverlap(
  a: Segment,
  b: Segment,
  toleranceMs: number,
): boolean {
  const overlapStart = Math.max(a.startTs, b.startTs);
  const overlapEnd = Math.min(a.endTs, b.endTs) + toleranceMs;
  return overlapStart <= overlapEnd;
}

/** Returns true if the two file-path lists share at least one path. */
function shareAtLeastOneFile(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setA = new Set(a);
  for (const path of b) {
    if (setA.has(path)) return true;
  }
  return false;
}

// ─── Utility ────────────────────────────────────────────────────────────────

function earliestTs(segs: readonly SegmentWithProject[]): number {
  let min = Infinity;
  for (const s of segs) {
    if (s.startTs < min) min = s.startTs;
  }
  return min;
}
