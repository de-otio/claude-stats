/**
 * Configuration management for claude-stats.
 * Stores user preferences in ~/.claude-stats/config.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { PlanType, PlanConfig } from "@claude-stats/core/types";
import type { AccountMode, PolicyEvent } from "@claude-stats/core/types/insight";
import { lookupPlanFee, type RateOverrides } from "@claude-stats/core/pricing";
import { parseTicketKey } from "@claude-stats/core/tickets";
import { createHttpJudgeProvider } from "./cost-per-task/judge-http.js";
import type { JudgeProvider } from "./cost-per-task/judge.js";
import { clampRetentionDays } from "./archive/retention.js";

export interface Config {
  costThresholds?: {
    day?: number;
    week?: number;
    month?: number;
  };
  plan?: {
    type?: PlanType;
    monthly_fee?: number;
  };
  /**
   * Opt-in: fold the experimental Tier-0/1/2 accuracy signals into the
   * cost-per-task outcome (off by default; flip only after calibrating —
   * see `cost-per-task --calibrate` and doc 07 §7.5).
   */
  experimentalSignals?: boolean;
  /**
   * Opt-in Phase-D LLM judge. When `enabled` and `experimentalSignals` are both
   * true, an independent model rules on ambiguous tasks. PRIVACY: this sends a
   * blinded task summary (including your prompt text) to `endpoint`. Use a LOCAL
   * endpoint (e.g. Ollama) to keep data on the machine; a hosted endpoint sends
   * it off-box. Prefer a model from a different family than the one being judged.
   */
  llmJudge?: {
    enabled?: boolean;
    /** OpenAI-compatible chat-completions URL. */
    endpoint?: string;
    model?: string;
    apiKey?: string;
    /** Max judge calls per report run (cost cap; default 25). */
    maxCalls?: number;
  };
  /**
   * Per-account subscription fees, keyed by `account_uuid`. The amount the user
   * actually pays for each Claude account. Used to attribute the flat
   * subscription cost across projects on the Projects tab. See
   * doc/analysis/project-fee-attribution/.
   */
  accountFees?: Record<string, AccountFee>;
  /**
   * Auto-refresh interval for the served dashboard, in seconds. Floored to
   * `MIN_AUTO_REFRESH_SECONDS` on every write (see `mergeConfig`).
   */
  autoRefreshSeconds?: number;
  /**
   * Opt-in raw transcript archive (Phase A). When `enabled`, `collect` mirrors
   * new transcript bytes under `paths.archiveDir`; `retentionDays` bounds the
   * history kept, pruned by real last-activity (NEVER mtime).
   */
  archive?: {
    enabled?: boolean;
    retentionDays?: number;
  };
  /**
   * Personal-plane backup/sync (Phases C–E). `target` is the storage sink (a
   * directory today; a blind zero-knowledge service later — see
   * `StorageTransport`). `encryption` selects which data classes are E2E-sealed
   * before leaving the machine; keys live only on the user's devices + recovery
   * secret, never on any server.
   */
  backup?: {
    target?: string;
    encryption?: {
      /** Encrypt the sync-data shards (which carry `prompt_text`). */
      syncData: boolean;
      /** Encrypt the raw transcript archive class. */
      archive: boolean;
    };
    /**
     * True once the user clicked "I've saved my recovery key" during the
     * onboarding fork (doc 02 §3). Never set automatically — drives whether
     * the standing, dismissible reminder (doc 02 §8) is shown.
     */
    recoveryKeyConfirmed?: boolean;
    /**
     * Epoch ms the user dismissed the one-time "Back up your Claude stats?"
     * nudge (doc 02 §9 step 2), or completed onboarding. Presence alone
     * suppresses the nudge on future activations — it must never re-prompt
     * aggressively once the user has made a choice either way.
     */
    onboardingDismissedAt?: number;
  };
  /**
   * Ticket attribution (doc/analysis/ticket-attribution/).
   *
   * `projectKeys` is the noise filter that makes extraction trustworthy: with an
   * allowlist configured, precision is essentially perfect; without one,
   * extraction still runs but every attribution is capped at medium confidence,
   * because the scanner cannot tell a real key from an unrelated identifier of
   * the same shape.
   */
  tickets?: {
    projectKeys?: string[];
  };
  /**
   * Declared policy boundaries for constraint-impact reporting
   * (doc/analysis/constraint-impact/03 §3.1).
   *
   * DECLARED, never inferred. Letting the tool detect its own boundaries would
   * let it choose the split that maximises apparent damage — the report has to
   * be structurally incapable of that to be worth showing to the person who
   * made the decision.
   */
  policyEvents?: PolicyEvent[];
  /**
   * Developer hourly rate, for the salary denominator. Absent, reports state
   * dev-time in minutes/hours and stop — never a dollar figure from an invented
   * rate (constraint-impact/01 §1.3).
   */
  rate?: {
    hourly?: number;
    /** ISO 4217. Default "USD". Never auto-converted. */
    currency?: string;
  };
  /**
   * Cost basis. `mode` selects the vocabulary — `plan` speaks in
   * equivalent-API-value against a flat fee, `metered` speaks in actual money
   * and supports reconciliation. Mixing the two in one report discredits the
   * tool with whichever reader sees the wrong one.
   *
   * `rates` supplies partner (Bedrock/Vertex) rates, which are priced
   * separately from first-party and vary by region. Without them a partner
   * account prices at first-party rates and every figure is flagged as an
   * estimate.
   */
  pricing?: {
    mode?: AccountMode;
    rates?: RateOverrides;
  };
  /**
   * Invoice reconciliation (ticket-attribution/04 §4.3). The top-down figure is
   * imported, never fetched — the store makes no network calls.
   */
  reconciliation?: {
    /** Invoice total for the period, in the account's currency. */
    invoiceTotal?: number;
    /** Percent difference below which the report says "reconciles". Default 5. */
    tolerancePercent?: number;
  };
  /**
   * Efficiency-hygiene detectors. `suppressions` holds detector ids the user
   * dismissed ("not waste"), so a card that was wrong once stays gone.
   */
  hygiene?: {
    suppressions?: string[];
  };
}

