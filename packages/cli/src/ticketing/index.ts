/**
 * Ticket attribution — glue between the store and the pure functions in
 * `@claude-stats/core/attribution`.
 *
 * Two halves, matching the pure module:
 *  - `runTicketExtraction` (write path): gathers one session's raw signals
 *    (branch, commit subjects, prompt text) and persists the extracted links
 *    via the Phase-0 storage seam. Called from `collect` per upserted session.
 *  - `getTicketCostReport` (query path): resolves the session/cost data an
 *    MCP tool or CLI report needs and folds it through `aggregateTicketCosts`.
 *
 * Design: doc/analysis/ticket-attribution/01-attribution-signals.md,
 *         doc/analysis/ticket-attribution/02-local-data-model.md.
 */
import { estimateCost } from "@claude-stats/core/pricing";
import {
  extractTicketLinks,
  aggregateTicketCosts,
  type ActiveLink,
  type Observation,
} from "@claude-stats/core/attribution";
import type { AttributionSource, Confidence, TicketCoverage } from "@claude-stats/core/types/insight";
import { getCommitSubjectsInWindow } from "../recap/git.js";
import type { MessageFilter, SessionRow, Store } from "../store/index.js";

/**
 * How far past a session's last message to look for a corroborating commit.
 * The commit rung "confirms more than it attributes — the commit lands AFTER
 * the spend" (01 §1.2), so the window must extend past the session, not just
 * cover it. 24h catches same-day/next-morning commits without pulling in
 * unrelated later work on the same project.
 */
const COMMIT_WINDOW_PAD_MS = 24 * 60 * 60 * 1000;

export interface RunExtractionOptions {
  /** `config.tickets.projectKeys`. Absent/empty is a real, documented mode
   *  (extraction runs, confidence caps at medium) — never treated as "skip". */
  allowlist?: readonly string[];
}

/**
 * Run the extraction pass for one just-upserted session and persist the
 * result through the Phase-0 storage seam (`store.addTicketLink`).
 * Deterministic; the only I/O is a local `git log` for commit subjects (no
 * network, no LLM).
 *
 * Idempotent and safe to re-run on every `collect`: `addTicketLink` upserts
 * per (session, key, source), and extraction never writes `source: 'tag'`, so
 * a manual link — which only that source can create — is structurally
 * unreachable by this path (enforced by the store's PK + upsert guard, not
 * duplicated here).
 *
 * Subagent fallback (01 §1.3): a subagent session with NO signal of its own
 * (the common case — subagents don't carry their own branch or prompt
 * context) inherits its parent's active links verbatim, at session
 * granularity. A subagent that DOES have its own signal keeps only its own —
 * read as all-or-nothing per session so an unrelated prompt mention in the
 * subagent can't dilute a real parent attribution by adding a spurious extra
 * key alongside it.
 *
 * KNOWN LIMITATION: inheritance reads the parent's links AT CALL TIME. If a
 * subagent's session file is processed before its parent's in the same
 * `collect` run, the parent has no links yet and inheritance is a no-op for
 * that run — it self-heals on the NEXT `collect` only if the child's
 * transcript changes again (extraction re-runs on every upsert, but an
 * unchanged, checkpointed file is skipped entirely, per `collect`'s file-skip
 * logic). Accepted rather than adding a second reconciliation pass: today's
 * within-run scan order isn't parent-before-child guaranteed, fixing it is a
 * `collect`-level concern outside this lane's scope, and the failure mode is
 * "occasionally under-attributes a subagent," never a wrong attribution.
 */
export function runTicketExtraction(store: Store, session: SessionRow, opts: RunExtractionOptions = {}): void {
  const branches: Observation[] = session.git_branch ? [{ text: session.git_branch }] : [];

  let commits: Observation[] = [];
  if (session.first_timestamp != null) {
    const start = session.first_timestamp;
    const end = (session.last_timestamp ?? session.first_timestamp) + COMMIT_WINDOW_PAD_MS;
    commits = getCommitSubjectsInWindow(session.project_path, start, end).map((subject) => ({ text: subject }));
  }

  const prompts: Observation[] = store
    .getSessionMessages(session.session_id)
    .filter((m): m is typeof m & { prompt_text: string } => Boolean(m.prompt_text))
    .map((m) => ({ text: m.prompt_text, uuid: m.uuid }));

  const links = extractTicketLinks({
    sessionId: session.session_id,
    branches,
    commits,
    prompts,
    allowlist: opts.allowlist,
  });

  if (links.length > 0) {
    for (const link of links) {
      store.addTicketLink({
        sessionId: link.sessionId,
        ticketKey: link.ticketKey,
        source: link.source,
        confidence: link.confidence,
        granularity: link.granularity,
        firstUuid: link.firstUuid,
        lastUuid: link.lastUuid,
        evidence: link.evidence,
      });
    }
    return;
  }

  if (session.is_subagent && session.parent_session_id) {
    for (const parentLink of store.getTicketLinksForSession(session.parent_session_id)) {
      if (parentLink.negated) continue;
      store.addTicketLink({
        sessionId: session.session_id,
        ticketKey: parentLink.ticket_key,
        source: parentLink.source as AttributionSource,
        confidence: parentLink.confidence as Confidence,
        // Inherited, not observed at this session's own message granularity —
        // the parent's uuid range means nothing on the child's own messages.
        granularity: "session",
        firstUuid: null,
        lastUuid: null,
        evidence: parentLink.evidence,
      });
    }
  }
}

