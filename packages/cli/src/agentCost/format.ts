/**
 * Rendering for `claude-stats agents` — turns an `AgentCostReport` into
 * localized, human-readable lines. Pure formatting: no store, no clock, no
 * process I/O beyond the stream handed to `printAgentCost`. Kept out of
 * `cli/index.ts` (excluded from coverage) so the rendering is testable.
 *
 * Rules enforced here:
 *  - Coverage comes FIRST: how much of the spend is subagent work, and how
 *    much of that has a recorded agent type, so every figure below it is read
 *    against what was and was not captured. Unpriced messages are disclosed.
 *  - Describe, never judge. Lists are ordered by cost for determinism; the
 *    wording never ranks or evaluates ("top", "waste", ...). A test pins this
 *    against the whole `en` output.
 *  - Built-in vs user-named agent types are marked; a `null` type reads
 *    "(unrecorded)".
 *  - Skill figures are spend DURING the run; carry is `context`'s measurement.
 */
import type { AgentCostReport } from "@claude-stats/core/agentCost";
import { formatCost } from "@claude-stats/core/pricing";
import { formatCount, formatPercent } from "@claude-stats/core/insight";

/** Same shape as `contextCarry/format.ts#Translate` (matches `../i18n.js`). */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** UTC calendar day of a bucket start, `YYYY-MM-DD`. Periods are UTC-aligned. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function pct(ratio: number): string {
  return formatPercent(ratio, 1);
}

/** The localized lines for a report, coverage first. */
export function formatAgentCostLines(report: AgentCostReport, t: Translate): string[] {
  const c = report.coverage;
  const lines: string[] = [t("cli:agentCost.title"), "", t("cli:agentCost.coverageTitle")];

  lines.push(
    "  " +
      t("cli:agentCost.totalLine", {
        total: formatCost(c.totalCost),
        messages: formatCount(c.messages),
        main: formatCost(c.mainCost),
        mainShare: pct(c.mainShare),
        subagent: formatCost(c.subagentCost),
        subagentShare: pct(c.subagentShare),
      }),
  );
  lines.push(
    "  " +
      (c.subagentCost > 0
        ? t("cli:agentCost.knownTypeLine", {
            knownShare: pct(c.knownTypeShare),
            known: formatCost(c.knownTypeCost),
            subagent: formatCost(c.subagentCost),
          })
        : t("cli:agentCost.knownTypeNoSubagents")),
  );
  lines.push(
    "  " +
      (c.unpricedMessages > 0
        ? t("cli:agentCost.unpricedLine", { count: formatCount(c.unpricedMessages) })
        : t("cli:agentCost.pricedAllLine")),
  );
  if (c.byPeriod.length > 0) {
    const periods = c.byPeriod
      .map((p) => t("cli:agentCost.periodItem", { start: utcDay(p.start), share: pct(p.knownTypeShare) }))
      .join(" · ");
    const key = c.periodGranularity === "week" ? "cli:agentCost.periodLineWeek" : "cli:agentCost.periodLineDay";
    lines.push("  " + t(key, { periods }));
  }
  if (c.undatedSubagentCost > 0) {
    lines.push("  " + t("cli:agentCost.undatedLine", { cost: formatCost(c.undatedSubagentCost) }));
  }

  lines.push("", t("cli:agentCost.byTypeTitle"));
  if (report.byAgentType.length === 0) {
    lines.push("  " + t("cli:agentCost.byTypeEmpty"));
  } else {
    for (const r of report.byAgentType) {
      lines.push(
        "  " +
          t("cli:agentCost.typeRow", {
            name: r.agentType ?? t("cli:agentCost.unrecordedName"),
            kind:
              r.agentType === null
                ? t("cli:agentCost.kindUnrecorded")
                : r.builtIn
                  ? t("cli:agentCost.kindBuiltIn")
                  : t("cli:agentCost.kindNamed"),
            cost: formatCost(r.cost),
            share: pct(r.share),
            messages: formatCount(r.messages),
          }),
      );
    }
  }
  const otherType = report.other.byAgentType;
  if (otherType) {
    lines.push(
      "  " +
        t("cli:agentCost.otherTypeRow", {
          buckets: formatCount(otherType.buckets),
          cost: formatCost(otherType.cost),
          share: pct(otherType.share),
          messages: formatCount(otherType.messages),
        }),
    );
  }

  lines.push("", t("cli:agentCost.bySkillTitle"));
  if (report.bySkill.length === 0) {
    lines.push("  " + t("cli:agentCost.bySkillEmpty"));
  } else {
    for (const r of report.bySkill) {
      lines.push(
        "  " +
          t("cli:agentCost.skillRow", {
            name: r.skill,
            cost: formatCost(r.costDuringRun),
            share: pct(r.share),
            messages: formatCount(r.messages),
          }),
      );
    }
    const otherSkill = report.other.bySkill;
    if (otherSkill) {
      lines.push(
        "  " +
          t("cli:agentCost.otherSkillRow", {
            buckets: formatCount(otherSkill.buckets),
            cost: formatCost(otherSkill.costDuringRun),
            share: pct(otherSkill.share),
            messages: formatCount(otherSkill.messages),
          }),
      );
    }
    lines.push("  " + t("cli:agentCost.skillNote"));
  }

  lines.push("", t("cli:agentCost.byDepthTitle"));
  if (report.bySpawnDepth.length === 0) {
    lines.push("  " + t("cli:agentCost.byDepthEmpty"));
  } else {
    for (const r of report.bySpawnDepth) {
      const vars = {
        depth: r.depth === null ? "" : String(r.depth),
        cost: formatCost(r.cost),
        share: pct(r.share),
        messages: formatCount(r.messages),
      };
      lines.push("  " + t(r.depth === null ? "cli:agentCost.depthUnrecorded" : "cli:agentCost.depthRow", vars));
    }
  }
  const otherDepth = report.other.bySpawnDepth;
  if (otherDepth) {
    lines.push(
      "  " +
        t("cli:agentCost.otherDepthRow", {
          buckets: formatCount(otherDepth.buckets),
          cost: formatCost(otherDepth.cost),
          share: pct(otherDepth.share),
          messages: formatCount(otherDepth.messages),
        }),
    );
  }

  return lines;
}

