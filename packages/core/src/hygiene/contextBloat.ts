/**
 * Context bloat — sustained very high input per turn for little output.
 *
 * Signal (efficiency-hygiene/README.md): a turn's total input (fresh input +
 * both cache columns — the full context fed to the model, whatever fraction
 * of it was cached) is huge relative to what came back out. One big turn is
 * often legitimate (a large but necessary file load); a SUSTAINED pattern of
 * them is the shape of "load the whole file/tree every turn" rather than
 * scoped reads.
 *
 * Precision guard: `minOccurrences` (default 3) requires the pattern to
 * repeat within the session — a single oversized turn never fires.
 */
import type { HygieneFinding, HygieneThresholds, HygieneMessageRow } from "./types.js";
import { groupBySession, sumCost } from "./util.js";
import type { RateOverrides } from "../pricing.js";

export function detectContextBloat(
  rows: readonly HygieneMessageRow[],
  thresholds: HygieneThresholds["contextBloat"],
  overrides?: RateOverrides,
): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  for (const group of groupBySession(rows)) {
    const flagged: HygieneMessageRow[] = [];
    for (const m of group.messages) {
      const totalInput = m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens;
      // totalInput <= 0 guards the division below — reachable only if a
      // caller configures `minTurnInputTokens` down to 0, since token counts
      // are never negative.
      if (totalInput <= 0 || totalInput < thresholds.minTurnInputTokens) continue;
      const outputRatio = m.outputTokens / totalInput;
      if (outputRatio > thresholds.maxOutputRatio) continue;
      flagged.push(m);
    }
    if (flagged.length < thresholds.minOccurrences) continue;

    const avgInput = Math.round(
      flagged.reduce((n, m) => n + m.inputTokens + m.cacheReadTokens + m.cacheCreationTokens, 0) / flagged.length,
    );

    findings.push({
      detectorId: "context-bloat",
      sessionIds: [group.sessionId],
      estimatedWaste: sumCost(flagged, overrides),
      rule: "A turn's total input tokens (fresh + cached) are at or above threshold while output stays at or below a low fraction of it, repeated within the session.",
      threshold: `≥${thresholds.minTurnInputTokens.toLocaleString()} input tokens, ≤${Math.round(thresholds.maxOutputRatio * 100)}% output ratio, ≥${thresholds.minOccurrences} turns`,
      remedy: "Trim context before the turn — scoped reads instead of whole-file/whole-tree loads.",
      detail: `${flagged.length} oversized, low-yield turns, averaging ${avgInput.toLocaleString()} input tokens each.`,
    });
  }
  return findings;
}