/** Auto-refresh can't be set faster than once a minute. */
export const MIN_AUTO_REFRESH_SECONDS = 60;

/** A user-recorded subscription for one Claude account. */
export interface AccountFee {
  /**
   * Plan type for this account (e.g. `max_20x`, `team_premium`). Per-account —
   * two accounts can hold different plans. Drives the default `monthlyFee` and
   * the per-account plan verdict. Optional/back-compat: entries written before
   * this field carry only a fee.
   */
  type?: PlanType;
  /** Monthly subscription fee, in `currency`. The amount actually paid. */
  monthlyFee: number;
  /** ISO 4217 (e.g. "EUR", "USD"). Default "USD". Never auto-converted. */
  currency?: string;
  /** User-facing name, e.g. "Work" / "Personal". */
  label?: string;
}

/** Valid per-account plan types (mirrors the `PlanType` union). */
const VALID_PLAN_TYPES: ReadonlySet<string> = new Set<PlanType>([
  "pro",
  "max_5x",
  "max_20x",
  "team_standard",
  "team_premium",
  "custom",
]);

/** Keys we accept in a config write. Anything else is dropped (no injection). */
const ALLOWED_CONFIG_KEYS: ReadonlyArray<keyof Config> = [
  "costThresholds",
  "plan",
  "experimentalSignals",
  "llmJudge",
  "accountFees",
  "autoRefreshSeconds",
  "archive",
  "backup",
  "tickets",
  "policyEvents",
  "rate",
  "pricing",
  "reconciliation",
  "hygiene",
];

/** Archive/backup bounds — defensive caps so a bad/hostile write can't corrupt. */
const MAX_RETENTION_DAYS = 3650; // ~10 years
const MAX_BACKUP_TARGET_LEN = 4096;

/** A validated, partial `backup` patch (leaf booleans optional so a partial
 *  update doesn't wipe siblings — reconciled in `mergeConfig`). */
