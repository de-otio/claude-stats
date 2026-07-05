/**
 * Clustering engine tests (Phase 2 B) — Unit B.
 *
 * Covers the pure `clusterProjects` function: grouping by remote owner,
 * grouping by path parent, cost ranking + key tiebreak, distinct + sorted
 * projectPaths, missing cost → 0, and empty input → [].
 *
 * Determinism: all fixtures are synthetic; paths follow the /home/user/…
 * placeholder convention; remotes use github.com/example-org and
 * gitlab.example.com. No real paths, org names, or UUIDs appear in this file.
 *
 * Confidentiality: placeholder vocabulary aligned to the canonical fixture
 * constants in `__tests__/fixtures/accounts.ts` (00000000- prefix UUIDs,
 * @example.com). Never reads ~/.claude*, the live stats.db, or the
 * claude-stats MCP.
 */
import { describe, it, expect } from "vitest";
import { clusterProjects } from "../attribution/clustering.js";
import type { ClusterInput } from "../attribution/clustering.js";
import { resolveOwner } from "../attribution/ownership.js";
import type { OwnerRule } from "@claude-stats/core/types";
import {
  PERSONAL_PATH_GLOB,
  WORK_PATH_GLOB,
  PERSONAL_REMOTE_GLOB,
  WORK_REMOTE_GLOB,
} from "./fixtures/accounts.js";

// ── placeholder vocabulary ────────────────────────────────────────────────────
// Derived from the canonical fixture globs — single source of truth for the
// path/remote placeholder strings used throughout these tests.

/** Parent directory for personal sessions: "/home/user/personal" */
const PERSONAL_DIR = PERSONAL_PATH_GLOB.replace("/**", "");
/** Parent directory for work sessions: "/home/user/work" */
const WORK_DIR = WORK_PATH_GLOB.replace("/**", "");
/** Remote owner for personal remotes: "github.com/example-org" */
const PERSONAL_REMOTE_OWNER = PERSONAL_REMOTE_GLOB.replace("/*", "");
/** Remote owner for work (gitlab) remotes: "gitlab.example.com" */
const WORK_REMOTE_OWNER = WORK_REMOTE_GLOB.replace("/*", "");

// Placeholder session IDs — all use the mandatory 00000000- prefix.
const SID_1 = "00000000-0000-0000-0000-000000000001";
const SID_2 = "00000000-0000-0000-0000-000000000002";
const SID_3 = "00000000-0000-0000-0000-000000000003";
const SID_4 = "00000000-0000-0000-0000-000000000004";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a ClusterInput with safe placeholder defaults; spread + override. */
function makeInput(overrides: Partial<ClusterInput> & Pick<ClusterInput, "sessionId">): ClusterInput {
  return {
    projectPath: `${WORK_DIR}/project-x`,
    repoUrl: null,
    ...overrides,
  };
}

/** Build a cost map from an array of [sessionId, cost] pairs. */
function costMap(entries: [string, number][]): Map<string, number> {
  return new Map(entries);
}

// ── Grouping by remote owner ──────────────────────────────────────────────────

