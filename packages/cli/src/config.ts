/**
 * Configuration management for claude-stats.
 * Stores user preferences in ~/.claude-stats/config.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { PlanType, PlanConfig } from "@claude-stats/core/types";
import { lookupPlanFee } from "@claude-stats/core/pricing";
import { createHttpJudgeProvider } from "./cost-per-task/judge-http.js";
import type { JudgeProvider } from "./cost-per-task/judge.js";

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
}

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
];

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
  /** Only populated for the current account, and only on the webview path. */
  email: string | null;
}

/**
 * Build the account list the Settings tab renders, enriching the current
 * account with its email when allowed. Pure; both the panel (includeEmail=true)
 * and the HTTP server (includeEmail=false — never leak PII on the unauth GET)
 * call this.
 */
export function buildAccountsForConfig(
  accounts: ReadonlyArray<{ accountUuid: string; subscriptionType: string | null; sessionCount: number }>,
  current: { accountUuid: string; emailAddress: string | null } | null,
  includeEmail: boolean,
): ConfigAccount[] {
  return accounts.map((a) => ({
    accountUuid: a.accountUuid,
    subscriptionType: a.subscriptionType,
    sessionCount: a.sessionCount,
    email: includeEmail && current && current.accountUuid === a.accountUuid ? current.emailAddress : null,
  }));
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
