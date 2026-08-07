/**
 * Ticket attribution — extraction and aggregation.
 *
 * Two pure functions, deliberately split at the seam that keeps them
 * independently testable without a database:
 *
 *  - `extractTicketLinks` turns the signals available for ONE session (branch
 *    name(s), commit subjects, prompt text) into graded `TicketLink` candidates.
 *    No store, no I/O — callers (the `collect` write path) fetch the raw
 *    signals and hand them in.
 *  - `aggregateTicketCosts` turns a flat list of already-persisted, already
 *    tombstone-filtered links plus a per-session cost map into the per-ticket
 *    report and the coverage figure. No store either — callers (the query
 *    path) resolve session costs and active links, then hand them in.
 *
 * Design: doc/analysis/ticket-attribution/01-attribution-signals.md,
 *         doc/analysis/ticket-attribution/02-local-data-model.md.
 */
import { parseTicketKey, matchesProjectAllowlist } from "./tickets.js";
import type { AttributionSource, Confidence, LinkGranularity, TicketCoverage, TicketKey } from "./types/insight.js";

// ─── Extraction ─────────────────────────────────────────────────────────────

/**
 * One occurrence of raw text to scan for a ticket key.
 *
 * `uuid` is the message this occurrence is anchored to. Branch and prompt
 * observations carry it when message-level evidence exists (per-message
 * branch capture, or a prompt — prompt text is always tied to one message);
 * omitting it means the observation is only known at session granularity
 * (today's branch capture, and always true for commits, which aren't tied to
 * any one message). The extractor uses this to decide `granularity` per key.
 */
export interface Observation {
  text: string;
  uuid?: string | null;
}

export interface ExtractionInput {
  sessionId: string;
  /** Branch name(s) this session touched. One entry with no `uuid` for
   *  today's session-level capture; multiple per-message entries once the
   *  branch lane's per-message capture is wired (02 §2.3). */
  branches: readonly Observation[];
  /** Commit subjects from the session's project within its time window
   *  (02 §2.4). Never carries a `uuid` — a commit isn't tied to one message. */
  commits: readonly Observation[];
  /** User-authored prompt text per message (rung 4, low confidence). */
  prompts: readonly Observation[];
  /**
   * Configured project-key allowlist. Absent or empty means "no project
   * filter configured": extraction still runs (matching every syntactically
   * valid key), but every result caps at medium confidence, because the
   * scanner cannot tell a real key from an unrelated identifier of the same
   * shape (doc/analysis/ticket-attribution/01 §1.1; `config.tickets.projectKeys`
   * doc comment records the same assumption). This is a deliberate choice,
   * not an oversight — an allowlist-shaped feature that silently produced
   * NO links when unconfigured would be a worse failure than a capped one.
   */
  allowlist?: readonly string[];
}

export interface ExtractedLink {
  sessionId: string;
  ticketKey: TicketKey;
  source: AttributionSource;
  confidence: Confidence;
  granularity: LinkGranularity;
  firstUuid: string | null;
  lastUuid: string | null;
  /** Matched branch name / commit subject. Null for prompt matches — the
   *  message's own (already-sanitized) `prompt_text` is the drill-down;
   *  duplicating a fragment of free-form user text into a second column
   *  is unnecessary surface area for a field this module's docs are explicit
   *  never syncs but which still lives on disk. */
  evidence: string | null;
}

/** Scan `text` for syntactically valid, allowlist-passing keys, in order of
 *  first appearance, each at most once. */
