/**
 * constraintImpact/apiThrottleWait.ts — pure module tests.
 *
 * The real `en` translator (setup.ts runs initCliI18n("en")) is used
 * throughout, not an identity stub — the previous version of this module
 * shipped with a suite that only asserted key NAMES, so renaming
 * `insight.throttle` in every locale file left both the suite and
 * `locales:check` green. Resolving against the real bundle here means a
 * missing/renamed key fails in THIS test, not on a rendered card.
 */
import { describe, it, expect } from "vitest";
import {
  summarizeApiThrottle,
  formatApiThrottle,
  type ApiThrottleSummary,
} from "@claude-stats/core/constraintImpact";
import type { ApiErrorEvent } from "@claude-stats/core/types";
import { t } from "../i18n.js";

const SESSION_A = "sess-a";
const SESSION_B = "sess-b";

function terminalRateLimit(overrides: Partial<ApiErrorEvent> = {}): ApiErrorEvent {
  return {
    uuid: `term-rl-${Math.random()}`,
    sessionId: SESSION_A,
    timestamp: 1_000_000,
    terminal: true,
    kind: "rate_limit",
    status: 429,
    retryInMs: null,
    retryAttempt: null,
    isNetworkDown: false,
    ...overrides,
  };
}

function terminalServerError(overrides: Partial<ApiErrorEvent> = {}): ApiErrorEvent {
  return {
    uuid: `term-se-${Math.random()}`,
    sessionId: SESSION_A,
    timestamp: 1_000_000,
    terminal: true,
    kind: "server_error",
    status: 529,
    retryInMs: null,
    retryAttempt: null,
    isNetworkDown: false,
    ...overrides,
  };
}

function retryLadder(overrides: Partial<ApiErrorEvent> = {}): ApiErrorEvent {
  return {
    uuid: `retry-${Math.random()}`,
    sessionId: SESSION_A,
    timestamp: 1_000_000,
    terminal: false,
    kind: "server_error",
    status: 529,
    retryInMs: 2_000,
    retryAttempt: 1,
    isNetworkDown: false,
    ...overrides,
  };
}

// ─── summarizeApiThrottle ───────────────────────────────────────────────────

