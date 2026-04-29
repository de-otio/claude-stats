import { describe, it, expect } from 'vitest';
import {
  clusterSegments,
  type SegmentWithProject,
  type SegmentCluster,
} from '../../recap/cluster.js';
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
  it('empty input returns empty array', () => {
    const result = clusterSegments([]);
    expect(result).toEqual([]);
  });

  it('single project, single segment → one cluster with one segment', () => {
    const seg = makeSeg({ projectPath: '/proj/a' });
    const clusters = clusterSegments([seg]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.projectPath).toBe('/proj/a');
    expect(clusters[0]!.segments).toHaveLength(1);
    expect(clusters[0]!.segments[0]!.segmentId).toBe(seg.segmentId);
  });

  it('two segments, file overlap ≥0.3 → one cluster', () => {
    // Jaccard([a,b,c], [b,c,d]) = |{b,c}| / |{a,b,c,d}| = 2/4 = 0.5 ≥ 0.3
    const seg1 = makeSeg({ projectPath: '/proj/a', filePaths: ['a', 'b', 'c'] });
    const seg2 = makeSeg({ projectPath: '/proj/a', filePaths: ['b', 'c', 'd'] });

    const clusters = clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.segments).toHaveLength(2);
  });

  it('two segments, file overlap <0.3 → two clusters', () => {
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

    const clusters = clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(2);
  });

  it('same session, no file overlap → two clusters (segmenter split preserved)', () => {
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

    const clusters = clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(2);
  });

  it('same session, shared files → one cluster (over-segmentation recovery)', () => {
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

    const clusters = clusterSegments([seg1, seg2, seg3]);

    // seg1 ∪ seg2 via user.ts, seg1 ∪ seg3 via auth.ts → all three merge
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.segments).toHaveLength(3);
  });

  it('cross-session prompt-prefix match → one cluster', () => {
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

    const clusters = clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.segments).toHaveLength(2);
  });

  it('different projects, identical files → two clusters (always separate by project)', () => {
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

    const clusters = clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(2);
    // Each cluster belongs to its own project
    const projects = clusters.map((c) => c.projectPath).sort();
    expect(projects).toEqual(['/proj/a', '/proj/b']);
    expect(clusters[0]!.segments).toHaveLength(1);
    expect(clusters[1]!.segments).toHaveLength(1);
  });

  it('determinism — byte-identical output on two runs with same input', () => {
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

    const run1 = JSON.stringify(clusterSegments(segs));
    const run2 = JSON.stringify(clusterSegments(segs));

    expect(run1).toBe(run2);
  });

  // ─── Additional coverage tests ───────────────────────────────────────────

  it('output clusters sorted by (projectPath, earliestStartTs)', () => {
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

    const clusters = clusterSegments([seg1, seg2, seg3]);

    // /proj/a before /proj/z; within /proj/a earliest start first
    expect(clusters[0]!.projectPath).toBe('/proj/a');
    expect(clusters[0]!.segments[0]!.startTs).toBe(1_000);
    expect(clusters[1]!.projectPath).toBe('/proj/a');
    expect(clusters[1]!.segments[0]!.startTs).toBe(3_000);
    expect(clusters[2]!.projectPath).toBe('/proj/z');
  });

  it('segments within a cluster sorted by startTs', () => {
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

    const clusters = clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.segments[0]!.startTs).toBe(1_000_000);
    expect(clusters[0]!.segments[1]!.startTs).toBe(2_000_000);
  });

  it('time-window overlap with shared file merges segments', () => {
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

    const clusters = clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(1);
  });

  it('time-window overlap without shared file does NOT merge', () => {
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

    const clusters = clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(2);
  });

  it('Jaccard exactly at threshold 0.3 merges', () => {
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

    const clusters = clusterSegments([seg1, seg2]);

    expect(clusters).toHaveLength(1);
  });

  it('null openingPromptText on both sides → no prompt merge', () => {
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

    const clusters = clusterSegments([seg1, seg2]);

    // Null prompts produce no signal; no other overlap → separate clusters
    expect(clusters).toHaveLength(2);
  });

  it('transitive merge via union-find: A–B file overlap, B–C file overlap → all three in one cluster', () => {
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

    const clusters = clusterSegments([seg1, seg2, seg3]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.segments).toHaveLength(3);
  });
});
