import { describe, it, expect } from 'vitest';
import {
  clusterSegments,
  type SegmentWithProject,
  type SegmentCluster,
} from '../../recap/cluster.js';
import type { EmbeddingProvider } from '../../recap/embeddings.js';
import type { SegmentId } from '../../recap/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _idCounter = 0;
function makeId(): SegmentId {
  return `seg-${++_idCounter}` as SegmentId;
}

/**
 * Minimal factory for SegmentWithProject. All fields not supplied default to
 * safe zero-ish values so tests only specify what they care about.
 */
function makeSeg(
  overrides: Partial<SegmentWithProject> & { projectPath: string },
): SegmentWithProject {
  return {
    segmentId: makeId(),
    sessionId: overrides.sessionId ?? 'session-a',
    index: overrides.index ?? 0,
    startTs: overrides.startTs ?? 1_000_000,
    endTs: overrides.endTs ?? 2_000_000,
    openingPromptText: overrides.openingPromptText ?? null,
    messageUuids: overrides.messageUuids ?? [],
    toolHistogram: overrides.toolHistogram ?? {},
    filePaths: overrides.filePaths ?? [],
    projectPath: overrides.projectPath,
  };
}

/** Collect all segment IDs from clusters into a sorted array for comparison. */
function segIds(clusters: readonly SegmentCluster[]): string[][] {
  return clusters.map((c) =>
    [...c.segments].map((s) => s.segmentId).sort(),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('clusterSegments', () => {
  it('empty input returns empty array', async () => {
    const result = await clusterSegments([]);
    expect(result).toEqual([]);
  });

  it('single project, single segment → one cluster with one segment', async () => {
    const seg = makeSeg({ projectPath: '/proj/a' });
    const clusters = await clusterSegments([seg]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.projectPath).toBe('/proj/a');
    expect(clusters[0]!.segments).toHaveLength(1);
    expect(clusters[0]!.segments[0]!.segmentId).toBe(seg.segmentId);
  });

  it('two segments, file overlap ≥0.3 → one cluster', async () => {
    // Jaccard([a,b,c], [b,c,d]) = |{b,c}| / |{a,b,c,d}| = 2/4 = 0.5 ≥ 0.3
    const seg1 = makeSeg({ projectPath: '/proj/a', filePaths: ['a', 'b', 'c'] });
    const seg2 = makeSeg({ projectPath: '/proj/a', filePaths: ['b', 'c', 'd'] });

    const clusters = await clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.segments).toHaveLength(2);
  });

  it('two segments, file overlap <0.3 → two clusters', async () => {
    // Jaccard([a,b], [c,d]) = 0/4 = 0 < 0.3; no shared prompt; no time overlap
    const base = 1_000_000;
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['a', 'b'],
      startTs: base,
      endTs: base + 60_000,
    });
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['c', 'd'],
      // far in time so time-window rule doesn't fire
      startTs: base + 10_000_000,
      endTs: base + 10_060_000,
    });

    const clusters = await clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(2);
  });

  it('same session, no file overlap → two clusters (segmenter split preserved)', async () => {
    // Same session, adjacent segments, no shared files, no shared prompt text
    const base = 1_000_000;
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      sessionId: 'session-x',
      index: 0,
      filePaths: ['src/foo.ts'],
      startTs: base,
      endTs: base + 300_000,
      openingPromptText: 'Fix the login bug',
    });
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      sessionId: 'session-x',
      index: 1,
      filePaths: ['docs/readme.md'],
      startTs: base + 300_001,
      endTs: base + 600_000,
      openingPromptText: 'Write documentation for deployment',
    });

    const clusters = await clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(2);
  });

  it('same session, shared files → one cluster (over-segmentation recovery)', async () => {
    // Three small adjacent segments sharing file paths — union-find transitively merges
    const base = 1_000_000;
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      sessionId: 'session-x',
      index: 0,
      filePaths: ['src/auth.ts', 'src/user.ts'],
      startTs: base,
      endTs: base + 60_000,
    });
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      sessionId: 'session-x',
      index: 1,
      filePaths: ['src/user.ts', 'src/profile.ts'],
      startTs: base + 60_001,
      endTs: base + 120_000,
    });
    const seg3 = makeSeg({
      projectPath: '/proj/a',
      sessionId: 'session-x',
      index: 2,
      filePaths: ['src/auth.ts', 'src/token.ts'],
      startTs: base + 120_001,
      endTs: base + 180_000,
    });

    const clusters = await clusterSegments([seg1, seg2, seg3]);

    // seg1 ∪ seg2 via user.ts, seg1 ∪ seg3 via auth.ts → all three merge
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.segments).toHaveLength(3);
  });

  it('cross-session prompt-prefix match → one cluster', async () => {
    // Same opening prompt text, different sessions, no shared files, no time overlap
    const prompt = 'Refactor the authentication module to use JWT tokens';
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      sessionId: 'session-1',
      filePaths: [],
      startTs: 1_000_000,
      endTs: 1_060_000,
      openingPromptText: prompt,
    });
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      sessionId: 'session-2',
      filePaths: [],
      // Far apart in time so time-window rule can't fire
      startTs: 100_000_000,
      endTs: 100_060_000,
      openingPromptText: prompt,
    });

    const clusters = await clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.segments).toHaveLength(2);
  });

  it('different projects, identical files → two clusters (always separate by project)', async () => {
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['src/auth.ts', 'src/user.ts'],
      openingPromptText: 'Fix auth',
    });
    const seg2 = makeSeg({
      projectPath: '/proj/b',
      filePaths: ['src/auth.ts', 'src/user.ts'],
      openingPromptText: 'Fix auth',
    });

    const clusters = await clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(2);
    // Each cluster belongs to its own project
    const projects = clusters.map((c) => c.projectPath).sort();
    expect(projects).toEqual(['/proj/a', '/proj/b']);
    expect(clusters[0]!.segments).toHaveLength(1);
    expect(clusters[1]!.segments).toHaveLength(1);
  });

  it('determinism — byte-identical output on two runs with same input', async () => {
    const base = 5_000_000;
    const segs: SegmentWithProject[] = [
      makeSeg({
        projectPath: '/proj/a',
        filePaths: ['x.ts', 'y.ts'],
        startTs: base,
        endTs: base + 60_000,
        openingPromptText: 'Add unit tests for the parser',
      }),
      makeSeg({
        projectPath: '/proj/a',
        filePaths: ['y.ts', 'z.ts'],
        startTs: base + 60_001,
        endTs: base + 120_000,
        openingPromptText: 'Continue adding tests for parser',
      }),
      makeSeg({
        projectPath: '/proj/b',
        filePaths: ['lib/main.ts'],
        startTs: base + 200_000,
        endTs: base + 300_000,
        openingPromptText: null,
      }),
    ];

    const run1 = JSON.stringify(await clusterSegments(segs));
    const run2 = JSON.stringify(await clusterSegments(segs));

    expect(run1).toBe(run2);
  });

  // ─── Additional coverage tests ───────────────────────────────────────────

  it('output clusters sorted by (projectPath, earliestStartTs)', async () => {
    const seg1 = makeSeg({
      projectPath: '/proj/z',
      filePaths: [],
      startTs: 1_000,
      endTs: 2_000,
    });
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      filePaths: [],
      startTs: 3_000,
      endTs: 4_000,
    });
    const seg3 = makeSeg({
      projectPath: '/proj/a',
      filePaths: [],
      startTs: 1_000,
      endTs: 2_000,
    });

    const clusters = await clusterSegments([seg1, seg2, seg3]);

    // /proj/a before /proj/z; within /proj/a earliest start first
    expect(clusters[0]!.projectPath).toBe('/proj/a');
    expect(clusters[0]!.segments[0]!.startTs).toBe(1_000);
    expect(clusters[1]!.projectPath).toBe('/proj/a');
    expect(clusters[1]!.segments[0]!.startTs).toBe(3_000);
    expect(clusters[2]!.projectPath).toBe('/proj/z');
  });

  it('segments within a cluster sorted by startTs', async () => {
    // Two segments that share files — merged into one cluster
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['a.ts', 'b.ts'],
      startTs: 2_000_000,
      endTs: 2_060_000,
    });
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['a.ts', 'c.ts'],
      startTs: 1_000_000,
      endTs: 1_060_000,
    });

    const clusters = await clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.segments[0]!.startTs).toBe(1_000_000);
    expect(clusters[0]!.segments[1]!.startTs).toBe(2_000_000);
  });

  it('time-window overlap with shared file merges segments', async () => {
    // Two segments that overlap in time and share a file path
    const base = 1_000_000;
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['shared.ts', 'other.ts'],
      startTs: base,
      endTs: base + 300_000,
    });
    // Starts 4 min after seg1 ends — within 5-min tolerance
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['shared.ts', 'another.ts'],
      startTs: base + 300_000 + 4 * 60_000,
      endTs: base + 600_000,
    });

    const clusters = await clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(1);
  });

  it('time-window overlap without shared file does NOT merge', async () => {
    const base = 1_000_000;
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['foo.ts'],
      startTs: base,
      endTs: base + 300_000,
    });
    // Overlaps in time but no shared file
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['bar.ts'],
      startTs: base + 100_000,
      endTs: base + 400_000,
    });

    const clusters = await clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(2);
  });

  it('Jaccard exactly at threshold 0.3 merges', async () => {
    // Jaccard([a,b,c,d,e,f,g], [c,d,e,x,y,z,w,q,r,s]) = 3/14 ≈ 0.214 < 0.3
    // Jaccard([a,b,c], [c,d,e,f,g,h,i,j,k]) = 1/9 ≈ 0.11 < 0.3
    // Jaccard([a,b,c,d,e,f,g], [c,d,e]) = 3/7 ≈ 0.43 ≥ 0.3
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      startTs: 1_000_000,
      endTs: 2_000_000,
    });
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['c', 'd', 'e'],
      startTs: 3_000_000,
      endTs: 4_000_000,
    });

    const clusters = await clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(1);
  });

  it('null openingPromptText on both sides → no prompt merge', async () => {
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      filePaths: [],
      startTs: 1_000_000,
      endTs: 2_000_000,
      openingPromptText: null,
    });
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      filePaths: [],
      startTs: 10_000_000,
      endTs: 11_000_000,
      openingPromptText: null,
    });

    const clusters = await clusterSegments([seg1, seg2]);

    // Null prompts produce no signal; no other overlap → separate clusters
    expect(clusters).toHaveLength(2);
  });

  it('transitive merge via union-find: A–B file overlap, B–C file overlap → all three in one cluster', async () => {
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['x.ts', 'y.ts'],
      startTs: 1_000_000,
      endTs: 1_060_000,
    });
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['y.ts', 'z.ts'],
      startTs: 5_000_000,
      endTs: 5_060_000,
    });
    const seg3 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['z.ts', 'w.ts'],
      startTs: 10_000_000,
      endTs: 10_060_000,
    });

    const clusters = await clusterSegments([seg1, seg2, seg3]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.segments).toHaveLength(3);
  });

  // ─── v2.03: Embedding-on tests ────────────────────────────────────────────

  /**
   * Deterministic stub embedding provider for unit tests.
   * Returns a 384-dim Float32Array seeded from a simple hash of the text.
   * No real model required.
   */
  function makeStubProvider(overrides?: {
    embedImpl?: (text: string) => Float32Array;
  }): EmbeddingProvider {
    function stubEmbed(text: string): Float32Array {
      if (overrides?.embedImpl) return overrides.embedImpl(text);
      // Simple deterministic vector: seed from text SHA bytes spread across 384 dims
      const vec = new Float32Array(384);
      // Use a simple LCG seeded from the text's char codes
      let seed = 0;
      for (let i = 0; i < text.length; i++) {
        seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
      }
      for (let i = 0; i < 384; i++) {
        // LCG step
        seed = (seed * 1664525 + 1013904223) >>> 0;
        // Map to [-1, 1]
        vec[i] = (seed / 0xffffffff) * 2 - 1;
      }
      // Normalise
      let mag = 0;
      for (let i = 0; i < 384; i++) mag += vec[i]! ** 2;
      const norm = Math.sqrt(mag);
      if (norm > 0) {
        for (let i = 0; i < 384; i++) vec[i] = vec[i]! / norm;
      }
      return vec;
    }

    return {
      embed: async (text: string) => stubEmbed(text),
      cosine(a: Float32Array, b: Float32Array): number {
        let dot = 0;
        for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
        // Vectors are already normalised, so dot == cosine
        return Math.max(-1, Math.min(1, dot));
      },
    };
  }

  it('embedding off (null provider) → identical behaviour to v1', async () => {
    // Same test as 'cross-session prompt-prefix match → one cluster' but with
    // embeddingProvider: null explicitly passed.
    const prompt = 'Refactor the authentication module to use JWT tokens';
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      sessionId: 'session-emb-1',
      filePaths: [],
      startTs: 1_000_000,
      endTs: 1_060_000,
      openingPromptText: prompt,
    });
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      sessionId: 'session-emb-2',
      filePaths: [],
      startTs: 100_000_000,
      endTs: 100_060_000,
      openingPromptText: prompt,
    });

    const withNull = await clusterSegments([seg1, seg2], { embeddingProvider: null });
    const withoutOpt = await clusterSegments([seg1, seg2]);

    // Both should produce the same result (v1 Jaccard path)
    expect(JSON.stringify(withNull)).toBe(JSON.stringify(withoutOpt));
    // High bigram Jaccard on identical prompts → one cluster
    expect(withNull).toHaveLength(1);
  });

  it('embedding-driven merge: low Jaccard, high cosine → merged', async () => {
    // Two segments with totally different file paths (low Jaccard) and different
    // prompt text that the stub maps to HIGH cosine (same seed → identical vectors).
    const identicalText = 'implement feature X with authentication';
    const seg1 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['file-alpha.ts'],
      startTs: 1_000_000,
      endTs: 2_000_000,
      openingPromptText: identicalText,
    });
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['file-beta.ts'],
      startTs: 10_000_000,
      endTs: 11_000_000,
      openingPromptText: identicalText, // same text → same vector → cosine = 1.0
    });

    // File Jaccard = 0 (no shared files), time windows don't overlap at 5-min tolerance
    // With stub: same text → same vector → cosine = 1.0 ≥ 0.65 → merge
    const clusters = await clusterSegments([seg1, seg2], {
      embeddingProvider: makeStubProvider(),
    });

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.segments).toHaveLength(2);
  });

  it('embedding-driven non-merge: low Jaccard, low cosine → not merged', async () => {
    // Two segments with totally different file paths (low Jaccard) and prompt text
    // that the stub maps to LOW cosine (orthogonal vectors).
    // We inject custom vectors: seg1 gets e_0, seg2 gets e_1 (orthogonal → cosine=0).
    const makeOrthogonalProvider = (): ReturnType<typeof makeStubProvider> => {
      const vec0 = new Float32Array(384); vec0[0] = 1;  // e_0
      const vec1 = new Float32Array(384); vec1[1] = 1;  // e_1
      return makeStubProvider({
        embedImpl: (text: string) => text.includes('alpha') ? vec0 : vec1,
      });
    };

    const seg1 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['file-a.ts'],
      startTs: 1_000_000,
      endTs: 2_000_000,
      openingPromptText: 'alpha task',
    });
    const seg2 = makeSeg({
      projectPath: '/proj/a',
      filePaths: ['file-b.ts'],
      startTs: 10_000_000,
      endTs: 11_000_000,
      openingPromptText: 'beta task',
    });

    // cosine(e_0, e_1) = 0 < 0.65 → not merged
    const clusters = await clusterSegments([seg1, seg2], {
      embeddingProvider: makeOrthogonalProvider(),
    });

    expect(clusters).toHaveLength(2);
  });
});
