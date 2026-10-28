/**
 * Placeholder-output disclosure (R1, plan A4).
 *
 * Claude Code < 2.1.307 wrote subagent transcripts whose assistant rows carry a
 * mid-stream placeholder for `output_tokens`. This module turns the store's
 * (model, flagged) groups into the one disclosure a cost reader needs: what
 * share of the window's rows and estimated cost sits on such rows, plus a fixed
 * sentence saying output cost there is a lower bound.
 *
 * It is a DISCLOSURE, not part of the headline reconciliation: it re-prices a
 * separate raw read and changes no total. The payload is numbers and one fixed
 * sentence — no session ids, paths or project names.
 */
import { estimateCost } from "@claude-stats/core/pricing";
import type { RateOverrides } from "@claude-stats/core/pricing";
import type { PlaceholderTotalRow, Store, MessageFilter } from "../store/index.js";

/** The one fixed sentence; a closed string, not localised, not interpolated. */
export const PLACEHOLDER_OUTPUT_NOTE =
  "Output tokens are under-reported on these rows (Claude Code < 2.1.307 subagent transcripts), " +
  "so subagent output cost is a lower bound.";

export interface PlaceholderOutputShare {
  /** Flagged rows / cost-bearing assistant rows in the window, 0..1. */
  rowShare: number;
  /** Estimated cost of flagged rows / estimated cost of all rows, 0..1 (0 when the window prices to $0). */
  costShare: number;
  note: string;
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Fold (model, flagged) groups into the disclosure. `null` when the window has
 * no flagged rows: a clean window needs no caveat (same convention as
 * `costBasisLabel`), and the key stays present so a reader can tell "checked,
 * none" from "field not supported".
 */
export function buildPlaceholderOutputShare(
  groups: readonly PlaceholderTotalRow[],
  rateOverrides?: RateOverrides,
): PlaceholderOutputShare | null {
  let rows = 0;
  let flaggedRows = 0;
  let cost = 0;
  let flaggedCost = 0;
  for (const g of groups) {
    const priced = estimateCost(
      g.model ?? "",
      g.input_tokens,
      g.output_tokens,
      g.cache_read_tokens,
      g.cache_creation_tokens,
      rateOverrides,
      { ephemeral5mCacheTokens: g.ephemeral_5m_cache_tokens, ephemeral1hCacheTokens: g.ephemeral_1h_cache_tokens },
      { longContext: g.long_context === 1 },
    );
    rows += g.row_count;
    cost += priced.cost;
    if (g.flagged === 1) {
      flaggedRows += g.row_count;
      flaggedCost += priced.cost;
    }
  }
  if (flaggedRows === 0) return null;
  return {
    rowShare: round4(flaggedRows / rows),
    costShare: cost > 0 ? round4(flaggedCost / cost) : 0,
    note: PLACEHOLDER_OUTPUT_NOTE,
  };
}

/** Read + fold for a filtered window. */
export function placeholderOutputShareFor(
  store: Store,
  filters: MessageFilter = {},
  rateOverrides?: RateOverrides,
): PlaceholderOutputShare | null {
  return buildPlaceholderOutputShare(store.getPlaceholderOutputTotals(filters), rateOverrides);
}
