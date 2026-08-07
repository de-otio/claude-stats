/**
 * The ticket attribution link/negate card — Lane L's dashboard surface.
 *
 * Renders `DashboardData.currentSessionTicket` (built by
 * `dashboard/index.ts`'s `attachTicketAttribution`) as a small card the user
 * can act on: link the current session to a key, negate a wrong automatic
 * link, or remove a manual link they no longer want.
 *
 * **Webview-only, by design, matching the cost-per-task outcome-labelling
 * precedent** (`extension/panel.ts`'s `[data-cpt-index]` wiring): this module
 * renders the SAME markup for both hosts (served HTTP and VS Code webview),
 * but the click handlers that turn the buttons into `postMessage` calls are
 * injected only by `panel.ts`'s `patchForWebview`. On the served host the
 * buttons render but do nothing — a `serve` LAN visitor cannot mutate the
 * store, which is the existing security posture for this class of action.
 *
 * A card with no session (empty store) or a session with no links states
 * that honestly rather than omitting itself, matching the Insights tab's own
 * "no silent emptiness" rule.
 */
import type { CurrentSessionTicket } from "../dashboard/index.js";

/** Minimal translator signature — same shape `template.ts` accepts. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Render the ticket attribution card. `data` is `DashboardData.currentSessionTicket`
 * — `undefined` and `null` are NOT the same state and must not render
 * identically:
 *
 * - `null` means `attachTicketAttribution` ran and found no eligible session
 *   (a genuinely empty store). "No sessions recorded yet" is honest here.
 * - `undefined` means `attachTicketAttribution` never ran at all — the field
 *   was never touched. The store may be full of sessions; this code has no
 *   idea. Rendering the SAME "no sessions" copy for this case would be a
 *   false honest-empty claim: a caller that forgot to wire the attach step
 *   would silently tell every user their history is empty. Omit the card
 *   entirely instead — no claim is safer than a wrong one (I1).
 */
export function renderTicketAttributionCard(
  data: CurrentSessionTicket | null | undefined,
  t: TranslateFn,
): string {
  if (data === undefined) {
    return "";
  }
  if (data === null) {
    return `<div class="cs-ticket-card" id="ticket-attribution-card">
      <div class="cs-card-title">${escapeHtml(t("dashboard:ticketCard.title"))}</div>
      <div class="cs-card-enablement">${escapeHtml(t("dashboard:ticketCard.noSession"))}</div>
    </div>`;
  }

  const shortId = escapeHtml(data.sessionId.slice(0, 8));
  const rows = data.links.length === 0
    ? `<div class="cs-card-enablement">${escapeHtml(t("dashboard:ticketCard.noLinks"))}</div>`
    : `<ul class="cs-ticket-list">
        ${data.links
          .map((link) => {
            const key = escapeHtml(link.ticketKey);
            const status = link.negated
              ? `<span class="cs-ticket-negated">${escapeHtml(t("dashboard:ticketCard.negatedBadge"))}</span>`
              : "";
            // Negate is always offered (even for an already-negated row, it's
            // idempotent); Remove only makes sense for a manual ('tag') row —
            // removing an automatic row would just have it reappear on the
            // next collect, which is confusing UI for a no-op.
            const negateBtn = `<button type="button" data-ticket-action="negate" data-ticket-key="${key}">${escapeHtml(t("dashboard:ticketCard.negateAction"))}</button>`;
            const removeBtn = link.source === "tag"
              ? `<button type="button" data-ticket-action="remove" data-ticket-key="${key}">${escapeHtml(t("dashboard:ticketCard.removeAction"))}</button>`
              : "";
            return `<li class="cs-ticket-row">
              <span class="cs-ticket-key">${key}</span>
              <span class="cs-ticket-meta">${escapeHtml(link.source)} / ${escapeHtml(link.confidence)}</span>
              ${status}
              <span class="cs-ticket-actions">${negateBtn}${removeBtn}</span>
            </li>`;
          })
          .join("\n        ")}
      </ul>`;

  return `<div class="cs-ticket-card" id="ticket-attribution-card" data-session-id="${escapeHtml(data.sessionId)}">
      <div class="cs-card-title">${escapeHtml(t("dashboard:ticketCard.title"))}</div>
      <div class="cs-ticket-session">${escapeHtml(t("dashboard:ticketCard.session", { sessionId: shortId }))}</div>
      ${rows}
      <div class="cs-ticket-link-form">
        <input type="text" id="ticket-key-input" placeholder="${escapeHtml(t("dashboard:ticketCard.keyPlaceholder"))}" maxlength="12">
        <button type="button" id="ticket-link-btn">${escapeHtml(t("dashboard:ticketCard.linkAction"))}</button>
      </div>
    </div>`;
}

/** Card-level CSS. Depends only on `CARD_TOKENS_CSS`'s tokens (`card.ts`),
 *  which is always embedded on the same page — safe to include alongside it. */
export const TICKET_CARD_CSS = `
    .cs-ticket-card {
      background: var(--cs-card-bg); border: 1px solid var(--cs-card-border);
      border-radius: 6px; padding: 0.75rem 1rem; margin-top: 0.75rem;
    }
    .cs-ticket-session { font-size: 0.7rem; color: var(--cs-card-fg-muted); margin-bottom: 0.4rem; }
    .cs-ticket-list { list-style: none; display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.5rem; }
    .cs-ticket-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; flex-wrap: wrap; }
    .cs-ticket-key { color: var(--cs-card-accent); font-weight: 600; }
    .cs-ticket-meta { color: var(--cs-card-fg-muted); }
    .cs-ticket-negated { color: var(--cs-card-down); font-size: 0.65rem; text-transform: uppercase; }
    .cs-ticket-actions { margin-left: auto; display: flex; gap: 0.35rem; }
    .cs-ticket-actions button, .cs-ticket-link-form button {
      background: var(--cs-card-unavailable-bg); color: var(--cs-card-fg);
      border: 1px solid var(--cs-card-border); border-radius: 3px;
      font-size: 0.65rem; padding: 0.15rem 0.4rem; cursor: pointer;
    }
    .cs-ticket-link-form { display: flex; gap: 0.4rem; }
    .cs-ticket-link-form input {
      flex: 1; background: var(--cs-card-unavailable-bg); color: var(--cs-card-fg);
      border: 1px solid var(--cs-card-border); border-radius: 3px;
      font-size: 0.7rem; padding: 0.2rem 0.4rem;
    }`;
