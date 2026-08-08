/**
 * Retry loop — turns burned on repeatedly failing tool calls.
 *
 * Signal (efficiency-hygiene/README.md): dense runs of `tool_error_count`
 * within a session — the developer (or the model) kept re-attempting the same
 * broken operation instead of stopping.
 *
 * Precision guard: an ISOLATED error is normal — most sessions have one
 * somewhere. Only a RUN of `minRunLength` (default 3) *consecutive* messages
 * each carrying at least one tool error counts; a single error surrounded by
 * clean turns never fires, however many total errors the session has.
 */
import type { HygieneFinding, HygieneThresholds, HygieneMessageRow } from "./types.js";
import { groupBySession, sumCost } from "./util.js";
import type { RateOverrides } from "../pricing.js";

export function detectRetryLoop(
  rows: readonly HygieneMessageRow[],
  thresholds: HygieneThresholds["retryLoop"],
  overrides?: RateOverrides,
): HygieneFinding[] {
  const findings: HygieneFinding[] = [];
  for (const group of groupBySession(rows)) {
    let runStart = -1;
    const runs: HygieneMessageRow[][] = [];
    for (let i = 0; i < group.messages.length; i++) {
      const errored = group.messages[i]!.toolErrorCount > 0;
      if (errored) {
        if (runStart === -1) runStart = i;
      } else if (runStart !== -1) {
        runs.push(group.messages.slice(runStart, i));
        runStart = -1;
      }
    }
    if (runStart !== -1) runs.push(group.messages.slice(runStart));

    const qualifying = runs.filter((r) => r.length >= thresholds.minRunLength);
    if (qualifying.length === 0) continue;

    const longest = qualifying.reduce((a, b) => (b.length > a.length ? b : a));
    const allQualifyingMessages = qualifying.flat();
    const totalErrors = allQualifyingMessages.reduce((n, m) => n + m.toolErrorCount, 0);

    findings.push({
      detectorId: "retry-loop",
      sessionIds: [group.sessionId],
      estimatedWaste: sumCost(allQualifyingMessages, overrides),
      rule: "A run of consecutive messages, each with at least one failed tool call, is at or above threshold length.",
      threshold: `≥${thresholds.minRunLength} consecutive messages with tool errors`,
      remedy: "Stop and fix the environment or escalate the model tier for the stuck step, rather than retrying blind.",
      detail: `Longest run: ${longest.length} consecutive messages with tool errors (${totalErrors} failed calls total across ${qualifying.length} run${qualifying.length === 1 ? "" : "s"}).`,
    });
  }
  return findings;
}
