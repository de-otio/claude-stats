/**
 * `repair request-records` — the one-time V28 backfill.
 *
 * The seed is a fixture corpus collected by the CURRENT parser (api-request
 * lines plus requestRef-bearing assistant messages), after which the V28
 * state is wiped to reproduce the pre-V28 store: `messages.request_ref`
 * NULLed and `api_requests` emptied. Everything the backfill must not touch
 * (every other column of `sessions` and `messages`, and the dollar total over
 * usage-carrier rows) is snapshotted before and compared after. Fixture names
 * are synthetic only.
 *
 * Nothing here reads the real home directory: every path `collect()` could
 * touch is redirected into a temp root.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import * as pathsMod from "@claude-stats/core/paths";
import { estimateCost } from "@claude-stats/core/pricing";
import { Store } from "../store/index.js";
import { collect } from "../aggregator/index.js";
import { REPAIR_DEDUPE_LOCK_KEY, RepairLockHeldError } from "../repair/dedupe.js";
import {
  REQUEST_RECORDS_ARMED_KEY,
  REQUEST_RECORDS_BACKFILL_KEY,
  REQUEST_RECORDS_BACKFILL_VALUE,
  repairRequestRecords,
} from "../repair/requestRecords.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const PROJECT = "/home/example/e1-proj";
const MAIN = "sess-e1-main";
const SUB = "agent-a1";
const MODEL = "claude-opus-4-6";
const REAL_HASH = "a".repeat(64);
const now = () => 1_700_100_000_000;

function tmpDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let tsCounter = 0;
function nextTs(): number {
  return 1_700_000_000_000 + tsCounter++ * 1_000;
}

function userLine(sessionId: string): string {
  return JSON.stringify({
    type: "user",
    sessionId,
    version: "2.1.301",
    cwd: PROJECT,
    timestamp: new Date(1_699_999_000_000).toISOString(),
    uuid: `usr-${sessionId}`,
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
}

function assistant(o: { sessionId: string; uuid: string; msgId: string; requestRef?: string; agentId?: string }): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: o.sessionId,
    version: "2.1.301",
    cwd: PROJECT,
    uuid: o.uuid,
    timestamp: new Date(nextTs()).toISOString(),
    ...(o.agentId ? { isSidechain: true, agentId: o.agentId, parentUuid: null } : {}),
    ...(o.requestRef !== undefined ? { requestRef: o.requestRef } : {}),
    message: {
      role: "assistant",
      model: MODEL,
      id: o.msgId,
      stop_reason: "end_turn",
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 10,
        output_tokens: 100,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 40_000,
      },
    },
  });
}

/** A realistic plain `api-request` line: fixed key order, `params` mid-line, tail after. */
function apiRequestLine(id: string, agentId = "agent-1"): string {
  return JSON.stringify({
    type: "api-request",
    sessionId: MAIN,
    agentId,
    id,
    timestamp: new Date(nextTs()).toISOString(),
    version: "2.1.301",
    querySource: "repl_main_thread",
    shapeHash: REAL_HASH,
    params: { model: MODEL },
    cacheControl: { ephemeral: { type: "ttl", ttl: "5m" } },
  });
}

interface Corpus {
  mainFile: string;
  subFile: string;
}

