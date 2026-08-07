/**
 * The filter-symmetry contract (F4).
 *
 * `store/index.ts` carries an explicit warning: adding a narrowing dimension to
 * `getSessions` without adding it to `MessageFilter` is how the two halves of
 * every aggregate drift apart — the session list describes one set of work and
 * the cost headline prices another. The comment has been there for a while; this
 * file turns it into something that fails.
 *
 * The invariant is a SUBSET relation, not equality: a session with no messages
 * in the window legitimately appears in the session list and contributes no
 * cost. What must never happen is the reverse — cost attributed to a session
 * the session list excludes.
 *
 *     ∀ filter:  sessions(message-half) ⊆ sessions(session-half)
 *
 * Precondition, and a real asymmetry worth knowing about: `getSessions` narrows
 * on `includeCI`/`includeDeleted` when they are UNDEFINED (`if (!filters.x)`),
 * while `buildMessageFilter` narrows only on an explicit `false`. The contract
 * therefore holds for explicitly-passed flags, which is what every production
 * caller does. These tests pass them explicitly and use only interactive,
 * non-deleted sessions so the defaults cannot mask a genuine failure.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store, type MessageFilter } from "../store/index.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";

const PROJECTS = ["/w/alpha", "/w/beta", "/w/gamma"];
const TICKETS = ["PROJ-1", "PROJ-2", "CORE-77"];
const TAGS = ["refactor", "hotfix"];
const T0 = 1_700_000_000_000;

function tmpDb(): string {
  return path.join(os.tmpdir(), `cs-symmetry-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
}

function session(id: string, projectPath: string, firstTs: number): SessionRecord {
  return {
    sessionId: id,
    projectPath,
    sourceFile: `/transcripts/${id}.jsonl`,
    firstTimestamp: firstTs,
    lastTimestamp: firstTs + 60_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude-vscode",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 1,
    assistantMessageCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-opus-4-6"],
    repoUrl: null,
    accountUuid: null,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: null,
    medianResponseTimeMs: null,
  };
}

function message(uuid: string, sessionId: string, timestamp: number): MessageRecord {
  return {
    uuid,
    sessionId,
    timestamp,
    claudeVersion: "2.1.70",
    model: "claude-opus-4-6",
    stopReason: "end_turn",
    inputTokens: 1_000,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: null,
  };
}

/** A deterministic little world: 9 sessions × 3 messages, tickets and tags sprinkled. */
function seed(store: Store): void {
  for (let i = 0; i < 9; i++) {
    const id = `s${i}`;
    const first = T0 + i * 3_600_000;
    store.upsertSession(session(id, PROJECTS[i % PROJECTS.length]!, first));
    store.upsertMessages([
      message(`${id}-m0`, id, first),
      message(`${id}-m1`, id, first + 60_000),
      message(`${id}-m2`, id, first + 120_000),
    ]);
    // Every session but the last gets a link, cycling through all three keys —
    // so each key is genuinely represented (an earlier version skipped exactly
    // the sessions that would have carried CORE-77, and the "narrows both
    // halves" assertion passed vacuously on an empty set).
    if (i !== 8) {
      store.addTicketLink({
        sessionId: id,
        ticketKey: TICKETS[i % TICKETS.length]!,
        source: i % 2 === 0 ? "branch" : "commit",
        confidence: i % 2 === 0 ? "high" : "medium",
        evidence: i % 2 === 0 ? `feature/${TICKETS[i % TICKETS.length]}-work` : null,
      });
    }
    if (i % 4 === 0) store.addTag(id, TAGS[i % TAGS.length]!);
  }
  // A tombstone: s0 is linked to PROJ-1 by branch, but the user says otherwise.
  store.negateTicketLink("s0", "PROJ-1");
}

