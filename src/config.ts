/**
 * Configuration management for claude-stats.
 * Stores user preferences in ~/.claude-stats/config.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { PlanType, PlanConfig } from "./types.js";

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
