/**
 * Lane L — manual ticket correction surfaces: the dashboard-facing half.
 *
 * `store.getMostRecentSessionId` (what "current session" means for the
 * link/negate card) and `attachTicketAttribution` + `renderTicketAttributionCard`
 * (the card's data-build and pure render). The CLI verb
 * (`claude-stats ticket <session> [key]`) and the mutation-guarded
 * correction-rule tests live in `ticket-cli.test.ts` — see that file's header
 * for why its `vi.mock("../store/index.js")` can't share a file with the
 * direct-Store-construction tests here. `{kind:'ticket'}` correction-action
 * tests live in `__tests__/recap/corrections.test.ts` (round-trip) and
 * `__tests__/recap/integration.test.ts` (Scenario 40, digest wiring),
 * alongside the other correction-kind tests.
 *
 * Design: doc/analysis/ticket-attribution/02-local-data-model.md §2.5–2.7,
 *         01-attribution-signals.md.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../store/index.js";
import { attachTicketAttribution } from "../dashboard/index.js";
import { renderTicketAttributionCard } from "../server/ticketCard.js";
import { FIXED_NOW } from "./fixtures/synthetic.js";

// ─── Shared seeding helper (mirrors ticket-attribution.test.ts) ────────────

function seedSession(
  store: Store,
  sessionId: string,
  overrides: Partial<Parameters<Store["upsertSession"]>[0]> = {},
): void {
  store.upsertSession({
    sessionId,
    projectPath: "/tmp/nonexistent-project",
    sourceFile: `/tmp/${sessionId}.jsonl`,
    firstTimestamp: FIXED_NOW,
    lastTimestamp: FIXED_NOW + 60_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude-cli",
    gitBranch: "feature/PROJ-1-work",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 1,
    assistantMessageCount: 1,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-sonnet-5"],
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
    ...overrides,
  });
}

// ─── store.getMostRecentSessionId ──────────────────────────────────────────

describe("store.getMostRecentSessionId", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-ticket-mru-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("returns null for an empty store (honest, not a fabricated id)", () => {
    expect(store.getMostRecentSessionId()).toBeNull();
  });

  it("picks the session with the latest activity, not insertion order", () => {
    seedSession(store, "old", { firstTimestamp: FIXED_NOW - 100_000, lastTimestamp: FIXED_NOW - 90_000 });
    seedSession(store, "newest", { firstTimestamp: FIXED_NOW - 5_000, lastTimestamp: FIXED_NOW - 1_000 });
    seedSession(store, "middle", { firstTimestamp: FIXED_NOW - 50_000, lastTimestamp: FIXED_NOW - 40_000 });
    expect(store.getMostRecentSessionId()).toBe("newest");
  });

  it("excludes a deleted session even if it is the most recent", () => {
    seedSession(store, "kept", { firstTimestamp: FIXED_NOW - 50_000, lastTimestamp: FIXED_NOW - 40_000 });
    seedSession(store, "deleted-newest", {
      firstTimestamp: FIXED_NOW - 5_000,
      lastTimestamp: FIXED_NOW - 1_000,
      sourceDeleted: true,
    });
    expect(store.getMostRecentSessionId()).toBe("kept");
  });

  it("excludes a subagent session even if it is the most recent", () => {
    seedSession(store, "kept", { firstTimestamp: FIXED_NOW - 50_000, lastTimestamp: FIXED_NOW - 40_000 });
    seedSession(store, "subagent-newest", {
      firstTimestamp: FIXED_NOW - 5_000,
      lastTimestamp: FIXED_NOW - 1_000,
      isSubagent: true,
      parentSessionId: "kept",
    });
    expect(store.getMostRecentSessionId()).toBe("kept");
  });
});

// ─── attachTicketAttribution + renderTicketAttributionCard ─────────────────

describe("attachTicketAttribution", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-ticket-attach-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key);

  it("attaches null (never throws) when the store is empty, and the card states it honestly", () => {
    const data = { currentSessionTicket: undefined } as { currentSessionTicket?: unknown };
    attachTicketAttribution(store, data as Parameters<typeof attachTicketAttribution>[1]);
    expect(data.currentSessionTicket).toBeNull();

    const html = renderTicketAttributionCard(data.currentSessionTicket as never, t);
    expect(html).toContain("dashboard:ticketCard.noSession");
    // Mutation check: an unavailable state must NOT render the link form —
    // a form with nothing behind it (no session id to attach to) is worse
    // than an honest "no sessions yet" line.
    expect(html).not.toContain("ticket-key-input");
  });

  it("attaches the most recent session's links, mapping `negated` to a boolean", () => {
    seedSession(store, "s1");
    store.addTicketLink({ sessionId: "s1", ticketKey: "PROJ-1", source: "branch", confidence: "high" });
    store.negateTicketLink("s1", "PROJ-2");

    const data = { currentSessionTicket: undefined } as { currentSessionTicket?: unknown };
    attachTicketAttribution(store, data as Parameters<typeof attachTicketAttribution>[1]);
    const attached = data.currentSessionTicket as { sessionId: string; links: Array<{ ticketKey: string; negated: boolean }> };
    expect(attached.sessionId).toBe("s1");
    const active = attached.links.find((l) => l.ticketKey === "PROJ-1")!;
    const negated = attached.links.find((l) => l.ticketKey === "PROJ-2")!;
    expect(active.negated).toBe(false);
    expect(negated.negated).toBe(true);

    const html = renderTicketAttributionCard(attached as never, t);
    expect(html).toContain("PROJ-1");
    expect(html).toContain("PROJ-2");
    // Mutation check: a negated link's row must actually say so — a card that
    // renders every link identically would silently hide the correction from
    // the person who made it.
    expect(html).toContain("dashboard:ticketCard.negatedBadge");
  });

  it("renders a session with no links as an honest empty list, not an empty card", () => {
    seedSession(store, "s1");
    const data = { currentSessionTicket: undefined } as { currentSessionTicket?: unknown };
    attachTicketAttribution(store, data as Parameters<typeof attachTicketAttribution>[1]);
    const html = renderTicketAttributionCard(data.currentSessionTicket as never, t);
    expect(html).toContain("dashboard:ticketCard.noLinks");
    // The link form must still be offered — an empty session is exactly when
    // a manual link is most useful.
    expect(html).toContain("ticket-key-input");
  });
});

// ─── CLI verb, mutation-guarded contracts, and coverage-consistency tests
// live in `ticket-cli.test.ts` — see that file's header comment for why the
// `vi.mock("../store/index.js")` it needs cannot share this file. ─────────
