/**
 * Re-entry burn — cache-creation spikes on resume after a gap.
 *
 * Signal (efficiency-hygiene/README.md): after an idle gap (throttle wait,
 * window boundary, or just stepping away), the resuming turn has to rebuild
 * the prompt cache from scratch, paying the write premium again for context
 * that was free to read a moment earlier. This one is explicitly framed as
 * "partly the org's cost, not the dev's" — a throttle-driven gap isn't the
 * developer's choice — but it is still a recoverable pattern worth surfacing
 * (schedule around limits; see constraint-impact/01) IF a different TTL
 * setting or a rescheduled gap would actually have prevented the rebuild.
 *
 * Precision guard: a gap that DIDN'T force a rebuild (cache_creation stayed 0
 * or small on the resuming message — the prefix was still warm) is not a
 * finding; only a gap immediately followed by an actual large re-write fires.
 *
 * `minGapMs`'s DEFAULT (not the contract — an explicit config value still
 * wins) is derived by the caller (`hygiene/index.ts`) from `observedTtlOf`:
 * under a workload actually recorded at the 1-hour TTL, a gap has to reach
 * 60 minutes before a rebuild is the TTL's doing rather than something else;
 * under a 5-minute TTL, 5 minutes is enough. That shorter default is exactly
 * the over-fire risk (cache-ttl-fit B3/#3): almost every ordinary think-pause
 * on a 5-minute-TTL workload clears a 5-minute gap, so `minCacheCreationTokens`
 * must scale up in step (also the caller's job) or this detector floods a
 * digest with routine pauses dressed up as waste.
 */
import type { HygieneFinding, HygieneThresholds, HygieneMessageRow } from "./types.js";
import { groupBySession, groupNum, messageCost, observedTtlOf } from "./util.js";
import type { RateOverrides } from "../pricing.js";

/**
 * A gap at or beyond this is cold under EITHER TTL — no cache-TTL
 * configuration would have kept the prefix warm across it, so the remedy
 * must not pretend a TTL change (or, by extension, scheduling around a TTL)
 * would have helped. Matches `ttlFit.ts`'s `longTtlMs` default (60 minutes);
 * duplicated as a local constant rather than imported because `ttlFit.ts`
 * exposes it only as a tunable option default, not a shared constant, and
 * this module must stay independent of that one (functional-core boundary —
 * neither detector may depend on the other's implementation).
 */
const LONG_TTL_MS = 60 * 60 * 1000;

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

    // The threshold shown to the reader must match the one actually applied —
    // this session's finding always quotes `thresholds.minGapMs`/
    // `minCacheCreationTokens`, whichever default (or override) produced them.
    const gapThresholdMin = Math.round(thresholds.minGapMs / 60_000);

    // Bare TTL token, no id, no path — `HygieneFinding.detail`'s contract.
    // Computed over this session's own rows: a session flagged under a
    // mixed/overall workload may itself be purely "5m" or "1h".
    const ttlAtDetection = observedTtlOf(group.messages);

    // Remedy branches (cache-ttl-fit B3/#5): a rebuild that a different TTL
    // setting would have prevented gets the actionable sentence; a gap
    // beyond ANY TTL's reach gets one that does not pretend scheduling (or a
    // TTL change) would have helped. At least one spike under `LONG_TTL_MS`
    // means at least one rebuild in this session was, in principle,
    // avoidable by a longer TTL.
    const anyPreventable = spikes.some((s) => s.gapMs < LONG_TTL_MS);
    const remedy = anyPreventable
      ? "A longer cache TTL (or scheduling work to avoid the idle gap) would likely have kept this context warm — consider the 1-hour TTL for this workload if the 5-minute one is active."
      : "This gap is longer than any available cache TTL, so no TTL setting would have prevented the rebuild — the cost reflects idle time, not a caching choice.";

    findings.push({
      detectorId: "re-entry-burn",
      sessionIds: [group.sessionId],
      estimatedWaste: totalWaste,
      rule: "The message right after an idle gap of at least the threshold has cache-creation tokens at or above the threshold (the cache had gone cold and had to be rebuilt).",
      threshold: `≥${gapThresholdMin} min idle gap, ≥${groupNum(thresholds.minCacheCreationTokens)} cache-creation tokens on resume`,
      remedy,
      detail: `${spikes.length} re-entry spike${spikes.length === 1 ? "" : "s"}, longest gap ${longestGapMin} min, ttlAtDetection: ${ttlAtDetection}.`,
    });
  }
  return findings;
}
