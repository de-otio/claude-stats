/** Shared helpers for the efficiency-hygiene detectors. Pure, no I/O. */
import { estimateCost, type RateOverrides } from "../pricing.js";
import type { HygieneMessageRow } from "./types.js";

/** One session's messages, sorted ascending by timestamp (nulls last, stable
 *  otherwise — matches SQL's `ORDER BY timestamp ASC` with NULLs floating to
 *  the end on SQLite, so a caller passing an already-sorted array is a no-op). */
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
