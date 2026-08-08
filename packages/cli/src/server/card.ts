/**
 * `renderCard()` — the one place an `InsightAnswer` becomes markup.
 *
 * `template.ts` is a single ~3,400-line function that every GUI task has so
 * far edited simultaneously (doc/analysis/gui-redesign/01-diagnosis.md). This
 * module extracts the card primitive so later GUI work (the Insights tab,
 * the justification pack's HTML section) is additive on a new file instead
 * of another hand at the same function body
 * (doc/analysis/gui-redesign/03-migration-and-mechanics.md §3.2 phase 2).
 *
 * The card renders the uniform grammar the formatters in
 * `@claude-stats/core/insight` already promise: answer sentence → number →
 * trend → caveat → evidence link. It never composes its own wording — the
 * sentence, caveat, and value string all come from the `InsightAnswer` the
 * caller passes in, which is what keeps the dashboard and the exported
 * justification pack from drifting apart (gui-redesign/03 §3.4).
 *
 * The honest-unavailable state (`InsightAnswer.unavailable`) is a first-class
 * branch here, not an error path: it renders its own enablement sentence
 * instead of an empty widget (gui-redesign/02 §2.6).
 *
 * Design tokens are CSS custom properties. Each maps to a VS Code theme
 * variable with a fallback equal to the served dashboard's existing dark
 * palette, so `CARD_TOKENS_CSS` — embedded once per page — makes the same
 * card markup render correctly in both hosts: the webview host overrides the
 * `--vscode-*` variables, the served host falls through to the fallback.
 */
import type { InsightAnswer } from "@claude-stats/core/types/insight";

/** Escapes text for safe embedding as HTML content or a double-quoted
 *  attribute value. Local copy, matching `template.ts`'s own escaper — the
 *  two must stay independent so this module has no import-order coupling
 *  with the 3,400-line file it exists to relieve. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Design tokens for the card primitive, as CSS custom properties. Embed once
 * inside the page's `<style>` block (or a webview's) before rendering any
 * card. Values follow `--vscode-<name>` with a fallback to the served
 * dashboard's existing palette so light/dark VS Code themes and the served
 * (theme-less) host all render sensibly.
 */
export const CARD_TOKENS_CSS = `
    :root {
      --cs-card-bg: var(--vscode-editorWidget-background, #16213e);
      --cs-card-border: var(--vscode-widget-border, #0f3460);
      --cs-card-fg: var(--vscode-foreground, #eee);
      --cs-card-fg-muted: var(--vscode-descriptionForeground, #888);
      --cs-card-accent: var(--vscode-textLink-foreground, #a0c4ff);
      --cs-card-up: var(--vscode-testing-iconPassed, #59a14f);
      --cs-card-down: var(--vscode-testing-iconFailed, #e15759);
      --cs-card-unavailable-bg: var(--vscode-inputValidation-infoBackground, #1c2740);
      --cs-card-unavailable-border: var(--vscode-inputValidation-infoBorder, #2a3552);
    }`;

const TREND_GLYPH: Record<InsightAnswer["trend"], string> = {
  up: "▲",
  down: "▼",
  flat: "—",
  unknown: "",
};

export interface RenderCardOptions {
  /** Optional heading shown above the answer sentence (e.g. the question
   *  label — "What did AI cost?"). Omit for a bare card. */
  title?: string;
  /** DOM id for the card root — lets a caller scroll/highlight a specific
   *  card (the "two-click evidence" path, gui-redesign/02 §2.5). */
  id?: string;
  /**
   * Override the evidence link's `href`, leaving `data-evidence-link` set to
   * the answer's canonical destination.
   *
   * `InsightAnswer.evidenceLink` names a DOMAIN VIEW (`"cost-and-controlling"`),
   * which is where the evidence lives in the target IA — but those views are
   * Phase 3 and the same evidence currently sits in a today-tab. A host that
   * knows the current mapping supplies the href it can actually navigate to;
   * the canonical id stays on the element so the later regrouping is a
   * one-line change at the mapping, not a hunt through the markup. Ignored
   * when the answer has no `evidenceLink` — an answer with no evidence must
   * not grow a link just because a caller offered one.
   */
  evidenceHref?: string;
}