describe("clusterProjects — grouping by remote owner", () => {
  it("groups two sessions with the same remote owner into one cluster", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/repo-a`,
        repoUrl: `https://github.com/example-org/repo-a.git`,
      }),
      makeInput({
        sessionId: SID_2,
        projectPath: `${WORK_DIR}/repo-b`,
        repoUrl: `git@github.com:example-org/repo-b.git`,
      }),
    ];

    const costs = costMap([
      [SID_1, 1.5],
      [SID_2, 0.5],
    ]);

    const result = clusterProjects(sessions, costs);

    expect(result).toHaveLength(1);
    const cluster = result[0]!;
    expect(cluster.key).toBe(PERSONAL_REMOTE_OWNER);
    expect(cluster.kind).toBe("remote");
    expect(cluster.label).toBe(PERSONAL_REMOTE_OWNER);
    expect(cluster.sessionCount).toBe(2);
    expect(cluster.estimatedCost).toBeCloseTo(2.0);
  });

  it("produces suggestedMatcher.remoteGlob = the EXACT owner for a remote cluster", () => {
    // The matcher must be the bare owner, NOT `owner + "/*"`: resolveOwner
    // matches remoteGlob against ownerOf(repoUrl), which is always
    // `host/firstSegment`, so an `owner + "/*"` glob would match nothing (see
    // the round-trip test below). The exact owner matches every repo under it.
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/repo-x`,
        repoUrl: `https://github.com/example-org/repo-x`,
      }),
    ];

    const result = clusterProjects(sessions, costMap([]));

    expect(result).toHaveLength(1);
    expect(result[0]!.suggestedMatcher).toEqual({
      remoteGlob: PERSONAL_REMOTE_OWNER,
    });
    expect(result[0]!.suggestedMatcher.pathGlob).toBeUndefined();
  });

  it("separates two different remote owners into two clusters", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/repo-a`,
        repoUrl: `https://github.com/example-org/repo-a`,
      }),
      makeInput({
        sessionId: SID_2,
        projectPath: `${PERSONAL_DIR}/repo-b`,
        repoUrl: `git@gitlab.example.com:example-group/repo-b.git`,
      }),
    ];

    const result = clusterProjects(sessions, costMap([]));
    expect(result).toHaveLength(2);

    const keys = result.map((c) => c.key);
    expect(keys).toContain(PERSONAL_REMOTE_OWNER); // github.com/example-org
    expect(keys).toContain("gitlab.example.com/example-group");
  });

  it("uses remote owner key even when projectPath parents differ", () => {
    // Two sessions in different local dirs but the same git remote org.
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/repo-x`,
        repoUrl: `https://github.com/example-org/repo-x`,
      }),
      makeInput({
        sessionId: SID_2,
        projectPath: `${PERSONAL_DIR}/repo-y`,
        repoUrl: `ssh://git@github.com/example-org/repo-y`,
      }),
    ];

    const result = clusterProjects(sessions, costMap([]));

    // Both under the same remote owner → one cluster, not two path clusters.
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("remote");
    expect(result[0]!.key).toBe(PERSONAL_REMOTE_OWNER);
  });
});

// ── Grouping by path parent ───────────────────────────────────────────────────

describe("clusterProjects — grouping by path parent when repoUrl is null", () => {
  it("groups two sessions under the same parent directory into one cluster", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/proj-a`,
        repoUrl: null,
      }),
      makeInput({
        sessionId: SID_2,
        projectPath: `${WORK_DIR}/proj-b`,
        repoUrl: null,
      }),
    ];

    const result = clusterProjects(sessions, costMap([]));

    expect(result).toHaveLength(1);
    const cluster = result[0]!;
    expect(cluster.key).toBe(WORK_DIR);
    expect(cluster.kind).toBe("path");
    expect(cluster.label).toBe(WORK_DIR);
    expect(cluster.sessionCount).toBe(2);
  });

  it("produces suggestedMatcher.pathGlob = parentDir + '/**' for a path cluster", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/proj-a`,
        repoUrl: null,
      }),
    ];

    const result = clusterProjects(sessions, costMap([]));

    expect(result).toHaveLength(1);
    expect(result[0]!.suggestedMatcher).toEqual({
      pathGlob: WORK_PATH_GLOB,
    });
    expect(result[0]!.suggestedMatcher.remoteGlob).toBeUndefined();
  });

  it("separates sessions under different parent directories", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/proj-a`,
        repoUrl: null,
      }),
      makeInput({
        sessionId: SID_2,
        projectPath: `${PERSONAL_DIR}/proj-b`,
        repoUrl: null,
      }),
    ];

    const result = clusterProjects(sessions, costMap([]));

    expect(result).toHaveLength(2);
    const keys = result.map((c) => c.key);
    expect(keys).toContain(WORK_DIR);
    expect(keys).toContain(PERSONAL_DIR);
  });

  it("falls back to path parent when repoUrl is present but ownerOf returns null (garbage URL)", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/proj-a`,
        repoUrl: "not-a-valid-url",
      }),
    ];

    const result = clusterProjects(sessions, costMap([]));

    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe("path");
    expect(result[0]!.key).toBe(WORK_DIR);
  });
});

// ── Cost ranking + key tiebreak ───────────────────────────────────────────────

