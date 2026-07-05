/**
 * Project clustering for the guided classifier (doc 10) — PURE, CLOCKLESS.
 *
 * Groups projects by their natural owner-signals (shallow path root + parsed
 * git-remote owner) and ranks clusters by cost, so a user classifies a handful
 * of high-$ clusters instead of hundreds of sessions. No I/O, no clock.
 */
import path from "node:path";
import type { ProjectCluster } from "@claude-stats/core/types";
import { ownerOf } from "./ownership.js";

/** A session reduced to what clustering needs (no store dependency). */
export interface ClusterInput {
  sessionId: string;
  projectPath: string;
  repoUrl: string | null;
}

/** Per-cluster accumulator during grouping. */
interface ClusterAcc {
  key: string;
  kind: "path" | "remote";
  label: string;
  suggestedMatcher: { pathGlob?: string; remoteGlob?: string };
  sessionIds: string[];
  projectPathSet: Set<string>;
}

/**
 * Cluster the given sessions' projects and rank by cost.
 *
 * Cluster key: if `repoUrl` is non-null and `ownerOf(repoUrl)` resolves to a
 * non-null string, the cluster key is that owner string (kind="remote");
 * otherwise, the key is the POSIX parent directory of `projectPath`
 * (kind="path").
 *
 * `costBySession` maps sessionId → estimated cost; missing entries treated as 0.
 *
 * Output is sorted by estimatedCost DESC, then key ASC (deterministic
 * tiebreak). Pure, no clock, no I/O.
 */
export function clusterProjects(
  sessions: ClusterInput[],
  costBySession: Map<string, number>,
): ProjectCluster[] {
  if (sessions.length === 0) return [];

  const byKey = new Map<string, ClusterAcc>();

  for (const session of sessions) {
    const owner = session.repoUrl != null ? ownerOf(session.repoUrl) : null;

    let key: string;
    let kind: "path" | "remote";
    let label: string;
    let suggestedMatcher: { pathGlob?: string; remoteGlob?: string };

    if (owner != null) {
      key = owner;
      kind = "remote";
      label = owner;
      // The matcher is the EXACT owner string, not `owner + "/*"`. resolveOwner
      // matches remoteGlob against ownerOf(repoUrl), which is always
      // `host/firstSegment` with no repo segment — so `owner + "/*"` (which
      // needs a segment after the owner) would match NOTHING, and a rule built
      // from it would silently attribute nothing. The exact owner matches every
      // repo under that owner (they all normalise to the same owner string) and
      // ranks in the wildcard-free specificity tier. See the round-trip test in
      // clustering.test.ts.
      suggestedMatcher = { remoteGlob: owner };
    } else {
      // Use POSIX dirname of the project path.
      // path.posix.dirname handles both absolute and relative POSIX paths.
      const parentDir = path.posix.dirname(session.projectPath);
      key = parentDir;
      kind = "path";
      label = parentDir;
      suggestedMatcher = { pathGlob: parentDir + "/**" };
    }

    let acc = byKey.get(key);
    if (acc == null) {
      acc = {
        key,
        kind,
        label,
        suggestedMatcher,
        sessionIds: [],
        projectPathSet: new Set<string>(),
      };
      byKey.set(key, acc);
    }

    acc.sessionIds.push(session.sessionId);
    acc.projectPathSet.add(session.projectPath);
  }

  const clusters: ProjectCluster[] = [];

  for (const acc of byKey.values()) {
    const estimatedCost = acc.sessionIds.reduce(
      (sum, id) => sum + (costBySession.get(id) ?? 0),
      0,
    );

    const projectPaths = Array.from(acc.projectPathSet).sort();

    clusters.push({
      key: acc.key,
      kind: acc.kind,
      label: acc.label,
      projectPaths,
      sessionCount: acc.sessionIds.length,
      estimatedCost,
      suggestedMatcher: acc.suggestedMatcher,
    });
  }

  // Sort by estimatedCost DESC, then key ASC (deterministic tiebreak).
  clusters.sort((a, b) => {
    if (b.estimatedCost !== a.estimatedCost) {
      return b.estimatedCost - a.estimatedCost;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return clusters;
}
