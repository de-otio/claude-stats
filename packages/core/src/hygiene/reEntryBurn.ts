/**
 * Re-entry burn — cache-creation spikes on resume after a gap.
 *
 * Signal (efficiency-hygiene/README.md): after an idle gap (throttle wait,
 * window boundary, or just stepping away), the resuming turn has to rebuild
 * the prompt cache from scratch, paying the write premium again for context
 * that was free to read a moment earlier. This one is explicitly framed as
 * "partly the org's cost, not the dev's" — a throttle-driven gap isn't the
 * developer's choice — but it is still a recoverable pattern worth surfacing
 * (schedule around limits; see constraint-impact/01).
 *
 * Precision guard: a gap that DIDN'T force a rebuild (cache_creation stayed 0
 * or small on the resuming message — the prefix was still warm) is not a
 * finding; only a gap immediately followed by an actual large re-write fires.
 */
import type { HygieneFinding, HygieneThresholds, HygieneMessageRow } from "./types.js";
import { groupBySession, messageCost } from "./util.js";
import type { RateOverrides } from "../pricing.js";

export function detectReEntryBurn(
  rows: readonly HygieneMessageRow[],
  thresholds: HygieneThresholds["reEntryBurn"],
  overrides?: RateOverrides,
): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  for (const group of groupBySession(rows)) {
    const spikes: Array<{ row: HygieneMessageRow; gapMs: number }> = [];
    for (let i = 1; i < group.messages.length; i++) {
      const prev = group.messages[i - 1]!;
      const cur = group.messages[i]!;
      if (prev.timestamp == null || cur.timestamp == null) continue;
      const gapMs = cur.timestamp - prev.timestamp;
      if (gapMs < thresholds.minGapMs) continue;
      if (cur.cacheCreationTokens < thresholds.minCacheCreationTokens) continue;
      spikes.push({ row: cur, gapMs });
    }
    if (spikes.length === 0) continue;

    const totalWaste = spikes.reduce((n, s) => n + messageCost({ ...s.row, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, overrides), 0);
    const longestGapMin = Math.round(Math.max(...spikes.map((s) => s.gapMs)) / 60_000);

    findings.push({
      detectorId: "re-entry-burn",
      sessionIds: [group.sessionId],
      estimatedWaste: totalWaste,
      rule: "The message right after an idle gap of at least the threshold has cache-creation tokens at or above the threshold (the cache had gone cold and had to be rebuilt).",
      threshold: `≥${Math.round(thresholds.minGapMs / 60_000)} min idle gap, ≥${thresholds.minCacheCreationTokens.toLocaleString()} cache-creation tokens on resume`,
      remedy: "Schedule work around throttle windows where possible, and expect the first turn after a long gap to cost more.",
      detail: `${spikes.length} re-entry spike${spikes.length === 1 ? "" : "s"}, longest gap ${longestGapMin} min.`,
    });
  }
  return findings;
}