describe("clusterProjects — cost ranking + key tiebreak", () => {
  it("sorts clusters by estimatedCost DESC", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${PERSONAL_DIR}/proj-a`,
        repoUrl: null,
      }),
      makeInput({
        sessionId: SID_2,
        projectPath: `${WORK_DIR}/proj-b`,
        repoUrl: null,
      }),
      makeInput({
        sessionId: SID_3,
        projectPath: "/home/user/side/proj-c",
        repoUrl: null,
      }),
    ];

    const costs = costMap([
      [SID_1, 1.0], // personal
      [SID_2, 5.0], // work — highest
      [SID_3, 2.5], // side
    ]);

    const result = clusterProjects(sessions, costs);

    expect(result).toHaveLength(3);
    expect(result[0]!.key).toBe(WORK_DIR);
    expect(result[0]!.estimatedCost).toBeCloseTo(5.0);
    expect(result[1]!.key).toBe("/home/user/side");
    expect(result[1]!.estimatedCost).toBeCloseTo(2.5);
    expect(result[2]!.key).toBe(PERSONAL_DIR);
    expect(result[2]!.estimatedCost).toBeCloseTo(1.0);
  });

  it("breaks cost ties alphabetically by key ASC", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: "/home/user/zzz-dir/proj",
        repoUrl: null,
      }),
      makeInput({
        sessionId: SID_2,
        projectPath: "/home/user/aaa-dir/proj",
        repoUrl: null,
      }),
    ];

    // Identical costs → tiebreak by key ASC
    const costs = costMap([
      [SID_1, 3.0],
      [SID_2, 3.0],
    ]);

    const result = clusterProjects(sessions, costs);

    expect(result).toHaveLength(2);
    // aaa-dir comes before zzz-dir alphabetically
    expect(result[0]!.key).toBe("/home/user/aaa-dir");
    expect(result[1]!.key).toBe("/home/user/zzz-dir");
  });

  it("mixes remote and path clusters ranked correctly by cost", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/repo-a`,
        repoUrl: `https://github.com/example-org/repo-a`,
      }),
      makeInput({
        sessionId: SID_2,
        projectPath: `${PERSONAL_DIR}/proj-b`,
        repoUrl: null,
      }),
    ];

    const costs = costMap([
      [SID_1, 0.5],  // remote — lower
      [SID_2, 10.0], // path — higher
    ]);

    const result = clusterProjects(sessions, costs);

    expect(result).toHaveLength(2);
    expect(result[0]!.kind).toBe("path");    // personal path wins by cost
    expect(result[0]!.estimatedCost).toBeCloseTo(10.0);
    expect(result[1]!.kind).toBe("remote");
    expect(result[1]!.estimatedCost).toBeCloseTo(0.5);
  });
});

// ── Distinct + sorted projectPaths ────────────────────────────────────────────

describe("clusterProjects — distinct + sorted projectPaths", () => {
  it("deduplicates projectPaths across sessions that share the same path", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/proj-a`,
        repoUrl: null,
      }),
      makeInput({
        sessionId: SID_2,
        // same projectPath as SID_1, different session
        projectPath: `${WORK_DIR}/proj-a`,
        repoUrl: null,
      }),
      makeInput({
        sessionId: SID_3,
        projectPath: `${WORK_DIR}/proj-b`,
        repoUrl: null,
      }),
    ];

    const result = clusterProjects(sessions, costMap([]));

    expect(result).toHaveLength(1);
    const cluster = result[0]!;
    expect(cluster.sessionCount).toBe(3); // 3 sessions
    expect(cluster.projectPaths).toHaveLength(2); // 2 distinct paths
    expect(cluster.projectPaths).toContain(`${WORK_DIR}/proj-a`);
    expect(cluster.projectPaths).toContain(`${WORK_DIR}/proj-b`);
  });

  it("returns projectPaths in ascending lexicographic order", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/zzz-proj`,
        repoUrl: null,
      }),
      makeInput({
        sessionId: SID_2,
        projectPath: `${WORK_DIR}/aaa-proj`,
        repoUrl: null,
      }),
      makeInput({
        sessionId: SID_3,
        projectPath: `${WORK_DIR}/mmm-proj`,
        repoUrl: null,
      }),
    ];

    const result = clusterProjects(sessions, costMap([]));

    expect(result).toHaveLength(1);
    expect(result[0]!.projectPaths).toEqual([
      `${WORK_DIR}/aaa-proj`,
      `${WORK_DIR}/mmm-proj`,
      `${WORK_DIR}/zzz-proj`,
    ]);
  });

  it("deduplicates projectPaths in a remote cluster spanning multiple repos", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/repo-a`,
        repoUrl: `https://github.com/example-org/repo-a`,
      }),
      makeInput({
        sessionId: SID_2,
        // same projectPath for repo-a, different session
        projectPath: `${WORK_DIR}/repo-a`,
        repoUrl: `https://github.com/example-org/repo-a`,
      }),
      makeInput({
        sessionId: SID_3,
        projectPath: `${WORK_DIR}/repo-b`,
        repoUrl: `git@github.com:example-org/repo-b.git`,
      }),
    ];

    const result = clusterProjects(sessions, costMap([]));

    expect(result).toHaveLength(1);
    expect(result[0]!.projectPaths).toHaveLength(2);
    expect(result[0]!.projectPaths).toEqual([
      `${WORK_DIR}/repo-a`,
      `${WORK_DIR}/repo-b`,
    ]);
  });
});

