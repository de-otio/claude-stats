/**
 * The per-ticket cost table — the `tickets` section's body.
 *
 * Why this section exists at all: the view named "Tickets & Value" grouped
 * `projects` and `classify` and rendered no ticket anywhere on the screen. The
 * per-ticket figures existed only behind MCP (`get_cost_per_ticket`) and behind
 * `report --ticket <KEY>`, which is a single-key drill-down — so a reader who
 * opened the view its label invites them to open saw per-project charts and
 * concluded, correctly, that the feature was broken. This is the missing
 * surface (`gui-redesign/02 §2.4`; see `nav.ts` for why it lands in this view
 * rather than in Cost & Controlling as that table assigns it).
 *
 * Three obligations shape the markup:
 *
 *  1. **The coverage header is not optional.** A per-ticket table without
 *     "36% of the window's spend is attributed" beside it reads as a complete
 *     account of the period's cost. It is not, and cannot be — the attribution
 *     signals are branch names, commit subjects and prompt mentions, so
 *     unattributed work is the normal majority. The header renders whenever the
 *     table does, above the rows, never folded away.
 *  2. **Every row states its confidence tier.** A cost with a `low` tier is a
 *     prompt-text mention, which is corroboration at best; presenting it in the
 *     same visual weight as a branch-sourced `high` row would launder a guess
 *     into a fact.
 *  3. **No silent caps.** The payload is bounded (`DashboardTicketTable`), so
 *     both the row cap and the per-row session cap say what they dropped.
 *
 * Drill-down mechanics: a native `<details>` per row, so the "ticket → sessions"
 * hop needs no JavaScript and behaves identically on the served page and in the
 * VS Code webview. That matters here for the same reason `ticketCard.ts` notes
 * it — the served host must not depend on `panel.ts`'s message wiring.
 */
import { confidenceCaveat, formatMoney, formatPercent } from "@claude-stats/core/insight";
import type { DashboardTicketRow, DashboardTicketTable } from "../dashboard/index.js";

/** Minimal translator signature — same shape `template.ts` accepts, and
 *  structurally identical to `core`'s `InsightT`, so `confidenceCaveat` takes
 *  one directly without a cast. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Tier → the CSS class carrying its colour. Kept a total map over the three
 *  tiers rather than a template literal so an unknown tier from a future schema
 *  renders unstyled instead of silently inheriting `high`'s green. */
const TIER_CLASS: Readonly<Record<string, string>> = {
  high: "cs-tt-high",
  medium: "cs-tt-medium",
  low: "cs-tt-low",
};

/** The tier as a coloured badge. `common:` resolves on every host — `initI18n`
 *  loads that namespace unconditionally — so there is no raw-key fallback here;
 *  an unresolved label would be a broken i18n setup, not a state to render. */
function tierBadge(confidence: string, t: TranslateFn): string {
  const cls = TIER_CLASS[confidence] ?? "";
  return `<span class="cs-tt-tier ${cls}">${escapeHtml(t(`common:insight.confidence.${confidence}`))}</span>`;
}

/**
 * The coverage header: what fraction of the window's spend these rows account
 * for, plus the confidence mix and the ambiguity note.
 *
 * Rendered from the SAME `TicketCoverage` the Insights "what did it buy?" card
 * quotes (`attachInsights` puts one object on both), so the two surfaces cannot
 * disagree about the same period.
 */
function renderCoverage(table: DashboardTicketTable, t: TranslateFn): string {
  const c = table.coverage;
  if (c.totalCost <= 0) {
    return `<div class="cs-tt-coverage"><div class="cs-tt-enablement">${escapeHtml(t("dashboard:tickets.noSpend"))}</div></div>`;
  }
  const headline = t("dashboard:tickets.coverage", {
    attributed: formatMoney(c.attributedCost),
    total: formatMoney(c.totalCost),
    ratio: formatPercent(c.ratio),
  });
  // `confidenceCaveat` owns the "0% attributed" case and returns the enablement
  // sentence for it — which is why this is never a bare zero with no
  // explanation. Reused rather than re-derived so the GUI, the CLI report and
  // the MCP tool phrase the same caveat identically.
  const caveat = confidenceCaveat(t, c);
  return `<div class="cs-tt-coverage">
      <div class="cs-tt-coverage-headline">${escapeHtml(headline)}</div>
      ${caveat ? `<div class="cs-tt-caveat">${escapeHtml(caveat)}</div>` : ""}
    </div>`;
}

