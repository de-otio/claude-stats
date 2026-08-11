/**
 * Bulk re-extraction of ticket links (`repair ticket-links`).
 *
 * Extraction only ever ADDS rows, so before this repair the project-key
 * allowlist was applied once — at the moment a session was first collected — and
 * never revisited. The first suite is that defect stated as a test: configure an
 * allowlist AFTER the fact, re-extract, and the look-alike key is gone while the
 * real one is upgraded.
 *
 * The rest guards the property that makes a destructive repair acceptable:
 * automatic links are derived and may be rebuilt, manual links are testimony and
 * must survive untouched. A regression there is silent — the summary would still
 * print, the numbers would still look plausible, and a user's corrections would
 * simply be gone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Store } from "../store/index.js";
import type { SessionRecord } from "@claude-stats/core/types";
import { runTicketExtraction } from "../ticketing/index.js";
import { reextractTicketLinks } from "../repair/ticket-links.js";

const FIXED_NOW = 1_700_000_000_000;

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `cs-reextract-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const clock = (): number => 1_700_000_500_000;

function makeSession(over: Partial<SessionRecord> & { sessionId: string }): SessionRecord {
  return {
    // A path that is not a git repo: the commit rung then reads nothing and
    // spawns nothing, keeping these tests to the branch and prompt rungs (the
    // commit rung has its own coverage in ticket-attribution.test.ts).
    projectPath: path.join(os.tmpdir(), "cs-reextract-not-a-repo"),
    sourceFile: "/nonexistent.jsonl",
    firstTimestamp: FIXED_NOW,
    lastTimestamp: FIXED_NOW + 1000,
    claudeVersion: "2.1.186",
    entrypoint: "cli",
    gitBranch: null,
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
    ...over,
  };
}

describe("repair ticket-links", () => {
  let store: Store;
  let dbPath: string;

  /** A session with a branch key and a prompt mentioning a second, look-alike
   *  key — the shape that produces junk rows without an allowlist. */
  function seed(sessionId: string, branch: string | null, promptText?: string): void {
    store.upsertSession(makeSession({ sessionId, gitBranch: branch }));
    if (promptText !== undefined) {
      store.upsertMessages([
        {
          uuid: `${sessionId}-m0`,
          sessionId,
          timestamp: FIXED_NOW,
          claudeVersion: "2.1.186",
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
          promptText,
        },
      ]);
    }
  }

  function keysNow(): string[] {
    return store.getTicketKeys().map((k) => k.ticket_key).sort();
  }

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    const dir = path.dirname(dbPath);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(path.basename(dbPath))) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ok */ }
      }
    }
  });

  // ─── The defect ────────────────────────────────────────────────────────────

  it("applies an allowlist configured AFTER the sessions were collected", () => {
    // Collected with no allowlist: the branch key caps at medium, and a
    // key-shaped string in the prompt ("WP-1") is attributed as its own ticket.
    seed("s1", "feature/PROJ-42-retry", "same as WP-1 in the other repo?");
    runTicketExtraction(store, store.findSession("s1")!, {});
    expect(keysNow()).toEqual(["PROJ-42", "WP-1"]);
    expect(store.getTicketLinksForSession("s1").find((l) => l.source === "branch")!.confidence).toBe("medium");

    const summary = reextractTicketLinks(store, { dryRun: false, allowlist: ["PROJ"] }, clock);

    // The junk key is gone and the real one is now high-confidence — neither of
    // which any amount of re-running `collect` would have achieved.
    expect(keysNow()).toEqual(["PROJ-42"]);
    expect(store.getTicketLinksForSession("s1").find((l) => l.source === "branch")!.confidence).toBe("high");
    expect(summary.keysBefore).toBe(2);
    expect(summary.keysAfter).toBe(1);
    expect(summary.sessionsScanned).toBe(1);
    expect(summary.removed).toBe(2);
    expect(summary.created).toBe(1);
  });

  it("re-derives links for sessions whose source file is gone", () => {
    // Their messages — and so their cost, and so their share of the coverage
    // denominator — are still in the store. Scanning a narrower set than the
    // delete would drop attribution silently, which reads as a coverage
    // regression with no error anywhere.
    seed("s-deleted", "feature/PROJ-7-thing");
    store.upsertSession(makeSession({ sessionId: "s-deleted", gitBranch: "feature/PROJ-7-thing", sourceDeleted: true }));

    reextractTicketLinks(store, { dryRun: false, allowlist: ["PROJ"] }, clock);

    expect(keysNow()).toEqual(["PROJ-7"]);
  });

  // ─── Manual links are testimony ────────────────────────────────────────────

  it("keeps manual assignments and negations, and reports how many it kept", () => {
    seed("s1", "feature/PROJ-42-retry");
    seed("s2", "feature/PROJ-9-other");
    runTicketExtraction(store, store.findSession("s1")!, { allowlist: ["PROJ"] });
    runTicketExtraction(store, store.findSession("s2")!, { allowlist: ["PROJ"] });

    // Two statements nothing in the session data can reproduce: an assignment
    // to a key that appears nowhere in the evidence, and a tombstone on a key
    // the branch name will keep on producing.
    store.addTicketLink({ sessionId: "s1", ticketKey: "OPS-5", source: "tag", confidence: "high", evidence: "manual" });
    store.negateTicketLink("s2", "PROJ-9");

    const summary = reextractTicketLinks(store, { dryRun: false, allowlist: ["PROJ"] }, clock);

    // The manual assignment survives verbatim…
    const manual = store.getTicketLinksForSession("s1").find((l) => l.source === "tag");
    expect(manual).toMatchObject({ ticket_key: "OPS-5", confidence: "high", evidence: "manual", negated: 0 });
    // …the tombstone still suppresses the key the branch name re-produced…
    expect(keysNow()).toEqual(["OPS-5", "PROJ-42"]);
    expect(store.getTicketLinksForSession("s2").some((l) => l.ticket_key === "PROJ-9" && l.negated === 1)).toBe(true);
    // …and the summary states it rather than asking to be trusted.
    expect(summary.manualPreserved).toBe(2);
  });

  it("deletes automatic rows only, and says how many it deleted", () => {
    seed("s1", "feature/PROJ-42-retry");
    runTicketExtraction(store, store.findSession("s1")!, { allowlist: ["PROJ"] });
    store.addTicketLink({ sessionId: "s1", ticketKey: "OPS-5", source: "tag", confidence: "high" });

    const before = store.getTicketLinkCounts();
    expect(before).toEqual({ automatic: 1, manual: 1 });

    const removed = store.deleteAutomaticTicketLinks();

    expect(removed).toBe(1);
    expect(store.getTicketLinkCounts()).toEqual({ automatic: 0, manual: 1 });
  });

  // ─── Dry run ───────────────────────────────────────────────────────────────

  it("dry run reports the real numbers and writes nothing", () => {
    seed("s1", "feature/PROJ-42-retry", "same as WP-1?");
    runTicketExtraction(store, store.findSession("s1")!, {});
    const linksBefore = store.getTicketLinksForSession("s1");

    const preview = reextractTicketLinks(store, { dryRun: true, allowlist: ["PROJ"] }, clock);

    expect(preview.dryRun).toBe(true);
    expect(preview.backupPath).toBeNull();
    // Rolled back: every row is exactly as it was, junk key included.
    expect(store.getTicketLinksForSession("s1")).toEqual(linksBefore);
    expect(keysNow()).toEqual(["PROJ-42", "WP-1"]);

    // …and the preview's numbers are the run's numbers, because it IS the run.
    const real = reextractTicketLinks(store, { dryRun: false, allowlist: ["PROJ"] }, clock);
    expect({ ...preview, dryRun: false, backupPath: real.backupPath }).toEqual(real);
  });

  it("backs the database up before a real run, and not before a dry run", () => {
    seed("s1", "feature/PROJ-42-retry");

    expect(reextractTicketLinks(store, { dryRun: true, allowlist: ["PROJ"], dbPath }, clock).backupPath).toBeNull();

    const summary = reextractTicketLinks(store, { dryRun: false, allowlist: ["PROJ"], dbPath }, clock);
    expect(summary.backupPath).toBe(`${dbPath}.pre-repair-ticket-links-1700000500000`);
    expect(fs.existsSync(summary.backupPath!)).toBe(true);
  });

  // ─── Ordering ──────────────────────────────────────────────────────────────

  it("processes parents before subagents, so inheritance actually happens", () => {
    // The child is inserted FIRST — under `collect`'s arbitrary file order this
    // is the case where inheritance silently no-ops (documented as a known
    // limitation on runTicketExtraction). A bulk pass chooses the order, so
    // here it must not.
    store.upsertSession(makeSession({ sessionId: "child-1", isSubagent: true, parentSessionId: "parent-1" }));
    store.upsertSession(makeSession({ sessionId: "parent-1", gitBranch: "feature/PROJ-42-retry" }));

    reextractTicketLinks(store, { dryRun: false, allowlist: ["PROJ"] }, clock);

    expect(store.getTicketLinksForSession("child-1").map((l) => l.ticket_key)).toEqual(["PROJ-42"]);
  });

  // ─── Empty allowlist ───────────────────────────────────────────────────────

  it("treats an absent allowlist as a mode, not a reason to skip", () => {
    // Clearing the allowlist and re-extracting is a legitimate move: extraction
    // still runs, matching every key-shaped string, capped at medium. A repair
    // that no-opped here would leave the store in the previous allowlist's
    // shape while the config said otherwise.
    seed("s1", "feature/PROJ-42-retry", "same as WP-1?");
    runTicketExtraction(store, store.findSession("s1")!, { allowlist: ["PROJ"] });
    expect(keysNow()).toEqual(["PROJ-42"]);

    reextractTicketLinks(store, { dryRun: false }, clock);

    expect(keysNow()).toEqual(["PROJ-42", "WP-1"]);
    expect(store.getTicketLinksForSession("s1").find((l) => l.source === "branch")!.confidence).toBe("medium");
  });
});