/** Write the report: the full `AgentCostReport` as JSON, or the text view. */
export function printAgentCost(
  report: AgentCostReport,
  out: NodeJS.WritableStream,
  t: Translate,
  opts: { json?: boolean } = {},
): void {
  if (opts.json) {
    out.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  for (const line of formatAgentCostLines(report, t)) out.write(line + "\n");
}

/**
 * Parse `--limit`. `undefined` (flag absent) → `undefined`; a string that is a
 * safe integer ≥ 1 → that number; anything else → `null` (invalid). The core
 * throws `RangeError` on a bad limit, so the CLI/MCP validate first.
 */
export function parseAgentsLimit(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  if (!/^\d{1,15}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** The `--period` values `periodRange` understands. */
export const AGENTS_PERIODS = ["day", "week", "month", "all"] as const;
export type AgentsPeriod = (typeof AGENTS_PERIODS)[number];

/**
 * Parse `--period`. `undefined` (flag absent) → `"month"`, the command's
 * default; one of {@link AGENTS_PERIODS} → itself; anything else → `null`
 * (invalid). Without this an unknown value fell through `periodRange` as an
 * all-time window — a silently wrong report rather than an error.
 */
export function parseAgentsPeriod(raw: string | undefined): AgentsPeriod | null {
  if (raw === undefined) return "month";
  return (AGENTS_PERIODS as readonly string[]).includes(raw) ? (raw as AgentsPeriod) : null;
}

// ─── `claude-stats export` field allowlist ──────────────────────────────────

/**
 * Every `sessions` column `claude-stats export --format json` emitted before
 * schema V25, in table order. The JSON export is an ALLOWLIST over this list,
 * not `SELECT *`: a column added to `sessions` later is not exported until it
 * is added here on purpose. The V25 columns below are deliberately absent —
 * they hold user-authored names (agent types) and spawn identifiers.
 */
export const EXPORT_SESSION_FIELDS: readonly string[] = Object.freeze([
  "session_id", "project_path", "source_file", "first_timestamp", "last_timestamp",
  "claude_version", "entrypoint", "git_branch", "permission_mode", "is_interactive",
  "prompt_count", "assistant_message_count", "input_tokens", "output_tokens",
  "cache_creation_tokens", "cache_read_tokens", "web_search_requests", "web_fetch_requests",
  "tool_use_counts", "models", "source_deleted", "updated_at", "repo_url", "account_uuid",
  "organization_uuid", "subscription_type", "thinking_blocks", "throttle_events",
  "active_duration_ms", "median_response_time_ms", "parent_session_id", "is_subagent",
  "account_source", "account_confidence",
]);

/** The V25 attribution columns, exported only with `--include-agent-names`. */
export const EXPORT_AGENT_FIELDS: readonly string[] = Object.freeze([
  "agent_type", "spawn_depth", "spawn_tool_use_id",
]);

/**
 * One session row for the JSON export: allowlisted keys only, in allowlist
 * order, plus the agent fields when `includeAgentNames`. A key absent from the
 * row is omitted (never invented).
 */
export function projectSessionForExport(
  row: object,
  includeAgentNames: boolean,
): Record<string, unknown> {
  const src = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const keys = includeAgentNames ? [...EXPORT_SESSION_FIELDS, ...EXPORT_AGENT_FIELDS] : EXPORT_SESSION_FIELDS;
  for (const k of keys) {
    if (Object.hasOwn(src, k)) out[k] = src[k];
  }
  return out;
}

/**
 * CSV cell for a name-bearing column. A cell starting with `@ - + =` is
 * prefixed with `'` so a spreadsheet does not evaluate it as a formula
 * (belt-and-braces over the identifier validator, which already rejects such
 * names). `null`/`undefined` → empty cell. The value is quoted if it contains
 * a comma, quote or newline.
 */
export function csvNameCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[@\-+=]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