/** Write the first half of the corpus; {@link appendCorpus} writes the rest. */
function writeCorpus(projectsDir: string): Corpus {
  const projDir = path.join(projectsDir, "-home-example-e1-proj");
  const subDir = path.join(projDir, MAIN, "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  const mainFile = path.join(projDir, `${MAIN}.jsonl`);
  const subFile = path.join(subDir, `${SUB}.jsonl`);

  fs.writeFileSync(
    mainFile,
    [
      userLine(MAIN),
      apiRequestLine("req_1"),
      assistant({ sessionId: MAIN, uuid: "m-1", msgId: "msg_1", requestRef: "req_1" }),
      apiRequestLine("req_2"),
      assistant({ sessionId: MAIN, uuid: "m-2", msgId: "msg_2", requestRef: "req_2" }),
      "{this is not json",
      // No request line for this message: request_ref stays NULL.
      assistant({ sessionId: MAIN, uuid: "m-3", msgId: "msg_3" }),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    subFile,
    [
      apiRequestLine("req_3", "a1"),
      assistant({ sessionId: MAIN, uuid: "s1-1", msgId: "msg_S1", requestRef: "req_3", agentId: "a1" }),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(subDir, `${SUB}.meta.json`),
    JSON.stringify({ agentType: "my-reviewer", spawnDepth: 1, toolUseId: "toolu_01Reviewer" }),
  );
  return { mainFile, subFile };
}

/** The incremental-append half: one more request line, one more linked message, one more bad line. */
function appendCorpus(c: Corpus): void {
  fs.appendFileSync(
    c.mainFile,
    [
      apiRequestLine("req_4"),
      // Not last: a bad line at EOF reads as a partial write and is not
      // quarantined until a good line follows it.
      "{also not json",
      assistant({ sessionId: MAIN, uuid: "m-4", msgId: "msg_4", requestRef: "req_4" }),
    ].join("\n") + "\n",
  );
}

// Corpus totals: 4 plain api-request lines → 4 rows; 4 messages carry a
// requestRef; m-3 does not. Two bad lines → two quarantine rows.
const FILES = 2;
const REQUEST_LINES = 4;
const REQUEST_ROWS = 4;
const LINKED_MESSAGES = 4;

// ── snapshots ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function snapshot(dbPath: string): { sessions: Row[]; messages: Row[]; quarantine: Row[] } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const strip = (rows: unknown[], drop: string[]): Row[] =>
      (rows as Row[]).map((r) => {
        const c: Row = { ...r };
        for (const k of drop) delete c[k];
        return c;
      });
    return {
      sessions: strip(db.prepare("SELECT * FROM sessions ORDER BY session_id").all(), [
        "request_ref", // no such column on sessions; defensive
        "updated_at",
        // Not money: re-derived over the WHOLE file by a byte-0 parse, where an
        // incremental history only saw each appended slice. Asserted separately.
        "active_duration_ms",
      ]),
      messages: strip(db.prepare("SELECT * FROM messages ORDER BY uuid").all(), ["request_ref", "updated_at"]),
      quarantine: strip(db.prepare("SELECT file_path, line_number, raw_line, error FROM quarantine ORDER BY id").all(), []),
    };
  } finally {
    db.close();
  }
}

/** Everything a dry run / a no-op second run must leave alone, as one comparable value. */
function wholeDb(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const out: Record<string, unknown> = {};
    for (const t of ["sessions", "messages", "collection_state", "metadata", "quarantine"]) {
      out[t] = db.prepare(`SELECT * FROM ${t}`).all();
    }
    return JSON.stringify(out);
  } finally {
    db.close();
  }
}

function carrierCost(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT model, input_tokens AS i, output_tokens AS o, cache_read_tokens AS cr, cache_creation_tokens AS cc FROM messages WHERE usage_counted = 1 ORDER BY uuid",
      )
      .all() as Array<{ model: string; i: number; o: number; cr: number; cc: number }>;
    return rows.reduce((sum, r) => sum + estimateCost(r.model, r.i, r.o, r.cr, r.cc).cost, 0);
  } finally {
    db.close();
  }
}

/** Reproduce the pre-V28 store: no request links, no request rows. */
function wipeV28State(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("UPDATE messages SET request_ref = NULL");
    db.exec("DELETE FROM api_requests");
  } finally {
    db.close();
  }
}