describe("filter symmetry — getSessions vs buildMessageFilter", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    seed(store);
  });

  afterEach(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* best effort */
    }
  });

  it("holds for every generated filter combination", () => {
    const arbFilter = fc.record(
      {
        projectPath: fc.option(fc.constantFrom(...PROJECTS), { nil: undefined }),
        ticket: fc.option(fc.constantFrom(...TICKETS), { nil: undefined }),
        tag: fc.option(fc.constantFrom(...TAGS), { nil: undefined }),
        since: fc.option(fc.integer({ min: T0 - 3_600_000, max: T0 + 9 * 3_600_000 }), {
          nil: undefined,
        }),
        until: fc.option(fc.integer({ min: T0, max: T0 + 12 * 3_600_000 }), { nil: undefined }),
      },
      { requiredKeys: [] },
    );

    fc.assert(
      fc.property(arbFilter, (raw) => {
        const filter: MessageFilter = { ...raw, includeCI: true, includeDeleted: true };

        // Session half. `activeSince` is the period predicate that agrees with
        // message timestamps (`since` is start-in-period and would exclude a
        // session that straddles the boundary while still owning in-window
        // messages — a legitimate difference, not a contract breach).
        const sessionHalf = new Set(
          store
            .getSessions({
              projectPath: filter.projectPath,
              ticket: filter.ticket,
              tag: filter.tag,
              activeSince: filter.since,
              until: filter.until,
              includeCI: true,
              includeDeleted: true,
            })
            .map((s) => s.session_id),
        );

        const messageHalf = store.getSessionIdsWithMessages(filter);

        for (const id of messageHalf) {
          expect(sessionHalf.has(id)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("prices nothing for a ticket that does not exist", () => {
    const filter: MessageFilter = { ticket: "NOPE-999", includeCI: true, includeDeleted: true };
    expect(store.getSessionIdsWithMessages(filter)).toEqual([]);
    expect(store.getMessageTotals(filter)).toEqual([]);
  });

  it("narrows both halves identically for a real ticket", () => {
    const filter: MessageFilter = { ticket: "CORE-77", includeCI: true, includeDeleted: true };
    const messageHalf = store.getSessionIdsWithMessages(filter);
    const sessionHalf = store
      .getSessions({ ticket: "CORE-77", includeCI: true, includeDeleted: true })
      .map((s) => s.session_id)
      .sort();

    expect(messageHalf.length).toBeGreaterThan(0);
    expect(messageHalf.sort()).toEqual(sessionHalf);
  });

  it("a tombstoned link excludes the session from BOTH halves", () => {
    // s0 carries a `branch` link to PROJ-1 and a user tombstone for it.
    const links = store.getTicketLinksForSession("s0");
    expect(links.some((l) => l.ticket_key === "PROJ-1" && l.negated === 1)).toBe(true);

    const filter: MessageFilter = { ticket: "PROJ-1", includeCI: true, includeDeleted: true };
    expect(store.getSessionIdsWithMessages(filter)).not.toContain("s0");
    expect(
      store.getSessions({ ticket: "PROJ-1", includeCI: true, includeDeleted: true }).map((s) => s.session_id),
    ).not.toContain("s0");
  });

  it("tag now narrows the message half too (it previously did not)", () => {
    const filter: MessageFilter = { tag: "refactor", includeCI: true, includeDeleted: true };
    const withTag = store.getSessionIdsWithMessages(filter);
    const withoutTag = store.getSessionIdsWithMessages({ includeCI: true, includeDeleted: true });
    expect(withTag.length).toBeGreaterThan(0);
    expect(withTag.length).toBeLessThan(withoutTag.length);
  });
});

describe("ticket-link storage seam", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new Store(dbPath);
    store.upsertSession(session("s1", "/w/alpha", T0));
  });

  afterEach(() => {
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      /* best effort */
    }
  });

  it("rejects a malformed key at the boundary", () => {
    expect(() => store.addTicketLink({ sessionId: "s1", ticketKey: "nope", source: "branch", confidence: "high" })).toThrow(
      /Invalid ticket key/,
    );
  });

  it("upper-cases keys so one ticket is never two rows", () => {
    store.addTicketLink({ sessionId: "s1", ticketKey: "proj-9", source: "branch", confidence: "high" });
    const links = store.getTicketLinksForSession("s1");
    expect(links).toHaveLength(1);
    expect(links[0]!.ticket_key).toBe("PROJ-9");
  });

  it("re-running extraction refreshes rather than duplicates", () => {
    store.addTicketLink({ sessionId: "s1", ticketKey: "PROJ-9", source: "branch", confidence: "medium" });
    store.addTicketLink({ sessionId: "s1", ticketKey: "PROJ-9", source: "branch", confidence: "high" });
    const links = store.getTicketLinksForSession("s1");
    expect(links).toHaveLength(1);
    expect(links[0]!.confidence).toBe("high");
  });

  it("never lets automatic extraction overwrite a manual assignment", () => {
    store.addTicketLink({ sessionId: "s1", ticketKey: "PROJ-9", source: "tag", confidence: "high" });
    // A later extraction pass tries to downgrade the user's own row.
    store.addTicketLink({ sessionId: "s1", ticketKey: "PROJ-9", source: "tag", confidence: "low", evidence: "guessed" });
    const links = store.getTicketLinksForSession("s1");
    expect(links[0]!.confidence).toBe("high");
    expect(links[0]!.evidence).toBeNull();
  });

  it("counts only non-negated links in the key index", () => {
    store.addTicketLink({ sessionId: "s1", ticketKey: "PROJ-9", source: "branch", confidence: "high" });
    expect(store.getTicketKeys()).toEqual([{ ticket_key: "PROJ-9", session_count: 1 }]);
    store.negateTicketLink("s1", "PROJ-9");
    expect(store.getTicketKeys()).toEqual([]);
  });
});
