/**
 * Figure extraction for the regrouping's behaviour comparison.
 *
 * The rule the redesign has to hold to is "moving a card must not move a
 * figure" (doc/analysis/gui-redesign/03 §3.2 phase 3). A DOM snapshot of a
 * 3,000-line page cannot express that — it fails on every whitespace change and
 * passes on a silently rescaled percentage. So the comparison is over the
 * NUMBERS the page renders, grouped by the panel they render in: reorder a card
 * inside a panel and nothing changes; move a number to a different panel, drop
 * one, or scale one by 100, and the multiset for that panel changes.
 *
 * Script bodies are excluded before extraction. The inline `<script>` blocks
 * carry the whole `__DASHBOARD__` JSON payload and every chart's data, so
 * including them would make the comparison dominated by numbers the reader
 * never sees — and would go green on a page whose visible figures had all
 * vanished.
 */

/** Visible text of an HTML fragment: scripts and styles dropped, tags stripped,
 *  the handful of entities this renderer emits decoded back. */
export function visibleText(htmlFragment: string): string {
  return htmlFragment
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Every number-shaped token in a fragment's visible text, sorted.
 *
 * Sorted, not in document order, precisely so that REORDERING a card inside its
 * view is invisible to the comparison while a changed, lost or gained value is
 * not. A currency prefix and a trailing `%` are kept as part of the token: "$35"
 * and "35%" are different claims about the same 35 and must not compare equal.
 */
export function figuresIn(htmlFragment: string): string[] {
  const text = visibleText(htmlFragment);
  const matches = text.match(/[$€£]?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
  return [...matches].sort();
}

/**
 * Figures per tab panel, keyed by the panel's section id.
 *
 * Panels are top-level siblings in the rendered body, so each one runs from its
 * own `id="tab-<id>"` to the next panel's. That boundary rule survives the
 * regrouping by construction: the grouping adds a `data-view` attribute and
 * changes the tab bar, it does not re-nest the panels.
 */
export function panelFigures(html: string): Record<string, string[]> {
  const re = /id="tab-([a-z-]+)"/g;
  const starts: Array<{ id: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) starts.push({ id: m[1]!, at: m.index });

  const out: Record<string, string[]> = {};
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!.at;
    const to = i + 1 < starts.length ? starts[i + 1]!.at : html.length;
    out[starts[i]!.id] = figuresIn(html.slice(from, to));
  }
  return out;
}