interface BackupConfigPatch {
  target?: string;
  encryption?: { syncData?: boolean; archive?: boolean };
  recoveryKeyConfirmed?: boolean;
  onboardingDismissedAt?: number;
}

/**
 * Validate an untrusted `archive` config. Drops unknown/invalid leaves rather
 * than throwing (the write path is unattended). Returns a clean partial object.
 */
export function validateArchiveConfig(input: unknown): NonNullable<Config["archive"]> {
  const out: NonNullable<Config["archive"]> = {};
  if (!input || typeof input !== "object") return out;
  const r = input as Record<string, unknown>;
  if (typeof r.enabled === "boolean") out.enabled = r.enabled;
  if (
    typeof r.retentionDays === "number" &&
    Number.isFinite(r.retentionDays) &&
    r.retentionDays >= 1 &&
    r.retentionDays <= MAX_RETENTION_DAYS
  ) {
    out.retentionDays = Math.floor(r.retentionDays);
  }
  return out;
}

/** True when the opt-in transcript archive (Phase A) is enabled. */
export function isArchiveEnabled(config: Config): boolean {
  return config.archive?.enabled === true;
}

/** Configured archive retention window (days), clamped to the valid range. */
export function archiveRetentionDays(config: Config): number {
  return clampRetentionDays(config.archive?.retentionDays);
}

/**
 * Validate an untrusted `backup` config into a clean partial patch. `target` is
 * length-bounded and NUL-free (it becomes a filesystem/transport path); each
 * `encryption` boolean is only carried when actually present so a partial write
 * never clobbers the other class's setting.
 */
export function validateBackupConfig(input: unknown): BackupConfigPatch {
  const out: BackupConfigPatch = {};
  if (!input || typeof input !== "object") return out;
  const r = input as Record<string, unknown>;
  if (
    typeof r.target === "string" &&
    r.target.length > 0 &&
    r.target.length <= MAX_BACKUP_TARGET_LEN &&
    !r.target.includes("\0")
  ) {
    out.target = r.target;
  }
  if (r.encryption && typeof r.encryption === "object") {
    const e = r.encryption as Record<string, unknown>;
    const enc: { syncData?: boolean; archive?: boolean } = {};
    if (typeof e.syncData === "boolean") enc.syncData = e.syncData;
    if (typeof e.archive === "boolean") enc.archive = e.archive;
    out.encryption = enc;
  }
  if (typeof r.recoveryKeyConfirmed === "boolean") {
    out.recoveryKeyConfirmed = r.recoveryKeyConfirmed;
  }
  if (typeof r.onboardingDismissedAt === "number" && Number.isFinite(r.onboardingDismissedAt)) {
    out.onboardingDismissedAt = r.onboardingDismissedAt;
  }
  return out;
}

// ─── Insight-suite config validation ────────────────────────────────────────
//
// Same posture as the blocks above: drop invalid leaves rather than throw (the
// write path is unattended and must not crash on one bad entry), and bound
// every collection so a hostile write can't DoS a report.

const MAX_PROJECT_KEYS = 100;
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const MAX_POLICY_EVENTS = 100;
const POLICY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const POLICY_KINDS: ReadonlySet<string> = new Set(["model-removal", "budget-cap", "quota-change", "other"]);
const POLICY_SCOPES: ReadonlySet<string> = new Set(["org", "team", "self"]);
const MAX_POLICY_DETAIL_LEN = 200;
const MAX_HOURLY_RATE = 10_000;
const MAX_SUPPRESSIONS = 200;
const MAX_SUPPRESSION_LEN = 64;
const MAX_INVOICE_TOTAL = 10_000_000;
const DEFAULT_RECONCILE_TOLERANCE = 5;

/** Validate `tickets`. Project keys are upper-cased and shape-checked. */
export function validateTicketsConfig(input: unknown): NonNullable<Config["tickets"]> {
  const out: NonNullable<Config["tickets"]> = {};
  if (!input || typeof input !== "object") return out;
  const r = input as Record<string, unknown>;
  if (Array.isArray(r.projectKeys)) {
    const keys: string[] = [];
    for (const raw of r.projectKeys) {
      if (keys.length >= MAX_PROJECT_KEYS) break;
      if (typeof raw !== "string") continue;
      const k = raw.trim().toUpperCase();
      if (PROJECT_KEY_RE.test(k) && !keys.includes(k)) keys.push(k);
    }
    out.projectKeys = keys;
  }
  return out;
}

