/**
 * Justification pack — imperative shell around the pure builders/renderers in
 * `@claude-stats/core/pack`.
 *
 * Gathers already-shipped Phase-1 data (ticket attribution, task-class
 * counts, config) and writes a self-contained HTML document plus a CSV
 * bundle to a directory. Nothing here calls the network; the only I/O is
 * local store reads and local file writes.
 *
 * Design: doc/analysis/ticket-attribution/05-justification-pack.md.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "../store/index.js";
import type { Config } from "../config.js";
import { getTicketCostReport } from "../ticketing/index.js";
import { dayWindowInTz } from "../recap/index.js";
import { t } from "../i18n.js";
import { PRICING_VERIFIED_DATE } from "@claude-stats/core/pricing";
import { TASK_CLASS_VERSION } from "@claude-stats/core/taskClass";
import {
  ALL_PACK_SECTIONS,
  DEFAULT_PACK_SECTIONS,
  PACK_SCHEMA_VERSION,
  buildJustificationPackModel,
  renderJustificationPackHtml,
  renderNonTicketCsv,
  renderSummaryCsv,
  renderTicketsCsv,
} from "@claude-stats/core/pack";
import type { AccountMode, Confidence } from "@claude-stats/core/types/insight";
import type { JustificationPackModel, JustificationPackSectionId } from "@claude-stats/core/types/pack";

export { ALL_PACK_SECTIONS, DEFAULT_PACK_SECTIONS, PACK_SCHEMA_VERSION };

/**
 * Parse a `YYYY-MM` period string into a concrete `[since, until)` window in
 * `tz`, and a stable label for the CSV `period` column. Pure given `tz` (no
 * `Date.now()`), so the same `(period, tz)` pair always resolves to the same
 * window — required for determinism (regenerating a past month must not
 * shift with the machine's clock).
 */
