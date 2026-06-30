/**
 * OTEL ingestion (Phase 2 D) — wires the OTLP parser to the store.
 *
 * Reads a configured OTLP export file, then:
 *   - records an append-only `account_observation` (source `otel`) for each
 *     distinct account seen,
 *   - upserts an `accounts` row (org id; tier fields are not in OTLP resource
 *     attrs so stay null, filled later by telemetry / account.ts),
 *   - applies session→account attribution via `store.applyAttribution` with
 *     `source='otel', confidence='authoritative'` (covers ALL surfaces — OTEL
 *     is the strongest non-override signal and is not gated on CLI_SURFACES).
 *
 * Determinism: the clock is injected (`now: () => number`). The parser takes no
 * clock; only the observation timestamp fallback and `applyAttribution` use it.
 */
import type { Store } from "../store/index.js";
import { parseOtelFile } from "./parse.js";
import type { OtelParseResult } from "./parse.js";

export interface OtelIngestSummary {
  /** OTLP records (resourceMetrics+resourceLogs) parsed from the file. */
  recordCount: number;
  /** Lines/records skipped as malformed. */
  malformed: number;
  /** True if the event cap was hit and parsing stopped early. */
  truncated: boolean;
  /** Distinct sessions with an account binding found in the file. */
  sessions: number;
  /** Distinct accounts observed. */
  accounts: number;
  /** Sessions whose attribution actually changed in the DB. */
  changed: number;
}

/**
 * Ingest an OTLP/JSON(L) file into the store. Returns a summary. Never throws
 * on malformed lines (they are counted); throws only on an unsafe/oversize file
 * (see parse.ts hardening) or a store error.
 *
 * @param store     the open Store.
 * @param filePath  path to the OTLP export file.
 * @param now       injected clock (epoch ms).
 */
export async function ingestOtel(
  store: Store,
  filePath: string,
  now: () => number,
): Promise<OtelIngestSummary> {
  const parsed: OtelParseResult = await parseOtelFile(filePath);

  // 1. Append an observation + upsert metadata for each distinct account.
  for (const [accountUuid, info] of parsed.accounts) {
    store.recordAccountObservation({
      accountUuid,
      observedAt: now(),
      source: "otel",
      surface: info.surface,
      rateLimitTier: null,
      billingType: null,
    });
    store.upsertAccount({
      accountUuid,
      organizationUuid: info.organizationUuid,
      emailHash: null,
      emailLabel: null,
      organizationType: null,
      rateLimitTier: null,
      userRateLimitTier: null,
      seatTier: null,
      billingType: null,
      subscriptionType: null,
      firstObservedAt: now(),
      lastObservedAt: now(),
    });
  }

  // 2. Build the session→attribution map (authoritative, all surfaces).
  const mapping = new Map<
    string,
    {
      accountUuid: string;
      organizationUuid: string | null;
      subscriptionType: string | null;
      source: string;
      confidence: string;
    }
  >();
  for (const [sessionId, tuple] of parsed.sessions) {
    mapping.set(sessionId, {
      accountUuid: tuple.accountUuid,
      organizationUuid: tuple.organizationUuid,
      // OTLP carries no subscription/plan tier; COALESCE in applyAttribution
      // lets a later telemetry signal fill it.
      subscriptionType: null,
      source: "otel",
      confidence: "authoritative",
    });
  }

  const changed = mapping.size > 0 ? store.applyAttribution(mapping, now) : 0;

  return {
    recordCount: parsed.recordCount,
    malformed: parsed.malformed,
    truncated: parsed.truncated,
    sessions: parsed.sessions.size,
    accounts: parsed.accounts.size,
    changed,
  };
}
