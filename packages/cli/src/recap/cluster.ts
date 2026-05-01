/**
 * Cluster topic-segments across sessions into digest items.
 *
 * Pure function (except when an EmbeddingProvider is supplied — that path is
 * async and performs SQLite cache lookups). Only imports from types.ts and
 * embeddings.ts within the recap module.
 */

import type { Segment } from './types.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { CorrectionAction, CorrectionSignature } from './corrections.js';

// ─── Public API ────────────────────────────────────────────────────────────

export interface SegmentWithProject extends Segment {
  projectPath: string;
}

export interface SegmentCluster {
  projectPath: string;
  segments: readonly SegmentWithProject[];
  /** User-supplied label from a 'rename' correction. */
  label?: string | null;
  /** When true, this cluster was hidden by a user correction. */
  hidden?: boolean;
}

/**
 * Minimal interface for corrections lookup, used to avoid circular deps.
 * The full CorrectionsClient from corrections.ts satisfies this.
 */
export interface CorrectionsLookup {
  forSignature(sig: CorrectionSignature): readonly CorrectionAction[];
}

/**
 * Cluster segments into digest items using file-path overlap, prompt-prefix
 * similarity, and time-window proximity (with shared file paths).
 *
 * Rules applied in order within each project bucket:
 *  1. Group by projectPath.
 *  2. Merge when filePaths Jaccard similarity ≥ 0.3 (union-find, transitive).
 *  3. Merge when prompt similarity ≥ threshold:
 *       - With embeddingProvider: cosine(embed(a), embed(b)) ≥ 0.65
 *       - Without embeddingProvider: normalised bigram Jaccard ≥ 0.4 (v1 behaviour)
 *  4. Merge when time windows overlap (within 5 min tolerance) AND share ≥ 1 file.
 *  5. (Optional) Apply user corrections (merge/split/rename/hide) when
 *     correctionsClient is supplied.
 *
 * When embeddingProvider is supplied, the function is async (embedding requires
 * I/O for SQLite cache lookups and/or model inference). When the provider is
 * null/absent, the function resolves synchronously via a Promise.resolve().
 *
 * Output sorted by (projectPath, earliestStartTs).
 * Segments within a cluster sorted by startTs.
 */
export async function clusterSegments(
  segments: readonly SegmentWithProject[],
  opts?: {
    embeddingProvider?: EmbeddingProvider | null;
    correctionsClient?: CorrectionsLookup | null;
  },
): Promise<readonly SegmentCluster[]> {
  if (segments.length === 0) return [];

  const embeddingProvider = opts?.embeddingProvider ?? null;

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
    const clusters = await clusterWithinProject(projectSegs, embeddingProvider);
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

  // Step 5: Apply user corrections if a corrections client is provided
  const correctionsClient = opts?.correctionsClient ?? null;
  if (correctionsClient !== null) {
    return applyCorrections(allClusters, correctionsClient);
  }

  return allClusters;
}

// ─── Corrections application ────────────────────────────────────────────────

/**
 * Build a CorrectionSignature from a cluster's segments.
 * Re-exported as a helper so CLI handlers can build the same signature.
 */
export function computeClusterSignature(cluster: SegmentCluster): CorrectionSignature {
  // Collect all unique file paths from all segments, sorted
  const filePathSet = new Set<string>();
  let allPromptParts: string[] = [];

  for (const seg of cluster.segments) {
    for (const fp of seg.filePaths) {
      filePathSet.add(fp);
    }
    if (seg.openingPromptText !== null) {
      allPromptParts.push(seg.openingPromptText);
    }
  }

  // Use the earliest segment's prompt as the prefix
  const sortedByTs = [...cluster.segments].sort((a, b) => a.startTs - b.startTs);
  const rawPrompt = sortedByTs.find(s => s.openingPromptText !== null)?.openingPromptText ?? '';
  const promptPrefix = normalisePrompt(rawPrompt).slice(0, 80);

  return {
    projectPath: cluster.projectPath,
    filePaths: [...filePathSet].sort(),
    promptPrefix,
  };
}

/**
 * Apply corrections (merge/split/rename/hide) to the cluster list.
 * Returns a new array with corrections applied.
 */
