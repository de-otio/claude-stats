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
 *
 * LOCALIZATION SCOPE, stated so the boundary is not mistaken for an oversight:
 * the sentences this pack SHARES with the dashboard and the CLI — the cost
 * caveat, the coverage caveat, the dev-time label — go through the injected
 * `InsightT` and are localized. The pack's OWN chrome (section headings, the
 * table column labels, `MODE_LABEL`, `TASK_CLASS_LABELS`, `UNAVAILABLE_TEXT`,
 * `scopeLabel`) is still English. That is deliberate: those strings have
 * exactly one surface, so localizing them cannot create the cross-surface drift
 * this module exists to prevent, and folding them in would double this change.
 * They are a separate, self-contained lane.
 */
import { isTicketKey } from "./tickets.js";
import type { InsightT } from "./insight.js";
import { formatDevTime, formatMoney, formatMoneyCsv, formatPercent, confidenceCaveat, costCaveat } from "./insight.js";
import { computeReconciliation } from "./reconciliation.js";
import type { AccountMode, Confidence, PolicyEvent, ReconciliationCause, TaskClass, TicketCoverage } from "./types/insight.js";
import type {
  JustificationPackModel,
  JustificationPackSectionId,
  PackHeadline,
  PackMethodology,
  PackNonTicketRow,
  PackReconciliation,
  PackScope,
  PackTicketRow,
  PackUnavailableSections,
} from "./types/pack.js";

/** English one-line explanation per residual cause — pack chrome, deliberately
 *  not localized (same "own English chrome" scope this file's header states
 *  for `MODE_LABEL`/`TASK_CLASS_LABELS`). Keep in cost-relevance order so the
 *  rendered list reads as "most likely first". */
const RECONCILIATION_CAUSE_TEXT: Readonly<Record<ReconciliationCause, string>> = {
  "unpriced-usage": "Usage on models with no pricing row this period (see unpriced-token count above).",
  "fallback-rates": "Some usage priced at first-party rates in place of an unconfigured partner rate.",
  "scope-mismatch":
    "The invoice's scope was not confirmed in config (reconciliation.scopeNote) — it may cover a different " +
    "account, project, or date range than this report.",
  unexplained: "No known cause accounts for this residual from the data available to this report.",
};

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
  /** What the invoice figure covers — `config.reconciliation.scopeNote`,
   *  passed straight through to {@link computeReconciliation}. */
  reconciliationScopeNote?: string | null;
  anyFallbackRates?: boolean;
  /** Configured monthly plan fee. Only rendered when `mode === "plan"` — a
   *  metered account's fee field (if any) is not this figure's business
   *  (I-4). */
  planFee?: number | null;
  /** Tokens with no pricing row this period — pass `TicketCostReport
   *  .unknownTokens` straight through (I-3). Defaults to 0, never silently
   *  dropped by an omitted field: a caller that forgets to wire it gets an
   *  honest "no unpriced usage" rather than a caveat that happens to vanish. */
  unknownTokens?: number;
}