/**
 * Validate `policyEvents`. An event with an unparseable date or unknown kind is
 * dropped — a malformed boundary would silently split a before/after report at
 * the wrong place, which is worse than having no boundary at all.
 */
export function validatePolicyEvents(input: unknown): PolicyEvent[] {
  if (!Array.isArray(input)) return [];
  const out: PolicyEvent[] = [];
  for (const raw of input) {
    if (out.length >= MAX_POLICY_EVENTS) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.date !== "string" || !POLICY_DATE_RE.test(r.date)) continue;
    if (Number.isNaN(Date.parse(r.date))) continue;
    if (typeof r.kind !== "string" || !POLICY_KINDS.has(r.kind)) continue;
    const ev: PolicyEvent = { date: r.date, kind: r.kind as PolicyEvent["kind"] };
    if (typeof r.detail === "string" && r.detail.length > 0) {
      ev.detail = r.detail.slice(0, MAX_POLICY_DETAIL_LEN);
    }
    if (typeof r.scope === "string" && POLICY_SCOPES.has(r.scope)) {
      ev.scope = r.scope as PolicyEvent["scope"];
    }
    out.push(ev);
  }
  // Chronological, so a report can walk boundaries in order without re-sorting.
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Validate the hourly-rate block that powers the salary denominator. */
export function validateRateConfig(input: unknown): NonNullable<Config["rate"]> {
  const out: NonNullable<Config["rate"]> = {};
  if (!input || typeof input !== "object") return out;
  const r = input as Record<string, unknown>;
  if (typeof r.hourly === "number" && Number.isFinite(r.hourly) && r.hourly > 0 && r.hourly <= MAX_HOURLY_RATE) {
    out.hourly = r.hourly;
  }
  if (typeof r.currency === "string" && ACCOUNT_FEE_CURRENCY_RE.test(r.currency)) {
    out.currency = r.currency;
  }
  return out;
}

/** Validate `pricing` (cost-basis mode + partner rate overrides). */
export function validatePricingConfig(input: unknown): NonNullable<Config["pricing"]> {
  const out: NonNullable<Config["pricing"]> = {};
  if (!input || typeof input !== "object") return out;
  const r = input as Record<string, unknown>;
  if (r.mode === "plan" || r.mode === "metered") out.mode = r.mode as AccountMode;
  if (r.rates && typeof r.rates === "object") {
    const rates: RateOverrides = {};
    for (const src of ["first_party", "bedrock", "vertex"] as const) {
      const table = (r.rates as Record<string, unknown>)[src];
      if (!table || typeof table !== "object") continue;
      const clean: Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number; cacheWritePerMillion: number }> = {};
      for (const [model, p] of Object.entries(table as Record<string, unknown>)) {
        if (!p || typeof p !== "object") continue;
        const pp = p as Record<string, unknown>;
        const nums = ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"] as const;
        if (!nums.every((n) => typeof pp[n] === "number" && Number.isFinite(pp[n]) && (pp[n] as number) >= 0)) continue;
        clean[model] = {
          inputPerMillion: pp.inputPerMillion as number,
          outputPerMillion: pp.outputPerMillion as number,
          cacheReadPerMillion: pp.cacheReadPerMillion as number,
          cacheWritePerMillion: pp.cacheWritePerMillion as number,
        };
      }
      if (Object.keys(clean).length > 0) rates[src] = clean;
    }
    if (Object.keys(rates).length > 0) out.rates = rates;
  }
  return out;
}

