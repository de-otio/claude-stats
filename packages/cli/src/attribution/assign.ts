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
 * — one per later interval the session reaches that belongs to a DIFFERENT
 * account — so the caller can stamp `messages.account_uuid` for the messages
 * that fall in that interval. Each override is a half-open range
 * `[boundaryFrom, boundaryTo)`; because the ranges mirror the disjoint
 * intervals they never overlap, so the caller can apply them in any order and a
 * re-entry to the session's own account is simply not emitted (those messages
 * keep the session-level account).
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
 * whose `timestamp` falls in the half-open range `[boundaryFrom, boundaryTo)`
 * belong to `accountUuid` (a later interval), not the session-level account.
 * The range mirrors one disjoint CLI interval, so overrides for a session never
 * overlap. The caller resolves the concrete message uuids (this module is
 * session/interval-level and message-id agnostic).
 */
export interface MessageOverride {
  sessionId: string;
  /** Inclusive start (epoch-ms): messages at/after this get `accountUuid`. */
  boundaryFrom: number;
  /** Exclusive end (epoch-ms); `Infinity` for the still-open final interval. */
  boundaryTo: number;
  accountUuid: string;
}

export interface AssignInput {
  sessions: SessionRow[];
  intervals: AccountInterval[];
  /** sessionId → telemetry account (precedence `telemetry`). */
  telemetryMap: Map<string, ExternalAccountInfo>;
  /** sessionId → otel account (precedence `otel`, authoritative). Optional. */
  otelMap?: Map<string, ExternalAccountInfo>;
  /** sessionId → anchor pin (precedence `anchor`, above observation). Optional. */
  anchorMap?: Map<string, { accountUuid: string }>;
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
 *   3. anchor     (high)           — CLI surfaces ONLY, from a live-session pin
 *                                     (doc 03 §B); overrides the interval choice
 *   4. observation (high)          — CLI surfaces ONLY, from the interval
 *                                     covering first_timestamp
 *   5. backfill   (medium)         — CLI surfaces ONLY, when the session
 *                                     PREDATES the first observation and exactly
 *                                     one CLI account has ever been observed
 *                                     (single-account fast-path, doc 03 §D.1)
 *   6. unknown    (none)           — fallthrough
 *
 * The `override` rank exists in the precedence enum but is not produced here
 * (manual user action, handled elsewhere). All ranks are honoured by the store's
 * monotonic `applyAttribution` guard, which also lets a later
 * observation/telemetry/otel pass UPGRADE a `backfill`/medium row (confidence ∈
 * {low,medium} is updatable). A pinned session is attributed WHOLE (no straddle
 * split): a live-session pin is a point-in-time ground truth for the session.
 */
export function assignAccounts(input: AssignInput): AssignResult {
  const { sessions, intervals, telemetryMap } = input;
  const otelMap = input.otelMap;
  const anchorMap = input.anchorMap;

  const assignments = new Map<string, Assignment>();
  const messageOverrides: MessageOverride[] = [];

  // Distinct CLI accounts ever observed — the single-account backfill signal.
  // `intervals` are already CLI-only (buildCliIntervals filters surfaces), so a
  // size of 1 means exactly one account has ever been seen on the CLI surface.
  const distinctCliAccounts = new Set(intervals.map((iv) => iv.accountUuid));

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

    // 3. anchor pin — CLI SURFACES ONLY. A live-session pin is exact ground
    // truth that this session ran under `accountUuid`; it overrides the interval
    // choice (sharpening the boundary within the observation lag). Surface-gated
    // for defence-in-depth (the writer only pins CLI-entrypoint sessions).
    const pin = anchorMap?.get(sessionId);
    if (pin && isCliSurface(s.entrypoint)) {
      assignments.set(sessionId, {
        accountUuid: pin.accountUuid,
        organizationUuid: null,
        subscriptionType: null,
        source: "anchor",
        confidence: "high",
      });
      continue;
    }

    // 4. observation interval — CLI SURFACES ONLY (allowlist).
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

      // 5. backfill — CLI surface but NO covering interval: the session predates
      // the first observation. Single-account fast-path (doc 03 §D.1): if only
      // ONE CLI account has ever been observed, attribute pre-observation CLI
      // usage to it at MEDIUM confidence (we cannot confirm the machine was
      // single-account back then, so not 'high'; a later stronger signal can
      // upgrade it). With ≥2 accounts observed we cannot safely guess → unknown.
      if (distinctCliAccounts.size === 1) {
        const only = intervals[0]!.accountUuid;
        assignments.set(sessionId, {
          accountUuid: only,
          organizationUuid: null,
          subscriptionType: null,
          source: "backfill",
          confidence: "medium",
        });
        continue;
      }
      // CLI surface, predates observations, and ≥2 accounts seen → unknown.
    }

    // 6. unknown — fallthrough. Non-CLI surfaces with no otel/telemetry land
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
 * later interval the session reaches that belongs to a DIFFERENT account, emit
 * one override spanning exactly that interval's half-open range
 * `[iv.start, iv.end)` — so messages whose timestamp falls in it take that
 * interval's account.
 *
 * Because the ranges mirror the disjoint intervals they never overlap, the
 * caller can apply them in any order. A later re-entry to the session's OWN
 * account is deliberately NOT emitted: those messages simply keep the
 * session-level account (the bounded earlier override does not bleed into them).
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
      boundaryTo: iv.end,
      accountUuid: iv.accountUuid,
    });
  }
}
