/**
 * The justification pack — pure model builders + renderers.
 *
 * Design: doc/analysis/ticket-attribution/05-justification-pack.md,
 *         04-reporting-and-roi.md.
 *
 * Everything here is pure: no clock (`generatedAt` is injected), no I/O, no
 * `Math.random()`, and every collection is sorted before it is rendered. That
 * is what makes "generate twice under a frozen clock → byte-identical bytes"
 * hold — the pack's entire credibility argument (05 §5.3).
 *
 * Quotes `insight.ts`'s formatters rather than re-deriving strings, so the
 * pack and the dashboard can never disagree about what a number means.
 */
import { isTicketKey } from "./tickets.js";
import { formatDevTime, confidenceCaveat, costCaveat } from "./insight.js";
import type { AccountMode, Confidence, PolicyEvent, TaskClass, TicketCoverage } from "./types/insight.js";
import type {
  JustificationPackModel,
  JustificationPackSectionId,
  PackHeadline,
  PackMethodology,
  PackNonTicketRow,
  PackReconciliation,
  PackTicketRow,
  PackUnavailableSections,
} from "./types/pack.js";

export const PACK_SCHEMA_VERSION = 1;

export const ALL_PACK_SECTIONS: readonly JustificationPackSectionId[] = [
  "headline",
  "tickets",
  "nonticket",
  "hygiene",
  "constraint",
  "calibration",
];

/** Sections 1–3 of 05 §5.2 — "a complete monthly pack for a team with no
 *  policy events." The developer still opts in explicitly; this is only the
 *  CLI/MCP default when `--sections` is omitted. */
export const DEFAULT_PACK_SECTIONS: readonly JustificationPackSectionId[] = [
  "headline",
  "tickets",
  "nonticket",
];

export const TASK_CLASS_LABELS: Readonly<Record<TaskClass | "unclassified", string>> = {
  debug: "Debugging",
  "refactor-multi-file": "Multi-file refactor",
  greenfield: "Greenfield build",
  review: "Code review",
  "config-chore": "Config / infra chore",
  explore: "Exploration",
  unknown: "Unclassified (classifier abstained)",
  unclassified: "Not yet classified",
};

export const CONFIDENCE_LABELS: Readonly<Record<Confidence, string>> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

// ─── Section builders ─────────────────────────────────────────────────────────

export interface BuildHeadlineInput {
  mode: AccountMode;
  currency: string;
  coverage: TicketCoverage;
  hourlyRate?: number | null;
  reconciledInvoiceTotal?: number | null;
  /** Fraction, e.g. 0.05 for ±5%. Defaults to 0.05. */
  reconciliationTolerance?: number;
  anyFallbackRates?: boolean;
}

export function buildPackHeadline(input: BuildHeadlineInput): PackHeadline {
  const totalCost = input.coverage.totalCost;
  const devTimeLabel =
    input.hourlyRate && input.hourlyRate > 0 && totalCost > 0
      ? formatDevTime(totalCost, input.hourlyRate)
      : null;

  let reconciliation: PackReconciliation | null = null;
  if (
    input.mode === "metered" &&
    input.reconciledInvoiceTotal != null &&
    Number.isFinite(input.reconciledInvoiceTotal) &&
    input.reconciledInvoiceTotal > 0
  ) {
    const tolerance = input.reconciliationTolerance ?? 0.05;
    const ratio = totalCost / input.reconciledInvoiceTotal;
    reconciliation = {
      bottomUp: totalCost,
      invoiceTotal: input.reconciledInvoiceTotal,
      ratio,
      withinTolerance: Math.abs(1 - ratio) <= tolerance,
      tolerancePercent: Math.round(tolerance * 100),
    };
  }

  return {
    mode: input.mode,
    currency: input.currency,
    totalCost,
    devTimeLabel,
    coverageRatio: input.coverage.ratio,
    coverageCaveat: confidenceCaveat(input.coverage),
    // Deliberately NOT passing reconciliation.ratio into costCaveat here:
    // costCaveat's "reconciles with the invoice at X%" phrasing reads as an
    // affirmative claim at any X, which is actively misleading for a residual
    // FAR from 100% (e.g. "reconciles ... at 4%" when the two figures barely
    // relate) — self-contradictory next to this same headline's own
    // tolerance-aware `reconciliation` block below, which states the verdict
    // correctly either way. The pack still quotes costCaveat for the mode
    // sentence and the fallback-rate caveat; it just doesn't feed it a number
    // whose wording that formatter doesn't yet handle safely.
    costCaveatText: costCaveat(input.mode, {
      reconciledRatio: null,
      anyFallbackRates: input.anyFallbackRates ?? false,
    }),
    reconciliation,
  };
}