/**
 * Render one `InsightAnswer` as a card. Handles both branches:
 * the normal answer (sentence, value, trend arrow, caveat) and the honest
 * `unavailable` state (its own sentence plus an enablement line, no number).
 */
export function renderCard(answer: InsightAnswer, opts: RenderCardOptions = {}): string {
  const idAttr = opts.id ? ` id="${escapeHtml(opts.id)}"` : "";
  const titleHtml = opts.title
    ? `<div class="cs-card-title">${escapeHtml(opts.title)}</div>`
    : "";

  if (answer.unavailable) {
    return `<div class="cs-card cs-card-unavailable"${idAttr} data-question="${escapeHtml(answer.question)}">
      ${titleHtml}
      <div class="cs-card-answer">${escapeHtml(answer.answer)}</div>
      <div class="cs-card-enablement">${escapeHtml(answer.unavailable.enablement)}</div>
    </div>`;
  }

  const glyph = TREND_GLYPH[answer.trend];
  const trendClass = answer.trend === "up" ? "cs-trend-up" : answer.trend === "down" ? "cs-trend-down" : "cs-trend-flat";
  const valueHtml = answer.value
    ? `<div class="cs-card-value">
        <span>${escapeHtml(answer.value)}</span>
        ${glyph ? `<span class="${trendClass}" title="${escapeHtml(answer.trend)}">${glyph}</span>` : ""}
      </div>`
    : "";
  const caveatHtml = answer.caveat ? `<div class="cs-card-caveat">${escapeHtml(answer.caveat)}</div>` : "";
  const evidenceHtml = answer.evidenceLink
    ? `<a class="cs-card-evidence" href="${escapeHtml(opts.evidenceHref ?? `#${answer.evidenceLink}`)}" data-evidence-link="${escapeHtml(answer.evidenceLink)}">›</a>`
    : "";

  return `<div class="cs-card"${idAttr} data-question="${escapeHtml(answer.question)}">
      ${titleHtml}
      <div class="cs-card-answer">${escapeHtml(answer.answer)}</div>
      ${valueHtml}
      ${caveatHtml}
      ${evidenceHtml}
    </div>`;
}

/** Card-level CSS. Depends only on the tokens above — safe to embed
 *  alongside `CARD_TOKENS_CSS` in either host's `<style>` block. */
export const CARD_CSS = `
    .cs-card {
      background: var(--cs-card-bg); border: 1px solid var(--cs-card-border);
      border-radius: 6px; padding: 0.75rem 1rem; position: relative;
    }
    .cs-card-title {
      font-size: 0.7rem; color: var(--cs-card-fg-muted); text-transform: uppercase;
      letter-spacing: 0.05em; margin-bottom: 0.35rem;
    }
    .cs-card-answer { font-size: 0.85rem; color: var(--cs-card-fg); line-height: 1.4; }
    .cs-card-value {
      display: flex; align-items: baseline; gap: 0.4rem;
      font-size: 1.3rem; font-weight: 700; color: var(--cs-card-accent);
      margin-top: 0.35rem;
    }
    .cs-trend-up { color: var(--cs-card-up); font-size: 0.8rem; }
    .cs-trend-down { color: var(--cs-card-down); font-size: 0.8rem; }
    .cs-trend-flat { color: var(--cs-card-fg-muted); font-size: 0.8rem; }
    .cs-card-caveat { font-size: 0.65rem; color: var(--cs-card-fg-muted); margin-top: 0.4rem; }
    .cs-card-evidence {
      position: absolute; top: 0.6rem; right: 0.75rem;
      color: var(--cs-card-accent); text-decoration: none; font-size: 0.9rem;
    }
    .cs-card-unavailable {
      background: var(--cs-card-unavailable-bg); border-color: var(--cs-card-unavailable-border);
    }
    .cs-card-enablement { font-size: 0.7rem; color: var(--cs-card-fg-muted); margin-top: 0.4rem; }`;
