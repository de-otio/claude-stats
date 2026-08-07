/**
 * Efficiency-hygiene detectors — shared vocabulary.
 *
 * Design: doc/analysis/efficiency-hygiene/README.md.
 *
 * This is a **self-audit tool, not a scoreboard**: nothing here ranks
 * developers, and per-developer waste figures never sync (I2, the two-plane
 * rule). Precision over recall — a false "you wasted money here" costs more
 * than a missed pattern, so every detector carries its rule and its threshold
 * on the finding, links the specific sessions it fired on, and ships a
 * false-positive fixture proving the guard actually holds.
 *
 * LOCALIZATION — deliberately deferred, same seam as `../insight.ts`: these
 * are English source strings because nothing renders them on screen yet (D1
 * ships the detectors and the MCP/digest surface, not the GUI card — that is
 * Phase 2's G1). The rule/remedy text is a plain string today so the first
 * renderer can inject a translator around it without this module needing to
 * know about i18n.
 */

/** One efficiency-hygiene detector's stable identifier. Also the suppression key
 *  in `config.hygiene.suppressions[]` (Phase 0). */
export type HygieneDetectorId =
  | "cache-churn"
  | "retry-loop"
  | "abandoned-spend"
  | "context-bloat"
  | "re-entry-burn";

/**
 * The row shape every detector consumes: one per stored message, already
 * carrying the columns each detector needs. Detectors group by `sessionId`
 * (and, for cross-session checks, by `projectPath`) themselves — callers pass
 * one flat, timestamp-ordered array so the store only needs a single query.
 */
export interface HygieneMessageRow {
  sessionId: string;
  projectPath: string;
  uuid: string;
  /** Epoch ms. Null timestamps are excluded from gap/order-sensitive checks. */
  timestamp: number | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Failed tool calls in this message (schema v11+; older rows are 0). */
  toolErrorCount: number;
}

/**
 * One detector firing — the unit a card renders. Carries its own rule and
 * threshold in plain language (I1: the reader must be able to judge the claim,
 * not just trust it) plus the exact sessions behind it (checkable) and one
 * remedy sentence (the deliverable is the behavior change, not the accusation).
 */
export interface HygieneFinding {
  detectorId: HygieneDetectorId;
  /** Sessions this finding is evidenced by, in the order the detector found them. */
  sessionIds: string[];
  /** Estimated recoverable cost in equivalent-API dollars (same convention as
   *  `insight.ts#answerEfficiency` — always currency, regardless of plan vs
   *  metered account; the caveat about what that dollar figure MEANS for a
   *  plan account is `costCaveat`'s job, not this module's). Conservative by
   *  construction — never the whole session's cost unless the rule says so. */
  estimatedWaste: number;
  /** The rule that fired, in plain language, so the reader can judge it. */
  rule: string;
  /** The threshold value(s) that tripped it, formatted for display. */
  threshold: string;
  /** One remedy sentence. */
  remedy: string;
  /** Free-form evidence detail (counts, ratios) — never prompt text, never a path. */
  detail: string;
}

/** One detector's result over a window: its findings plus whether the whole
 *  detector is suppressed (`config.hygiene.suppressions[]`, Phase 0). */
export interface HygieneDetectorResult {
  detectorId: HygieneDetectorId;
  title: string;
  findings: HygieneFinding[];
  /** True when this detector id is in `config.hygiene.suppressions[]` — its
   *  findings are still computed (so a digest can report "1 suppressed") but
   *  must not be surfaced as an active card. */
  suppressed: boolean;
}

/** Tunable thresholds, one block per detector. All have conservative
 *  (precision-favoring) defaults — see each detector module for the reasoning
 *  behind its specific numbers. */
export interface HygieneThresholds {
  cacheChurn: {
    /** Minimum cache-creation tokens in a session before churn is even
     *  considered — guards against flagging small/short sessions. */
    minCacheCreationTokens: number;
    /** Minimum turns (messages) in the session — a single-turn session has
     *  nothing to read back yet and is not churn. */
    minMessages: number;
    /** creation / (creation + read) ratio at/above which a session fires. */
    ratio: number;
  };
  retryLoop: {
    /** Consecutive messages with `toolErrorCount > 0` needed to call it a loop. */
    minRunLength: number;
  };
  contextBloat: {
    /** Total input tokens fed to the model in one turn (input + both cache
     *  columns) above which a turn counts as oversized. */
    minTurnInputTokens: number;
    /** output / totalInput at/below which the turn counts as low-yield. */
    maxOutputRatio: number;
    /** Oversized+low-yield turns needed in a session to call it "sustained". */
    minOccurrences: number;
  };
  reEntryBurn: {
    /** Idle gap (ms) since the previous message in the session before a
     *  cache-creation spike counts as a re-entry rather than ordinary churn. */
    minGapMs: number;
    /** Cache-creation tokens on the message right after the gap needed to
     *  call it a "spike" (i.e. the cache actually had to be rebuilt). */
    minCacheCreationTokens: number;
  };
  abandonedSpend: {
    /** Minimum session cost (equivalent-API $) before "no successor" is worth
     *  flagging — small abandoned sessions aren't worth a card. */
    minCost: number;
    /** How long, after the session's last message, a same-project follow-up
     *  session must start within to count as a continuation, not abandonment. */
    graceMs: number;
  };
}

/** Conservative defaults. Every number here is deliberately on the side of
 *  under-firing — see the per-detector module docs for the reasoning. */
export const DEFAULT_HYGIENE_THRESHOLDS: HygieneThresholds = {
  cacheChurn: { minCacheCreationTokens: 200_000, minMessages: 3, ratio: 0.85 },
  retryLoop: { minRunLength: 3 },
  contextBloat: { minTurnInputTokens: 150_000, maxOutputRatio: 0.02, minOccurrences: 3 },
  reEntryBurn: { minGapMs: 30 * 60 * 1000, minCacheCreationTokens: 20_000 },
  abandonedSpend: { minCost: 1, graceMs: 2 * 60 * 60 * 1000 },
};