/** A minimal per-ticket source row — whatever shape the caller's report has,
 *  as long as it carries these fields (`ticketing/index.ts`'s `TicketCostRow`
 *  is a superset and satisfies this directly). */
export interface RawPackTicketRow {
  ticketKey: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessionCount: number;
  confidence: Confidence;
}

/**
 * Minimize + sort raw ticket rows into the redacted pack shape. Rows whose key
 * fails `isTicketKey` are dropped rather than rendered — defence in depth: a
 * corrupt store row can never reach an outward-facing document even if it
 * somehow bypassed the write-path validator.
 */
export function buildTicketRows(rows: readonly RawPackTicketRow[]): PackTicketRow[] {
  return rows
    .filter((r) => isTicketKey(r.ticketKey))
    .map((r): PackTicketRow => ({
      ticketKey: r.ticketKey,
      cost: r.cost,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      sessionCount: r.sessionCount,
      confidence: r.confidence,
    }))
    .sort((a, b) => b.cost - a.cost || a.ticketKey.localeCompare(b.ticketKey));
}

export function buildNonTicketRows(
  byClass: ReadonlyMap<string, { cost: number; sessionCount: number }>,
): PackNonTicketRow[] {
  return [...byClass.entries()]
    .map(([taskClass, v]): PackNonTicketRow => ({
      taskClass: taskClass as TaskClass | "unclassified",
      cost: v.cost,
      sessionCount: v.sessionCount,
    }))
    .sort((a, b) => b.cost - a.cost || a.taskClass.localeCompare(b.taskClass));
}

export interface BuildMethodologyInput {
  pricingVerifiedDate: string;
  taskClassVersion: number;
  languageMode: AccountMode;
  policyEvents: readonly Pick<PolicyEvent, "date" | "kind" | "scope">[];
}

export function buildPackMethodology(input: BuildMethodologyInput): PackMethodology {
  return {
    pricingVerifiedDate: input.pricingVerifiedDate,
    taskClassVersion: input.taskClassVersion,
    languageMode: input.languageMode,
    policyEvents: input.policyEvents
      .map((e) => ({ date: e.date, kind: e.kind, scope: e.scope ?? null }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind)),
  };
}

const UNAVAILABLE_TEXT: Readonly<Record<"hygiene" | "constraint" | "calibration", string>> = {
  hygiene:
    "Hygiene trend is not available in this build — it needs the efficiency-hygiene " +
    "detectors (self-audited waste as % of spend). Not yet shipped.",
  constraint:
    "Constraint-impact before/after is not available in this build — it needs the " +
    "constraint-engine comparison across a declared policy boundary. Not yet shipped. " +
    "Configured policy events are still listed in the methodology appendix.",
  calibration:
    "The calibration footnote is not available in this build — it needs outcome-" +
    "detection agreement tracked against manual labels. Not yet shipped.",
};

export interface BuildPackModelInput {
  generatedAt: number;
  period: { since: number; until: number; label: string };
  sections: readonly JustificationPackSectionId[];
  headline: BuildHeadlineInput;
  tickets?: readonly RawPackTicketRow[];
  nonTicketByClass?: ReadonlyMap<string, { cost: number; sessionCount: number }>;
  methodology: BuildMethodologyInput;
}

/** Assemble the whole pack model. The single place section opt-in is applied
 *  — every renderer downstream just reads what's present (05 §5.3: "the tool
 *  never produces a pack the developer hasn't reviewed"). */
