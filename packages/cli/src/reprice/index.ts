/**
 * Counterfactual repricing of a window: glue between the store and the pure
 * `repriceGroups` in `@claude-stats/core/repricing`.
 *
 * One bounded store read (`getRepriceGroups`: raw path, so `speed` is exact and
 * no `fastModeUnpriced` disclosure is needed), a mapping from store snake_case
 * to the core group, and the core call. Consumers: MCP `reprice_period` and
 * `claude-stats reprice`.
 *
 * Validation lives here so both surfaces refuse the same inputs the same way: a
 * malformed id, an unknown id (no rate), or a window that does not parse is an
 * `{ ok: false }` result, never a $0 figure.
 */
import {
  checkRepriceModel,
  isModelIdShape,
  longContextThresholdFor,
  repriceGroups,
  roundRepriceResult,
  type RepriceGroup,
  type RepriceResult,
} from "@claude-stats/core/repricing";
import type { RateOverrides } from "@claude-stats/core/pricing";
import type { MessageFilter, RepriceGroupRow, Store } from "../store/index.js";

export interface RepriceRequest {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive. */
  to: string;
  project?: string;
  model: string;
  asModel: string;
  /** IANA timezone for the day boundaries; default: the host's. */
  timezone?: string;
  rateOverrides?: RateOverrides;
}

export type RepriceOutcome =
  | { ok: true; result: RepriceResult; filters: MessageFilter }
  | { ok: false; error: string };

/** Store row to core group. Pure. */
export function toRepriceGroup(row: RepriceGroupRow): RepriceGroup {
  return {
    model: row.model,
    longContext: row.long_context === 1,
    targetLongContext: row.target_long_context === 1,
    speed: row.speed_class,
    inferenceGeo: row.us_geo === 1 ? "us" : null,
    rows: row.msg_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    ephemeral5mTokens: row.ephemeral_5m_cache_tokens,
    ephemeral1hTokens: row.ephemeral_1h_cache_tokens,
  };
}

/**
 * Validate a request and price the window. Both model ids must be shaped like
 * model ids AND resolve to a rate row; otherwise nothing is read.
 */
export async function buildRepriceResult(store: Store, req: RepriceRequest): Promise<RepriceOutcome> {
  for (const [field, id] of [["model", req.model], ["asModel", req.asModel]] as const) {
    if (!isModelIdShape(id)) {
      return { ok: false, error: `\`${field}\` is not a model id (letters, digits and . _ : @ / [ ] - only, up to 128 characters).` };
    }
    if (!checkRepriceModel(id, req.rateOverrides)) {
      return {
        ok: false,
        error: `\`${field}\` "${id}" has no known rate, so it cannot be priced (an unknown model would silently cost $0). Use a model id from get_stats \`byModel\`, or add a rate in the pricing config.`,
      };
    }
  }

  const { periodRange } = await import("../reporter/index.js");
  const tz = req.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  let range: { since: number; until: number };
  try {
    range = periodRange({ since: req.from, until: req.to }, tz);
  } catch (err) {
    if (err instanceof RangeError) return { ok: false, error: err.message };
    throw err;
  }

  const filters: MessageFilter = {
    since: range.since > 0 ? range.since : undefined,
    until: range.until,
    projectPath: req.project,
  };
  const rows = store.getRepriceGroups(filters, longContextThresholdFor(req.asModel, req.rateOverrides));
  const result = roundRepriceResult(repriceGroups(rows.map(toRepriceGroup), req.model, req.asModel, req.rateOverrides));
  return { ok: true, result, filters };
}
