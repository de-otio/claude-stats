/**
 * "Agents & skills" dashboard card — cost by agent type, by skill (during its
 * run) and by spawn depth, read straight off `DashboardData.agentCost`.
 *
 * Describes, never judges: no ranking words, no good/bad colouring. The
 * coverage line comes FIRST so the reader meets how much of the spend the
 * lists below can account for before any list.
 *
 * Escaping: agent and skill names are caller data. Every one goes through
 * `escapeHtml` in text nodes AND in the `title=` attribute; `t()` returns RAW
 * text, so every `t()` result is escaped too, and every number is formatted to
 * a fixed string BEFORE it is interpolated into a `t()` call.
 *
 * Design: plans/agent-attribution/IMPLEMENTATION.md §4/D2.
 */
import type { AgentCostReport } from "@claude-stats/core/agentCost";
import { formatCount, formatMoney, formatPercent } from "@claude-stats/core/insight";
import { escapeHtml } from "./utils.js";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

const SUBHEAD =
  "font-size:0.7rem;color:#a0c4ff;text-transform:uppercase;letter-spacing:0.05em;margin:0.75rem 0 0.3rem;";
const TH_L = "text-align:left;padding:0.3rem 0.5rem;color:#888;";
const TH_R = "text-align:right;padding:0.3rem 0.5rem;color:#888;";
const TD_L = "padding:0.3rem 0.5rem;color:#ccc;";
const TD_R = "padding:0.3rem 0.5rem;text-align:right;color:#e8e8e8;";

function th(t: TranslateFn, key: string, right: boolean): string {
  return `<th style="${right ? TH_R : TH_L}">${escapeHtml(t(key))}</th>`;
}

function money(n: number, currency: string): string {
  return escapeHtml(formatMoney(n, currency, { precise: true }));
}

/** A name cell: the escaped name in the text node and in `title=`. */
function nameCell(name: string, extra = ""): string {
  const e = escapeHtml(name);
  return `<td style="${TD_L}" title="${e}">${e}${extra}</td>`;
}