// ─── Query path ─────────────────────────────────────────────────────────────

export interface TicketReportFilters {
  since?: number;
  until?: number;
  projectPath?: string;
  repoUrl?: string;
  accountUuid?: string;
  /** Mirrors `MessageFilter` — explicit `false` narrows, `undefined` doesn't. */
  includeCI?: boolean;
  includeDeleted?: boolean;
}

export interface TicketCostRow {
  ticketKey: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sessionCount: number;
  /** Sessions contributing to this key's cost — the evidence drill-down
   *  (`get_cost_per_ticket`'s `ticket` param joins these against
   *  `getTicketLinksForSession` for per-session evidence text). */
  sessionIds: string[];
  confidence: Confidence;
  sources: AttributionSource[];
}

export interface TicketCostReport {
  totalCost: number;
  /** Tokens whose model priced as unknown (`estimateCost.known === false`) —
   *  never silently folded into a zero cost; see `doc/analysis/…/pricing.ts`. */
  unknownTokens: number;
  /** Sorted by cost, descending. */
  tickets: TicketCostRow[];
  coverage: TicketCoverage;
}

/**
 * Per-ticket cost report for a period/project/account window, plus the
 * coverage figure (02 §2.6, `get_cost_per_ticket` / `report --ticket`).
 *
 * `totalCost` is deliberately derived by summing this function's OWN
 * per-session cost map rather than from a second, independently-grouped
 * store query — see `aggregateTicketCosts`'s doc for why that's what makes
 * "per-ticket sum (deduped) + unattributed === total" hold exactly rather
 * than approximately.
 */
export function getTicketCostReport(store: Store, filters: TicketReportFilters = {}): TicketCostReport {
  const base: MessageFilter = {
    since: filters.since,
    until: filters.until,
    projectPath: filters.projectPath,
    repoUrl: filters.repoUrl,
    accountUuid: filters.accountUuid,
    includeCI: filters.includeCI,
    includeDeleted: filters.includeDeleted,
  };

  const sessionIds = store.getSessionIdsWithMessages(base);
  const perSessionRows = store.getMessageTotalsBySession(sessionIds, {
    since: filters.since,
    until: filters.until,
  });

  const sessionCosts = new Map<string, number>();
  const sessionTokens = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheCreation: number }
  >();
  let unknownTokens = 0;

  for (const row of perSessionRows) {
    const priced = estimateCost(
      row.model,
      row.input_tokens,
      row.output_tokens,
      row.cache_read_tokens,
      row.cache_creation_tokens,
    );
    if (priced.known) {
      sessionCosts.set(row.session_id, (sessionCosts.get(row.session_id) ?? 0) + priced.cost);
    } else {
      unknownTokens += row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_creation_tokens;
    }
    const tok = sessionTokens.get(row.session_id) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    tok.input += row.input_tokens;
    tok.output += row.output_tokens;
    tok.cacheRead += row.cache_read_tokens;
    tok.cacheCreation += row.cache_creation_tokens;
    sessionTokens.set(row.session_id, tok);
  }
  // Every session in the window counts as "in scope" for aggregation even if
  // every one of its messages priced unknown (cost 0) — an ABSENT map entry
  // means "outside the window" to `aggregateTicketCosts`, not "$0 in it".
  for (const sid of sessionIds) {
    if (!sessionCosts.has(sid)) sessionCosts.set(sid, 0);
  }

  let totalCost = 0;
  for (const c of sessionCosts.values()) totalCost += c;

  const activeLinks: ActiveLink[] = store.getActiveTicketLinks().map((l) => ({
    sessionId: l.session_id,
    ticketKey: l.ticket_key,
    source: l.source as AttributionSource,
    confidence: l.confidence as Confidence,
  }));

  const { tickets, coverage } = aggregateTicketCosts(activeLinks, sessionCosts, totalCost);

  const rows: TicketCostRow[] = tickets.map((t) => {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheCreation = 0;
    for (const sid of t.sessionIds) {
      const tok = sessionTokens.get(sid);
      if (!tok) continue;
      input += tok.input;
      output += tok.output;
      cacheRead += tok.cacheRead;
      cacheCreation += tok.cacheCreation;
    }
    return {
      ticketKey: t.ticketKey,
      cost: t.cost,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      sessionCount: t.sessionIds.length,
      sessionIds: t.sessionIds,
      confidence: t.confidence,
      sources: t.sources,
    };
  });

  return { totalCost, unknownTokens, tickets: rows, coverage };
}
