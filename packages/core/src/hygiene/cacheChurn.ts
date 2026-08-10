/**
 * Cache churn — context paid for repeatedly but rarely read back.
 *
 * Signal (efficiency-hygiene/README.md): a high cache-creation vs cache-read
 * ratio within a session. Every cache write is billed at the write rate
 * (pricier than a plain input token); a session that keeps re-writing instead
 * of reading back an existing prefix is paying that premium over and over for
 * no benefit.
 *
 * Precision guard: a session with only 1-2 turns naturally has little or no
 * cache read yet — there has been no SECOND turn to read the first turn's
 * write back on. That is not churn, it's just early. `minMessages` excludes
 * it. `minCacheCreationTokens` excludes trivial sessions where the ratio is
 * high only because everything is small.
 */
import { estimateCost, type CacheWriteSplit, type RateOverrides } from "../pricing.js";
import type { HygieneFinding, HygieneThresholds } from "./types.js";
import { groupBySession, groupNum } from "./util.js";
import type { HygieneMessageRow } from "./types.js";

export function detectCacheChurn(
  rows: readonly HygieneMessageRow[],
  thresholds: HygieneThresholds["cacheChurn"],
  overrides?: RateOverrides,
): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  for (const group of groupBySession(rows)) {
    if (group.messages.length < thresholds.minMessages) continue;

    let creation = 0;
    let read = 0;
    let creationCost = 0;
    for (const m of group.messages) {
      creation += m.cacheCreationTokens;
      read += m.cacheReadTokens;
      if (m.model && m.cacheCreationTokens > 0) {
        // This is the one detector that calls `estimateCost` directly instead
        // of going through `messageCost` (cache-ttl-fit B3/#1) — its entire
        // subject is cache-write cost, so it is the last place a missing TTL
        // split would leave a detector silently priced on the old 5-minute-
        // only basis inside a payload (`hygieneRatio`) that sums all six
        // detectors together.
        const ttlSplit: CacheWriteSplit = {
          ephemeral5mCacheTokens: m.ephemeral5mCacheTokens,
          ephemeral1hCacheTokens: m.ephemeral1hCacheTokens,
        };
        creationCost += estimateCost(m.model, 0, 0, 0, m.cacheCreationTokens, overrides, ttlSplit).cost;
      }
    }
    if (creation < thresholds.minCacheCreationTokens) continue;

    const ratio = creation / (creation + read);
    if (ratio < thresholds.ratio) continue;

    // Excess over the threshold ratio, applied to the creation cost — a
    // conservative partial estimate, not "the whole write was wasted".
    const excessShare = (ratio - thresholds.ratio) / (1 - thresholds.ratio);
    const estimatedWaste = creationCost * Math.max(0, Math.min(1, excessShare));

    findings.push({
      detectorId: "cache-churn",
      sessionIds: [group.sessionId],
      estimatedWaste,
      rule: "Cache-creation tokens are ≥ threshold and creation/(creation+read) ratio is at or above threshold across the session.",
      threshold: `≥${groupNum(thresholds.minCacheCreationTokens)} cache-creation tokens, ≥${Math.round(thresholds.ratio * 100)}% creation ratio, ≥${thresholds.minMessages} messages`,
      remedy: "Keep this session alive across turns instead of restarting it, and batch config edits that invalidate the prompt prefix.",
      detail: `${groupNum(creation)} cache-creation tokens vs ${groupNum(read)} cache-read tokens (${Math.round(ratio * 100)}% creation) over ${group.messages.length} messages.`,
    });
  }
  return findings;
}
