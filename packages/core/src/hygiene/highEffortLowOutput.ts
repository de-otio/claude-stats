/**
 * High effort, low output — long runs at a high reasoning-effort tier whose
 * turns are mostly short tool calls (polling, listing, reading), where a lower
 * tier or a cheaper model would likely do (#125 PR 3, B3).
 *
 * A **run** is a maximal stretch of consecutive turns in one session whose
 * effort is at or above `high` in the D1 order (`high < xhigh < max`). A turn
 * with a lower tier, an unknown tier (`"turbo"`) or no reported effort ends the
 * run: absence is never read as high effort, and an unknown tier is never
 * assumed to rank above `high`.
 *
 * A run fires when ALL of these hold (thresholds from check V5(b), which
 * supersede the #125 plan's first candidates; 18 runs / 0.91% of high+ effort
 * sessions, 7/9 hand-read precision):
 *   1. at least `minRunTurns` turns (20);
 *   2. at least `minToolTurnShare` of them invoke a tool (0.8);
 *   3. the MEDIAN output tokens per turn is at most `maxMedianOutputTokens`
 *      (500) — the median so one long answer does not hide a polling run;
 *   4. the run contains no Edit / Write / MultiEdit / NotebookEdit / Agent /
 *      StructuredOutput call: work that edits files, delegates, or returns
 *      structured output is not "polling", whatever its per-turn output.
 *
 * EXCLUDED ROWS: every subagent row written by Claude Code before 2.1.307, not
 * only rows `isPlaceholderOutput` flags. V5 found placeholder `output_tokens`
 * on subagent rows beyond that predicate, and a run of understated outputs
 * would read as "low output" by construction. A top-level (non-subagent) row of
 * the same version is a real measurement and is kept.
 *
 * `estimatedWaste` is 0 (the #125 plan's Q1 option (a)): there is no
 * calibration for what a lower tier would have cost on the same turns, so the
 * detector reports the run's measured cost in `detail` and claims no saving.
 * That keeps `hygieneRatio` free of a guessed number.
 *
 * Pure; no I/O.
 */
import type { RateOverrides } from "../pricing.js";
import { KNOWN_EFFORT_ORDER } from "../effort.js";
import { PLACEHOLDER_FIXED_IN, isVersionBefore } from "./placeholderOutput.js";
import { formatMoney } from "../insight.js";
import { groupBySession, sumCost } from "./util.js";
import type { HygieneFinding, HygieneMessageRow, HygieneThresholds } from "./types.js";

/** Tool calls that mark a run as doing work rather than polling. `Task` is the
 *  pre-rename name of `Agent` in older transcripts. */
const DISQUALIFYING_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Agent",
  "Task",
  "StructuredOutput",
]);

const HIGH_RANK = KNOWN_EFFORT_ORDER.indexOf("high");

/** True for `high`, `xhigh`, `max`. Unknown tiers and null are not high. */
function isHighEffort(effort: string | null): boolean {
  if (effort === null) return false;
  const i = KNOWN_EFFORT_ORDER.indexOf(effort);
  return i >= HIGH_RANK;
}

function isPreFixSubagentRow(r: HygieneMessageRow): boolean {
  return r.isSubagent && (r.outputPlaceholder || isVersionBefore(r.claudeVersion, PLACEHOLDER_FIXED_IN));
}

function median(ns: readonly number[]): number {
  const s = [...ns].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Maximal consecutive stretches of high-effort rows. */
function highEffortRuns(messages: readonly HygieneMessageRow[]): HygieneMessageRow[][] {
  const runs: HygieneMessageRow[][] = [];
  let cur: HygieneMessageRow[] = [];
  for (const m of messages) {
    if (isHighEffort(m.effort)) {
      cur.push(m);
    } else if (cur.length > 0) {
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) runs.push(cur);
  return runs;
}

export function detectHighEffortLowOutput(
  rows: readonly HygieneMessageRow[],
  thresholds: HygieneThresholds["highEffortLowOutput"],
  overrides?: RateOverrides,
): HygieneFinding[] {
  const findings: HygieneFinding[] = [];

  for (const group of groupBySession(rows.filter((r) => !isPreFixSubagentRow(r)))) {
    for (const run of highEffortRuns(group.messages)) {
      if (run.length < thresholds.minRunTurns) continue;
      if (run.some((m) => m.tools.some((t) => DISQUALIFYING_TOOLS.has(t)))) continue;

      const toolTurns = run.filter((m) => m.tools.length > 0).length;
      const toolShare = toolTurns / run.length;
      if (toolShare < thresholds.minToolTurnShare) continue;

      const medianOutput = median(run.map((m) => m.outputTokens));
      if (medianOutput > thresholds.maxMedianOutputTokens) continue;

      const subagent = run.every((m) => m.isSubagent);
      const tiers = [...new Set(run.map((m) => m.effort))].join("/");
      findings.push({
        detectorId: "high-effort-low-output",
        sessionIds: [group.sessionId],
        estimatedWaste: 0,
        rule:
          `A run of consecutive turns at a high reasoning-effort tier (high, xhigh or max) where most turns were ` +
          `tool calls with short output, and none edited files, delegated to an agent or returned structured output. ` +
          `Unknown or unreported effort never counts as high. Subagent rows written before Claude Code ${PLACEHOLDER_FIXED_IN} ` +
          `are ignored because their output counts are placeholders.`,
        threshold:
          `≥${thresholds.minRunTurns} turns; ≥${Math.round(thresholds.minToolTurnShare * 100)}% of turns call a tool; ` +
          `median output ≤${thresholds.maxMedianOutputTokens} tokens`,
        remedy: subagent
          ? "A lower effort would likely do for this kind of work; pass `effort` on the Agent call or set it in the agent definition, because subagents inherit the parent model's effort."
          : "A lower effort or a cheaper model would likely do for this kind of work; switch at session start, since the prompt cache is per model.",
        detail:
          `${run.length} turns at ${tiers}; ${Math.round(toolShare * 100)}% tool turns; median output ` +
          `${Math.round(medianOutput)} tokens; run cost ${formatMoney(sumCost(run, overrides))} (measured, not a saving: ` +
          `no estimate of what a lower tier would have cost).`,
      });
    }
  }

  return findings;
}