function scanKeys(text: string, allowlist: readonly string[] | undefined): TicketKey[] {
  const seen = new Set<TicketKey>();
  const out: TicketKey[] = [];
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}\b/g)) {
    const key = parseTicketKey(match[0]);
    if (!key) continue;
    if (!matchesProjectAllowlist(key, allowlist)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

interface SignalOccurrence {
  /** First message uuid this key was seen at, or null if never seen with one. */
  first: string | null;
  /** Most recent message uuid this key was seen at (encounter order). */
  last: string | null;
  /** True the moment any occurrence of this key had no `uuid` — forces
   *  session-wide granularity, since a session-level observation can't be
   *  bounded to a message range. */
  wholeSession: boolean;
  /** First matched raw text, kept as evidence. */
  evidence: string;
}

function collectSignal(
  observations: readonly Observation[],
  allowlist: readonly string[] | undefined,
): Map<TicketKey, SignalOccurrence> {
  const out = new Map<TicketKey, SignalOccurrence>();
  for (const obs of observations) {
    const hasUuid = obs.uuid != null;
    for (const key of scanKeys(obs.text, allowlist)) {
      const cur = out.get(key);
      if (!cur) {
        out.set(key, {
          first: hasUuid ? obs.uuid! : null,
          last: hasUuid ? obs.uuid! : null,
          wholeSession: !hasUuid,
          evidence: obs.text,
        });
      } else {
        if (hasUuid) {
          if (cur.first === null) cur.first = obs.uuid!;
          cur.last = obs.uuid!;
        } else {
          cur.wholeSession = true;
        }
      }
    }
  }
  return out;
}

/**
 * Extract graded ticket links from one session's signals.
 *
 * Confidence follows the accuracy ladder (01 §1.2): branch is high (medium
 * without an allowlist), commit is medium (corroboration, not attribution —
 * it lands after the spend), prompt is low unless the same key also appears
 * in branch or commit evidence for the same session, in which case it is
 * corroborated up to medium.
 *
 * Returns at most one entry per (ticketKey, source) — never a guessed
 * attribution: a key that appears nowhere in any signal never produces a
 * link, and a key outside a configured allowlist never produces one either.
 */
export function extractTicketLinks(input: ExtractionInput): ExtractedLink[] {
  const branchSignal = collectSignal(input.branches, input.allowlist);
  const commitSignal = collectSignal(input.commits, input.allowlist);
  const promptSignal = collectSignal(input.prompts, input.allowlist);
  const hasAllowlist = input.allowlist !== undefined && input.allowlist.length > 0;

  const links: ExtractedLink[] = [];

  for (const [key, occ] of branchSignal) {
    links.push({
      sessionId: input.sessionId,
      ticketKey: key,
      source: "branch",
      confidence: hasAllowlist ? "high" : "medium",
      granularity: occ.wholeSession ? "session" : "messages",
      firstUuid: occ.wholeSession ? null : occ.first,
      lastUuid: occ.wholeSession ? null : occ.last,
      evidence: occ.evidence,
    });
  }

  for (const [key, occ] of commitSignal) {
    links.push({
      sessionId: input.sessionId,
      ticketKey: key,
      source: "commit",
      confidence: "medium",
      granularity: "session",
      firstUuid: null,
      lastUuid: null,
      evidence: occ.evidence,
    });
  }

  for (const [key, occ] of promptSignal) {
    const corroborated = branchSignal.has(key) || commitSignal.has(key);
    links.push({
      sessionId: input.sessionId,
      ticketKey: key,
      source: "prompt",
      confidence: corroborated ? "medium" : "low",
      granularity: occ.wholeSession ? "session" : "messages",
      firstUuid: occ.wholeSession ? null : occ.first,
      lastUuid: occ.wholeSession ? null : occ.last,
      evidence: null,
    });
  }

  return links;
}

// ─── Aggregation ────────────────────────────────────────────────────────────

/** One active (non-tombstoned) link, as read back from storage. */
export interface ActiveLink {
  sessionId: string;
  ticketKey: string;
  source: AttributionSource;
  confidence: Confidence;
}

export interface TicketAggregateRow {
  ticketKey: string;
  /** Sum of the cost of every session linked to this key. A session linked to
   *  more than one key (ambiguous, no message-level evidence to split on)
   *  contributes its FULL cost to every key it's linked to — 01 §1.3 forbids
   *  a silent 50/50 split. This is the one place a per-ticket sum can exceed
   *  `coverage.attributedCost`; the coverage split (below) counts each
   *  session once and is what the sum+unattributed=total contract binds. */
  cost: number;
  sessionIds: string[];
  /** Max confidence across contributing sessions, upgraded one step when a
   *  session's link to this key is corroborated by ≥2 independent sources. */
  confidence: Confidence;
  sources: AttributionSource[];
}

export interface TicketAggregation {
  /** Sorted by cost, descending. */
  tickets: TicketAggregateRow[];
  coverage: TicketCoverage;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function maxConfidence(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

function upgradeConfidence(c: Confidence): Confidence {
  if (c === "low") return "medium";
  return "high";
}

/**
 * Fold active links + per-session cost into the per-ticket report and the
 * coverage figure.
 *
 * `totalCost` MUST be the sum of every value in `sessionCosts` (callers
 * derive it that way — see `getTicketCostReport` — rather than from an
 * independently-queried total) so that `attributedCost` (a subset sum of the
 * same map) can never exceed it: the honesty contract this function exists to
 * guarantee — `coverage.attributedCost` plus the unattributed remainder
 * (`totalCost - attributedCost`, computed by the caller) equals `totalCost`
 * EXACTLY, for any input. Sessions absent from `sessionCosts` (out of the
 * report's window) are ignored even if a link references them.
 */
export function aggregateTicketCosts(
  links: readonly ActiveLink[],
  sessionCosts: ReadonlyMap<string, number>,
  totalCost: number,
): TicketAggregation {
  // Per-session, per-key: max confidence + the distinct sources that agree.
  const bySession = new Map<string, Map<string, { confidence: Confidence; sources: Set<AttributionSource> }>>();
  for (const link of links) {
    if (!sessionCosts.has(link.sessionId)) continue;
    let perKey = bySession.get(link.sessionId);
    if (!perKey) {
      perKey = new Map();
      bySession.set(link.sessionId, perKey);
    }
    const cur = perKey.get(link.ticketKey);
    if (!cur) {
      perKey.set(link.ticketKey, { confidence: link.confidence, sources: new Set([link.source]) });
    } else {
      cur.confidence = maxConfidence(cur.confidence, link.confidence);
      cur.sources.add(link.source);
    }
  }
  // Corroboration upgrade (01 §1.2): independent sources agreeing on the same
  // key for the same session upgrade its effective confidence one step.
  for (const perKey of bySession.values()) {
    for (const entry of perKey.values()) {
      if (entry.sources.size >= 2) entry.confidence = upgradeConfidence(entry.confidence);
    }
  }

  const perTicket = new Map<
    string,
    { cost: number; sessionIds: string[]; confidence: Confidence; sources: Set<AttributionSource> }
  >();
  let attributedCost = 0;
  const byConfidence: Record<Confidence, number> = { high: 0, medium: 0, low: 0 };
  let ambiguousSessions = 0;

  for (const [sessionId, perKey] of bySession) {
    const keys = [...perKey.keys()];
    if (keys.length === 0) continue;
    const cost = sessionCosts.get(sessionId) ?? 0;

    // The session's OWN effective confidence for the coverage split: the max
    // across every key it's linked to, so an ambiguous second link never
    // downgrades the tier a stronger link already earned.
    let sessionConfidence: Confidence = "low";
    for (const key of keys) sessionConfidence = maxConfidence(sessionConfidence, perKey.get(key)!.confidence);

    attributedCost += cost;
    byConfidence[sessionConfidence] += cost;
    if (keys.length > 1) ambiguousSessions += 1;

    for (const key of keys) {
      const entry = perKey.get(key)!;
      const row = perTicket.get(key) ?? { cost: 0, sessionIds: [], confidence: entry.confidence, sources: new Set() };
      row.cost += cost;
      row.sessionIds.push(sessionId);
      row.confidence = maxConfidence(row.confidence, entry.confidence);
      for (const s of entry.sources) row.sources.add(s);
      perTicket.set(key, row);
    }
  }

  const coverage: TicketCoverage = {
    attributedCost,
    totalCost,
    ratio: totalCost > 0 ? attributedCost / totalCost : null,
    byConfidence,
    ambiguousSessions,
  };

  const tickets: TicketAggregateRow[] = [...perTicket.entries()]
    .map(([ticketKey, v]) => ({
      ticketKey,
      cost: v.cost,
      sessionIds: v.sessionIds,
      confidence: v.confidence,
      sources: [...v.sources],
    }))
    .sort((a, b) => b.cost - a.cost);

  return { tickets, coverage };
}