describe("summarizeApiThrottle", () => {
  it("returns an all-zero summary for no events", () => {
    const s = summarizeApiThrottle([]);
    expect(s).toEqual({
      rateLimitRejections: 0,
      rateLimitSessionsAffected: 0,
      serverErrorRejections: 0,
      measuredOverloadWaitMs: 0,
      overloadRetryEvents: 0,
      overloadSessionsAffected: 0,
      unknownEvents: 0,
    });
  });

  it("counts terminal rate_limit rejections exactly, independent of server_error", () => {
    const s = summarizeApiThrottle([
      terminalRateLimit(),
      terminalRateLimit(),
      terminalServerError(),
    ]);
    expect(s.rateLimitRejections).toBe(2);
    expect(s.serverErrorRejections).toBe(1);
  });

  it("counts DISTINCT sessions affected by rate_limit, not raw event count", () => {
    const s = summarizeApiThrottle([
      terminalRateLimit({ sessionId: SESSION_A }),
      terminalRateLimit({ sessionId: SESSION_A }), // same session, second rejection
      terminalRateLimit({ sessionId: SESSION_B }),
    ]);
    expect(s.rateLimitRejections).toBe(3);
    expect(s.rateLimitSessionsAffected).toBe(2);
  });

  it("sums retryInMs across retry-ladder attempts as the measured overload wait", () => {
    const s = summarizeApiThrottle([
      retryLadder({ retryInMs: 500 }),
      retryLadder({ retryInMs: 1_500 }),
      retryLadder({ retryInMs: 4_000 }),
    ]);
    expect(s.measuredOverloadWaitMs).toBe(6_000);
    expect(s.overloadRetryEvents).toBe(3);
  });

  it("does NOT let a terminal rejection's null retryInMs contribute to the wait total", () => {
    // The load-bearing honesty guard: a terminal event's absence of a
    // scheduled wait must never silently coerce to 0 and blend into a sum
    // that is supposed to mean "the client scheduled and (empirically)
    // waited this long" — a terminal event never scheduled anything.
    const s = summarizeApiThrottle([terminalRateLimit(), terminalServerError()]);
    expect(s.measuredOverloadWaitMs).toBe(0);
    expect(s.overloadRetryEvents).toBe(0);
  });

  it("counts distinct sessions affected by the overload-wait signal", () => {
    const s = summarizeApiThrottle([
      retryLadder({ sessionId: SESSION_A }),
      retryLadder({ sessionId: SESSION_A }),
      retryLadder({ sessionId: SESSION_B }),
    ]);
    expect(s.overloadRetryEvents).toBe(3);
    expect(s.overloadSessionsAffected).toBe(2);
  });

  it("tracks unknown-classified terminal events separately, never folding them into rate_limit or server_error", () => {
    const s = summarizeApiThrottle([
      terminalRateLimit({ kind: "unknown" as ApiErrorEvent["kind"] }),
    ]);
    expect(s.rateLimitRejections).toBe(0);
    expect(s.serverErrorRejections).toBe(0);
    expect(s.unknownEvents).toBe(1);
  });

  it("tracks an unknown-classified retry-ladder event without dropping its measured wait", () => {
    // Classification failure must not also destroy a genuinely measured
    // number — the wait is measured independent of what kind of error caused it.
    const s = summarizeApiThrottle([
      retryLadder({ kind: "unknown" as ApiErrorEvent["kind"], retryInMs: 750 }),
    ]);
    expect(s.measuredOverloadWaitMs).toBe(750);
    expect(s.overloadRetryEvents).toBe(1);
    expect(s.unknownEvents).toBe(1);
  });

  it("a retry-ladder event with retryInMs null (defensive — parser should never emit one) contributes nothing", () => {
    const s = summarizeApiThrottle([retryLadder({ retryInMs: null })]);
    expect(s.measuredOverloadWaitMs).toBe(0);
    expect(s.overloadRetryEvents).toBe(0);
  });
});

// ─── formatApiThrottle ───────────────────────────────────────────────────────

