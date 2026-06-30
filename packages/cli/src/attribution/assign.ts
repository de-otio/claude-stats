/**
 * Account assignment (Phase 2 A) — PURE, CLOCKLESS.
 *
 * Given sessions + a CLI observation timeline + per-session telemetry/otel
 * maps, decide each session's account and the provenance (source + confidence)
 * of that decision. No clock, no I/O.
 *
 * Precedence (strongest → weakest, plan §4):
 *   override > otel > telemetry > anchor > observation > backfill > unknown
 *
 * Surface ALLOWLIST (plan §4 / ASSUMPTIONS #3): a session is interval-attributed
 * (`source='observation'`, `confidence='high'`) ONLY when its entrypoint ∈
 * CLI_SURFACES. Every other surface (`claude-vscode`, `vscode`,
 * `claude-desktop`, unknown) NEVER receives the CLI interval — it gets
 * otel/telemetry if present, else `source='unknown'`, `confidence='none'`.
 *
 * Straddle: when a CLI session's [first_timestamp, last_timestamp] crosses an
 * interval boundary, the SESSION is attributed to the interval covering its
 * first_timestamp (confidence 'high'), and per-message overrides are returned
 * for the boundary so the caller can stamp `messages.account_uuid` for the
 * messages that fall in the later interval.
 */
import { CLI_SURFACES } from "@claude-stats/core/types";
import type { AccountInterval } from "./intervals.js";
import { intervalAt } from "./intervals.js";
import type { SessionRow } from "../store/index.js";

const CLI_SURFACE_SET = new Set<string>(CLI_SURFACES);

/** Per-session account info supplied by an external map (telemetry / otel). */
export interface ExternalAccountInfo {
  accountUuid: string;
  organizationUuid: string | null;
  subscriptionType: string | null;
}

/** The decided attribution for one session. */
export interface Assignment {
  accountUuid: string;
  organizationUuid: string | null;
  subscriptionType: string | null;
  source: string;
  confidence: string;
}

/**
 * A per-message account override produced by a straddling CLI session: messages
 * with `timestamp >= boundaryFrom` belong to `accountUuid` (the next interval),
 * not the session-level account. The caller resolves the concrete message uuids
 * (this module is session/interval-level and message-id agnostic).
 */
export interface MessageOverride {
  sessionId: string;
  /** Messages at/after this timestamp (epoch-ms) get `accountUuid`. */
  boundaryFrom: number;
  accountUuid: string;
}

export interface AssignInput {
  sessions: SessionRow[];
  intervals: AccountInterval[];
  /** sessionId → telemetry account (precedence `telemetry`). */
  telemetryMap: Map<string, ExternalAccountInfo>;
  /** sessionId → otel account (precedence `otel`, authoritative). Optional. */
  otelMap?: Map<string, ExternalAccountInfo>;
}

export interface AssignResult {
  assignments: Map<string, Assignment>;
  /** Per-message account overrides for straddling CLI sessions. */
  messageOverrides: MessageOverride[];
}

/** True when an entrypoint is one of the CLI surfaces (allowlist). */
function isCliSurface(entrypoint: string | null): boolean {
  return entrypoint !== null && CLI_SURFACE_SET.has(entrypoint);
}

/**
 * Assign accounts to sessions. Pure: same inputs → same outputs, no clock.
 *
 * For each session, the strongest available signal wins:
 *   1. otel       (authoritative)  — any surface
 *   2. telemetry  (high)           — any surface
 *   3. observation (high)          — CLI surfaces ONLY, from the interval
 *                                     covering first_timestamp
 *   4. unknown    (none)           — fallthrough
 *
 * `override`, `anchor`, and `backfill` ranks exist in the precedence enum but
 * are not produced here (override = manual user action handled elsewhere;
 * anchor/backfill = reserved for future signals). They are still honoured by
 * the store's monotonic `applyAttribution` guard.
 */
export function assignAccounts(input: AssignInput): AssignResult {
  const { sessions, intervals, telemetryMap } = input;
  const otelMap = input.otelMap;

  const assignments = new Map<string, Assignment>();
  const messageOverrides: MessageOverride[] = [];

  for (const s of sessions) {
    const sessionId = s.session_id;

    // 1. otel — authoritative, all surfaces.
    const otel = otelMap?.get(sessionId);
    if (otel) {
      assignments.set(sessionId, {
        accountUuid: otel.accountUuid,
        organizationUuid: otel.organizationUuid,
        subscriptionType: otel.subscriptionType,
        source: "otel",
        confidence: "authoritative",
      });
      continue;
    }

    // 2. telemetry — high, all surfaces.
    const tel = telemetryMap.get(sessionId);
    if (tel) {
      assignments.set(sessionId, {
        accountUuid: tel.accountUuid,
        organizationUuid: tel.organizationUuid,
        subscriptionType: tel.subscriptionType,
        source: "telemetry",
        confidence: "high",
      });
      continue;
    }

    // 3. observation interval — CLI SURFACES ONLY (allowlist).
    if (isCliSurface(s.entrypoint) && s.first_timestamp != null) {
      const iv = intervalAt(intervals, s.first_timestamp);
      if (iv) {
        assignments.set(sessionId, {
          accountUuid: iv.accountUuid,
          // Observation intervals carry no org/subscription metadata; leave
          // null so applyAttribution's COALESCE preserves any existing value.
          organizationUuid: null,
          subscriptionType: null,
          source: "observation",
          confidence: "high",
        });

        // Straddle: does the session extend past this interval's end into a
        // DIFFERENT account's interval? If so, emit per-message overrides for
        // every boundary the session crosses.
        if (s.last_timestamp != null && s.last_timestamp >= iv.end) {
          collectStraddleOverrides(intervals, s, iv, messageOverrides);
        }
        continue;
      }
      // CLI surface but no covering interval (e.g. session predates the first
      // observation) → falls through to unknown.
    }

    // 4. unknown — fallthrough. Non-CLI surfaces with no otel/telemetry land
    // here; they NEVER get the CLI interval.
    assignments.set(sessionId, {
      accountUuid: "",
      organizationUuid: null,
      subscriptionType: null,
      source: "unknown",
      confidence: "none",
    });
  }

  return { assignments, messageOverrides };
}

/**
 * Emit per-message overrides for a CLI session that straddles one or more
 * interval boundaries past the interval covering its first_timestamp. For each
 * later interval that overlaps [iv.end, session.last_timestamp], messages at or
 * after that interval's start belong to that interval's account.
 *
 * We emit ONE override per distinct later account boundary the session reaches;
 * the caller applies them in boundary order (a message takes the account of the
 * latest boundary it is at/after).
 */
function collectStraddleOverrides(
  intervals: AccountInterval[],
  session: SessionRow,
  startInterval: AccountInterval,
  out: MessageOverride[],
): void {
  const last = session.last_timestamp;
  if (last == null) return;

  for (const iv of intervals) {
    // Only intervals strictly after the session's starting interval that the
    // session actually reaches, and that belong to a different account.
    if (iv.start <= startInterval.start) continue;
    if (iv.start > last) continue;
    if (iv.accountUuid === startInterval.accountUuid) continue;

    out.push({
      sessionId: session.session_id,
      boundaryFrom: iv.start,
      accountUuid: iv.accountUuid,
    });
  }
}
