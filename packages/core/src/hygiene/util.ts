/** Shared helpers for the efficiency-hygiene detectors. Pure, no I/O. */
import { estimateCost, type RateOverrides } from "../pricing.js";
import type { HygieneMessageRow } from "./types.js";

/** One session's messages in the caller's row order — grouping never reorders.
 *  The store hands rows over already sorted by `ORDER BY m.timestamp ASC`,
 *  which on SQLite sorts NULL timestamps FIRST (verified: SQLite treats NULL
 *  as smaller than any value). That ordering is what the order-sensitive
 *  detectors rely on: a null-timestamp row landing at the FRONT leaves each
 *  session's last row a real, timestamped message, which is what
 *  `abandonedSpend` reads. Do not "fix" the query to `NULLS LAST` without
 *  revisiting that detector. */
export interface SessionGroup {
  sessionId: string;
  projectPath: string;
  messages: HygieneMessageRow[];
}

/** Group a flat, timestamp-ordered row array into per-session groups,
 *  preserving row order within each group. */
export function groupBySession(rows: readonly HygieneMessageRow[]): SessionGroup[] {
  const order: string[] = [];
  const groups = new Map<string, SessionGroup>();
  for (const row of rows) {
    let g = groups.get(row.sessionId);
    if (!g) {
      g = { sessionId: row.sessionId, projectPath: row.projectPath, messages: [] };
      groups.set(row.sessionId, g);
      order.push(row.sessionId);
    }
    g.messages.push(row);
  }
  return order.map((id) => groups.get(id)!);
}

/** Equivalent-API cost of one message's tokens; 0 for an unpriced model
 *  (never silently dropped from a sum — callers summing across a session with
 *  a mix of known/unknown models will under-count by the unknown share, which
 *  is the same convention `estimateCost` establishes everywhere else). */
export function messageCost(row: HygieneMessageRow, overrides?: RateOverrides): number {
  if (!row.model) return 0;
  return estimateCost(row.model, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens, overrides).cost;
}

/** Sum of `messageCost` over a set of rows. */
export function sumCost(rows: readonly HygieneMessageRow[], overrides?: RateOverrides): number {
  let total = 0;
  for (const r of rows) total += messageCost(r, overrides);
  return total;
}