/** Validate `reconciliation`. Tolerance is clamped to a sane 0–100%. */
export function validateReconciliationConfig(input: unknown): NonNullable<Config["reconciliation"]> {
  const out: NonNullable<Config["reconciliation"]> = {};
  if (!input || typeof input !== "object") return out;
  const r = input as Record<string, unknown>;
  if (
    typeof r.invoiceTotal === "number" &&
    Number.isFinite(r.invoiceTotal) &&
    r.invoiceTotal >= 0 &&
    r.invoiceTotal <= MAX_INVOICE_TOTAL
  ) {
    out.invoiceTotal = r.invoiceTotal;
  }
  if (typeof r.tolerancePercent === "number" && Number.isFinite(r.tolerancePercent)) {
    out.tolerancePercent = Math.min(100, Math.max(0, r.tolerancePercent));
  }
  return out;
}

/** Validate `hygiene`. Suppression ids are opaque, bounded strings. */
export function validateHygieneConfig(input: unknown): NonNullable<Config["hygiene"]> {
  const out: NonNullable<Config["hygiene"]> = {};
  if (!input || typeof input !== "object") return out;
  const r = input as Record<string, unknown>;
  if (Array.isArray(r.suppressions)) {
    const ids: string[] = [];
    for (const raw of r.suppressions) {
      if (ids.length >= MAX_SUPPRESSIONS) break;
      if (typeof raw !== "string" || raw.length === 0) continue;
      const id = raw.slice(0, MAX_SUPPRESSION_LEN);
      if (!ids.includes(id)) ids.push(id);
    }
    out.suppressions = ids;
  }
  return out;
}

/** Configured project-key allowlist, or undefined when none is set. */
export function ticketProjectKeys(config: Config): string[] | undefined {
  const keys = config.tickets?.projectKeys;
  return keys && keys.length > 0 ? keys : undefined;
}

/**
 * The cost vocabulary for this account. Explicit config wins; otherwise a
 * subscription type implies `plan` and its absence implies `metered` — an
 * account with no detected subscription is most likely API/Bedrock usage, which
 * is exactly the audience for whom these are real dollars.
 */
export function resolveAccountMode(config: Config, subscriptionType?: string | null): AccountMode {
  if (config.pricing?.mode) return config.pricing.mode;
  return subscriptionType ? "plan" : "metered";
}

/** Reconciliation tolerance as a fraction (0.05 = 5%). */
export function reconciliationTolerance(config: Config): number {
  const pct = config.reconciliation?.tolerancePercent ?? DEFAULT_RECONCILE_TOLERANCE;
  return pct / 100;
}

/** True when `key` passes the configured project allowlist (or none is set). */
export function isAllowedTicketKey(config: Config, key: string): boolean {
  const parsed = parseTicketKey(key);
  if (!parsed) return false;
  const allow = ticketProjectKeys(config);
  if (!allow) return true;
  const prefix = parsed.slice(0, parsed.lastIndexOf("-"));
  return allow.includes(prefix);
}

/** Account-fee bounds — defensive caps so a bad/hostile write can't corrupt or DoS. */
const ACCOUNT_FEE_KEY_RE = /^[a-f0-9-]{8,64}$/i;
const ACCOUNT_FEE_CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_ACCOUNT_FEE = 100_000;
const MAX_ACCOUNT_FEE_ENTRIES = 50;
const MAX_LABEL_LEN = 100;

/**
 * Validate and sanitise an untrusted `accountFees` map. Returns a clean object
 * built on a null prototype (so `__proto__`/`constructor` keys can never poison
 * the prototype chain). Invalid entries are dropped rather than throwing — the
 * write path is unattended and must not crash on a single bad entry.
 */