describe("formatApiThrottle", () => {
  const EMPTY: ApiThrottleSummary = {
    rateLimitRejections: 0,
    rateLimitSessionsAffected: 0,
    serverErrorRejections: 0,
    measuredOverloadWaitMs: 0,
    overloadRetryEvents: 0,
    overloadSessionsAffected: 0,
    unknownEvents: 0,
  };

  it("abstains (all null) when there is nothing to report — never renders '0 times'", () => {
    const a = formatApiThrottle(t, EMPTY, "plan");
    expect(a.rejectionHeadline).toBeNull();
    expect(a.rejectionCaveat).toBeNull();
    expect(a.overloadHeadline).toBeNull();
    expect(a.overloadCaveat).toBeNull();
  });

  it("renders the rejection count in the headline (singular)", () => {
    const s: ApiThrottleSummary = { ...EMPTY, rateLimitRejections: 1, rateLimitSessionsAffected: 1 };
    const a = formatApiThrottle(t, s, "plan");
    expect(a.rejectionHeadline).toContain("1");
    expect(a.rejectionHeadline).not.toBeNull();
    expect(a.rejectionCaveat).not.toBeNull();
  });

  it("renders the rejection count in the headline (plural)", () => {
    const s: ApiThrottleSummary = { ...EMPTY, rateLimitRejections: 7, rateLimitSessionsAffected: 3 };
    const a = formatApiThrottle(t, s, "plan");
    expect(a.rejectionHeadline).toContain("7");
  });

  it("selects DIFFERENT rejection caveat text for metered vs plan accountMode", () => {
    const s: ApiThrottleSummary = { ...EMPTY, rateLimitRejections: 2, rateLimitSessionsAffected: 1 };
    const metered = formatApiThrottle(t, s, "metered").rejectionCaveat;
    const plan = formatApiThrottle(t, s, "plan").rejectionCaveat;
    expect(metered).not.toBeNull();
    expect(plan).not.toBeNull();
    expect(metered).not.toBe(plan);
    // Real content check, not just "not equal" — metered points at the API/Bedrock
    // tier, plan clarifies this is distinct from the 5-hour usage window.
    expect(metered).toMatch(/API|Bedrock/i);
    expect(plan).toMatch(/5-hour/i);
  });

  it("the rejection caveat NEVER claims a wait duration for a rate-limit rejection", () => {
    // This is the honesty assertion the whole module exists to keep true —
    // must survive a mutation that starts summing rate_limit retryInMs too.
    const s: ApiThrottleSummary = { ...EMPTY, rateLimitRejections: 3, rateLimitSessionsAffected: 1 };
    const a = formatApiThrottle(t, s, "metered");
    expect(a.rejectionHeadline).not.toMatch(/hour|minute|dev-/i);
  });

  it("renders the overload headline with BOTH the count and the interpolated duration", () => {
    const s: ApiThrottleSummary = {
      ...EMPTY,
      overloadRetryEvents: 4,
      overloadSessionsAffected: 2,
      measuredOverloadWaitMs: 90 * 60_000, // 1.5 hours
    };
    const a = formatApiThrottle(t, s, "metered");
    expect(a.overloadHeadline).not.toBeNull();
    expect(a.overloadHeadline).toContain("4");
    // 90 min = 1.5h -> formatDurationHours's "hours" branch ("1.5")
    expect(a.overloadHeadline).toContain("1.5");
    expect(a.overloadCaveat).not.toBeNull();
  });

  it("the ms→hours division is exact at the minutes/hours boundary (guards a 60x-class divisor bug)", () => {
    // Exactly 30 minutes: formatDurationHours's minutes branch (hours < 1),
    // rounds to whole minutes. A 60x divisor error would render ~30ms worth
    // of minutes (0) or 30 hours worth of minutes — both visibly wrong.
    const s: ApiThrottleSummary = {
      ...EMPTY,
      overloadRetryEvents: 1,
      overloadSessionsAffected: 1,
      measuredOverloadWaitMs: 30 * 60_000,
    };
    const a = formatApiThrottle(t, s, "metered");
    expect(a.overloadHeadline).toContain("30");
  });

  it("the overload caveat states this is NOT a policy/constraint cost", () => {
    const s: ApiThrottleSummary = { ...EMPTY, overloadRetryEvents: 1, overloadSessionsAffected: 1, measuredOverloadWaitMs: 1000 };
    const a = formatApiThrottle(t, s, "metered");
    expect(a.overloadCaveat).toMatch(/not.*constraint|infrastructure/i);
  });

  it("overload vocabulary does not vary by accountMode (the signal is not account-specific)", () => {
    const s: ApiThrottleSummary = { ...EMPTY, overloadRetryEvents: 2, overloadSessionsAffected: 1, measuredOverloadWaitMs: 5000 };
    const metered = formatApiThrottle(t, s, "metered");
    const plan = formatApiThrottle(t, s, "plan");
    expect(metered.overloadHeadline).toBe(plan.overloadHeadline);
    expect(metered.overloadCaveat).toBe(plan.overloadCaveat);
  });

  it("rejection and overload halves are independently abstainable", () => {
    // Rejections present, no overload events at all.
    const s: ApiThrottleSummary = { ...EMPTY, rateLimitRejections: 1, rateLimitSessionsAffected: 1 };
    const a = formatApiThrottle(t, s, "plan");
    expect(a.rejectionHeadline).not.toBeNull();
    expect(a.overloadHeadline).toBeNull();
    expect(a.overloadCaveat).toBeNull();
  });
});
