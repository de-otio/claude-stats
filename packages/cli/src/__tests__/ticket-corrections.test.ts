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
    attachTicketAttribution(store, data as Parameters<typeof attachTicketAttribution>[1], { tickets: { showUi: true } });
    expect(data.currentSessionTicket).toBeNull();

    const html = renderTicketAttributionCard(data.currentSessionTicket as never, t);
    expect(html).toContain("dashboard:ticketCard.noSession");
    // Mutation check: an unavailable state must NOT render the link form —
    // a form with nothing behind it (no session id to attach to) is worse
    // than an honest "no sessions yet" line.
    expect(html).not.toContain("ticket-key-input");
  });

  it("attaches the most recent session's links, mapping `negated` to a boolean", () => {
    // A session id longer than the 8 chars the card's header shows, so the
    // truncated header and the full `data-session-id` are genuinely two
    // different strings derived from one value (see the divergence assertion
    // at the end of this test).
    const sid = "sess-1234-abcd";
    seedSession(store, sid);
    store.addTicketLink({ sessionId: sid, ticketKey: "PROJ-1", source: "branch", confidence: "high" });
    store.negateTicketLink(sid, "PROJ-2");

    const data = { currentSessionTicket: undefined } as { currentSessionTicket?: unknown };
    attachTicketAttribution(store, data as Parameters<typeof attachTicketAttribution>[1], { tickets: { showUi: true } });
    const attached = data.currentSessionTicket as { sessionId: string; links: Array<{ ticketKey: string; negated: boolean }> };
    expect(attached.sessionId).toBe(sid);
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
    //
    // A bare `toContain` here is NOT enough: it searches the WHOLE card, so a
    // card that badged EVERY row (including the active one) would still pass
    // while telling the user the exact opposite of the truth. Assert the badge
    // count AND which row carries it.
    const badgeCount = (html.match(/ticketCard\.negatedBadge/g) ?? []).length;
    expect(badgeCount).toBe(1);
    const rowsHtml = html.split("<li");
    const activeRow = rowsHtml.find((r) => r.includes("PROJ-1"))!;
    const negatedRow = rowsHtml.find((r) => r.includes("PROJ-2"))!;
    expect(negatedRow).toContain("ticketCard.negatedBadge");
    expect(activeRow).not.toContain("ticketCard.negatedBadge");

    // The session the card NAMES and the session id its buttons act on must be
    // the same session — two renderings of one quantity that could silently
    // diverge (the header is a truncated copy, the attribute is the full id).
    expect(html).toContain(`data-session-id="${attached.sessionId}"`);
    const header = html.match(/<div class="cs-ticket-session">([\s\S]*?)<\/div>/);
    expect(header).not.toBeNull();
    expect(header![1]).toContain(attached.sessionId.slice(0, 8));
  });

  it("distinguishes `undefined` (attach never ran) from `null` (store genuinely empty) — undefined must NOT render the honest-empty copy", () => {
    // Seed a session so the store is demonstrably NOT empty. If the card
    // rendered `undefined` with the same "no sessions recorded yet" copy as
    // `null`, this would be a false claim over a store full of sessions —
    // exactly the failure mode a dropped `attachTicketAttribution` call
    // produces (server/index.ts never invokes it, the field is left
    // `undefined`, and the card would lie about the store being empty).
    seedSession(store, "s-not-empty");

    const undefinedHtml = renderTicketAttributionCard(undefined, t);
    // Omit the card entirely rather than assert anything about the store.
    expect(undefinedHtml).toBe("");
    expect(undefinedHtml).not.toContain("dashboard:ticketCard.noSession");

    // `null` (attach ran, found nothing) keeps the honest-empty state.
    const nullHtml = renderTicketAttributionCard(null, t);
    expect(nullHtml).toContain("dashboard:ticketCard.noSession");
  });

  it("renders a session with no links as an honest empty list, not an empty card", () => {
    seedSession(store, "s1");
    const data = { currentSessionTicket: undefined } as { currentSessionTicket?: unknown };
    attachTicketAttribution(store, data as Parameters<typeof attachTicketAttribution>[1], { tickets: { showUi: true } });
    const html = renderTicketAttributionCard(data.currentSessionTicket as never, t);
    expect(html).toContain("dashboard:ticketCard.noLinks");
    // The link form must still be offered — an empty session is exactly when
    // a manual link is most useful.
    expect(html).toContain("ticket-key-input");
  });

  // The per-ticket UI is opt-in (`tickets.showUi`, default off). The attach
  // must leave the field UNDEFINED — the "never ran" state the card omits —
  // not null, which would render the honest-empty card for a hidden feature.
  it("leaves currentSessionTicket undefined (card omitted) when tickets.showUi is off or config is absent", () => {
    seedSession(store, "s-hidden");
    store.addTicketLink({ sessionId: "s-hidden", ticketKey: "PROJ-1", source: "branch", confidence: "high" });

    for (const config of [undefined, {}, { tickets: {} }, { tickets: { showUi: false } }]) {
      const data = { currentSessionTicket: undefined } as { currentSessionTicket?: unknown };
      attachTicketAttribution(store, data as Parameters<typeof attachTicketAttribution>[1], config);
      expect(data.currentSessionTicket).toBeUndefined();
      expect(renderTicketAttributionCard(data.currentSessionTicket as never, t)).toBe("");
    }
  });
});

// ─── CLI verb, mutation-guarded contracts, and coverage-consistency tests
// live in `ticket-cli.test.ts` — see that file's header comment for why the
// `vi.mock("../store/index.js")` it needs cannot share this file. ─────────