export function validateAccountFees(input: unknown): Record<string, AccountFee> {
  const out: Record<string, AccountFee> = Object.create(null) as Record<string, AccountFee>;
  if (!input || typeof input !== "object") return out;
  let count = 0;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_ACCOUNT_FEE_ENTRIES) break;
    if (!ACCOUNT_FEE_KEY_RE.test(key)) continue; // rejects __proto__, constructor, etc.
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    // Per-account plan type (optional). A known, non-custom type implies a
    // default fee, so a row that carries only a type still records a usable fee.
    const type =
      typeof r.type === "string" && VALID_PLAN_TYPES.has(r.type) ? (r.type as PlanType) : undefined;
    const rawFee = r.monthlyFee;
    const feeValid = typeof rawFee === "number" && Number.isFinite(rawFee) && rawFee >= 0 && rawFee <= MAX_ACCOUNT_FEE;
    const fee = feeValid
      ? (rawFee as number)
      : type && type !== "custom"
        ? PLAN_FEES[type]
        : undefined;
    // Drop the entry only when neither a valid fee nor a fee-implying type is present.
    if (fee === undefined) continue;
    const entry: AccountFee = { monthlyFee: fee };
    if (type !== undefined) entry.type = type;
    if (typeof r.currency === "string" && ACCOUNT_FEE_CURRENCY_RE.test(r.currency)) {
      entry.currency = r.currency;
    }
    if (typeof r.label === "string" && r.label.length > 0) {
      entry.label = r.label.slice(0, MAX_LABEL_LEN);
    }
    out[key] = entry;
    count++;
  }
  return out;
}

/**
 * Merge an untrusted incoming config over the current one. Only allow-listed
 * top-level keys are copied (no arbitrary key injection); object-valued keys are
 * shallow-merged so a partial update doesn't wipe siblings; `accountFees` is
 * validated. Shared by every write path (panel + HTTP server).
 */
export function mergeConfig(current: Config, incoming: unknown): Config {
  const inc = (incoming && typeof incoming === "object" ? incoming : {}) as Partial<Config>;
  const merged: Config = { ...current };
  for (const key of ALLOWED_CONFIG_KEYS) {
    if (inc[key] === undefined) continue;
    if (key === "accountFees") {
      merged.accountFees = { ...current.accountFees, ...validateAccountFees(inc.accountFees) };
    } else if (key === "plan") {
      merged.plan = { ...current.plan, ...inc.plan };
    } else if (key === "costThresholds") {
      merged.costThresholds = { ...current.costThresholds, ...inc.costThresholds };
    } else if (key === "llmJudge") {
      merged.llmJudge = { ...current.llmJudge, ...inc.llmJudge };
    } else if (key === "experimentalSignals") {
      merged.experimentalSignals = inc.experimentalSignals;
    } else if (key === "autoRefreshSeconds") {
      const n = Number(inc.autoRefreshSeconds);
      if (Number.isFinite(n)) merged.autoRefreshSeconds = Math.max(MIN_AUTO_REFRESH_SECONDS, Math.round(n));
    } else if (key === "archive") {
      merged.archive = { ...current.archive, ...validateArchiveConfig(inc.archive) };
    } else if (key === "backup") {
      const patch = validateBackupConfig(inc.backup);
      const next: NonNullable<Config["backup"]> = { ...current.backup };
      if (patch.target !== undefined) next.target = patch.target;
      if (patch.encryption) {
        // Nested shallow-merge so setting one class doesn't wipe the other.
        next.encryption = {
          ...current.backup?.encryption,
          ...patch.encryption,
        } as { syncData: boolean; archive: boolean };
      }
      if (patch.recoveryKeyConfirmed !== undefined) next.recoveryKeyConfirmed = patch.recoveryKeyConfirmed;
      if (patch.onboardingDismissedAt !== undefined) next.onboardingDismissedAt = patch.onboardingDismissedAt;
      merged.backup = next;
    } else if (key === "tickets") {
      merged.tickets = { ...current.tickets, ...validateTicketsConfig(inc.tickets) };
    } else if (key === "policyEvents") {
      // Replaced wholesale, not merged: policy events are an ordered timeline,
      // and a shallow merge of two arrays has no meaningful semantics. A caller
      // that wants to add one sends the full list.
      merged.policyEvents = validatePolicyEvents(inc.policyEvents);
    } else if (key === "rate") {
      merged.rate = { ...current.rate, ...validateRateConfig(inc.rate) };
    } else if (key === "pricing") {
      const patch = validatePricingConfig(inc.pricing);
      const next: NonNullable<Config["pricing"]> = { ...current.pricing };
      if (patch.mode !== undefined) next.mode = patch.mode;
      if (patch.rates !== undefined) next.rates = { ...current.pricing?.rates, ...patch.rates };
      merged.pricing = next;
    } else if (key === "reconciliation") {
      merged.reconciliation = { ...current.reconciliation, ...validateReconciliationConfig(inc.reconciliation) };
    } else if (key === "hygiene") {
      merged.hygiene = { ...current.hygiene, ...validateHygieneConfig(inc.hygiene) };
    }
  }
  return merged;
}

