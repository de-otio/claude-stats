/**
 * Ticket attribution (Lane A) — extraction, write path, query path, surfaces.
 *
 * Design: doc/analysis/ticket-attribution/01-attribution-signals.md,
 *         doc/analysis/ticket-attribution/02-local-data-model.md.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../store/index.js";
import { collect } from "../aggregator/index.js";
import * as pathsMod from "@claude-stats/core/paths";
import { extractTicketLinks, aggregateTicketCosts, type ActiveLink } from "@claude-stats/core/attribution";
import type { AttributionSource, Confidence } from "@claude-stats/core/types/insight";
import { runTicketExtraction, getTicketCostReport } from "../ticketing/index.js";
import { printTicketReport } from "../reporter/index.js";
import { createMcpServer } from "../mcp/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { seedStore, FIXED_NOW } from "./fixtures/synthetic.js";
import { estimateCost } from "@claude-stats/core/pricing";

// ─── Extraction (pure) ──────────────────────────────────────────────────────

describe("extractTicketLinks", () => {
  it("extracts a branch key at high confidence when an allowlist is configured", () => {
    const links = extractTicketLinks({
      sessionId: "s1",
      branches: [{ text: "feature/PROJ-42-fix-thing" }],
      commits: [],
      prompts: [],
      allowlist: ["PROJ"],
    });
    expect(links).toEqual([
      {
        sessionId: "s1",
        ticketKey: "PROJ-42",
        source: "branch",
        confidence: "high",
        granularity: "session",
        firstUuid: null,
        lastUuid: null,
        evidence: "feature/PROJ-42-fix-thing",
      },
    ]);
  });

  it("caps branch confidence at medium when no allowlist is configured (01 §1.1, config.ts doc)", () => {
    const links = extractTicketLinks({
      sessionId: "s1",
      branches: [{ text: "feature/PROJ-42-fix-thing" }],
      commits: [],
      prompts: [],
    });
    expect(links[0]!.confidence).toBe("medium");
  });

  it("grades commit subjects medium regardless of allowlist", () => {
    const links = extractTicketLinks({
      sessionId: "s1",
      branches: [],
      commits: [{ text: "PROJ-9: fix the thing" }],
      prompts: [],
      allowlist: ["PROJ"],
    });
    expect(links[0]!).toMatchObject({ ticketKey: "PROJ-9", source: "commit", confidence: "medium", granularity: "session" });
  });

  it("grades an uncorroborated prompt mention low, and stores no evidence text for it", () => {
    const links = extractTicketLinks({
      sessionId: "s1",
      branches: [],
      commits: [],
      prompts: [{ text: "same bug as PROJ-77?", uuid: "m1" }],
      allowlist: ["PROJ"],
    });
    expect(links[0]!).toMatchObject({ ticketKey: "PROJ-77", source: "prompt", confidence: "low", evidence: null });
  });

  it("upgrades a corroborated prompt mention to medium", () => {
    const links = extractTicketLinks({
      sessionId: "s1",
      branches: [{ text: "feature/PROJ-77-work" }],
      commits: [],
      prompts: [{ text: "working on PROJ-77 today", uuid: "m1" }],
      allowlist: ["PROJ"],
    });
    const prompt = links.find((l) => l.source === "prompt")!;
    expect(prompt.confidence).toBe("medium");
  });

  it("bounds a message-granular link to the encounter order of matching observations", () => {
    const links = extractTicketLinks({
      sessionId: "s1",
      branches: [],
      commits: [],
      prompts: [
        { text: "PROJ-1 first mention", uuid: "m1" },
        { text: "unrelated", uuid: "m2" },
        { text: "PROJ-1 again", uuid: "m3" },
      ],
      allowlist: ["PROJ"],
    });
    const link = links.find((l) => l.ticketKey === "PROJ-1")!;
    expect(link.granularity).toBe("messages");
    expect(link.firstUuid).toBe("m1");
    expect(link.lastUuid).toBe("m3");
  });

  it("falls back to session granularity when ANY occurrence of the key has no uuid", () => {
    const links = extractTicketLinks({
      sessionId: "s1",
      branches: [
        { text: "PROJ-1", uuid: "m1" },
        { text: "PROJ-1" }, // session-level occurrence — no uuid
      ],
      commits: [],
      prompts: [],
      allowlist: ["PROJ"],
    });
    const link = links.find((l) => l.ticketKey === "PROJ-1")!;
    expect(link.granularity).toBe("session");
    expect(link.firstUuid).toBeNull();
    expect(link.lastUuid).toBeNull();
  });

  it("never produces a link for a key with no signal (no guessed attribution)", () => {
    const links = extractTicketLinks({
      sessionId: "s1",
      branches: [{ text: "main" }],
      commits: [{ text: "chore: bump deps" }],
      prompts: [{ text: "please refactor this function", uuid: "m1" }],
      allowlist: ["PROJ"],
    });
    expect(links).toHaveLength(0);
  });

  it("dedupes so one key never yields two rows from one source", () => {
    const links = extractTicketLinks({
      sessionId: "s1",
      branches: [{ text: "PROJ-1 and PROJ-1 again in the same branch string" }],
      commits: [],
      prompts: [],
      allowlist: ["PROJ"],
    });
    expect(links).toHaveLength(1);
  });

  // A2: case-insensitive scanning is safe ONLY when a configured allowlist
  // can reject shape-alike false positives — see the doc comment on
  // `scanKeys` in attribution.ts. These four tests pin both directions.

  it("finds a lowercase or mixed-case key when an allowlist makes it safe (A2)", () => {
    for (const branch of ["feature/proj-1-work", "feature/Proj-1-work", "feature/PROJ-1-work"]) {
      const links = extractTicketLinks({
        sessionId: "s1",
        branches: [{ text: branch }],
        commits: [],
        prompts: [],
        allowlist: ["PROJ"],
      });
      expect(links).toHaveLength(1);
      // Normalised to uppercase regardless of the casing it was typed in —
      // two casings of one key must never become two rows in a cost report.
      expect(links[0]!.ticketKey).toBe("PROJ-1");
    }
  });

  it("still does NOT match a lowercase or mixed-case key without an allowlist (A2)", () => {
    // Without an allowlist there is nothing to reject `utf-8`-shaped noise,
    // so the scan stays conservative (uppercase-only) — today's behavior,
    // unchanged. Only the ALL-CAPS form matches.
    for (const branch of ["feature/proj-1-work", "feature/Proj-1-work"]) {
      expect(
        extractTicketLinks({
          sessionId: "s1",
          branches: [{ text: branch }],
          commits: [],
          prompts: [],
        }),
      ).toHaveLength(0);
    }
    expect(
      extractTicketLinks({
        sessionId: "s1",
        branches: [{ text: "feature/PROJ-1-work" }],
        commits: [],
        prompts: [],
      }),
    ).toHaveLength(1);
  });

  it("never turns utf-8/sha-1/base-64/http-2-shaped text into a ticket, even with an allowlist configured (A2)", () => {
    const noise = [
      "encode as utf-8 before hashing",
      "verify the sha-1 checksum",
      "switch the payload to base-64",
      "the client now speaks http-2",
    ];
    for (const text of noise) {
      const links = extractTicketLinks({
        sessionId: "s1",
        branches: [{ text }],
        commits: [{ text }],
        prompts: [{ text, uuid: "m1" }],
        allowlist: ["PROJ", "CORE"], // realistic Jira-style allowlist — never "UTF"/"SHA"/"BASE"/"HTTP"
      });
      expect(links).toHaveLength(0);
    }
  });

  it("DOES turn a shape-alike string into a ticket only when its prefix is itself configured (A2, precision boundary)", () => {
    // Pathological but honest: if a team's own project key happens to collide
    // with a common technical token, the allowlist is what makes that an
    // intentional choice rather than an accident — same contract as any other
    // configured prefix.
    const links = extractTicketLinks({
      sessionId: "s1",
      branches: [{ text: "encode as utf-8 before hashing" }],
      commits: [],
      prompts: [],
      allowlist: ["UTF"],
    });
    expect(links).toHaveLength(1);
    expect(links[0]!.ticketKey).toBe("UTF-8");
  });

  // ── Properties ──────────────────────────────────────────────────────────

  it("property: a key outside a configured allowlist never produces a link", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom("PROJ", "CORE", "ZULU"), { minLength: 1, maxLength: 3 }),
        fc.integer({ min: 1, max: 999999 }),
        fc.constantFrom("PROJ", "CORE", "ZULU", "OUTSIDE", "NOPE"),
        (allowlist, num, prefix) => {
          const key = `${prefix}-${num}`;
          const links = extractTicketLinks({
            sessionId: "s1",
            branches: [{ text: `feature/${key}-work` }],
            commits: [{ text: `${key}: fix` }],
            prompts: [{ text: `about ${key}`, uuid: "m1" }],
            allowlist,
          });
          const found = links.some((l) => l.ticketKey === key);
          expect(found).toBe((allowlist as readonly string[]).includes(prefix));
        },
      ),
    );
  });

  // Alphabet with NO uppercase letters — the scan regex requires `[A-Z]` to
  // start a key, so text drawn from this alphabet structurally cannot contain
  // a syntactically valid key. Makes the property unconditional rather than
  // "skip when the fuzzer didn't happen to produce a match."
  const noKeyText = fc.string({
    unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789 /_.:,!?".split("")),
    maxLength: 60,
  });

  it("property: no signal contains a valid key → no link, ever", () => {
    fc.assert(
      fc.property(noKeyText, noKeyText, noKeyText, (a, b, c) => {
        const links = extractTicketLinks({
          sessionId: "s1",
          branches: [{ text: a }],
          commits: [{ text: b }],
          prompts: [{ text: c, uuid: "m1" }],
          allowlist: ["PROJ"],
        });
        expect(links).toHaveLength(0);
      }),
    );
  });
});

// ─── Aggregation (pure) ─────────────────────────────────────────────────────

describe("aggregateTicketCosts", () => {
  it("splits an ambiguous session's cost across every key it's linked to, but counts it once toward coverage", () => {
    const links: ActiveLink[] = [
      { sessionId: "s1", ticketKey: "PROJ-1", source: "branch", confidence: "high" },
      { sessionId: "s1", ticketKey: "PROJ-2", source: "prompt", confidence: "low" },
    ];
    const sessionCosts = new Map([["s1", 100]]);
    const { tickets, coverage } = aggregateTicketCosts(links, sessionCosts, 100);
    expect(coverage.attributedCost).toBe(100);
    expect(coverage.ambiguousSessions).toBe(1);
    // Both ticket rows carry the FULL session cost — never a silent 50/50 split.
    expect(tickets.find((t) => t.ticketKey === "PROJ-1")!.cost).toBe(100);
    expect(tickets.find((t) => t.ticketKey === "PROJ-2")!.cost).toBe(100);
    // The session's coverage tier is the MAX across its links (high), not
    // downgraded by the weaker second link.
    expect(coverage.byConfidence.high).toBe(100);
  });

  it("upgrades confidence one step when ≥2 independent sources agree on a session's key", () => {
    const links: ActiveLink[] = [
      { sessionId: "s1", ticketKey: "PROJ-1", source: "prompt", confidence: "low" },
      { sessionId: "s1", ticketKey: "PROJ-1", source: "commit", confidence: "medium" },
    ];
    const sessionCosts = new Map([["s1", 50]]);
    const { tickets } = aggregateTicketCosts(links, sessionCosts, 50);
    // max(low, medium) = medium, then corroboration (2 distinct sources) upgrades one step → high.
    expect(tickets[0]!.confidence).toBe("high");
  });

  it("ignores links to sessions outside the reporting window", () => {
    const links: ActiveLink[] = [{ sessionId: "outside", ticketKey: "PROJ-1", source: "branch", confidence: "high" }];
    const { tickets, coverage } = aggregateTicketCosts(links, new Map([["s1", 10]]), 10);
    expect(tickets).toHaveLength(0);
    expect(coverage.attributedCost).toBe(0);
  });

  it("reports null ratio (never a fabricated 0%) when the period total is zero", () => {
    const { coverage } = aggregateTicketCosts([], new Map(), 0);
    expect(coverage.ratio).toBeNull();
    expect(coverage.totalCost).toBe(0);
  });

  // ── The load-bearing property ──────────────────────────────────────────

  const sessionIds = ["s1", "s2", "s3", "s4", "s5"] as const;
  const linkArb = fc.record({
    sessionId: fc.constantFrom(...sessionIds),
    ticketKey: fc.constantFrom("PROJ-1", "PROJ-2", "CORE-9"),
    source: fc.constantFrom<AttributionSource>("branch", "commit", "prompt", "tag"),
    confidence: fc.constantFrom<Confidence>("high", "medium", "low"),
  });

  // A6: the original version of this test computed
  // `unattributed = coverage.totalCost - coverage.attributedCost` and then
  // asserted `attributedCost + unattributed ≈ totalCost` — which reduces
  // algebraically to "totalCost was echoed back unchanged" (aggregateTicketCosts
  // literally assigns `coverage.totalCost = totalCost`) and never constrained
  // `attributedCost` at all: an implementation that always returned
  // `attributedCost = 0`, or one that double-counted every session, would have
  // passed this identity just as well. Fixed by computing the expected
  // attributed total INDEPENDENTLY from the fixture's own ground truth — never
  // from the function's output — and comparing against that.
  it("property: attributedCost equals the independently-computed ground truth (one contribution per linked, in-window session), and byConfidence sums to it — for ANY link/cost combination", () => {
    fc.assert(
      fc.property(
        fc.array(linkArb, { maxLength: 25 }),
        fc.tuple(
          fc.double({ min: 0, max: 500, noNaN: true }),
          fc.double({ min: 0, max: 500, noNaN: true }),
          fc.double({ min: 0, max: 500, noNaN: true }),
          fc.double({ min: 0, max: 500, noNaN: true }),
          fc.double({ min: 0, max: 500, noNaN: true }),
        ),
        (links, costs) => {
          const sessionCosts = new Map(sessionIds.map((id, i) => [id, costs[i]!]));
          // totalCost is defined as the sum of sessionCosts, exactly as the real
          // query path derives it (getTicketCostReport) — see aggregateTicketCosts's
          // doc for why that's what makes this hold EXACTLY, not approximately.
          let totalCost = 0;
          for (const c of sessionCosts.values()) totalCost += c;

          const { coverage } = aggregateTicketCosts(links, sessionCosts, totalCost);

          // Ground truth, computed directly from `links`/`sessionCosts` — NOT
          // from `coverage` — per the documented contract: a session
          // contributes its cost to `attributedCost` exactly once iff it has
          // at least one active link AND is in the reporting window (present
          // in `sessionCosts`), no matter how many distinct keys it's linked
          // to (the ambiguous-session, no-silent-split rule).
          const linkedInWindowSessions = new Set(
            links.map((l) => l.sessionId).filter((sid) => sessionCosts.has(sid)),
          );
          let expectedAttributed = 0;
          for (const sid of linkedInWindowSessions) expectedAttributed += sessionCosts.get(sid)!;

          expect(coverage.attributedCost).toBeCloseTo(expectedAttributed, 6);
          expect(coverage.totalCost).toBe(totalCost);

          const unattributed = coverage.totalCost - coverage.attributedCost;
          expect(unattributed).toBeGreaterThanOrEqual(-1e-9);

          const sumByConf = coverage.byConfidence.high + coverage.byConfidence.medium + coverage.byConfidence.low;
          expect(sumByConf).toBeCloseTo(coverage.attributedCost, 6);
        },
      ),
    );
  });
});

// ─── Write path: store integration ──────────────────────────────────────────

describe("runTicketExtraction (write path)", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-ticket-wr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  function seedSession(sessionId: string, overrides: Partial<Parameters<Store["upsertSession"]>[0]> = {}) {
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
      inputTokens: 0,
      outputTokens: 0,
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

  it("writes an automatic link from the session's branch", () => {
    seedSession("s1");
    runTicketExtraction(store, store.findSession("s1")!, { allowlist: ["PROJ"] });
    const links = store.getTicketLinksForSession("s1");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ ticket_key: "PROJ-1", source: "branch", confidence: "high", negated: 0 });
  });

  // The branch rung is covered above. These two cover the OTHER two rungs
  // through `runTicketExtraction` itself — i.e. the wiring from the store /
  // git reader into `extractTicketLinks`, not just the pure function. Without
  // them, gutting either signal-gathering line in `runTicketExtraction`
  // (`commits = []`, or dropping `prompt_text`) leaves the whole suite green.

  it("picks up a prompt-sourced key from the session's stored messages (rung 4 wiring)", () => {
    seedSession("s-prompt", { gitBranch: null });
    store.upsertMessages([
      {
        uuid: "s-prompt-m0",
        sessionId: "s-prompt",
        timestamp: FIXED_NOW,
        claudeVersion: "2.1.70",
        model: "claude-sonnet-5",
        stopReason: "end_turn",
        inputTokens: 100,
        outputTokens: 10,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        tools: [],
        thinkingBlocks: 0,
        serviceTier: null,
        inferenceGeo: null,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
        promptText: "can you look at PROJ-7 while you're in here",
      },
    ]);

    runTicketExtraction(store, store.findSession("s-prompt")!, { allowlist: ["PROJ"] });

    const links = store.getTicketLinksForSession("s-prompt");
    expect(links).toHaveLength(1);
    // Uncorroborated prompt mention → low, and message-granular (the prompt is
    // tied to exactly one message uuid).
    expect(links[0]).toMatchObject({
      ticket_key: "PROJ-7",
      source: "prompt",
      confidence: "low",
      granularity: "messages",
      first_uuid: "s-prompt-m0",
      last_uuid: "s-prompt-m0",
    });
  });

  // A4: `getSessionMessages` is `SELECT *` — the largest column in the table
  // (`prompt_text`) plus every other column, when extraction only ever reads
  // `uuid` + `prompt_text`. Prove the write path uses the targeted query
  // instead by asserting the expensive one is never called.
  it("reads prompt signal via the targeted getSessionPromptTexts query, never the full-row getSessionMessages (A4)", () => {
    seedSession("s-a4", { gitBranch: null });
    store.upsertMessages([
      {
        uuid: "s-a4-m0",
        sessionId: "s-a4",
        timestamp: FIXED_NOW,
        claudeVersion: "2.1.70",
        model: "claude-sonnet-5",
        stopReason: "end_turn",
        inputTokens: 100,
        outputTokens: 10,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        tools: [],
        thinkingBlocks: 0,
        serviceTier: null,
        inferenceGeo: null,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
        promptText: "about PROJ-3",
      },
    ]);

    const fullRowSpy = vi.spyOn(store, "getSessionMessages");
    runTicketExtraction(store, store.findSession("s-a4")!, { allowlist: ["PROJ"] });
    expect(fullRowSpy).not.toHaveBeenCalled();
    fullRowSpy.mockRestore();

    const links = store.getTicketLinksForSession("s-a4");
    expect(links.some((l) => l.ticket_key === "PROJ-3" && l.source === "prompt")).toBe(true);
  });

  it("picks up a commit-sourced key from the project's real git log (rung 3 wiring)", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "claude-stats-ticket-commit-wiring-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      writeFileSync(join(repoDir, "a.txt"), "hello");
      execFileSync("git", ["add", "a.txt"], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "PROJ-8: land the fix"], { cwd: repoDir });

      const now = Date.now();
      // No branch signal, so anything extracted must have come from the commit.
      seedSession("s-commit", {
        gitBranch: null,
        projectPath: repoDir,
        firstTimestamp: now - 60_000,
        lastTimestamp: now,
      });

      runTicketExtraction(store, store.findSession("s-commit")!, { allowlist: ["PROJ"] });

      const links = store.getTicketLinksForSession("s-commit");
      expect(links).toHaveLength(1);
      expect(links[0]).toMatchObject({
        ticket_key: "PROJ-8",
        source: "commit",
        confidence: "medium",
        granularity: "session",
        evidence: "PROJ-8: land the fix",
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("property: a manual (tag) link survives any number of automatic extraction passes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), (passes) => {
        const sid = `manual-${Math.random().toString(36).slice(2)}`;
        seedSession(sid, { gitBranch: "feature/PROJ-1-work" });
        store.addTicketLink({ sessionId: sid, ticketKey: "PROJ-1", source: "tag", confidence: "high", evidence: "manual: definitely PROJ-1" });
        for (let i = 0; i < passes; i++) {
          runTicketExtraction(store, store.findSession(sid)!, { allowlist: ["PROJ"] });
        }
        const manualRow = store.getTicketLinksForSession(sid).find((l) => l.source === "tag")!;
        expect(manualRow.evidence).toBe("manual: definitely PROJ-1");
        expect(manualRow.confidence).toBe("high");
      }),
      { numRuns: 20 },
    );
  });

  it("a negation tombstone suppresses the key even though the branch still matches it", () => {
    seedSession("s2", { gitBranch: "feature/PROJ-1-work" });
    runTicketExtraction(store, store.findSession("s2")!, { allowlist: ["PROJ"] });
    expect(store.getTicketKeys().some((k) => k.ticket_key === "PROJ-1")).toBe(true);

    store.negateTicketLink("s2", "PROJ-1");
    // Re-running extraction (as a later `collect` would) must not resurrect it.
    runTicketExtraction(store, store.findSession("s2")!, { allowlist: ["PROJ"] });
    expect(store.getTicketKeys().some((k) => k.ticket_key === "PROJ-1")).toBe(false);
    expect(store.getActiveTicketLinks().some((l) => l.session_id === "s2" && l.ticket_key === "PROJ-1")).toBe(false);
  });

  it("a subagent with no signal of its own inherits its parent's active links", () => {
    seedSession("parent-1", { gitBranch: "feature/PROJ-1-work" });
    runTicketExtraction(store, store.findSession("parent-1")!, { allowlist: ["PROJ"] });

    seedSession("child-1", { gitBranch: null, isSubagent: true, parentSessionId: "parent-1" });
    runTicketExtraction(store, store.findSession("child-1")!, { allowlist: ["PROJ"] });

    const childLinks = store.getTicketLinksForSession("child-1");
    expect(childLinks).toHaveLength(1);
    expect(childLinks[0]).toMatchObject({ ticket_key: "PROJ-1", source: "branch", granularity: "session" });
  });

  it("a subagent with its OWN signal does not inherit the parent's (unrelated) link", () => {
    seedSession("parent-2", { gitBranch: "feature/PROJ-1-work" });
    runTicketExtraction(store, store.findSession("parent-2")!, { allowlist: ["PROJ"] });

    seedSession("child-2", { gitBranch: "feature/PROJ-2-work", isSubagent: true, parentSessionId: "parent-2" });
    runTicketExtraction(store, store.findSession("child-2")!, { allowlist: ["PROJ"] });

    const childKeys = store.getTicketLinksForSession("child-2").map((l) => l.ticket_key);
    expect(childKeys).toEqual(["PROJ-2"]);
  });
});

// ─── Query path: store integration ──────────────────────────────────────────

describe("getTicketCostReport (query path)", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-ticket-qr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("over the synthetic corpus: coverage.attributedCost matches an independently-computed ground truth, and every ticket key is honestly graded", () => {
    const corpus = seedStore(store, { sessions: 20, seed: 11, ticketCoverage: 0.6 });
    const report = getTicketCostReport(store, {});

    // A6: `unattributed = totalCost - attributedCost; expect(attributedCost +
    // unattributed).toBeCloseTo(totalCost)` is an algebraic identity — it
    // reduces to "totalCost was echoed back unchanged" and never actually
    // checks `attributedCost`. Compute the expected attributed total
    // INDEPENDENTLY instead: sum, from the fixture's own `corpus.links` +
    // `corpus.messagesBySession` (never from `report` itself), the cost of
    // every session that has at least one linked ticket key — the same
    // primitive (`estimateCost`) the production code uses, but driven purely
    // from the fixture's ground truth.
    const linkedSessionIds = new Set(corpus.links.map((l) => l.sessionId));
    let expectedAttributed = 0;
    for (const sessionId of linkedSessionIds) {
      const messages = corpus.messagesBySession.get(sessionId) ?? [];
      for (const m of messages) {
        if (!m.model) continue;
        const priced = estimateCost(m.model, m.inputTokens, m.outputTokens, m.cacheReadTokens, m.cacheCreationTokens);
        if (priced.known) expectedAttributed += priced.cost;
      }
    }
    expect(report.coverage.attributedCost).toBeCloseTo(expectedAttributed, 6);
    expect(report.coverage.totalCost).toBeGreaterThan(0);

    // Every key the fixture recorded a link for shows up in the report
    // (unless its session happened to price at $0, which the seeded model mix
    // makes vanishingly unlikely — assert the set relationship instead of an
    // exact count to stay robust to that edge).
    const reportedKeys = new Set(report.tickets.map((t) => t.ticketKey));
    for (const link of corpus.links) {
      expect(reportedKeys.has(link.ticketKey)).toBe(true);
    }

    // Coverage ratio is a real fraction, not fabricated 100%.
    expect(report.coverage.ratio).not.toBeNull();
    expect(report.coverage.ratio!).toBeLessThan(1);
    expect(report.coverage.ratio!).toBeGreaterThan(0);
  });

  it("returns an honest empty report (never a fabricated number) when the store has no data", () => {
    const report = getTicketCostReport(store, {});
    expect(report.tickets).toHaveLength(0);
    expect(report.coverage.totalCost).toBe(0);
    expect(report.coverage.ratio).toBeNull();
  });

  it("scopes to the given project/period — a session outside the filter contributes to neither total nor coverage", () => {
    const corpus = seedStore(store, { sessions: 6, seed: 3 });
    // The fixture spreads sessions round-robin over PROJECTS, so /w/alpha owns
    // SOME but not ALL of them — guard that, or the assertions below could pass
    // vacuously on an empty or an unfiltered set.
    const alphaIds = new Set(corpus.sessions.filter((s) => s.projectPath === "/w/alpha").map((s) => s.sessionId));
    expect(alphaIds.size).toBeGreaterThan(0);
    expect(alphaIds.size).toBeLessThan(corpus.sessions.length);

    const all = getTicketCostReport(store, {});
    const scoped = getTicketCostReport(store, { projectPath: "/w/alpha" });

    // STRICTLY less, and strictly positive: `<=` alone is satisfied by a filter
    // that is silently ignored (scoped === all) and by one that matches nothing
    // (scoped === 0). Both are real bugs this test exists to catch.
    expect(scoped.coverage.totalCost).toBeGreaterThan(0);
    expect(scoped.coverage.totalCost).toBeLessThan(all.coverage.totalCost);

    // And every session the scoped report attributed must belong to /w/alpha.
    for (const row of scoped.tickets) {
      for (const sid of row.sessionIds) expect(alphaIds.has(sid)).toBe(true);
    }
  });

  // A5: `getActiveTicketLinks` had no ORDER BY, so equal-cost tickets resolved
  // in SQLite's unspecified scan order — a latent flake for any caller/test
  // indexing `tickets[0]`. Insert deliberately OUT of the expected order and
  // assert the store still returns them sorted: this only passes if an
  // explicit ORDER BY is doing the work, not by accident of insertion order.
  it("returns active ticket links in a deterministic total order, not insertion order (A5)", () => {
    store.upsertSession({
      sessionId: "s-a5",
      projectPath: "/w/a5",
      sourceFile: "/tmp/s-a5.jsonl",
      firstTimestamp: FIXED_NOW,
      lastTimestamp: FIXED_NOW + 1_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude-cli",
      gitBranch: null,
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
    });

    // Inserted in REVERSE key order on purpose.
    store.addTicketLink({ sessionId: "s-a5", ticketKey: "PROJ-9", source: "branch", confidence: "high" });
    store.addTicketLink({ sessionId: "s-a5", ticketKey: "PROJ-2", source: "branch", confidence: "high" });
    store.addTicketLink({ sessionId: "s-a5", ticketKey: "PROJ-5", source: "branch", confidence: "high" });

    const links = store.getActiveTicketLinks();
    const keys = links.filter((l) => l.session_id === "s-a5").map((l) => l.ticket_key);
    expect(keys).toEqual(["PROJ-2", "PROJ-5", "PROJ-9"]);
  });
});

// ─── CLI surface ─────────────────────────────────────────────────────────────

describe("printTicketReport (CLI --ticket)", () => {
  it("renders cost, sessions, and the coverage line through the shared formatters", () => {
    const dbPath = path.join(os.tmpdir(), `cs-ticket-cli-${Date.now()}.db`);
    const store = new Store(dbPath);
    try {
      seedStore(store, { sessions: 12, seed: 5, ticketCoverage: 0.8, projectKeys: ["PROJ"] });
      const report = getTicketCostReport(store, {});
      const someKey = report.tickets[0]?.ticketKey;
      expect(someKey).toBeDefined();

      let output = "";
      const fakeStream = { write: (chunk: string) => { output += chunk; return true; } } as unknown as NodeJS.WritableStream;
      printTicketReport(store, { ticket: someKey, period: "all" }, fakeStream);

      expect(output).toContain(someKey!);
      expect(output).toContain("Period coverage");
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    }
  });

  it("says so honestly when the ticket key has no attributed spend", () => {
    const dbPath = path.join(os.tmpdir(), `cs-ticket-cli-nf-${Date.now()}.db`);
    const store = new Store(dbPath);
    try {
      let output = "";
      const fakeStream = { write: (chunk: string) => { output += chunk; return true; } } as unknown as NodeJS.WritableStream;
      printTicketReport(store, { ticket: "NOPE-1", period: "all" }, fakeStream);
      expect(output).toContain("No attributed spend found");
    } finally {
      store.close();
      try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    }
  });
});

// ─── MCP surface ─────────────────────────────────────────────────────────────

describe("get_cost_per_ticket (MCP)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-stats-mcp-ticket-test-"));
  let store: Store;
  let client: Client;

  beforeAll(async () => {
    store = new Store(join(tmpDir, "test.db"));
    seedStore(store, { sessions: 16, seed: 9, ticketCoverage: 0.75, projectKeys: ["PROJ", "CORE"] });

    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function textOf(result: unknown): Record<string, unknown> {
    const content = (result as { content: unknown }).content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  }

  it("returns every ticket with cost, confidence, sources, and a coverage figure", async () => {
    const result = await client.callTool({ name: "get_cost_per_ticket", arguments: { period: "all" } });
    const data = textOf(result);
    expect(data).toHaveProperty("coverage");
    expect(data).toHaveProperty("tickets");
    const tickets = data["tickets"] as Array<Record<string, unknown>>;
    expect(tickets.length).toBeGreaterThan(0);
    for (const row of tickets) {
      expect(row).toHaveProperty("ticketKey");
      expect(row).toHaveProperty("cost");
      expect(row).toHaveProperty("confidence");
      expect(row).toHaveProperty("sources");
    }
    const coverage = data["coverage"] as Record<string, unknown>;
    expect(coverage).toHaveProperty("attributedCost");
    expect(coverage).toHaveProperty("unattributedCost");
    expect(coverage).toHaveProperty("ratio");
  });

  it("drills into one ticket's evidence when `ticket` is passed", async () => {
    const list = textOf(await client.callTool({ name: "get_cost_per_ticket", arguments: { period: "all" } }));
    const firstKey = (list["tickets"] as Array<{ ticketKey: string }>)[0]!.ticketKey;

    const result = await client.callTool({ name: "get_cost_per_ticket", arguments: { period: "all", ticket: firstKey } });
    const data = textOf(result);
    const ticket = data["ticket"] as Record<string, unknown>;
    expect(ticket["ticketKey"]).toBe(firstKey);
    const sessions = ticket["sessions"] as Array<{ sessionId: string; links: unknown[] }>;
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0]!.links.length).toBeGreaterThan(0);
  });

  it("reports honestly (an error, not a fabricated zero row) for an unknown ticket key", async () => {
    const result = await client.callTool({ name: "get_cost_per_ticket", arguments: { period: "all", ticket: "NOPE-999999" } });
    const data = textOf(result);
    expect(data).toHaveProperty("error");
  });

  // ── Lane K: the confidence tiers travel with their calibration state ──

  it("ships the calibration state beside the confidence tiers it qualifies", async () => {
    // The tiers in `coverage.byConfidence` are an ASSERTION about reliability.
    // Shipping them without the one field that has ever checked one — behind a
    // second tool call the caller may never make — is the uncalibrated-confidence
    // defect the practice contract names.
    const data = textOf(await client.callTool({ name: "get_cost_per_ticket", arguments: { period: "all" } }));
    const cal = data["calibration"] as Record<string, unknown>;
    expect(cal["subject"]).toBe("attribution");
    expect(cal["measures"]).toBe("agreement-on-reviewed-subset");
    // The synthetic corpus has no manual rulings, so there is nothing to
    // measure and no rate may appear.
    expect(cal["state"]).toBe("uncalibrated");
    expect(cal["rate"]).toBeNull();
    expect(cal["interval"]).toBeNull();
    expect(cal["minN"]).toBe(30);
    expect(cal["enablement"]).toBeTruthy();
  });

  it("keeps the calibration state on the single-ticket drill-down too", async () => {
    // The drill-down is where a reader asks "why do you claim PROJ-123 cost
    // this?" — the answer must carry the same qualification the table does, or
    // one click strips it.
    const list = textOf(await client.callTool({ name: "get_cost_per_ticket", arguments: { period: "all" } }));
    const firstKey = (list["tickets"] as Array<{ ticketKey: string }>)[0]!.ticketKey;
    const data = textOf(
      await client.callTool({ name: "get_cost_per_ticket", arguments: { period: "all", ticket: firstKey } }),
    );
    expect((data["calibration"] as Record<string, unknown>)["measures"]).toBe("agreement-on-reviewed-subset");
  });
});

describe("get_calibration (MCP)", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "claude-stats-mcp-calib-test-"));
  let store: Store;
  let client: Client;

  beforeAll(async () => {
    store = new Store(join(tmpDir, "test.db"));
    seedStore(store, { sessions: 8, seed: 11, ticketCoverage: 0.75, projectKeys: ["PROJ"] });

    const server = createMcpServer(store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function textOf(result: unknown): Record<string, unknown> {
    const content = (result as { content: unknown }).content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  }

  it("reports both calibratable subjects, each with its denominator", async () => {
    const data = textOf(await client.callTool({ name: "get_calibration", arguments: {} }));
    const subjects = data["subjects"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(subjects).sort()).toEqual(["attribution", "outcome"]);
    for (const [name, s] of Object.entries(subjects)) {
      expect(s["subject"], `${name} names itself`).toBe(name);
      expect(s["n"], `${name} carries its denominator`).toBeTypeOf("number");
      expect(s["minN"], `${name} carries its floor`).toBe(30);
      expect(s["measures"]).toBe("agreement-on-reviewed-subset");
    }
  });

  it("states no rate at all on a store nobody has corrected", async () => {
    const data = textOf(await client.callTool({ name: "get_calibration", arguments: {} }));
    const subjects = data["subjects"] as Record<string, Record<string, unknown>>;
    for (const [name, s] of Object.entries(subjects)) {
      expect(s["state"], `${name} is uncalibrated`).toBe("uncalibrated");
      expect(s["rate"], `${name} states no rate`).toBeNull();
      expect(s["interval"], `${name} states no interval`).toBeNull();
      expect(s["enablement"], `${name} says what would fix it`).toBeTruthy();
    }
  });

  it("keeps attribution's recall misses out of its precision denominator", async () => {
    const data = textOf(await client.callTool({ name: "get_calibration", arguments: {} }));
    const attribution = (data["subjects"] as Record<string, Record<string, unknown>>)["attribution"]!;
    expect(attribution).toHaveProperty("unproposed");
    expect(attribution["n"]).toBe((attribution["agreed"] as number) + (attribution["disagreed"] as number));
  });

  it("names the classifier as un-calibratable rather than omitting it", async () => {
    // Silence would read as "the classifier is fine". The honest answer is that
    // nothing on this machine records disagreement with it, so its confidence
    // cannot be checked here at all.
    const data = textOf(await client.callTool({ name: "get_calibration", arguments: {} }));
    const not = data["notCalibrated"] as Record<string, string>;
    expect(not["taskClass"]).toBeTruthy();
    expect(data["subjects"]).not.toHaveProperty("taskClass");
  });

  it("justifies the minimum sample rather than asserting it", async () => {
    const data = textOf(await client.callTool({ name: "get_calibration", arguments: {} }));
    expect(data["minimumSampleRationale"]).toContain("3/n");
  });
});

// ─── A1: tool descriptions must never promise a CLI surface that doesn't exist ─
//
// `get_cost_per_ticket`'s description told the calling model to run
// `claude-stats ticket <session> <KEY>` (manual link) and `--negate`
// (tombstone) — neither verb is registered by the CLI (Lane L / Phase 2
// work). An LLM reading the description has no way to know that; it would
// confidently hand the user a command that fails. This check is mechanical
// and general — it fails for ANY tool whose description references a
// `claude-stats <verb>` invocation the CLI doesn't actually register, so the
// class of drift (not just this one instance) is caught as lanes land.

describe("MCP tool descriptions never reference an unregistered CLI verb (A1)", () => {
  it("every `claude-stats <verb>` mentioned in a tool description names a real registered command", async () => {
    const { buildCli } = await import("../cli/index.js");
    const program = await buildCli();

    // Every registered command name, walked recursively so nested
    // subcommands (`recap precompute`, `tags rename`, …) count too — though
    // only the FIRST word after `claude-stats ` (the verb) is ever checked
    // below, since that's what `get_cost_per_ticket` got wrong.
    type CliCommand = Awaited<ReturnType<typeof buildCli>>;
    const registered = new Set<string>();
    const collectNames = (cmd: CliCommand): void => {
      for (const sub of cmd.commands as CliCommand[]) {
        registered.add(sub.name());
        collectNames(sub);
      }
    };
    collectNames(program);
    expect(registered.size).toBeGreaterThan(0); // sanity: the walk actually found commands

    const localTmpDir = mkdtempSync(join(tmpdir(), "claude-stats-mcp-drift-test-"));
    const localDbPath = join(localTmpDir, "test.db");
    const localStore = new Store(localDbPath);
    try {
      const server = createMcpServer(localStore);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const driftClient = new Client({ name: "drift-check-client", version: "1.0.0" });
      await driftClient.connect(clientTransport);

      const { tools } = await driftClient.listTools();
      expect(tools.length).toBeGreaterThan(0);

      // Scoped to backtick-fenced spans — this codebase's convention for a
      // literal command example (see `get_cost_per_ticket`'s own
      // `` `claude-stats report --ticket <KEY>` `` reference below) — so
      // prose that merely mentions the product name ("the running
      // claude-stats version") is never mistaken for an invocation.
      const verbPattern = /`claude-stats\s+([a-zA-Z][\w-]*)/g;
      const offenders: string[] = [];
      for (const tool of tools) {
        const description = tool.description ?? "";
        for (const match of description.matchAll(verbPattern)) {
          const verb = match[1]!;
          if (!registered.has(verb)) {
            offenders.push(`${tool.name}: references "claude-stats ${verb}" (${match[0]}…), which the CLI does not register`);
          }
        }
      }
      expect(offenders).toEqual([]);
    } finally {
      localStore.close();
      rmSync(localTmpDir, { recursive: true, force: true });
    }
  });
});

// ─── End-to-end: collect() wires extraction into the write path ────────────

describe("collect() end-to-end ticket extraction", () => {
  function tmpProjectsDir(): string {
    const dir = path.join(os.tmpdir(), `cs-ticket-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function sessionLine(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: "assistant",
      sessionId: "e2e-1",
      version: "2.1.70",
      timestamp: 1_700_000_000_000,
      uuid: `msg-${Math.random()}`,
      entrypoint: "claude",
      gitBranch: "feature/PROJ-42-fix-thing",
      permissionMode: "default",
      message: {
        model: "claude-sonnet-5",
        stop_reason: "end_turn",
        content: [],
        usage: { input_tokens: 500, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      ...overrides,
    });
  }

  function userLine(sessionId: string, text: string): string {
    return JSON.stringify({
      type: "user",
      sessionId,
      version: "2.1.70",
      timestamp: 1_699_999_000_000,
      uuid: `usr-${Math.random()}`,
      isMeta: false,
      message: { role: "user", content: [{ type: "text", text }] },
    });
  }

  let projectsDir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    projectsDir = tmpProjectsDir();
    dbPath = path.join(os.tmpdir(), `cs-ticket-e2e-db-${Date.now()}.db`);
    store = new Store(dbPath);
    const original = pathsMod.paths;
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({ ...original, projectsDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  it("extracts and persists a branch-sourced link during collect(), and the ticket report reflects it", async () => {
    const projDir = path.join(projectsDir, "-proj-e2e");
    fs.mkdirSync(projDir);
    fs.writeFileSync(
      path.join(projDir, "e2e-1.jsonl"),
      [userLine("e2e-1", "please fix the thing"), sessionLine()].join("\n") + "\n",
    );

    const result = await collect(store, { ticketAllowlist: ["PROJ"] });
    expect(result.sessionsUpserted).toBe(1);

    const links = store.getTicketLinksForSession("e2e-1");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ ticket_key: "PROJ-42", source: "branch", confidence: "high" });

    const report = getTicketCostReport(store, {});
    const row = report.tickets.find((t) => t.ticketKey === "PROJ-42");
    expect(row).toBeDefined();
    expect(row!.cost).toBeGreaterThan(0);
    expect(report.coverage.attributedCost).toBeCloseTo(row!.cost, 6);
  });

  it("re-running collect() on an unchanged file does not duplicate or corrupt the link (idempotent)", async () => {
    const projDir = path.join(projectsDir, "-proj-e2e2");
    fs.mkdirSync(projDir);
    fs.writeFileSync(
      path.join(projDir, "e2e-2.jsonl"),
      [userLine("e2e-2", "hi"), sessionLine({ sessionId: "e2e-2" })].join("\n") + "\n",
    );

    await collect(store, { ticketAllowlist: ["PROJ"] });
    await collect(store, { ticketAllowlist: ["PROJ"] }); // second run — file unchanged, checkpoint skips it

    const links = store.getTicketLinksForSession("e2e-2");
    expect(links).toHaveLength(1);
  });

  it("a manual tag link is never clobbered by a subsequent collect()", async () => {
    const projDir = path.join(projectsDir, "-proj-e2e3");
    fs.mkdirSync(projDir);
    fs.writeFileSync(
      path.join(projDir, "e2e-3.jsonl"),
      [userLine("e2e-3", "hi"), sessionLine({ sessionId: "e2e-3" })].join("\n") + "\n",
    );
    await collect(store, { ticketAllowlist: ["PROJ"] });

    store.addTicketLink({ sessionId: "e2e-3", ticketKey: "PROJ-42", source: "tag", confidence: "high", evidence: "confirmed by hand" });

    // Append another line to force a re-parse of this file on the next collect.
    fs.appendFileSync(path.join(projDir, "e2e-3.jsonl"), sessionLine({ sessionId: "e2e-3", uuid: "msg-extra" }) + "\n");
    await collect(store, { ticketAllowlist: ["PROJ"] });

    const manual = store.getTicketLinksForSession("e2e-3").find((l) => l.source === "tag")!;
    expect(manual.evidence).toBe("confirmed by hand");
  });
});

// ─── getCommitSubjectsInWindow: real git subprocess (rung 3 signal) ─────────

describe("getCommitSubjectsInWindow", () => {
  it("finds a commit subject within the window from a real repo, and feeds it through extraction end-to-end", async () => {
    const { getCommitSubjectsInWindow } = await import("../recap/git.js");
    const repoDir = mkdtempSync(join(tmpdir(), "claude-stats-ticket-git-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      writeFileSync(join(repoDir, "a.txt"), "hello");
      execFileSync("git", ["add", "a.txt"], { cwd: repoDir });
      execFileSync("git", ["commit", "-q", "-m", "PROJ-55: fix the widget"], { cwd: repoDir });

      const now = Date.now();
      const subjects = getCommitSubjectsInWindow(repoDir, now - 60_000, now + 60_000);
      expect(subjects).toContain("PROJ-55: fix the widget");

      const links = extractTicketLinks({
        sessionId: "s1",
        branches: [],
        commits: subjects.map((s) => ({ text: s })),
        prompts: [],
        allowlist: ["PROJ"],
      });
      expect(links).toEqual([
        { sessionId: "s1", ticketKey: "PROJ-55", source: "commit", confidence: "medium", granularity: "session", firstUuid: null, lastUuid: null, evidence: "PROJ-55: fix the widget" },
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("returns [] (never throws) for a path that isn't a git repo", async () => {
    const { getCommitSubjectsInWindow } = await import("../recap/git.js");
    expect(getCommitSubjectsInWindow("/tmp/definitely-not-a-repo-xyz", 0, Date.now())).toEqual([]);
  });
});
