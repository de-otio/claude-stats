/**
 * The reconciliation panel — the thing the dashboard already promised.
 *
 * `dashboard:insights.alerts.reconciliationDrift` has told the reader, in all
 * ten locales, to "see the cost card's caveat for the residual and its candidate
 * causes". The caveat `costCaveat` produces carries the RATIO and nothing else:
 * no residual, no invoice total, no tolerance band, no causes — all four of
 * which `computeReconciliation` had already computed and put on
 * `DashboardData.insights.reconciliation`. Verified end to end before this
 * module existed: with a residual of 49.4 and `candidateCauses:
 * ["scope-mismatch"]`, the rendered page contained neither figure nor cause.
 *
 * An alert that points somewhere nothing is, is worse than no alert. It spends
 * the reader's attention, then their trust. This module is the destination; the
 * alert sentence now names it.
 *
 * Pure and wording-free by construction: every string comes from
 * `reconciliationDetail` in `@claude-stats/core/insight`, so the panel, the
 * justification pack and any CLI surface state the same residual in the same
 * words (gui-redesign/03 §3.4). This file chooses markup and nothing else.
 */
import type { Reconciliation } from "@claude-stats/core/types/insight";
import { reconciliationDetail } from "@claude-stats/core/insight";

/** Minimal translator signature — same shape every other server module accepts. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** DOM id of the panel root. The alert's action link targets it, and the id is
 *  exported rather than written twice so the link cannot outlive the panel. */
export const RECONCILIATION_ANCHOR = "reconciliation";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Render the panel, or the empty string when there is nothing to reconcile.
 *
 * `null` means "no invoice figure configured" — not "reconciles". Rendering an
 * empty panel in that state would imply a check ran, so the panel is simply
 * absent and Q1's caveat says what it always said.
 *
 * The panel renders for a reconciliation that PASSES as well as one that fails.
 * A reader told "reconciles at 99%" has been given a claim; the figures behind
 * it are what let them check it, and hiding them on success while showing them
 * on failure would make the panel read as a failure notice rather than as
 * evidence.
 */
export function renderReconciliationPanel(
  reconciliation: Reconciliation | null | undefined,
  t: TranslateFn,
  currency = "USD",
): string {
  if (!reconciliation) return "";
  const detail = reconciliationDetail(t, reconciliation, currency);

  const rows = detail.lines
    .map(
      (line) => `<div class="cs-recon-row" data-recon-line="${escapeHtml(line.id)}">
          <span class="cs-recon-label">${escapeHtml(line.label)}</span>
          <span class="cs-recon-value">${escapeHtml(line.value)}</span>
        </div>`,
    )
    .join("\n        ");

  const causesHtml =
    detail.causesLabel === null
      ? ""
      : `<div class="cs-recon-causes">
          <div class="cs-recon-causes-label">${escapeHtml(detail.causesLabel)}</div>
          <ul class="cs-recon-cause-list">
            ${detail.causes.map((c) => `<li>${escapeHtml(c)}</li>`).join("\n            ")}
          </ul>
        </div>`;

  // `cs-card` so the panel inherits the card primitive's tokens in both hosts
  // without renderCard() growing a branch for a shape that is not an
  // InsightAnswer (the scope rule: add a variant, don't change the primitive).
  return `
      <div class="cs-card cs-recon${reconciliation.withinTolerance ? "" : " cs-recon-drift"}" id="${RECONCILIATION_ANCHOR}">
        <div class="cs-card-title">${escapeHtml(t("common:insight.reconciliation.title"))}</div>
        <div class="cs-card-answer">${escapeHtml(detail.verdict)}</div>
        <div class="cs-recon-figures">
        ${rows}
        </div>
        ${causesHtml}
        <div class="cs-recon-scope">${escapeHtml(detail.scope)}</div>
      </div>`;
}

/** Panel CSS. Depends only on the card tokens, so it themes in both hosts. */
export const RECONCILIATION_CSS = `
    .cs-recon { margin-top: 0.75rem; }
    .cs-recon-drift { border-left: 3px solid var(--cs-alert-warning); }
    .cs-recon-figures { margin-top: 0.5rem; }
    .cs-recon-row {
      display: flex; justify-content: space-between; gap: 1rem;
      font-size: 0.72rem; padding: 0.2rem 0;
      border-top: 1px solid var(--cs-card-border);
    }
    .cs-recon-label { color: var(--cs-card-fg-muted); }
    .cs-recon-value { color: var(--cs-card-fg); text-align: right; }
    .cs-recon-causes { margin-top: 0.5rem; }
    .cs-recon-causes-label {
      font-size: 0.65rem; color: var(--cs-card-fg-muted);
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .cs-recon-cause-list {
      margin: 0.25rem 0 0 1rem; padding: 0;
      font-size: 0.7rem; color: var(--cs-card-fg); line-height: 1.5;
    }
    .cs-recon-scope { font-size: 0.65rem; color: var(--cs-card-fg-muted); margin-top: 0.5rem; }`;
