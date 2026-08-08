/**
 * `applyTicketCorrection` — the dashboard/webview ticket card's
 * action→store-call mapping (`extension/panel.ts`), extracted out of
 * `DashboardPanel.correctTicketLink` specifically so this suite can drive it
 * against a real `Store` without constructing a full `DashboardPanel`
 * (which needs a live `vscode.window.createWebviewPanel`).
 *
 * L-3: this handler previously had NO test at all. Replacing the `negate`
 * branch with `addTicketLink({source:'tag'})` — i.e. making the dashboard's
 * Negate button silently CREATE an affirmative link instead of tombstoning
 * one — left the (nonexistent) suite green. These tests assert the
 * RESULTING row shape for each action, not just that some store method fired,
 * so swapping any two branches fails.
 *
 * Design: doc/analysis/ticket-attribution/02-local-data-model.md §2.6.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// `panel.ts` imports `vscode` at module scope; a minimal mock (unused by
// `applyTicketCorrection` itself) lets the module load under vitest, matching
// `extension.test.ts`'s established pattern for this file.
vi.mock("vscode", () => ({
  window: {
    createStatusBarItem: () => ({ show: vi.fn(), dispose: vi.fn(), text: "", command: "", tooltip: "" }),
    createWebviewPanel: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  workspace: { getConfiguration: () => ({ get: (_key: string, defaultVal: unknown) => defaultVal }) },
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Two: 2 },
}));

import { applyTicketCorrection } from "../extension/panel.js";
import { Store } from "../store/index.js";
import { FIXED_NOW } from "./fixtures/synthetic.js";

function seedSession(store: Store, sessionId: string): void {
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
  });
}

describe("applyTicketCorrection", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-ticket-panel-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    store = new Store(dbPath);
    seedSession(store, "sess-panel-1");
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("'link' creates an active manual link, not a tombstone", () => {
    applyTicketCorrection(store, "sess-panel-1", "PROJ-1", "link");
    const links = store.getTicketLinksForSession("sess-panel-1");
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual(
      expect.objectContaining({ ticket_key: "PROJ-1", source: "tag", negated: 0 }),
    );
    expect(store.getActiveTicketLinks().some((l) => l.ticket_key === "PROJ-1")).toBe(true);
  });

  it("'negate' tombstones the key — it must NOT create an active affirmative link", () => {
    applyTicketCorrection(store, "sess-panel-1", "PROJ-1", "negate");
    const links = store.getTicketLinksForSession("sess-panel-1");
    expect(links).toHaveLength(1);
    // The row must be a tombstone (negated = 1). A mutation that swaps this
    // branch for the 'link' action's `addTicketLink` call would produce
    // `negated: 0` here instead — the Negate button silently becoming a Link
    // button, exactly the regression this test exists to catch.
    expect(links[0]).toEqual(
      expect.objectContaining({ ticket_key: "PROJ-1", source: "tag", negated: 1 }),
    );
    expect(store.getActiveTicketLinks().some((l) => l.ticket_key === "PROJ-1")).toBe(false);
  });

  it("'remove' deletes a prior manual link entirely, leaving no row", () => {
    applyTicketCorrection(store, "sess-panel-1", "PROJ-1", "link");
    expect(store.getTicketLinksForSession("sess-panel-1")).toHaveLength(1);

    applyTicketCorrection(store, "sess-panel-1", "PROJ-1", "remove");
    // Distinct from 'negate': removal leaves NO row at all (not a tombstone).
    expect(store.getTicketLinksForSession("sess-panel-1")).toHaveLength(0);
  });

  it("'remove' does not delete a tombstone left by 'negate' for a DIFFERENT key", () => {
    applyTicketCorrection(store, "sess-panel-1", "PROJ-1", "negate");
    applyTicketCorrection(store, "sess-panel-1", "PROJ-2", "remove");
    const links = store.getTicketLinksForSession("sess-panel-1");
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual(expect.objectContaining({ ticket_key: "PROJ-1", negated: 1 }));
  });

  it("a malformed key throws (caller treats this as best-effort UI, but the store call itself must reject it)", () => {
    expect(() => applyTicketCorrection(store, "sess-panel-1", "not-a-key!!", "link")).toThrow();
    expect(store.getTicketLinksForSession("sess-panel-1")).toHaveLength(0);
  });
});