// ── Missing cost → 0 ─────────────────────────────────────────────────────────

describe("clusterProjects — missing cost entry defaults to 0", () => {
  it("treats a sessionId absent from costBySession as cost 0", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/proj-a`,
        repoUrl: null,
      }),
    ];

    // Completely empty cost map
    const result = clusterProjects(sessions, costMap([]));

    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedCost).toBe(0);
  });

  it("sums present costs and treats missing ones as 0 within the same cluster", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/proj-a`,
        repoUrl: null,
      }),
      makeInput({
        sessionId: SID_2,
        projectPath: `${WORK_DIR}/proj-b`,
        repoUrl: null,
      }),
      makeInput({
        sessionId: SID_3,
        projectPath: `${WORK_DIR}/proj-c`,
        repoUrl: null,
      }),
    ];

    // Only two of three sessions have costs
    const costs = costMap([
      [SID_1, 2.0],
      [SID_3, 1.5],
      // SID_2 is missing → treated as 0
    ]);

    const result = clusterProjects(sessions, costs);

    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedCost).toBeCloseTo(3.5);
  });
});

// ── Empty input ───────────────────────────────────────────────────────────────

describe("clusterProjects — empty input", () => {
  it("returns an empty array for an empty sessions list", () => {
    const result = clusterProjects([], new Map());
    expect(result).toEqual([]);
  });

  it("returns an empty array for an empty sessions list regardless of cost map content", () => {
    const costs = costMap([[SID_1, 99.0]]);
    const result = clusterProjects([], costs);
    expect(result).toEqual([]);
  });
});

// ── Additional edge cases ─────────────────────────────────────────────────────

describe("clusterProjects — edge cases", () => {
  it("a single session produces a single cluster with sessionCount 1", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/solo-proj`,
        repoUrl: null,
      }),
    ];

    const costs = costMap([[SID_1, 4.25]]);

    const result = clusterProjects(sessions, costs);

    expect(result).toHaveLength(1);
    expect(result[0]!.sessionCount).toBe(1);
    expect(result[0]!.estimatedCost).toBeCloseTo(4.25);
    expect(result[0]!.projectPaths).toEqual([`${WORK_DIR}/solo-proj`]);
  });

  it("handles an ssh:// remote with non-standard port (ownerOf normalises it)", () => {
    // WORK_REMOTE_GLOB = "gitlab.example.com/*" → owner = "gitlab.example.com"
    // The sub-group is the first path segment after the host.
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/repo-x`,
        repoUrl: `ssh://git@gitlab.example.com:2222/example-group/repo-x.git`,
      }),
    ];

    const result = clusterProjects(sessions, costMap([]));

    expect(result).toHaveLength(1);
    // ownerOf strips port → "gitlab.example.com/example-group"
    expect(result[0]!.kind).toBe("remote");
    expect(result[0]!.key).toBe(`${WORK_REMOTE_OWNER}/example-group`);
  });

  it("accumulates cost across multiple sessions in the same remote cluster", () => {
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${WORK_DIR}/repo-a`,
        repoUrl: `https://github.com/example-org/repo-a`,
      }),
      makeInput({
        sessionId: SID_2,
        projectPath: `${WORK_DIR}/repo-b`,
        repoUrl: `https://github.com/example-org/repo-b`,
      }),
      makeInput({
        sessionId: SID_3,
        projectPath: `${WORK_DIR}/repo-a`,
        repoUrl: `https://github.com/example-org/repo-a`,
      }),
    ];

    const costs = costMap([
      [SID_1, 1.0],
      [SID_2, 2.0],
      [SID_3, 3.0],
    ]);

    const result = clusterProjects(sessions, costs);

    expect(result).toHaveLength(1);
    expect(result[0]!.sessionCount).toBe(3);
    expect(result[0]!.estimatedCost).toBeCloseTo(6.0);
  });

  it("correctly builds suggestedMatcher for a gitlab remote cluster", () => {
    // A session whose remote maps to "gitlab.example.com/example-group" gets a
    // remoteGlob of exactly that owner (nested-group top segment), NOT
    // `.../example-group/*` — ownerOf never yields a segment past the group.
    const sessions: ClusterInput[] = [
      makeInput({
        sessionId: SID_1,
        projectPath: `${PERSONAL_DIR}/repo-p`,
        repoUrl: `git@gitlab.example.com:example-group/repo-p.git`,
      }),
    ];

    const result = clusterProjects(sessions, costMap([]));

    expect(result).toHaveLength(1);
    expect(result[0]!.suggestedMatcher).toEqual({
      remoteGlob: "gitlab.example.com/example-group",
    });
  });

  it("four sessions across two path dirs and two remote owners yields four clusters", () => {
    // Cluster map:
    //   SID_1 → github.com/example-org (remote), cost 3.0
    //   SID_2 → /home/user/personal   (path, no remote), cost 1.0
    //   SID_3 → gitlab.example.com/example-group (remote), cost 5.0
    //   SID_4 → /home/user/work       (path, no remote), cost 2.0
    // Expected order: gitlab (5.0), github (3.0), work (2.0), personal (1.0)
    const sessions: ClusterInput[] = [
      makeInput({ sessionId: SID_1, projectPath: `${WORK_DIR}/repo-a`, repoUrl: `https://github.com/example-org/repo-a` }),
      makeInput({ sessionId: SID_2, projectPath: `${PERSONAL_DIR}/proj-b`, repoUrl: null }),
      makeInput({ sessionId: SID_3, projectPath: `${PERSONAL_DIR}/repo-c`, repoUrl: `git@gitlab.example.com:example-group/repo-c.git` }),
      makeInput({ sessionId: SID_4, projectPath: `${WORK_DIR}/proj-d`, repoUrl: null }),
    ];

    const costs = costMap([
      [SID_1, 3.0],
      [SID_2, 1.0],
      [SID_3, 5.0],
      [SID_4, 2.0],
    ]);

    const result = clusterProjects(sessions, costs);

    expect(result).toHaveLength(4);
    // gitlab.example.com/example-group → 5.0 (highest)
    expect(result[0]!.key).toBe("gitlab.example.com/example-group");
    expect(result[0]!.estimatedCost).toBeCloseTo(5.0);
    // github.com/example-org → 3.0
    expect(result[1]!.key).toBe(PERSONAL_REMOTE_OWNER);
    expect(result[1]!.estimatedCost).toBeCloseTo(3.0);
    // /home/user/work (path) → 2.0
    expect(result[2]!.key).toBe(WORK_DIR);
    expect(result[2]!.estimatedCost).toBeCloseTo(2.0);
    // /home/user/personal (path) → 1.0
    expect(result[3]!.key).toBe(PERSONAL_DIR);
    expect(result[3]!.estimatedCost).toBeCloseTo(1.0);
  });
});

