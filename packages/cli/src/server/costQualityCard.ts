/**
 * The consolidated cost-quality card — one card, three layers.
 *
 * The diagnosis names this as debt in its own right: "three competing
 * cost-quality cards on Spending (cost-per-task, efficiency frontier,
 * calibration — each with its own headline number and honesty caveats)"
 * (doc/analysis/gui-redesign/01-diagnosis.md §1.2, §1.5). Three headline numbers
 * competing for one question is why the reader has to study the page instead of
 * reading it. The fix is prescribed:
 *
 *   "The three cost-quality cards consolidate per value-per-cost/06: frontier
 *    leads, cost-per-task nests inside it, calibration shrinks to a caveat badge
 *    with a details popover." (03-migration-and-mechanics.md §3.2 phase 3, and
 *    §3.3 item 1: "Three cost-quality cards → one layered card".)
 *
 * So the layer ORDER here is the whole point and is not cosmetic: the frontier
 * leads because value-per-cost/06 makes it the headline and cost-per-successful
 * -task the layer inside it (01 §1.4 — "implemented but never promoted": the
 * frontier card was built and then placed BELOW the card it was supposed to
 * demote). Calibration goes last and collapsed, because it qualifies the other
 * two rather than answering anything itself.
 *
 * ## What this module does NOT do
 *
 * It composes; it does not format. Each layer arrives as already-rendered HTML
 * from the one place that knows how to render it, and the badge text arrives
 * already localized. Nothing here computes, rounds, scales or phrases a figure —
 * so consolidating the cards cannot change one, which is the property the
 * regrouping's behaviour comparison pins (a moved card must not move a figure).
 * The only decision made here is which layers exist and in what order.
 */

/** Minimal translator signature — the same shape `template.ts` accepts. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * The calibration layer: a verdict for the collapsed summary, and the full view
 * for the expanded body.
 *
 * The summary deliberately carries NO number. Calibration's own figures (the
 * label count, the precision pair, the Brier scores) live in the body one click
 * away; repeating one of them in the summary would put a fourth headline figure
 * back on the card this module exists to reduce to one — and a figure in a
 * collapsed summary is a figure whose caveats are hidden.
 */
export interface CalibrationLayer {
  /** Rendered calibration view (table, readiness line, activation toggle). */
  body: string;
  /** Localized one-line verdict shown on the collapsed `<summary>`. */
  summary: string;
}

export interface CostQualityLayers {
  /** The efficiency frontier — realised vs frontier vs recoverable, and levers. */
  frontier: string;
  /** Cost per successful task — headline, decomposition, badges, per-model. */
  perTask: string;
  /** Calibration, or null when the host has no calibration data (serve/CLI). */
  calibration: CalibrationLayer | null;
}

/** DOM id of the card, so an evidence link can name it. */
export const COST_QUALITY_ANCHOR = "cost-quality";

/**
 * Render the card, or `""` when no layer has anything to say.
 *
 * Returning `""` rather than an empty card matters: the three predecessors were
 * each individually conditional, so a payload with no cost-per-task report and
 * no calibration rendered nothing at all in this spot. An always-present empty
 * shell would be a new silent-emptiness defect (02 §2.6) on the exact screen the
 * consolidation is supposed to make calmer.
 */
export function renderCostQualityCard(layers: CostQualityLayers, t: TranslateFn): string {
  const hasCalibration = layers.calibration !== null && layers.calibration.body.length > 0;
  if (layers.frontier.length === 0 && layers.perTask.length === 0 && !hasCalibration) return "";

  const layerBlock = (titleKey: string, body: string): string =>
    body.length === 0
      ? ""
      : `
      <div class="cs-cq-layer">
        <div class="cs-cq-layer-title">${t(titleKey)}</div>
        ${body}
      </div>`;

  // `<details>` rather than a bespoke toggle: it is the popover the plan asks
  // for, it works with no JavaScript at all (so the served page and a webview
  // whose CSP blocked a handler behave the same), and it is keyboard- and
  // screen-reader-navigable without any ARIA of ours.
  const calibrationBlock = hasCalibration
    ? `
      <details class="cs-cq-calibration">
        <summary class="cs-cq-caveat">${layers.calibration!.summary}</summary>
        <div class="cs-cq-layer-title">${t("dashboard:costQuality.calibrationLayer")}</div>
        ${layers.calibration!.body}
      </details>`
    : "";

  return `
    <div class="cpt-card cs-cq-card" id="${COST_QUALITY_ANCHOR}">
      <div class="cs-cq-title">${t("dashboard:costQuality.title")}</div>${layerBlock(
        "dashboard:costQuality.frontierLayer",
        layers.frontier,
      )}${layerBlock("dashboard:costQuality.perTaskLayer", layers.perTask)}${calibrationBlock}
    </div>`;
}

/**
 * Card chrome. The three predecessors each carried the same inline style block
 * (`background:#16213e;border:1px solid #2a3552;…`); it is declared once here
 * and the layers inside are plain, so the card reads as one surface rather than
 * three boxes stacked in a fourth.
 */
export const COST_QUALITY_CSS = `
    .cs-cq-card {
      margin-bottom: 1rem; background: #16213e; border: 1px solid #2a3552;
      border-radius: 6px; padding: 0.75rem 1rem;
    }
    .cs-cq-title {
      font-size: 0.75rem; color: #a0c4ff; text-transform: uppercase;
      letter-spacing: 0.05em; margin-bottom: 0.6rem;
    }
    .cs-cq-layer + .cs-cq-layer { margin-top: 0.9rem; padding-top: 0.7rem; border-top: 1px solid #2a3552; }
    .cs-cq-layer-title { font-size: 0.65rem; color: #8892b0; margin-bottom: 0.35rem; }
    .cs-cq-calibration { margin-top: 0.9rem; padding-top: 0.7rem; border-top: 1px solid #2a3552; }
    .cs-cq-caveat {
      font-size: 0.7rem; color: #9aa3c0; cursor: pointer; list-style: revert;
    }
    .cs-cq-calibration[open] .cs-cq-caveat { margin-bottom: 0.5rem; }`;