/** A subscription fee resolved for one account, with its currency. */
export interface ResolvedAccountFee {
  monthlyFee: number;
  currency: string;
}

/**
 * Resolve the effective monthly fee for one account. Order:
 *   1. an explicit per-account fee (`accountFees[uuid]`), in its own currency;
 *   2. the single global `plan.monthly_fee` — only when there is exactly one
 *      account in scope (otherwise it's ambiguous) — treated as USD;
 *   3. the auto-detected default from the subscription type (`lookupPlanFee`), USD;
 *   4. null when nothing is known.
 */
export function resolveAccountFee(
  config: Config,
  accountUuid: string,
  subscriptionType: string | null,
  accountCount: number,
): ResolvedAccountFee | null {
  const explicit = config.accountFees?.[accountUuid];
  if (explicit && Number.isFinite(explicit.monthlyFee) && explicit.monthlyFee >= 0) {
    return { monthlyFee: explicit.monthlyFee, currency: explicit.currency ?? "USD" };
  }
  if (accountCount === 1 && config.plan?.monthly_fee != null && config.plan.monthly_fee >= 0) {
    return { monthlyFee: config.plan.monthly_fee, currency: "USD" };
  }
  const detected = lookupPlanFee(subscriptionType);
  if (detected != null && detected > 0) {
    return { monthlyFee: detected, currency: "USD" };
  }
  return null;
}

/** An account row for the Settings UI account list. */
export interface ConfigAccount {
  accountUuid: string;
  subscriptionType: string | null;
  sessionCount: number;
  /**
   * Only populated on the webview/local path (never on the unauth HTTP path).
   * For the current account this is the live `emailAddress` from
   * `~/.claude.json`; for other accounts it falls back to the `emailLabel`
   * persisted in the accounts table the last time that account was current
   * (see `attribution/observer.ts`), so switching accounts doesn't blank out
   * a previously-known email.
   */
  email: string | null;
  /**
   * Human-readable plan label derived from `subscriptionType` (and optionally
   * enriched by AccountRecord tier/billing data when `fullAccounts` is supplied).
   * Examples: "Max 20x", "Team Premium", "Pro", "Unknown plan".
   * Always populated — callers on the unauth HTTP path should show this label
   * instead of the raw `subscriptionType`.
   */
  planLabel: string;
}

/** Derive a human-readable plan label from a subscription type string. */
export function derivePlanLabel(subscriptionType: string | null): string {
  if (!subscriptionType) return "Unknown plan";
  const labels: Record<PlanType, string> = {
    pro: "Pro",
    max_5x: "Max 5x",
    max_20x: "Max 20x",
    team_standard: "Team Standard",
    team_premium: "Team Premium",
    custom: "Custom",
  };
  const lower = subscriptionType.toLowerCase();
  // Accept both telemetry subscription strings (via the map) and a PlanType
  // passed directly (e.g. "custom", which isn't in SUBSCRIPTION_TYPE_MAP).
  const mapped: PlanType | null =
    SUBSCRIPTION_TYPE_MAP[lower] ?? (lower in labels ? (lower as PlanType) : null);
  if (!mapped) return subscriptionType;
  return labels[mapped];
}

/**
 * Build the account list the Settings tab renders, enriching the current
 * account with its email when allowed. Pure; both the panel (includeEmail=true)
 * and the HTTP server (includeEmail=false — never leak PII on the unauth GET)
 * call this.
 *
 * When `fullAccounts` is provided (from store.listAccountsFull()), the plan label
 * is derived from the richer tier/subscription data in those records. Otherwise
 * it falls back to the `subscriptionType` on the session-count row.
 */
