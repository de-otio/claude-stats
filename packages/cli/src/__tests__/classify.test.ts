/**
 * Guided-classification core tests — the pure `enrichClusters` / `planApply`
 * behind the extension's Classify panel.
 *
 * Determinism: synthetic fixtures only. Paths follow /home/user/…, remotes use
 * github.com/example-org and gitlab.example.com, accounts use the 00000000-
 * prefix UUIDs from fixtures/accounts. No real paths, org names, or UUIDs, and
 * no I/O — the module is pure. Never reads ~/.claude*, the live stats.db, or the
 * claude-stats MCP.
 */
import { describe, it, expect } from "vitest";
import { enrichClusters, planApply } from "../attribution/classify.js";
import type { ClassifyAssignment } from "../attribution/classify.js";
import type { OwnerRule, ProjectCluster } from "@claude-stats/core/types";
import {
  ACCOUNT_A_UUID,
  ACCOUNT_B_UUID,
  makeOwnerRule,
} from "./fixtures/accounts.js";

// ── cluster builders (mirror clusterProjects output, exact-owner matcher) ──────

function pathCluster(overrides: Partial<ProjectCluster> = {}): ProjectCluster {
  return {
    key: "/home/user/work",
    kind: "path",
    label: "/home/user/work",
    projectPaths: ["/home/user/work/app"],
    sessionCount: 1,
    estimatedCost: 10,
    suggestedMatcher: { pathGlob: "/home/user/work/**" },
    ...overrides,
  };
}

function remoteCluster(overrides: Partial<ProjectCluster> = {}): ProjectCluster {
  return {
    key: "github.com/example-org",
    kind: "remote",
    label: "github.com/example-org",
    projectPaths: ["/home/user/anywhere/repo"],
    sessionCount: 1,
    estimatedCost: 5,
    suggestedMatcher: { remoteGlob: "github.com/example-org" },
    ...overrides,
  };
}

const A = { kind: "account", accountUuid: ACCOUNT_A_UUID } as const;
const B = { kind: "account", accountUuid: ACCOUNT_B_UUID } as const;
const SPLIT = { kind: "split" } as const;

// ── enrichClusters ────────────────────────────────────────────────────────────

describe("enrichClusters", () => {
  it("empty clusters → empty array", () => {
    expect(enrichClusters([], [makeOwnerRule()])).toEqual([]);
  });

  it("no matching rule → currentTarget null, ownRuleId null", () => {
    const [c] = enrichClusters([pathCluster()], []);
    expect(c!.currentTarget).toBeNull();
    expect(c!.ownRuleId).toBeNull();
  });

  it("path cluster matched by its own path rule → currentTarget + ownRuleId", () => {
    const rule = makeOwnerRule({ id: 7, pathGlob: "/home/user/work/**", remoteGlob: null, target: A });
    const [c] = enrichClusters([pathCluster()], [rule]);
    expect(c!.currentTarget).toEqual(A);
    expect(c!.ownRuleId).toBe(7);
  });

  it("remote cluster matched by the EXACT-owner rule → currentTarget + ownRuleId", () => {
    const rule = makeOwnerRule({ id: 9, pathGlob: null, remoteGlob: "github.com/example-org", target: B });
    const [c] = enrichClusters([remoteCluster()], [rule]);
    expect(c!.currentTarget).toEqual(B);
    expect(c!.ownRuleId).toBe(9);
  });

  it("split target resolves as currentTarget {kind:'split'}", () => {
    const rule = makeOwnerRule({ id: 3, pathGlob: "/home/user/work/**", remoteGlob: null, target: SPLIT });
    const [c] = enrichClusters([pathCluster()], [rule]);
    expect(c!.currentTarget).toEqual(SPLIT);
    expect(c!.ownRuleId).toBe(3);
  });

  it("governed by a broader rule with a DIFFERENT matcher → currentTarget set but ownRuleId null", () => {
    // A path rule one level up governs the cluster, but it is not the cluster's
    // own suggested matcher, so there is no own-rule to replace/unassign.
    const broader = makeOwnerRule({ id: 5, pathGlob: "/home/user/**", remoteGlob: null, target: A });
    const [c] = enrichClusters([pathCluster()], [broader]);
    expect(c!.currentTarget).toEqual(A);
    expect(c!.ownRuleId).toBeNull();
  });

  it("ownRuleId is the exact-matcher rule even when another rule also resolves", () => {
    const broader = makeOwnerRule({ id: 5, pathGlob: "/home/user/**", remoteGlob: null, target: A, createdAt: 2 });
    const own = makeOwnerRule({ id: 8, pathGlob: "/home/user/work/**", remoteGlob: null, target: B, createdAt: 1 });
    const [c] = enrichClusters([pathCluster()], [broader, own]);
    // resolveOwner: exact-tier "/home/user/work/**" (id 8) is more specific → B.
    expect(c!.currentTarget).toEqual(B);
    expect(c!.ownRuleId).toBe(8);
  });

  it("preserves the base ProjectCluster fields", () => {
    const [c] = enrichClusters([pathCluster({ estimatedCost: 42, sessionCount: 3 })], []);
    expect(c!.estimatedCost).toBe(42);
    expect(c!.sessionCount).toBe(3);
    expect(c!.suggestedMatcher).toEqual({ pathGlob: "/home/user/work/**" });
  });

  it("first rule wins the own-rule slot when two rules share a matcher", () => {
    const r1 = makeOwnerRule({ id: 11, pathGlob: "/home/user/work/**", remoteGlob: null, target: A });
    const r2 = makeOwnerRule({ id: 12, pathGlob: "/home/user/work/**", remoteGlob: null, target: A });
    const [c] = enrichClusters([pathCluster()], [r1, r2]);
    expect(c!.ownRuleId).toBe(11);
  });
});