export function buildJustificationPackModel(input: BuildPackModelInput): JustificationPackModel {
  const wanted = new Set(input.sections);

  const tickets =
    wanted.has("tickets") && input.tickets ? buildTicketRows(input.tickets) : null;
  const nonTicket =
    wanted.has("nonticket") && input.nonTicketByClass
      ? buildNonTicketRows(input.nonTicketByClass)
      : null;

  const unavailableSections: PackUnavailableSections = {
    hygiene: wanted.has("hygiene") ? UNAVAILABLE_TEXT.hygiene : null,
    constraint: wanted.has("constraint") ? UNAVAILABLE_TEXT.constraint : null,
    calibration: wanted.has("calibration") ? UNAVAILABLE_TEXT.calibration : null,
  };

  return {
    generatedAt: input.generatedAt,
    period: { ...input.period },
    sections: ALL_PACK_SECTIONS.filter((s) => wanted.has(s)),
    headline: buildPackHeadline(input.headline),
    tickets,
    nonTicket,
    methodology: buildPackMethodology(input.methodology),
    unavailableSections,
  };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isoStamp(ms: number): string {
  return new Date(ms).toISOString();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtMoney(n: number, currency: string): string {
  const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : `${currency} `;
  return `${symbol}${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

const MODE_LABEL: Record<AccountMode, string> = {
  plan: "Flat-rate plan (equivalent-API-value framing)",
  metered: "Metered / pay-per-token billing (actual cost)",
};

/**
 * Render the self-contained HTML document. No external assets, no scripts,
 * no network calls — opens correctly forwarded as an email attachment or
 * printed to PDF, which is the whole point of this format (05 §5.1).
 */
export function renderJustificationPackHtml(model: JustificationPackModel): string {
  const parts: string[] = [];
  const h = model.headline;

  parts.push(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">`,
    `<title>Claude Code justification pack — ${escapeHtml(model.period.label)}</title>`,
    `<style>`,
    `:root{--fg:#1a1a1a;--muted:#5a5a66;--bg:#ffffff;--panel:#f6f6f8;--line:#dcdce2;--accent:#2f5fd6;}`,
    `@media (prefers-color-scheme:dark){:root{--fg:#e8e8ec;--muted:#a5a5b2;--bg:#15151a;--panel:#1e1e26;--line:#33333d;--accent:#7fa2ff;}}`,
    `*{box-sizing:border-box}body{margin:0;padding:2.5rem 3rem;background:var(--bg);color:var(--fg);`,
    `font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;max-width:840px;margin-inline:auto}`,
    `h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:2rem 0 .75rem;border-bottom:1px solid var(--line);padding-bottom:.35rem}`,
    `.meta{color:var(--muted);font-size:.85rem;margin-bottom:1.5rem}`,
    `.headline{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:1.25rem 1.5rem}`,
    `.figure{font-size:2rem;font-weight:600}.caveat{color:var(--muted);font-size:.85rem;margin-top:.4rem}`,
    `table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--line)}`,
    `th{color:var(--muted);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.03em}`,
    `td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}`,
    `.unavailable{background:var(--panel);border:1px dashed var(--line);border-radius:8px;padding:.9rem 1.1rem;color:var(--muted);font-size:.9rem}`,
    `.appendix{font-size:.85rem;color:var(--muted)}.appendix dt{font-weight:600;color:var(--fg);margin-top:.6rem}`,
    `@media print{body{padding:0 1cm}.headline{border:1px solid #999}}`,
    `</style></head><body>`,
  );

  parts.push(
    `<h1>Claude Code usage — justification pack</h1>`,
    `<div class="meta">Period ${escapeHtml(model.period.label)} ` +
      `(${isoDate(model.period.since)} – ${isoDate(model.period.until)}) · ` +
      `generated ${escapeHtml(isoStamp(model.generatedAt))}</div>`,
  );

  if (model.sections.includes("headline")) {
    parts.push(`<div class="headline">`);
    parts.push(`<div class="figure">${fmtMoney(h.totalCost, h.currency)}</div>`);
    if (h.devTimeLabel) parts.push(`<div>≈ ${escapeHtml(h.devTimeLabel)} at the configured rate</div>`);
    if (h.coverageRatio != null) {
      parts.push(`<div>${fmtPct(h.coverageRatio)} of spend is ticket-attributable</div>`);
    }
    parts.push(`<div class="caveat">${escapeHtml(h.costCaveatText)}</div>`);
    if (h.coverageCaveat) parts.push(`<div class="caveat">${escapeHtml(h.coverageCaveat)}</div>`);
    if (h.reconciliation) {
      const r = h.reconciliation;
      const verdict = r.withinTolerance ? "reconciles" : "does not reconcile";
      parts.push(
        `<div class="caveat">Bottom-up ${fmtMoney(r.bottomUp, h.currency)} vs invoice ` +
          `${fmtMoney(r.invoiceTotal, h.currency)} → ${fmtPct(r.ratio)} — ${verdict} within ±${r.tolerancePercent}%.</div>`,
      );
    }
    parts.push(`</div>`);
  }

  if (model.sections.includes("tickets")) {
    parts.push(`<h2>Per-ticket spend</h2>`);
    if (model.tickets && model.tickets.length > 0) {
      parts.push(
        `<table><thead><tr><th>Ticket</th><th>Confidence</th><th class="num">Sessions</th>` +
          `<th class="num">Cost</th></tr></thead><tbody>`,
      );
      for (const t of model.tickets) {
        parts.push(
          `<tr><td>${escapeHtml(t.ticketKey)}</td><td>${escapeHtml(CONFIDENCE_LABELS[t.confidence] ?? t.confidence)}</td>` +
            `<td class="num">${t.sessionCount}</td><td class="num">${fmtMoney(t.cost, h.currency)}</td></tr>`,
        );
      }
      parts.push(`</tbody></table>`);
    } else {
      parts.push(`<div class="unavailable">No ticket-attributed spend in this period.</div>`);
    }
  }

  if (model.sections.includes("nonticket")) {
    parts.push(`<h2>Non-ticket work</h2>`);
    if (model.nonTicket && model.nonTicket.length > 0) {
      parts.push(
        `<table><thead><tr><th>Kind of work</th><th class="num">Sessions</th>` +
          `<th class="num">Cost</th></tr></thead><tbody>`,
      );
      for (const row of model.nonTicket) {
        parts.push(
          `<tr><td>${escapeHtml(TASK_CLASS_LABELS[row.taskClass] ?? row.taskClass)}</td>` +
            `<td class="num">${row.sessionCount}</td><td class="num">${fmtMoney(row.cost, h.currency)}</td></tr>`,
        );
      }
      parts.push(`</tbody></table>`);
    } else {
      parts.push(`<div class="unavailable">No non-ticket spend in this period.</div>`);
    }
  }

  for (const key of ["hygiene", "constraint", "calibration"] as const) {
    const msg = model.unavailableSections[key];
    if (msg) {
      parts.push(`<h2>${key === "hygiene" ? "Hygiene trend" : key === "constraint" ? "Constraint impact" : "Calibration"}</h2>`);
      parts.push(`<div class="unavailable">${escapeHtml(msg)}</div>`);
    }
  }

  const m = model.methodology;
  parts.push(`<h2>Methodology</h2><dl class="appendix">`);
  parts.push(`<dt>Pricing table</dt><dd>Verified ${escapeHtml(m.pricingVerifiedDate)}.</dd>`);
  parts.push(`<dt>Language mode</dt><dd>${escapeHtml(MODE_LABEL[m.languageMode])}.</dd>`);
  parts.push(
    `<dt>Confidence tiers</dt><dd>High/medium/low evidence grade per attribution — see ` +
      `doc/analysis/ticket-attribution/01-attribution-signals.md. A session linked to more ` +
      `than one ticket with no message-level evidence to split on is reported as ambiguous, ` +
      `never silently split.</dd>`,
  );
  parts.push(
    `<dt>Task classes (classifier v${m.taskClassVersion})</dt><dd>${Object.values(TASK_CLASS_LABELS)
      .map(escapeHtml)
      .join(" · ")}.</dd>`,
  );
  if (m.policyEvents.length > 0) {
    parts.push(
      `<dt>Declared policy events</dt><dd>${m.policyEvents
        .map((e) => escapeHtml(`${e.date} — ${e.kind}${e.scope ? ` (${e.scope})` : ""}`))
        .join("; ")}.</dd>`,
    );
  }
  parts.push(`</dl>`);

  parts.push(`</body></html>`);
  return parts.join("\n");
}

// ─── CSV bundle ───────────────────────────────────────────────────────────────

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(cells: readonly (string | number)[]): string {
  return cells.map(csvCell).join(",");
}

/** `ticketKey, period, cost, tokens, confidence, sessionCount` — the export
 *  shape 04 §4.1 defines, reused verbatim for the pack's CSV bundle. */
export function renderTicketsCsv(model: JustificationPackModel): string {
  const lines = [
    csvLine([
      "ticketKey",
      "period",
      "cost",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheCreationTokens",
      "sessionCount",
      "confidence",
    ]),
  ];
  for (const t of model.tickets ?? []) {
    lines.push(
      csvLine([
        t.ticketKey,
        model.period.label,
        t.cost.toFixed(2),
        t.inputTokens,
        t.outputTokens,
        t.cacheReadTokens,
        t.cacheCreationTokens,
        t.sessionCount,
        t.confidence,
      ]),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

export function renderNonTicketCsv(model: JustificationPackModel): string {
  const lines = [csvLine(["taskClass", "period", "cost", "sessionCount"])];
  for (const row of model.nonTicket ?? []) {
    lines.push(csvLine([row.taskClass, model.period.label, row.cost.toFixed(2), row.sessionCount]));
  }
  return lines.join("\r\n") + "\r\n";
}

export function renderSummaryCsv(model: JustificationPackModel): string {
  const h = model.headline;
  const lines = [
    csvLine([
      "period",
      "mode",
      "currency",
      "totalCost",
      "coverageRatio",
      "reconciledInvoiceTotal",
      "reconciledRatio",
      "withinTolerance",
    ]),
    csvLine([
      model.period.label,
      h.mode,
      h.currency,
      h.totalCost.toFixed(2),
      h.coverageRatio != null ? h.coverageRatio.toFixed(4) : "",
      h.reconciliation ? h.reconciliation.invoiceTotal.toFixed(2) : "",
      h.reconciliation ? h.reconciliation.ratio.toFixed(4) : "",
      h.reconciliation ? String(h.reconciliation.withinTolerance) : "",
    ]),
  ];
  return lines.join("\r\n") + "\r\n";
}