function count(dbPath: string, sql: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

// ── the suite ────────────────────────────────────────────────────────────────

describe("repairRequestRecords", () => {
  let root: string;
  let projectsDir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(async () => {
    tsCounter = 0;
    root = tmpDir("cs-e1-repair");
    projectsDir = path.join(root, "projects");
    fs.mkdirSync(projectsDir);
    dbPath = path.join(root, "db", "stats.db");
    store = new Store(dbPath);

    // Redirect EVERYTHING `collect()` can read: scanner, account file, telemetry.
    const original = pathsMod.paths;
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({
      ...original,
      claudeDir: root,
      projectsDir,
      historyFile: path.join(root, "history.jsonl"),
      changelogFile: path.join(root, "cache", "changelog.md"),
      sessionsDir: path.join(root, "sessions"),
      claudeConfigFile: path.join(root, "claude.json"),
    });

    // Build the pre-V28 state the way history produced it: an initial collect,
    // an incremental-append collect, then the V28 state wiped.
    const corpus = writeCorpus(projectsDir);
    await collect(store, {}, now);
    appendCorpus(corpus);
    await collect(store, {}, now);
    wipeV28State(dbPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("the seed is the pre-V28 state: links NULL, no request rows, messages and cost present", () => {
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM messages WHERE request_ref IS NOT NULL")).toBe(0);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM api_requests")).toBe(0);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM sessions")).toBe(2);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM messages")).toBe(5);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM quarantine")).toBe(2);
    expect(carrierCost(dbPath)).toBeGreaterThan(0);
    expect(store.getMeta(REQUEST_RECORDS_BACKFILL_KEY)).toBeNull();
  });

  it("COST-NEUTRAL: every pre-existing column is byte-identical, the carrier cost sum is unchanged, the V28 state fills", async () => {
    const before = snapshot(dbPath);
    const costBefore = carrierCost(dbPath);
    const durationsBefore = new Map(
      store.getSessions({ includeCI: true, includeSubagents: true, includeDeleted: true }).map((s) => [s.session_id, s.active_duration_ms ?? 0]),
    );

    const summary = await repairRequestRecords(store, {}, now);

    expect(summary.alreadyDone).toBe(false);
    expect(summary.files).toBe(FILES);
    expect(summary.requestLines).toBe(REQUEST_LINES);
    expect(summary.requestsStored).toBe(REQUEST_ROWS);
    expect(summary.backupPath).not.toBeNull();
    expect(summary.parseErrors).toBeGreaterThan(0);

    const after = snapshot(dbPath);
    expect(JSON.stringify(after.sessions)).toBe(JSON.stringify(before.sessions));
    expect(JSON.stringify(after.messages)).toBe(JSON.stringify(before.messages));
    expect(after.quarantine).toEqual(before.quarantine);
    // The one pre-existing column a byte-0 parse legitimately re-derives
    // (see the V25 repair test): never lower.
    const durations = (rows: Array<{ session_id: string; active_duration_ms: number | null }>) =>
      new Map(rows.map((r) => [r.session_id, r.active_duration_ms ?? 0]));
    const dAfter = durations(store.getSessions({ includeCI: true, includeSubagents: true, includeDeleted: true }));
    for (const [id, was] of durationsBefore) expect(dAfter.get(id)!).toBeGreaterThanOrEqual(was);
    // Cost: exactly equal, not "close".
    expect(carrierCost(dbPath)).toBe(costBefore);

    // The V28 state, filled as the fixture dictates.
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM api_requests")).toBe(REQUEST_ROWS);
    const rows = (new DatabaseSync(dbPath, { readOnly: true }).prepare("SELECT request_id FROM api_requests ORDER BY request_id").all() as Array<{ request_id: string }>);
    expect(rows.map((r) => r.request_id)).toEqual(["req_1", "req_2", "req_3", "req_4"]);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM messages WHERE request_ref IS NOT NULL")).toBe(LINKED_MESSAGES);
    // m-3 had no request line: stays NULL.
    const linked = store.getSessionMessages(MAIN).filter((m) => m.request_ref != null).map((m) => m.uuid).sort();
    expect(linked).toEqual(["m-1", "m-2", "m-4"]);
    expect(store.getSessionMessages(SUB).filter((m) => m.request_ref != null).map((m) => m.uuid)).toEqual(["s1-1"]);

    // The request rows carry the store's own session id of the file parsed.
    const subReq = (new DatabaseSync(dbPath, { readOnly: true }).prepare("SELECT session_id FROM api_requests WHERE request_id = 'req_3'").get() as { session_id: string });
    expect(subReq.session_id).toBe(SUB);

    // Complete pass: gate set, armed marker cleared, lock released.
    expect(store.getMeta(REQUEST_RECORDS_BACKFILL_KEY)).toBe(REQUEST_RECORDS_BACKFILL_VALUE);
    expect(store.getMeta(REQUEST_RECORDS_ARMED_KEY)).toBeFalsy();
    expect(store.getMeta(REPAIR_DEDUPE_LOCK_KEY)).toBeFalsy();
  });

  it("is idempotent: a second run is a no-op once the key is set", async () => {
    await repairRequestRecords(store, {}, now);
    const settled = wholeDb(dbPath);
    const backups = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes("pre-repair"));
    expect(backups.length).toBe(1);

    const again = await repairRequestRecords(store, {}, now);
    expect(again.alreadyDone).toBe(true);
    expect(again.files).toBe(0);
    expect(again.backupPath).toBeNull();
    expect(wholeDb(dbPath)).toBe(settled);
    expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes("pre-repair"))).toEqual(backups);
  });

  it("--force re-runs the pass; the pass itself is idempotent so the data is unchanged", async () => {
    await repairRequestRecords(store, {}, now);
    const settled = snapshot(dbPath);
    const costBefore = carrierCost(dbPath);

    // A ticking clock: the forced pass makes its own backup, named by the clock.
    let t = now();
    const tick = () => t++;
    const forced = await repairRequestRecords(store, { force: true }, tick);
    expect(forced.alreadyDone).toBe(false);
    expect(forced.files).toBe(FILES);
    expect(forced.requestsStored).toBe(0); // every row already present: first-writer-wins
    expect(forced.backupPath).not.toBeNull();

    // The re-parse upserts in place: same rows, same links, same quarantine,
    // same cost — only the backup file is new.
    const after = snapshot(dbPath);
    expect(JSON.stringify(after.sessions)).toBe(JSON.stringify(settled.sessions));
    expect(JSON.stringify(after.messages)).toBe(JSON.stringify(settled.messages));
    expect(after.quarantine).toEqual(settled.quarantine);
    expect(carrierCost(dbPath)).toBe(costBefore);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM api_requests")).toBe(REQUEST_ROWS);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM messages WHERE request_ref IS NOT NULL")).toBe(LINKED_MESSAGES);
    expect(store.getMeta(REQUEST_RECORDS_BACKFILL_KEY)).toBe(REQUEST_RECORDS_BACKFILL_VALUE);
    expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes("pre-repair")).length).toBe(2);
  });

  it("dry run reports counts and writes nothing: no rows, no key, no backup, no lock", async () => {
    const dbBefore = wholeDb(dbPath);
    const summary = await repairRequestRecords(store, { dryRun: true }, now);

    expect(summary.dryRun).toBe(true);
    expect(summary.alreadyDone).toBe(false);
    expect(summary.files).toBe(FILES);
    expect(summary.requestLines).toBe(REQUEST_LINES);
    expect(summary.requestsStored).toBe(0);
    expect(summary.backupPath).toBeNull();
    // Counts and key names only: the summary has no field that can carry a
    // request id, a session id or a path.
    expect(JSON.stringify(summary)).not.toMatch(/req_\d|sess-e1|agent-a1|home\/example|\.jsonl/);

    expect(wholeDb(dbPath)).toBe(dbBefore);
    expect(store.getMeta(REQUEST_RECORDS_BACKFILL_KEY)).toBeNull();
    expect(store.getMeta(REQUEST_RECORDS_ARMED_KEY)).toBeNull();
    expect(store.getMeta(REPAIR_DEDUPE_LOCK_KEY)).toBeNull();
    expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes("pre-repair"))).toHaveLength(0);
  });

  it("refuses cleanly when another process holds the lock, and changes nothing", async () => {
    // The parent of this test process: alive, and not us.
    store.setMeta(REPAIR_DEDUPE_LOCK_KEY, JSON.stringify({ pid: process.ppid, startedAt: now() }));
    const dbBefore = wholeDb(dbPath);

    await expect(repairRequestRecords(store, {}, now)).rejects.toBeInstanceOf(RepairLockHeldError);

    expect(wholeDb(dbPath)).toBe(dbBefore);
    expect(store.getMeta(REQUEST_RECORDS_BACKFILL_KEY)).toBeNull();
    expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes("pre-repair"))).toHaveLength(0);
    // The other holder's lock is not ours to clear.
    expect(JSON.parse(store.getMeta(REPAIR_DEDUPE_LOCK_KEY)!).pid).toBe(process.ppid);
  });

  it("an interrupted pass leaves the key unset; a rerun completes cost-neutrally", async () => {
    const before = snapshot(dbPath);
    const costBefore = carrierCost(dbPath);

    const original = store.upsertMessages.bind(store);
    let calls = 0;
    const spy = vi.spyOn(store, "upsertMessages").mockImplementation((rows) => {
      if (++calls === 2) throw new Error("simulated crash mid-pass");
      return original(rows);
    });

    // A ticking clock: each pass makes its own backup, named by the clock.
    let t = now();
    const tick = () => t++;
    await expect(repairRequestRecords(store, {}, tick)).rejects.toThrow("simulated crash mid-pass");
    expect(store.getMeta(REQUEST_RECORDS_BACKFILL_KEY)).toBeNull();
    expect(store.getMeta(REQUEST_RECORDS_ARMED_KEY)).toBe("1");
    expect(store.getMeta(REPAIR_DEDUPE_LOCK_KEY)).toBeFalsy();
    // The file that did finish is committed; the one that threw rolled back whole.
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM messages")).toBe(before.messages.length);

    spy.mockRestore();
    const summary = await repairRequestRecords(store, {}, tick);

    expect(summary.alreadyDone).toBe(false);
    expect(store.getMeta(REQUEST_RECORDS_BACKFILL_KEY)).toBe(REQUEST_RECORDS_BACKFILL_VALUE);
    expect(store.getMeta(REQUEST_RECORDS_ARMED_KEY)).toBeFalsy();
    const after = snapshot(dbPath);
    expect(JSON.stringify(after.sessions)).toBe(JSON.stringify(before.sessions));
    expect(JSON.stringify(after.messages)).toBe(JSON.stringify(before.messages));
    expect(after.quarantine).toEqual(before.quarantine);
    expect(carrierCost(dbPath)).toBe(costBefore);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM api_requests")).toBe(REQUEST_ROWS);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM messages WHERE request_ref IS NOT NULL")).toBe(LINKED_MESSAGES);
  });

  it("the pre-repair backup is created owner-only (0600) and holds the pre-repair data", async () => {
    const summary = await repairRequestRecords(store, {}, now);
    expect(summary.backupPath).not.toBeNull();
    expect(fs.statSync(summary.backupPath!).mode & 0o777).toBe(0o600);

    const backup = new DatabaseSync(summary.backupPath!, { readOnly: true });
    try {
      const reqs = (backup.prepare("SELECT COUNT(*) AS n FROM api_requests").get() as { n: number }).n;
      const links = (backup.prepare("SELECT COUNT(*) AS n FROM messages WHERE request_ref IS NOT NULL").get() as { n: number }).n;
      expect(reqs).toBe(0);
      expect(links).toBe(0);
    } finally {
      backup.close();
    }
  });
});
