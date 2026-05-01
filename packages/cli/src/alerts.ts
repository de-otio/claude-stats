/**
 * Cost threshold alert checking.
 * Compares current period spending against configured thresholds.
 */
import type { Store } from "./store/index.js";
import type { Config } from "./config.js";
import { estimateCost } from "@claude-stats/core/pricing";
import { periodStart } from "./reporter/index.js";

export interface ThresholdCheck {
  period: string;
  currentCost: number;
  threshold: number;
  exceeded: boolean;
  percentage: number;
}

const PERIODS = ["day", "week", "month"] as const;

export function checkThresholds(store: Store, config: Config): ThresholdCheck[] {
  if (!config.costThresholds) return [];

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const results: ThresholdCheck[] = [];

  for (const period of PERIODS) {
    const threshold = config.costThresholds[period];
    if (threshold === undefined) continue;

    const since = periodStart(period, tz);
    const messageTotals = store.getMessageTotals({ since });

    let currentCost = 0;
    for (const mt of messageTotals) {
      const result = estimateCost(
        mt.model,
        mt.input_tokens,
        mt.output_tokens,
        mt.cache_read_tokens,
        mt.cache_creation_tokens,
      );
      if (result.known) {
        currentCost += result.cost;
      }
    }

    const percentage = threshold > 0 ? (currentCost / threshold) * 100 : 0;

    results.push({
      period,
      currentCost,
      threshold,
      exceeded: currentCost > threshold,
      percentage,
    });
  }

  return results;
}