/** One row's `<details>` drill-down: the sessions behind its cost. */
function renderSessions(row: DashboardTicketRow, t: TranslateFn): string {
  if (row.sessions.length === 0) {
    return `<div class="cs-tt-enablement">${escapeHtml(t("dashboard:tickets.noSessions"))}</div>`;
  }
  const omitted =
    row.sessionsOmitted > 0
      ? `<div class="cs-tt-omitted">${escapeHtml(t("dashboard:tickets.sessionsOmitted", { count: row.sessionsOmitted }))}</div>`
      : "";
  return `<table class="cs-tt-sessions">
        <thead><tr>
          <th>${escapeHtml(t("dashboard:tickets.colSession"))}</th>
          <th>${escapeHtml(t("dashboard:tickets.colProject"))}</th>
          <th class="cs-tt-num">${escapeHtml(t("dashboard:tickets.colCost"))}</th>
          <th>${escapeHtml(t("dashboard:tickets.colSource"))}</th>
          <th>${escapeHtml(t("dashboard:tickets.colEvidence"))}</th>
        </tr></thead>
        <tbody>
          ${row.sessions
            .map(
              (s) => `<tr>
            <td class="cs-tt-mono">${escapeHtml(s.sessionIdShort)}…</td>
            <td>${escapeHtml(s.projectLabel)}</td>
            <td class="cs-tt-num">${escapeHtml(formatMoney(s.cost))}</td>
            <td>${escapeHtml(s.source)} ${tierBadge(s.confidence, t)}</td>
            <td class="cs-tt-evidence">${
              s.evidence != null
                ? escapeHtml(s.evidence)
                : `<span class="cs-tt-none">${escapeHtml(t("dashboard:tickets.noEvidence"))}</span>`
            }</td>
          </tr>`,
            )
            .join("\n          ")}
        </tbody>
      </table>${omitted}`;
}

/**
 * The route from "these rows are guesses" to the setting that fixes it.
 *
 * Shown when the table has no rows, or when any row is below `high` — i.e.
 * exactly when a configured `tickets.projectKeys` allowlist would change the
 * answer. Suppressed when every row is already `high`, because there the
 * allowlist is demonstrably doing its job and the advice would be furniture.
 *
 * The anchor targets `#settings`, which the template's hash resolver accepts as
 * both a view and a section id, so this works from any host without JS wiring.
 */
function renderTuneHint(table: DashboardTicketTable, t: TranslateFn): string {
  const needsTuning = table.rows.length === 0 || table.rows.some((r) => r.confidence !== "high");
  if (!needsTuning) return "";
  return `<div class="cs-tt-note">${escapeHtml(t("dashboard:tickets.tuneHint"))} <a class="cs-tt-link" href="#settings">${escapeHtml(t("dashboard:tickets.tuneHintLink"))}</a></div>`;
}

/**
 * Render the whole section body.
 *
 * `undefined` and `null` are NOT the same state, matching `ticketCard.ts`'s
 * precedent exactly:
 *
 * - `undefined` — `attachInsights` never ran, so this code has no idea whether
 *   any ticket is attributed. Omit the body rather than claim emptiness a
 *   caller's missing attach step invented.
 * - `null` — the attach ran and the report could not be built (a store predating
 *   schema V19). Say that, with the enablement path.
 * - populated with `rows: []` — the report ran and nothing is attributed. That
 *   is a real answer and gets the coverage header plus the enablement copy, NOT
 *   an omitted section: it is the state a new user is in, and the one where
 *   being told what to configure is worth the most.
 */