export function buildAccountsForConfig(
  accounts: ReadonlyArray<{ accountUuid: string; subscriptionType: string | null; sessionCount: number }>,
  current: { accountUuid: string; emailAddress: string | null } | null,
  includeEmail: boolean,
  fullAccounts?: ReadonlyArray<{
    accountUuid: string;
    subscriptionType: string | null;
    emailLabel?: string | null;
  }>,
): ConfigAccount[] {
  // Build a fast lookup from fullAccounts for plan-label/email enrichment.
  const fullMap = new Map<string, { subscriptionType: string | null; emailLabel?: string | null }>();
  if (fullAccounts) {
    for (const fa of fullAccounts) {
      fullMap.set(fa.accountUuid, fa);
    }
  }
  return accounts.map((a) => {
    const full = fullMap.get(a.accountUuid);
    // Prefer the richer subscriptionType from the accounts table (listAccountsFull)
    // when available; fall back to the session-aggregated value.
    const effectiveSubType = full?.subscriptionType ?? a.subscriptionType;
    const isCurrent = current !== null && current.accountUuid === a.accountUuid;
    // For the current account use the live email; for others fall back to the
    // emailLabel persisted last time that account was current, so switching
    // accounts doesn't blank out an already-known address.
    const email = includeEmail ? (isCurrent ? current!.emailAddress : (full?.emailLabel ?? null)) : null;
    return {
      accountUuid: a.accountUuid,
      subscriptionType: a.subscriptionType,
      sessionCount: a.sessionCount,
      email,
      planLabel: derivePlanLabel(effectiveSubType),
    };
  });
}

/** A copy of `config` safe to send over the unauthenticated HTTP GET — secrets stripped. */
export function redactConfigForHttp(config: Config): Config {
  if (!config.llmJudge?.apiKey) return config;
  return { ...config, llmJudge: { ...config.llmJudge, apiKey: undefined } };
}

/**
 * Build a judge provider from config, or null when the LLM judge is not fully
 * configured/enabled. Keeping this here (not at the call sites) means the only
 * way to enable Phase D is via config — never a hardcoded flag.
 */
export function createJudgeProviderFromConfig(config: Config): JudgeProvider | null {
  const j = config.llmJudge;
  if (!j?.enabled || !j.endpoint || !j.model) return null;
  return createHttpJudgeProvider({ endpoint: j.endpoint, model: j.model, apiKey: j.apiKey });
}

/** Default monthly fees by plan type (USD). */
const PLAN_FEES: Record<PlanType, number> = {
  pro: 20,
  max_5x: 100,
  max_20x: 200,
  team_standard: 25,
  team_premium: 125,
  custom: 0,
};

/** Known subscription_type strings from Claude telemetry → PlanType. */
const SUBSCRIPTION_TYPE_MAP: Record<string, PlanType> = {
  pro: "pro",
  claude_pro: "pro",
  max_5x: "max_5x",
  max_20x: "max_20x",
  max: "max_5x",
  claude_max: "max_5x",
  team_standard: "team_standard",
  team_premium: "team_premium",
  team: "team_standard",
  claude_team: "team_standard",
};

/**
 * Derive plan config from the stored config and optional telemetry subscription type.
 * Returns null when no plan info is available and the fee would be 0 anyway.
 */
export function getPlanConfig(config: Config, subscriptionType?: string | null): PlanConfig | null {
  const configPlan = config.plan;

  let planType: PlanType | null = null;

  if (configPlan?.type) {
    planType = configPlan.type;
  } else if (subscriptionType) {
    planType = SUBSCRIPTION_TYPE_MAP[subscriptionType.toLowerCase()] ?? null;
  }

  if (!planType) return null;

  const monthlyFee = configPlan?.monthly_fee ?? PLAN_FEES[planType];
  return { type: planType, monthlyFee };
}

const CONFIG_DIR = path.join(os.homedir(), ".claude-stats");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function loadConfig(configPath?: string): Config {
  const filePath = configPath ?? CONFIG_FILE;
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as Config;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

export function saveConfig(config: Config, configPath?: string): void {
  const filePath = configPath ?? CONFIG_FILE;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function getCostThreshold(config: Config, period: string): number | undefined {
  return config.costThresholds?.[period as keyof NonNullable<Config["costThresholds"]>];
}
