/**
 * Abandoned spend — costly sessions that end in error with no continuation.
 *
 * Signal (efficiency-hygiene/README.md): task clusters above a cost threshold
 * ending failed with no successor. Escalation chains (the full task-boundary
 * engine that would let this measure sub-session task clusters precisely) are
 * explicitly deferred (constraint-impact Gap 3, "not load-bearing for v1"), so
 * this detector works at SESSION granularity instead: a session that (a) cost
 * real money, (b) ended on a message with a tool error — the model was mid
 * failure when the transcript stops — and (c) has no same-project session
 * starting again within a grace window afterward. That last condition is what
 * separates "abandoned" from "the developer kept going in a fresh session,"
 * which is completely normal and must not fire.
 *
 * Precision guard: a session that ends CLEANLY (no tool error on its last
 * message) never fires, however costly or however long the gap before the
 * next session — silence, not failure, needs no story. A session with a
 * same-project follow-up inside the grace window never fires either — that is
 * continuation, not abandonment.
 */
import type { HygieneFinding, HygieneThresholds, HygieneMessageRow } from "./types.js";
import { groupBySession, sumCost } from "./util.js";
import type { RateOverrides } from "../pricing.js";

export function detectAbandonedSpend(
  rows: readonly HygieneMessageRow[],
  thresholds: HygieneThresholds["abandonedSpend"],
  overrides?: RateOverrides,
): HygieneFinding[] {
  const groups = groupBySession(rows);

  // Bucket session start times by project so "any successor?" is a local
  // scan, not an O(n²) cross-project search.
  const startsByProject = new Map<string, number[]>();
  for (const g of groups) {
    const first = g.messages.find((m) => m.timestamp != null)?.timestamp;
    if (first == null) continue;
    const list = startsByProject.get(g.projectPath) ?? [];
    list.push(first);
    startsByProject.set(g.projectPath, list);
  }
  for (const list of startsByProject.values()) list.sort((a, b) => a - b);

  const findings: HygieneFinding[] = [];
  for (const g of groups) {
    // `g.messages` is never empty — `groupBySession` only creates a group
    // when at least one row was assigned to it (see util.ts).
    const last = g.messages[g.messages.length - 1]!;
    if (last.toolErrorCount <= 0) continue; // ended cleanly — not this detector's business
    if (last.timestamp == null) continue;

    const cost = sumCost(g.messages, overrides);
    if (cost < thresholds.minCost) continue;

    // `startsByProject` always has an entry for this project: `last.timestamp`
    // being non-null (checked above) means this very session already
    // contributed its own first-non-null timestamp to the bucket above.
    const starts = startsByProject.get(g.projectPath)!;
    const hasSuccessor = starts.some(
      (t) => t > last.timestamp! && t <= last.timestamp! + thresholds.graceMs,
    );
    if (hasSuccessor) continue;

    findings.push({
      detectorId: "abandoned-spend",
      sessionIds: [g.sessionId],
      estimatedWaste: cost,
      rule: "The session's last message has a failed tool call, cost is at or above threshold, and no same-project session starts within the grace window afterward.",
      threshold: `≥$${thresholds.minCost.toFixed(2)} session cost, no same-project follow-up within ${Math.round(thresholds.graceMs / 60_000)} min`,
      remedy: "Review what stalled the task before spending more on it; consider a smaller scope next attempt.",
      detail: `Session ended on a failed tool call; cost ${cost.toFixed(2)}; no follow-up in this project within the grace window.`,
    });
  }
  return findings;
}