export function renderTicketTable(
  table: DashboardTicketTable | null | undefined,
  t: TranslateFn,
): string {
  if (table === undefined) return "";
  if (table === null) {
    return `<div class="chart-card" id="ticket-table">
      <h2>${escapeHtml(t("dashboard:tickets.title"))}</h2>
      <div class="cs-tt-enablement">${escapeHtml(t("dashboard:tickets.unavailable"))}</div>
    </div>`;
  }

  const body =
    table.rows.length === 0
      ? `<div class="cs-tt-enablement">${escapeHtml(t("dashboard:tickets.empty"))}</div>`
      : `<div class="cs-tt-scroll">
        <table class="cs-tt-rows">
          <thead><tr>
            <th>${escapeHtml(t("dashboard:tickets.colTicket"))}</th>
            <th class="cs-tt-num">${escapeHtml(t("dashboard:tickets.colCost"))}</th>
            <th class="cs-tt-num">${escapeHtml(t("dashboard:tickets.colSessions"))}</th>
            <th>${escapeHtml(t("dashboard:tickets.colConfidence"))}</th>
            <th>${escapeHtml(t("dashboard:tickets.colSources"))}</th>
          </tr></thead>
          <tbody>
            ${table.rows
              .map(
                (row) => `<tr class="cs-tt-row" data-ticket-row="${escapeHtml(row.ticketKey)}">
              <td class="cs-tt-key">${escapeHtml(row.ticketKey)}</td>
              <td class="cs-tt-num cs-tt-cost">${escapeHtml(formatMoney(row.cost))}</td>
              <td class="cs-tt-num">${row.sessionCount}</td>
              <td>${tierBadge(row.confidence, t)}</td>
              <td class="cs-tt-sources">${escapeHtml(row.sources.join(", "))}</td>
            </tr>
            <tr class="cs-tt-drill"><td colspan="5">
              <details>
                <summary>${escapeHtml(t("dashboard:tickets.drillDown", { count: row.sessionCount }))}</summary>
                ${renderSessions(row, t)}
              </details>
            </td></tr>`,
              )
              .join("\n            ")}
          </tbody>
        </table>
      </div>
      ${
        table.rowsOmitted > 0
          ? `<div class="cs-tt-omitted">${escapeHtml(
              t("dashboard:tickets.rowsOmitted", {
                count: table.rowsOmitted,
                cost: formatMoney(table.rowsOmittedCost),
              }),
            )}</div>`
          : ""
      }
      <div class="cs-tt-note">${escapeHtml(t("dashboard:tickets.ambiguityNote"))}</div>`;

  return `<div class="chart-card" id="ticket-table">
      <h2>${escapeHtml(t("dashboard:tickets.title"))}</h2>
      ${renderCoverage(table, t)}
      ${body}
      ${renderTuneHint(table, t)}
    </div>`;
}

/** Section CSS. Self-contained apart from `CARD_TOKENS_CSS`'s tokens, which are
 *  always embedded on the same page (same dependency `TICKET_CARD_CSS` has). */
export const TICKET_TABLE_CSS = `
    .cs-tt-coverage { margin-bottom: 0.75rem; }
    .cs-tt-coverage-headline { font-size: 0.85rem; color: var(--cs-card-fg); font-weight: 600; }
    .cs-tt-caveat { font-size: 0.7rem; color: var(--cs-card-fg-muted); margin-top: 0.2rem; }
    .cs-tt-enablement { font-size: 0.72rem; color: var(--cs-card-fg-muted); }
    .cs-tt-scroll { overflow-x: auto; }
    .cs-tt-rows { width: 100%; border-collapse: collapse; font-size: 0.72rem; }
    .cs-tt-rows thead th {
      text-align: left; padding: 0.4rem; border-bottom: 1px solid var(--cs-card-border);
      color: var(--cs-card-fg-muted); font-weight: 600;
    }
    .cs-tt-rows td { padding: 0.4rem; }
    .cs-tt-row { border-bottom: 1px solid var(--cs-card-border); }
    .cs-tt-num { text-align: right; }
    .cs-tt-key { color: var(--cs-card-accent); font-weight: 600; }
    .cs-tt-cost { color: #59a14f; }
    .cs-tt-sources, .cs-tt-none { color: var(--cs-card-fg-muted); }
    .cs-tt-tier {
      font-size: 0.6rem; text-transform: uppercase; padding: 0.1rem 0.3rem;
      border-radius: 3px; background: var(--cs-card-unavailable-bg);
    }
    .cs-tt-high { color: #59a14f; }
    .cs-tt-medium { color: #f28e2b; }
    .cs-tt-low { color: #e15759; }
    .cs-tt-drill > td { padding: 0 0.4rem 0.5rem; border-bottom: 1px solid var(--cs-card-border); }
    .cs-tt-drill summary { font-size: 0.65rem; color: var(--cs-card-fg-muted); cursor: pointer; }
    .cs-tt-sessions { width: 100%; border-collapse: collapse; font-size: 0.65rem; margin: 0.4rem 0 0.2rem; }
    .cs-tt-sessions th {
      text-align: left; padding: 0.25rem 0.4rem; color: var(--cs-card-fg-muted); font-weight: 600;
    }
    .cs-tt-sessions td { padding: 0.25rem 0.4rem; }
    .cs-tt-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .cs-tt-evidence { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cs-tt-omitted, .cs-tt-note { font-size: 0.65rem; color: var(--cs-card-fg-muted); margin-top: 0.4rem; }
    .cs-tt-link { color: var(--cs-card-accent); }`;