// ── Round-trip: suggested matcher actually resolves back to the cluster ────────
// Regression for the bug where remote clusters suggested `owner + "/*"`, which
// resolveOwner (matching against ownerOf() = host/firstSegment) never matched —
// so a rule built from the suggestion attributed NOTHING. Every suggested
// matcher MUST resolve the sessions of the cluster it came from.

describe("clusterProjects — suggested matcher round-trips through resolveOwner", () => {
  const cases: Array<{ name: string; sessions: ClusterInput[] }> = [
    {
      name: "github remote",
      sessions: [
        makeInput({ sessionId: SID_1, projectPath: `${WORK_DIR}/repo-a`, repoUrl: `https://github.com/example-org/repo-a.git` }),
        makeInput({ sessionId: SID_2, projectPath: `${PERSONAL_DIR}/repo-b`, repoUrl: `git@github.com:example-org/repo-b.git` }),
      ],
    },
    {
      name: "gitlab nested-group remote",
      sessions: [
        makeInput({ sessionId: SID_1, projectPath: `${WORK_DIR}/repo-p`, repoUrl: `git@gitlab.example.com:example-group/sub/repo-p.git` }),
      ],
    },
    {
      name: "path cluster (no remote)",
      sessions: [
        makeInput({ sessionId: SID_1, projectPath: `${WORK_DIR}/proj-a`, repoUrl: null }),
        makeInput({ sessionId: SID_2, projectPath: `${WORK_DIR}/proj-b`, repoUrl: null }),
      ],
    },
  ];

  for (const { name, sessions } of cases) {
    it(`${name}: a split rule from the suggestion matches every member session`, () => {
      const [cluster] = clusterProjects(sessions, costMap([]));
      expect(cluster).toBeDefined();
      const rule: OwnerRule = {
        id: 1,
        pathGlob: cluster!.suggestedMatcher.pathGlob ?? null,
        remoteGlob: cluster!.suggestedMatcher.remoteGlob ?? null,
        target: { kind: "split" },
        createdAt: 1,
      };
      for (const s of sessions) {
        const target = resolveOwner({ projectPath: s.projectPath, repoUrl: s.repoUrl }, [rule]);
        expect(target).toEqual({ kind: "split" });
      }
    });
  }
});