function applyCorrections(
  clusters: SegmentCluster[],
  correctionsClient: CorrectionsLookup,
): readonly SegmentCluster[] {
  // Build a signature-to-index map for merge lookups
  const buildSigKey = (sig: CorrectionSignature): string =>
    `${sig.projectPath}\x1f${sig.filePaths.join(',')}\x1f${sig.promptPrefix}`;

  // Work on a mutable copy
  let result: SegmentCluster[] = [...clusters];

  // Track which clusters have been merged-into (absorbed) and should be removed
  const absorbed = new Set<number>();

  // First pass: apply rename and hide corrections
  for (let i = 0; i < result.length; i++) {
    const cluster = result[i]!;
    const sig = computeClusterSignature(cluster);
    const corrections = correctionsClient.forSignature(sig);

    let updated = { ...cluster };

    for (const action of corrections) {
      if (action.kind === 'rename') {
        updated = { ...updated, label: action.label };
      } else if (action.kind === 'hide') {
        updated = { ...updated, hidden: true };
      }
    }

    result[i] = updated;
  }

  // Second pass: apply merge corrections
  // Build sig-key → cluster index map for efficient lookup
  const sigToIndex = new Map<string, number>();
  for (let i = 0; i < result.length; i++) {
    const sig = computeClusterSignature(result[i]!);
    sigToIndex.set(buildSigKey(sig), i);
  }

  for (let i = 0; i < result.length; i++) {
    if (absorbed.has(i)) continue;
    const cluster = result[i]!;
    const sig = computeClusterSignature(cluster);
    const corrections = correctionsClient.forSignature(sig);

    for (const action of corrections) {
      if (action.kind === 'merge') {
        const otherKey = buildSigKey(action.otherSignature);
        const otherIdx = sigToIndex.get(otherKey);
        if (otherIdx !== undefined && otherIdx !== i && !absorbed.has(otherIdx)) {
          const other = result[otherIdx]!;
          // Merge other into this cluster
          result[i] = {
            ...cluster,
            segments: [...cluster.segments, ...other.segments].sort(
              (a, b) => a.startTs - b.startTs,
            ),
          };
          absorbed.add(otherIdx);
        }
      }
    }
  }

  // Third pass: apply split corrections
  const extra: SegmentCluster[] = [];

  for (let i = 0; i < result.length; i++) {
    if (absorbed.has(i)) continue;
    const cluster = result[i]!;
    const sig = computeClusterSignature(cluster);
    const corrections = correctionsClient.forSignature(sig);

    for (const action of corrections) {
      if (action.kind === 'split') {
        const targetSegIdx = cluster.segments.findIndex(
          (s) => s.segmentId === action.segmentId,
        );
        if (targetSegIdx !== -1) {
          const target = cluster.segments[targetSegIdx]!;
          // Remove the segment from this cluster
          const remaining = cluster.segments.filter((_, idx) => idx !== targetSegIdx);
          result[i] = { ...cluster, segments: remaining };
          // Create a new single-segment cluster for the split segment
          extra.push({
            projectPath: cluster.projectPath,
            segments: [target],
          });
        }
      }
    }
  }

  // Build final list: non-absorbed + extras
  const finalResult: SegmentCluster[] = [];
  for (let i = 0; i < result.length; i++) {
    if (!absorbed.has(i) && result[i]!.segments.length > 0) {
      finalResult.push(result[i]!);
    }
  }
  finalResult.push(...extra);

  // Re-sort
  finalResult.sort((a, b) => {
    const projCmp = a.projectPath.localeCompare(b.projectPath);
    if (projCmp !== 0) return projCmp;
    return earliestTs(a.segments) - earliestTs(b.segments);
  });

  return finalResult;
}

// ─── Clustering within a single project ────────────────────────────────────

/** Cosine similarity threshold for embedding-based prompt merging. */
const EMBEDDING_COSINE_THRESHOLD = 0.65;

async function clusterWithinProject(
  segs: readonly SegmentWithProject[],
  embeddingProvider: EmbeddingProvider | null,
): Promise<readonly SegmentWithProject[][]> {
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

  // Rule 3: prompt similarity
  //   With embeddings: cosine(embed(a), embed(b)) ≥ 0.65
  //   Without embeddings (v1 behaviour): normalised bigram Jaccard ≥ 0.4
  if (embeddingProvider !== null) {
    // Compute embeddings for all segments with non-null prompt text
    const embeddings = new Array<Float32Array | null>(n).fill(null);
    for (let i = 0; i < n; i++) {
      const promptText = segs[i]!.openingPromptText;
      if (promptText !== null && promptText.trim().length > 0) {
        try {
          embeddings[i] = await embeddingProvider.embed(promptText);
        } catch {
          // Embedding failure is non-fatal — skip this segment in rule 3
          embeddings[i] = null;
        }
      }
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ei = embeddings[i] ?? null;
        const ej = embeddings[j] ?? null;
        if (ei !== null && ej !== null) {
          if (embeddingProvider.cosine(ei, ej) >= EMBEDDING_COSINE_THRESHOLD) {
            uf.union(i, j);
          }
        }
      }
    }
  } else {
    // v1 Jaccard fallback
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (promptPrefixSimilarity(segs[i]!.openingPromptText, segs[j]!.openingPromptText) >= 0.4) {
          uf.union(i, j);
        }
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