export function buildPackHeadline(t: InsightT, input: BuildHeadlineInput): PackHeadline {
  const totalCost = input.coverage.totalCost;
  const devTimeLabel =
    input.hourlyRate && input.hourlyRate > 0 && totalCost > 0
      ? formatDevTime(t, totalCost, input.hourlyRate)
      : null;

  // Reconciliation only makes sense for metered accounts (04 §4.3): a plan
  // account's bottom-up figure is equivalent-API-VALUE, not money, so
  // comparing it against an invoice's actual dollars is a category error, not
  // a residual.
  const reconciliation: PackReconciliation | null =
    input.mode === "metered"
      ? computeReconciliation({
          bottomUp: totalCost,
          invoiceTotal: input.reconciledInvoiceTotal,
          tolerance: input.reconciliationTolerance,
          unknownTokens: input.unknownTokens,
          anyFallbackRates: input.anyFallbackRates,
          scopeNote: input.reconciliationScopeNote,
        })
      : null;

  // Attributed cost split by evidence tier, as a fraction of attributedCost —
  // the same mix `coverageCaveat`'s prose already describes, as numbers a
  // CSV/appendix reader can carry into a spreadsheet without re-parsing a
  // sentence (I-5). Null when there's nothing attributed to split.
  const confidenceMix: Readonly<Record<Confidence, number>> | null =
    input.coverage.attributedCost > 0
      ? {
          high: (input.coverage.byConfidence.high ?? 0) / input.coverage.attributedCost,
          medium: (input.coverage.byConfidence.medium ?? 0) / input.coverage.attributedCost,
          low: (input.coverage.byConfidence.low ?? 0) / input.coverage.attributedCost,
        }
      : null;

  return {
    mode: input.mode,
    currency: input.currency,
    totalCost,
    devTimeLabel,
    coverageRatio: input.coverage.ratio,
    coverageCaveat: confidenceCaveat(t, input.coverage),
    // `costCaveat` now takes `reconciledWithinTolerance` explicitly (fixed
    // alongside this call site — it used to read ANY ratio as an affirmative
    // "reconciles with the invoice at X%", which was actively misleading for
    // a residual far from tolerance). With that fixed, feeding the real ratio
    // and verdict through is safe and is exactly what makes this caveat state
    // something instead of nothing (R — reconciliation was the starved
    // integration point `costCaveat`'s `reconciledRatio` param was built for).
    costCaveatText: costCaveat(t, input.mode, {
      reconciledRatio: reconciliation?.ratio ?? null,
      reconciledWithinTolerance: reconciliation?.withinTolerance,
      anyFallbackRates: input.anyFallbackRates ?? false,
    }),
    reconciliation,
    // I-4: only a plan-mode pack states a plan fee — a metered account's fee
    // field (if any exists in config) has no place in this headline.
    planFee: input.mode === "plan" ? (input.planFee ?? null) : null,
    anyFallbackRates: input.anyFallbackRates ?? false,
    unknownTokens: input.unknownTokens ?? 0,
    confidenceMix,
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

/** Per-class aggregate the caller supplies to `buildNonTicketRows`.
 *  `byConfidence` is optional so existing/simpler callers keep working; when
 *  present it carries the classifier's own confidence for the sessions in
 *  this bucket, cost-weighted, so the row can report which tier dominates
 *  rather than dropping that information on the floor (I-5). */
export interface NonTicketClassAggregate {
  cost: number;
  sessionCount: number;
  byConfidence?: Readonly<Record<Confidence, number>>;
}

export function buildNonTicketRows(
  byClass: ReadonlyMap<string, NonTicketClassAggregate>,
): PackNonTicketRow[] {
  return [...byClass.entries()]
    .map(([taskClass, v]): PackNonTicketRow => {
      let confidence: Confidence | null = null;
      if (v.byConfidence) {
        const order: Confidence[] = ["high", "medium", "low"];
        let bestValue = 0;
        for (const c of order) {
          const value = v.byConfidence[c] ?? 0;
          if (value > bestValue) {
            bestValue = value;
            confidence = c;
          }
        }
      }
      return {
        taskClass: taskClass as TaskClass | "unclassified",
        cost: v.cost,
        sessionCount: v.sessionCount,
        confidence,
      };
    })
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
  /** What this generation was filtered to. Omitted (or a field left
   *  undefined) defaults to "no filter" — an explicit, honest unscoped pack,
   *  never a silently-blank one (I-2). */
  scope?: { projectPath?: string | null; accountUuid?: string | null };
  sections: readonly JustificationPackSectionId[];
  headline: BuildHeadlineInput;
  tickets?: readonly RawPackTicketRow[];
  nonTicketByClass?: ReadonlyMap<string, NonTicketClassAggregate>;
  methodology: BuildMethodologyInput;
}

/** Assemble the whole pack model. The single place section opt-in is applied
 *  — every renderer downstream just reads what's present (05 §5.3: "the tool
 *  never produces a pack the developer hasn't reviewed"). */
export function buildJustificationPackModel(t: InsightT, input: BuildPackModelInput): JustificationPackModel {
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

  const scope: PackScope = {
    projectPath: input.scope?.projectPath ?? null,
    accountUuid: input.scope?.accountUuid ?? null,
  };

  return {
    generatedAt: input.generatedAt,
    period: { ...input.period },
    scope,
    sections: ALL_PACK_SECTIONS.filter((s) => wanted.has(s)),
    headline: buildPackHeadline(t, input.headline),
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

// Money and percentages route through `insight.ts`'s shared formatters with
// `precise: true` / 1 decimal — the pack is read closely (not glanced at like
// a dashboard tile), so it keeps its finer precision, but through the SAME
// implementation the dashboard uses, so the two can never quote different
// figures for the same underlying number (I-1). `fmtMoney`/`fmtPct` are thin
// currying wrappers kept only to avoid threading `currency` through every
// call site below.
function fmtMoney(n: number, currency: string): string {
  return formatMoney(n, currency, { precise: true });
}

function fmtPct(n: number): string {
  return formatPercent(n, 1);
}

/** Non-money integer with the same fixed-locale thousands separator as
 *  `formatMoney` — used for the unpriced-token count, which is a count, not
 *  a currency figure, and must not silently drift to a runtime locale. */
function fmtInt(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const MODE_LABEL: Record<AccountMode, string> = {
  plan: "Flat-rate plan (equivalent-API-value framing)",
  metered: "Metered / pay-per-token billing (actual cost)",
};

/** One human-readable line describing what a pack was filtered to — always
 *  rendered, because "no filter" is itself a fact the reader needs (I-2): a
 *  scoped pack must never be textually indistinguishable from a whole-machine
 *  one, and an unscoped pack should say so rather than just omitting a line. */
function scopeLabel(scope: PackScope): string {
  const parts: string[] = [];
  if (scope.projectPath) parts.push(`project ${scope.projectPath}`);
  if (scope.accountUuid) parts.push(`account ${scope.accountUuid}`);
  return parts.length > 0 ? parts.join(" · ") : "unscoped — all projects and accounts on this machine";
}

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
      `Scope: ${escapeHtml(scopeLabel(model.scope))} · ` +
      `generated ${escapeHtml(isoStamp(model.generatedAt))}</div>`,
  );

  if (model.sections.includes("headline")) {
    parts.push(`<div class="headline">`);
    parts.push(`<div class="figure">${fmtMoney(h.totalCost, h.currency)}</div>`);
    if (h.devTimeLabel) parts.push(`<div>≈ ${escapeHtml(h.devTimeLabel)} at the configured rate</div>`);
    if (h.planFee != null) {
      parts.push(`<div>Plan fee: ${fmtMoney(h.planFee, h.currency)}/mo</div>`);
    }
    if (h.coverageRatio != null) {
      parts.push(`<div>${fmtPct(h.coverageRatio)} of spend is ticket-attributable</div>`);
    }
    parts.push(`<div class="caveat">${escapeHtml(h.costCaveatText)}</div>`);
    if (h.coverageCaveat) parts.push(`<div class="caveat">${escapeHtml(h.coverageCaveat)}</div>`);
    if (h.unknownTokens > 0) {
      parts.push(
        `<div class="caveat">${fmtInt(h.unknownTokens)} tokens from unpriced models are excluded from the ` +
          `total above — the figure understates spend by that amount.</div>`,
      );
    }
    if (h.reconciliation) {
      const r = h.reconciliation;
      const verdict = r.withinTolerance ? "reconciles" : "does not reconcile";
      parts.push(
        `<div class="caveat">Bottom-up ${fmtMoney(r.bottomUp, h.currency)} vs invoice ` +
          `${fmtMoney(r.invoiceTotal, h.currency)} → ${fmtPct(r.ratio)} — ${verdict} within ±${r.tolerancePercent}%.</div>`,
      );
      parts.push(
        `<div class="caveat">Invoice scope: ${escapeHtml(r.scopeNote ?? "not confirmed in config (reconciliation.scopeNote) — verify it covers the same account(s) and date range as this report")}.</div>`,
      );
      if (!r.withinTolerance) {
        const signedResidual = `${r.residual >= 0 ? "+" : "−"}${fmtMoney(Math.abs(r.residual), h.currency)}`;
        parts.push(
          `<div class="caveat">Residual: ${signedResidual} (invoice minus bottom-up, ${fmtPct(Math.abs(r.residualRatio))} of the invoice). ` +
            `Candidate cause${r.candidateCauses.length > 1 ? "s" : ""}: ${r.candidateCauses
              .map((c) => escapeHtml(RECONCILIATION_CAUSE_TEXT[c]))
              .join(" ")}</div>`,
        );
      }
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
        `<table><thead><tr><th>Kind of work</th><th>Classification confidence</th>` +
          `<th class="num">Sessions</th><th class="num">Cost</th></tr></thead><tbody>`,
      );
      for (const row of model.nonTicket) {
        const confidenceLabel = row.confidence ? CONFIDENCE_LABELS[row.confidence] : "—";
        parts.push(
          `<tr><td>${escapeHtml(TASK_CLASS_LABELS[row.taskClass] ?? row.taskClass)}</td>` +
            `<td>${escapeHtml(confidenceLabel)}</td>` +
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
  parts.push(`<dt>Scope</dt><dd>${escapeHtml(scopeLabel(model.scope))}.</dd>`);
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

/** `ticketKey, period, projectPath, accountUuid, cost, tokens, sessionCount,
 *  confidence` — the export shape 04 §4.1 defines, extended with the pack's
 *  scope columns (I-2) and reused for the pack's CSV bundle. `cost` goes
 *  through `formatMoneyCsv` rather than a bare `toFixed(2)` so a genuinely
 *  priced sub-cent row never renders as an indistinguishable "0.00" (I-6). */
export function renderTicketsCsv(model: JustificationPackModel): string {
  const lines = [
    csvLine([
      "ticketKey",
      "period",
      "projectPath",
      "accountUuid",
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
        model.scope.projectPath ?? "",
        model.scope.accountUuid ?? "",
        formatMoneyCsv(t.cost),
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

/** `confidence` is the classification tier for the class bucket (or `"n/a"`
 *  when the sessions in it were never classified) — I-5: a bare cost/session
 *  count with no quality signal at all was the gap here, unlike `tickets.csv`
 *  which already carried a confidence column per row. */
export function renderNonTicketCsv(model: JustificationPackModel): string {
  const lines = [csvLine(["taskClass", "period", "projectPath", "accountUuid", "cost", "sessionCount", "confidence"])];
  for (const row of model.nonTicket ?? []) {
    lines.push(
      csvLine([
        row.taskClass,
        model.period.label,
        model.scope.projectPath ?? "",
        model.scope.accountUuid ?? "",
        formatMoneyCsv(row.cost),
        row.sessionCount,
        row.confidence ?? "n/a",
      ]),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * Carries the same honesty obligations the HTML headline renders — the
 * fallback-rate flag, the confidence mix, and unpriced tokens — into the CSV
 * (I-5). Without these columns a spreadsheet reader gets a bare total with
 * none of the qualification the HTML document carefully attaches to it.
 */
export function renderSummaryCsv(model: JustificationPackModel): string {
  const h = model.headline;
  const lines = [
    csvLine([
      "period",
      "projectPath",
      "accountUuid",
      "mode",
      "currency",
      "totalCost",
      "coverageRatio",
      "confidenceHigh",
      "confidenceMedium",
      "confidenceLow",
      "anyFallbackRates",
      "unknownTokens",
      "planFee",
      "reconciledInvoiceTotal",
      "reconciledRatio",
      "withinTolerance",
      "reconciliationResidual",
      "reconciliationScopeNote",
      "reconciliationCandidateCauses",
    ]),
    csvLine([
      model.period.label,
      model.scope.projectPath ?? "",
      model.scope.accountUuid ?? "",
      h.mode,
      h.currency,
      formatMoneyCsv(h.totalCost),
      h.coverageRatio != null ? h.coverageRatio.toFixed(4) : "",
      h.confidenceMix ? h.confidenceMix.high.toFixed(4) : "",
      h.confidenceMix ? h.confidenceMix.medium.toFixed(4) : "",
      h.confidenceMix ? h.confidenceMix.low.toFixed(4) : "",
      String(h.anyFallbackRates),
      h.unknownTokens,
      h.planFee != null ? h.planFee.toFixed(2) : "",
      h.reconciliation ? h.reconciliation.invoiceTotal.toFixed(2) : "",
      h.reconciliation ? h.reconciliation.ratio.toFixed(4) : "",
      h.reconciliation ? String(h.reconciliation.withinTolerance) : "",
      h.reconciliation ? formatMoneyCsv(h.reconciliation.residual) : "",
      h.reconciliation?.scopeNote ?? "",
      h.reconciliation ? h.reconciliation.candidateCauses.join(";") : "",
    ]),
  ];
  return lines.join("\r\n") + "\r\n";
}