// ── planApply ─────────────────────────────────────────────────────────────────

describe("planApply", () => {
  it("assign a cluster with no existing rule → create one, delete none", () => {
    const a: ClassifyAssignment = { suggestedMatcher: { pathGlob: "/home/user/work/**" }, target: A };
    const plan = planApply([a], []);
    expect(plan.toDelete).toEqual([]);
    expect(plan.toCreate).toEqual([{ pathGlob: "/home/user/work/**", remoteGlob: null, target: A }]);
  });

  it("reassign a cluster with an existing same-matcher rule → delete old, create new", () => {
    const existing: OwnerRule = makeOwnerRule({ id: 4, pathGlob: "/home/user/work/**", remoteGlob: null, target: A });
    const a: ClassifyAssignment = { suggestedMatcher: { pathGlob: "/home/user/work/**" }, target: B };
    const plan = planApply([a], [existing]);
    expect(plan.toDelete).toEqual([4]);
    expect(plan.toCreate).toEqual([{ pathGlob: "/home/user/work/**", remoteGlob: null, target: B }]);
  });

  it("unassign (target null) with an existing rule → delete only", () => {
    const existing: OwnerRule = makeOwnerRule({ id: 6, pathGlob: "/home/user/work/**", remoteGlob: null, target: A });
    const a: ClassifyAssignment = { suggestedMatcher: { pathGlob: "/home/user/work/**" }, target: null };
    const plan = planApply([a], [existing]);
    expect(plan.toDelete).toEqual([6]);
    expect(plan.toCreate).toEqual([]);
  });

  it("unassign with NO existing rule → no-op", () => {
    const a: ClassifyAssignment = { suggestedMatcher: { pathGlob: "/home/user/work/**" }, target: null };
    const plan = planApply([a], []);
    expect(plan.toDelete).toEqual([]);
    expect(plan.toCreate).toEqual([]);
  });

  it("remote matcher → creates a remote-glob rule (pathGlob null)", () => {
    const a: ClassifyAssignment = { suggestedMatcher: { remoteGlob: "github.com/example-org" }, target: SPLIT };
    const plan = planApply([a], []);
    expect(plan.toCreate).toEqual([{ pathGlob: null, remoteGlob: "github.com/example-org", target: SPLIT }]);
  });

  it("batch across path + remote clusters aggregates correctly", () => {
    const existingPath: OwnerRule = makeOwnerRule({ id: 1, pathGlob: "/home/user/work/**", remoteGlob: null, target: A });
    const assignments: ClassifyAssignment[] = [
      { suggestedMatcher: { pathGlob: "/home/user/work/**" }, target: B }, // replace id 1
      { suggestedMatcher: { remoteGlob: "github.com/example-org" }, target: A }, // new
      { suggestedMatcher: { pathGlob: "/home/user/personal/**" }, target: null }, // no-op (no existing)
    ];
    const plan = planApply(assignments, [existingPath]);
    expect(plan.toDelete).toEqual([1]);
    expect(plan.toCreate).toEqual([
      { pathGlob: "/home/user/work/**", remoteGlob: null, target: B },
      { pathGlob: null, remoteGlob: "github.com/example-org", target: A },
    ]);
  });

  it("last assignment wins when the same matcher appears twice in a batch", () => {
    const assignments: ClassifyAssignment[] = [
      { suggestedMatcher: { pathGlob: "/home/user/work/**" }, target: A },
      { suggestedMatcher: { pathGlob: "/home/user/work/**" }, target: B },
    ];
    const plan = planApply(assignments, []);
    expect(plan.toDelete).toEqual([]);
    expect(plan.toCreate).toEqual([{ pathGlob: "/home/user/work/**", remoteGlob: null, target: B }]);
  });

  it("last-wins can collapse to a no-op (assign then unassign the same matcher)", () => {
    const existing: OwnerRule = makeOwnerRule({ id: 2, pathGlob: "/home/user/work/**", remoteGlob: null, target: A });
    const assignments: ClassifyAssignment[] = [
      { suggestedMatcher: { pathGlob: "/home/user/work/**" }, target: B },
      { suggestedMatcher: { pathGlob: "/home/user/work/**" }, target: null },
    ];
    const plan = planApply(assignments, [existing]);
    expect(plan.toDelete).toEqual([2]); // the stale rule still goes
    expect(plan.toCreate).toEqual([]); // final target null → nothing created
  });

  it("ignores an assignment with no matcher at all", () => {
    const a = { suggestedMatcher: {}, target: A } as ClassifyAssignment;
    const plan = planApply([a], []);
    expect(plan.toDelete).toEqual([]);
    expect(plan.toCreate).toEqual([]);
  });

  it("empty batch → empty plan", () => {
    const plan = planApply([], [makeOwnerRule()]);
    expect(plan.toDelete).toEqual([]);
    expect(plan.toCreate).toEqual([]);
  });
});