export function renderAgentCostCard(
  report: AgentCostReport | null | undefined,
  t: TranslateFn,
  currency: string,
): string {
  if (!report) return "";
  const { coverage } = report;
  const heading = `<h2>${escapeHtml(t("dashboard:agentCost.title"))}</h2>`;

  if (coverage.subagentMessages === 0 && report.bySkill.length === 0) {
    return `
    <div class="chart-card agent-cost-card" style="grid-column: 1 / -1; margin-top:1rem;">
      ${heading}
      <p style="font-size:0.78rem;color:#888;margin:0;">${escapeHtml(t("dashboard:agentCost.empty"))}</p>
    </div>`;
  }

  // Coverage first.
  const coverageLines = [
    `<p style="font-size:0.78rem;color:#e8e8e8;margin:0 0 0.3rem 0;">${escapeHtml(
      t("dashboard:agentCost.coverage.subagentShare", {
        share: formatPercent(coverage.subagentShare, 1),
        subagent: formatMoney(coverage.subagentCost, currency, { precise: true }),
        total: formatMoney(coverage.totalCost, currency, { precise: true }),
      }),
    )}</p>`,
    `<p style="font-size:0.78rem;color:#e8e8e8;margin:0 0 0.3rem 0;">${escapeHtml(
      t("dashboard:agentCost.coverage.knownType", { share: formatPercent(coverage.knownTypeShare, 1) }),
    )}</p>`,
  ];
  if (coverage.unpricedMessages > 0) {
    coverageLines.push(
      `<p style="font-size:0.72rem;color:#c9a227;margin:0 0 0.3rem 0;">${escapeHtml(
        t("dashboard:agentCost.coverage.unpriced", { messages: formatCount(coverage.unpricedMessages) }),
      )}</p>`,
    );
  }

  // Spend by agent type.
  const typeRows = report.byAgentType
    .map((r) => {
      const name =
        r.agentType === null ? t("dashboard:agentCost.byAgentType.unrecorded") : r.agentType;
      const kind =
        r.agentType === null
          ? "—"
          : r.builtIn
            ? t("dashboard:agentCost.byAgentType.builtIn")
            : t("dashboard:agentCost.byAgentType.named");
      return `
          <tr>
            ${nameCell(name)}
            <td style="${TD_L}">${escapeHtml(kind)}</td>
            <td style="${TD_R}">${money(r.cost, currency)}</td>
            <td style="${TD_R}">${escapeHtml(formatPercent(r.share, 1))}</td>
            <td style="${TD_R}">${formatCount(r.messages)}</td>
          </tr>`;
    })
    .join("");
  const otherType = report.other.byAgentType;
  const otherTypeRow = otherType
    ? `
          <tr>
            <td style="${TD_L}">${escapeHtml(t("dashboard:agentCost.byAgentType.other", { buckets: formatCount(otherType.buckets) }))}</td>
            <td style="${TD_L}">—</td>
            <td style="${TD_R}">${money(otherType.cost, currency)}</td>
            <td style="${TD_R}">${escapeHtml(formatPercent(otherType.share, 1))}</td>
            <td style="${TD_R}">${formatCount(otherType.messages)}</td>
          </tr>`
    : "";
  const typeBlock =
    typeRows || otherTypeRow
      ? `
      <div style="${SUBHEAD}">${escapeHtml(t("dashboard:agentCost.byAgentType.title"))}</div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.72rem;">
          <thead>
            <tr style="border-bottom:1px solid #0f3460;">
              ${th(t, "dashboard:agentCost.byAgentType.type", false)}
              ${th(t, "dashboard:agentCost.byAgentType.kind", false)}
              ${th(t, "dashboard:agentCost.byAgentType.cost", true)}
              ${th(t, "dashboard:agentCost.byAgentType.share", true)}
              ${th(t, "dashboard:agentCost.byAgentType.messages", true)}
            </tr>
          </thead>
          <tbody>${typeRows}${otherTypeRow}</tbody>
        </table>
      </div>`
      : "";

  // Spend during a skill's run.
  const skillRows = report.bySkill
    .map(
      (r) => `
          <tr>
            ${nameCell(r.skill)}
            <td style="${TD_R}">${money(r.costDuringRun, currency)}</td>
            <td style="${TD_R}">${escapeHtml(formatPercent(r.share, 1))}</td>
            <td style="${TD_R}">${formatCount(r.messages)}</td>
          </tr>`,
    )
    .join("");
  const otherSkill = report.other.bySkill;
  const otherSkillRow = otherSkill
    ? `
          <tr>
            <td style="${TD_L}">${escapeHtml(t("dashboard:agentCost.bySkill.other", { buckets: formatCount(otherSkill.buckets) }))}</td>
            <td style="${TD_R}">${money(otherSkill.costDuringRun, currency)}</td>
            <td style="${TD_R}">${escapeHtml(formatPercent(otherSkill.share, 1))}</td>
            <td style="${TD_R}">${formatCount(otherSkill.messages)}</td>
          </tr>`
    : "";
  const skillBlock =
    skillRows || otherSkillRow
      ? `
      <div style="${SUBHEAD}">${escapeHtml(t("dashboard:agentCost.bySkill.title"))}</div>
      <p style="font-size:0.65rem;color:#888;margin:0 0 0.3rem 0;">${escapeHtml(t("dashboard:agentCost.bySkill.note"))}</p>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.72rem;">
          <thead>
            <tr style="border-bottom:1px solid #0f3460;">
              ${th(t, "dashboard:agentCost.bySkill.skill", false)}
              ${th(t, "dashboard:agentCost.bySkill.cost", true)}
              ${th(t, "dashboard:agentCost.bySkill.share", true)}
              ${th(t, "dashboard:agentCost.bySkill.messages", true)}
            </tr>
          </thead>
          <tbody>${skillRows}${otherSkillRow}</tbody>
        </table>
      </div>`
      : "";

  // Spawn depth.
  const depthRows = report.bySpawnDepth
    .map((r) => {
      const label =
        r.depth === null
          ? t("dashboard:agentCost.bySpawnDepth.unrecorded")
          : t("dashboard:agentCost.bySpawnDepth.level", { depth: formatCount(r.depth) });
      return `
          <tr>
            <td style="${TD_L}">${escapeHtml(label)}</td>
            <td style="${TD_R}">${money(r.cost, currency)}</td>
            <td style="${TD_R}">${escapeHtml(formatPercent(r.share, 1))}</td>
            <td style="${TD_R}">${formatCount(r.messages)}</td>
          </tr>`;
    })
    .join("");
  const otherDepth = report.other.bySpawnDepth;
  const otherDepthRow = otherDepth
    ? `
          <tr>
            <td style="${TD_L}">${escapeHtml(t("dashboard:agentCost.bySpawnDepth.other", { buckets: formatCount(otherDepth.buckets) }))}</td>
            <td style="${TD_R}">${money(otherDepth.cost, currency)}</td>
            <td style="${TD_R}">${escapeHtml(formatPercent(otherDepth.share, 1))}</td>
            <td style="${TD_R}">${formatCount(otherDepth.messages)}</td>
          </tr>`
    : "";
  const depthBlock =
    depthRows || otherDepthRow
      ? `
      <div style="${SUBHEAD}">${escapeHtml(t("dashboard:agentCost.bySpawnDepth.title"))}</div>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.72rem;">
          <thead>
            <tr style="border-bottom:1px solid #0f3460;">
              ${th(t, "dashboard:agentCost.bySpawnDepth.depth", false)}
              ${th(t, "dashboard:agentCost.bySpawnDepth.cost", true)}
              ${th(t, "dashboard:agentCost.bySpawnDepth.share", true)}
              ${th(t, "dashboard:agentCost.bySpawnDepth.messages", true)}
            </tr>
          </thead>
          <tbody>${depthRows}${otherDepthRow}</tbody>
        </table>
      </div>`
      : "";

  return `
    <div class="chart-card agent-cost-card" style="grid-column: 1 / -1; margin-top:1rem;">
      ${heading}
      ${coverageLines.join("\n      ")}
      ${typeBlock}
      ${skillBlock}
      ${depthBlock}
    </div>`;
}