export function resolvePackPeriod(period: string, tz: string): { since: number; until: number; label: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!m) throw new RangeError(`--period must be YYYY-MM, got "${period}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new RangeError(`--period must be YYYY-MM, got "${period}"`);
  const { startMs: since } = dayWindowInTz(`${m[1]}-${m[2]}-01`, tz);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const { startMs: until } = dayWindowInTz(
    `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`,
    tz,
  );
  return { since, until, label: `${m[1]}-${m[2]}` };
}

/**
 * Parse a `--sections` CLI/MCP value (comma-separated) into a validated,
 * deduplicated list. Unknown tokens are dropped rather than rejected — an
 * unattended-safe default (rule §5), never a thrown error over a typo.
 */
export function parseSections(raw: string | undefined): JustificationPackSectionId[] {
  if (!raw || raw.trim().length === 0) return [...DEFAULT_PACK_SECTIONS];
  const known = new Set<string>(ALL_PACK_SECTIONS);
  const seen = new Set<JustificationPackSectionId>();
  for (const token of raw.split(",").map((s) => s.trim().toLowerCase())) {
    if (known.has(token)) seen.add(token as JustificationPackSectionId);
  }
  return ALL_PACK_SECTIONS.filter((s) => seen.has(s));
}

/**
 * Effective account-mode inference for the pack, mirroring the dashboard's
 * "a detected plan fee implies plan-mode" convention (`resolveAccountMode`'s
 * subscription-type path is unwired — phase-1-result.md item 3, left for
 * G1). Explicit `config.pricing.mode` always wins.
 */
function resolvePackMode(config: Config): { mode: AccountMode; planFee: number } {
  const accountFeesTotal = Object.values(config.accountFees ?? {}).reduce((sum, f) => sum + f.monthlyFee, 0);
  const planFee = config.plan?.monthly_fee && config.plan.monthly_fee > 0 ? config.plan.monthly_fee : accountFeesTotal;
  const mode: AccountMode = config.pricing?.mode ?? (planFee > 0 ? "plan" : "metered");
  return { mode, planFee };
}

export interface PackGenerateOptions {
  /** `YYYY-MM`. Required — the pack is always scoped to a whole calendar month. */
  period: string;
  timezone?: string;
  sections?: readonly JustificationPackSectionId[];
  projectPath?: string;
  accountUuid?: string;
  /** Injected clock. Defaults to `Date.now`; tests pin this for determinism. */
  now?: () => number;
}

export interface PackGenerateResult {
  model: JustificationPackModel;
  html: string;
  ticketsCsv: string;
  nonTicketCsv: string;
  summaryCsv: string;
}

/** Build the pack's in-memory content (no file I/O) — the piece the
 *  determinism test exercises directly. */
export function buildJustificationPack(store: Store, config: Config, opts: PackGenerateOptions): PackGenerateResult {
  const now = opts.now ?? (() => Date.now());
  const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const period = resolvePackPeriod(opts.period, tz);
  const sections = opts.sections && opts.sections.length > 0 ? [...opts.sections] : [...DEFAULT_PACK_SECTIONS];
  const { mode, planFee } = resolvePackMode(config);
  const currency = config.rate?.currency ?? "USD";

  const report = getTicketCostReport(store, {
    since: period.since,
    until: period.until,
    projectPath: opts.projectPath,
    accountUuid: opts.accountUuid,
  });

  // byConfidence tracks the CLASSIFIER's own confidence for the sessions in
  // each bucket (cost-weighted) — separate from ticket-attribution confidence
  // — so the non-ticket table/CSV can report which tier dominates a class
  // rather than presenting every bucket as equally certain (I-5).
  const nonTicketByClass = new Map<
    string,
    { cost: number; sessionCount: number; byConfidence: Record<Confidence, number> }
  >();
  for (const s of report.unattributedSessions) {
    const row = store.getTaskClass(s.sessionId);
    const key = row ? row.task_class : "unclassified";
    const cur = nonTicketByClass.get(key) ?? { cost: 0, sessionCount: 0, byConfidence: { high: 0, medium: 0, low: 0 } };
    cur.cost += s.cost;
    cur.sessionCount += 1;
    if (row) cur.byConfidence[row.confidence as Confidence] += s.cost;
    nonTicketByClass.set(key, cur);
  }

  // The CLI's i18n singleton is injected here, at the imperative shell — the
  // pure builders take it as a parameter so they never reach for a singleton
  // themselves (and so a test can hand them an identity translator).
  const model = buildJustificationPackModel(t, {
    generatedAt: now(),
    period,
    scope: { projectPath: opts.projectPath ?? null, accountUuid: opts.accountUuid ?? null },
    sections,
    headline: {
      mode,
      currency,
      coverage: report.coverage,
      hourlyRate: config.rate?.hourly ?? null,
      reconciledInvoiceTotal: config.reconciliation?.invoiceTotal ?? null,
      reconciliationTolerance: (config.reconciliation?.tolerancePercent ?? 5) / 100,
      anyFallbackRates: report.anyFallbackRates,
      planFee,
      unknownTokens: report.unknownTokens,
    },
    tickets: report.tickets,
    nonTicketByClass,
    methodology: {
      pricingVerifiedDate: PRICING_VERIFIED_DATE,
      taskClassVersion: TASK_CLASS_VERSION,
      languageMode: mode,
      policyEvents: config.policyEvents ?? [],
    },
  });

  return {
    model,
    html: renderJustificationPackHtml(model),
    ticketsCsv: renderTicketsCsv(model),
    nonTicketCsv: renderNonTicketCsv(model),
    summaryCsv: renderSummaryCsv(model),
  };
}

export interface WrittenPack extends PackGenerateResult {
  dir: string;
  htmlPath: string;
  ticketsCsvPath: string;
  nonTicketCsvPath: string;
  summaryCsvPath: string;
}

/**
 * Generate the pack and write it to `<outDir>/claude-stats-pack-<period>/` —
 * one HTML document plus the CSV bundle (05 §5.1: "self-contained HTML …
 * A CSV bundle alongside"). Directory, not a single file, so the bundle is
 * one thing to attach or `zip`.
 *
 * I-7 (write-path decision, recorded rather than left implicit): the MCP
 * tool that calls this (`generate_justification_pack`) is the one exception
 * to the read-only convention every other tool follows, and that is judged
 * acceptable here — producing files IS this tool's entire purpose; the other
 * thirteen tools return data because their purpose is answering questions.
 * The scope of the exception is kept narrow rather than opened up: `outDir`
 * is resolved to an absolute path (never silently relative to whatever the
 * MCP server process's cwd happens to be — an agent-supplied relative path
 * has no reliable meaning there) and every write lands under a single
 * `claude-stats-pack-<period>` subdirectory of it, never scattered files.
 */
export function generateJustificationPack(
  store: Store,
  config: Config,
  opts: PackGenerateOptions,
  outDir: string = process.cwd(),
): WrittenPack {
  const result = buildJustificationPack(store, config, opts);
  const dir = path.join(path.resolve(outDir), `claude-stats-pack-${result.model.period.label}`);
  fs.mkdirSync(dir, { recursive: true });
  const htmlPath = path.join(dir, "report.html");
  const ticketsCsvPath = path.join(dir, "tickets.csv");
  const nonTicketCsvPath = path.join(dir, "nonticket.csv");
  const summaryCsvPath = path.join(dir, "summary.csv");
  fs.writeFileSync(htmlPath, result.html, "utf-8");
  fs.writeFileSync(ticketsCsvPath, result.ticketsCsv, "utf-8");
  fs.writeFileSync(nonTicketCsvPath, result.nonTicketCsv, "utf-8");
  fs.writeFileSync(summaryCsvPath, result.summaryCsv, "utf-8");
  return { ...result, dir, htmlPath, ticketsCsvPath, nonTicketCsvPath, summaryCsvPath };
}
