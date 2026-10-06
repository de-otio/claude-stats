/**
 * `repair agent-attribution` — the one-time V25 backfill.
 *
 * The seed is a fixture corpus collected by the CURRENT parser, after which the
 * four V25 columns are NULLed to reproduce the pre-V25 state. Everything the
 * backfill must not touch (every other column of `sessions` and `messages`,
 * and the dollar total over usage-carrier rows) is snapshotted before and
 * compared after. Fixture names are synthetic only.
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
import { backupDatabase } from "../repair/backup.js";
import { REPAIR_DEDUPE_LOCK_KEY, RepairLockHeldError } from "../repair/dedupe.js";
import {
  AGENT_ATTRIBUTION_ARMED_KEY,
  AGENT_ATTRIBUTION_BACKFILL_KEY,
  AGENT_ATTRIBUTION_BACKFILL_VALUE,
  repairAgentAttribution,
} from "../repair/agentAttribution.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const PROJECT = "/home/example/attr-proj";
const MAIN = "sess-attr-main";
const MODEL = "claude-opus-4-6";
const now = () => 1_700_100_000_000;

function tmpDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let tsCounter = 0;
function assistant(o: {
  sessionId: string;
  uuid: string;
  msgId: string;
  out: number;
  skill?: string;
  agentId?: string;
  content?: unknown[];
}): string {
  const ts = 1_700_000_000_000 + tsCounter++ * 1_000;
  return JSON.stringify({
    type: "assistant",
    sessionId: o.sessionId,
    version: "2.1.72",
    cwd: PROJECT,
    uuid: o.uuid,
    timestamp: new Date(ts).toISOString(),
    ...(o.agentId ? { isSidechain: true, agentId: o.agentId, parentUuid: null } : {}),
    ...(o.skill ? { attributionSkill: o.skill } : {}),
    message: {
      role: "assistant",
      model: MODEL,
      id: o.msgId,
      stop_reason: "end_turn",
      content: o.content ?? [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 10,
        output_tokens: o.out,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 40_000,
      },
    },
  });
}

function userLine(sessionId: string): string {
  return JSON.stringify({
    type: "user",
    sessionId,
    version: "2.1.72",
    cwd: PROJECT,
    timestamp: new Date(1_699_999_000_000).toISOString(),
    uuid: `usr-${sessionId}`,
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  });
}

interface Corpus {
  mainFile: string;
  subFiles: string[];
}

/** Write the first half of the corpus; {@link appendCorpus} writes the rest. */
function writeCorpus(projectsDir: string): Corpus {
  const projDir = path.join(projectsDir, "-home-example-attr-proj");
  const subDir = path.join(projDir, MAIN, "subagents");
  fs.mkdirSync(subDir, { recursive: true });
  const mainFile = path.join(projDir, `${MAIN}.jsonl`);
  const a1 = path.join(subDir, "agent-a1.jsonl");
  const a2 = path.join(subDir, "agent-a2.jsonl");

  fs.writeFileSync(
    mainFile,
    [
      userLine(MAIN),
      // One response, three entries (multi-entry message.id group); skill on two of them.
      assistant({ sessionId: MAIN, uuid: "m-a1", msgId: "msg_A", out: 300, content: [{ type: "thinking", thinking: "…" }] }),
      assistant({ sessionId: MAIN, uuid: "m-a2", msgId: "msg_A", out: 300, skill: "example-skill", content: [{ type: "text", text: "x" }] }),
      assistant({
        sessionId: MAIN,
        uuid: "m-a3",
        msgId: "msg_A",
        out: 300,
        skill: "example-skill",
        content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: `${PROJECT}/f.ts` } }],
      }),
      "{this is not json",
      assistant({ sessionId: MAIN, uuid: "m-b1", msgId: "msg_B", out: 120 }),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    a1,
    [
      assistant({ sessionId: MAIN, uuid: "s1-1", msgId: "msg_S1A", out: 50, agentId: "a1", skill: "example-skill" }),
      assistant({ sessionId: MAIN, uuid: "s1-2", msgId: "msg_S1B", out: 60, agentId: "a1" }),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(subDir, "agent-a1.meta.json"),
    JSON.stringify({ agentType: "my-reviewer", spawnDepth: 1, toolUseId: "toolu_01Reviewer", description: "ignored free text" }),
  );
  fs.writeFileSync(a2, [assistant({ sessionId: MAIN, uuid: "s2-1", msgId: "msg_S2A", out: 70, agentId: "a2" })].join("\n") + "\n");
  fs.writeFileSync(
    path.join(subDir, "agent-a2.meta.json"),
    JSON.stringify({ agentType: "acme-critic", spawnDepth: 2, toolUseId: "toolu_02Critic" }),
  );
  return { mainFile, subFiles: [a1, a2] };
}

/** The incremental-append half: a replayed uuid, a second bad line, more responses. */
function appendCorpus(c: Corpus): void {
  const replay = assistant({ sessionId: MAIN, uuid: "m-a1", msgId: "msg_A", out: 300, content: [{ type: "thinking", thinking: "…" }] });
  fs.appendFileSync(
    c.mainFile,
    [
      replay,
      "{also not json",
      assistant({ sessionId: MAIN, uuid: "m-c1", msgId: "msg_C", out: 200, skill: "example-skill" }),
      assistant({ sessionId: MAIN, uuid: "m-c2", msgId: "msg_C", out: 200 }),
    ].join("\n") + "\n",
  );
  fs.appendFileSync(
    c.subFiles[1]!,
    assistant({ sessionId: MAIN, uuid: "s2-2", msgId: "msg_S2B", out: 80, agentId: "a2", skill: "example-skill" }) + "\n",
  );
}

// Messages carrying a skill in the corpus: m-a2, m-a3, m-c1, s1-1, s2-2.
const SKILL_ROWS = 5;
const SUBAGENT_SESSIONS = 2;
const FILES = 3;

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
        "agent_type",
        "spawn_depth",
        "spawn_tool_use_id",
        "updated_at",
        // Not money: re-derived over the WHOLE file by a byte-0 parse, where an
        // incremental history only saw each appended slice. Asserted separately.
        "active_duration_ms",
      ]),
      messages: strip(db.prepare("SELECT * FROM messages ORDER BY uuid").all(), ["skill", "updated_at"]),
      quarantine: strip(db.prepare("SELECT file_path, line_number, raw_line, error FROM quarantine ORDER BY id").all(), []),
    };
  } finally {
    db.close();
  }
}

/** Everything a dry run must leave alone, as one comparable value. */
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

function nullV25Columns(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("UPDATE sessions SET agent_type = NULL, spawn_depth = NULL, spawn_tool_use_id = NULL");
    db.exec("UPDATE messages SET skill = NULL");
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

describe("repairAgentAttribution", () => {
  let root: string;
  let projectsDir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(async () => {
    tsCounter = 0;
    root = tmpDir("cs-attr");
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

    // Build the pre-V25 state the way history produced it: an initial collect,
    // an incremental-append collect, then the V25 columns wiped.
    const corpus = writeCorpus(projectsDir);
    await collect(store, {}, now);
    appendCorpus(corpus);
    await collect(store, {}, now);
    nullV25Columns(dbPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("the seed is the pre-V25 state: columns NULL, rows and cost present, quarantine written", () => {
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM sessions WHERE agent_type IS NOT NULL OR spawn_depth IS NOT NULL OR spawn_tool_use_id IS NOT NULL")).toBe(0);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM messages WHERE skill IS NOT NULL")).toBe(0);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM sessions")).toBe(1 + SUBAGENT_SESSIONS);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM quarantine")).toBe(2);
    // A pre-existing multi-entry group with a replayed uuid: one carrier per message.id.
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM messages WHERE usage_counted = 1 AND session_id = 'sess-attr-main'")).toBe(3);
    expect(carrierCost(dbPath)).toBeGreaterThan(0);
    expect(store.getMeta(AGENT_ATTRIBUTION_BACKFILL_KEY)).toBeNull();
  });

  it("COST-NEUTRAL: every pre-existing column is byte-identical, the carrier cost sum is unchanged, the V25 columns fill", async () => {
    const before = snapshot(dbPath);
    const costBefore = carrierCost(dbPath);
    const durationsBefore = new Map(
      store.getSessions({ includeCI: true, includeSubagents: true, includeDeleted: true }).map((s) => [s.session_id, s.active_duration_ms ?? 0]),
    );

    const summary = await repairAgentAttribution(store, {}, now);

    expect(summary.alreadyDone).toBe(false);
    expect(summary.files).toBe(FILES);
    expect(summary.sessionsGainingAgentType).toBe(SUBAGENT_SESSIONS);
    expect(summary.messagesGainingSkill).toBe(SKILL_ROWS);
    expect(summary.parseErrors).toBeGreaterThan(0);

    const after = snapshot(dbPath);
    expect(JSON.stringify(after.sessions)).toBe(JSON.stringify(before.sessions));
    expect(JSON.stringify(after.messages)).toBe(JSON.stringify(before.messages));
    expect(after.sessions).toHaveLength(1 + SUBAGENT_SESSIONS);
    // The one pre-existing column a byte-0 parse legitimately re-derives:
    // `active_duration_ms` of sessions that were built by incremental appends
    // (their slices never saw the gap to the earlier entries). Never lower, and
    // untouched where the history was a single parse.
    const durations = (rows: Array<{ session_id: string; active_duration_ms: number | null }>) =>
      new Map(rows.map((r) => [r.session_id, r.active_duration_ms ?? 0]));
    const dAfter = durations(store.getSessions({ includeCI: true, includeSubagents: true, includeDeleted: true }));
    for (const [id, was] of durationsBefore) expect(dAfter.get(id)!).toBeGreaterThanOrEqual(was);
    expect(dAfter.get("agent-a1")).toBe(durationsBefore.get("agent-a1"));
    // Cost: exactly equal, not "close".
    expect(carrierCost(dbPath)).toBe(costBefore);

    // The four columns, now populated as the fixture dictates.
    const byId = new Map(store.getSessions({ includeCI: true, includeSubagents: true, includeDeleted: true }).map((s) => [s.session_id, s]));
    expect(byId.get(MAIN)!.agent_type ?? null).toBeNull();
    expect(byId.get(MAIN)!.spawn_depth ?? null).toBeNull();
    expect(byId.get("agent-a1")!.agent_type).toBe("my-reviewer");
    expect(byId.get("agent-a1")!.spawn_depth).toBe(1);
    expect(byId.get("agent-a1")!.spawn_tool_use_id).toBe("toolu_01Reviewer");
    expect(byId.get("agent-a2")!.agent_type).toBe("acme-critic");
    expect(byId.get("agent-a2")!.spawn_depth).toBe(2);
    expect(byId.get("agent-a2")!.spawn_tool_use_id).toBe("toolu_02Critic");

    const skillUuids = [
      ...store.getSessionMessages(MAIN),
      ...store.getSessionMessages("agent-a1"),
      ...store.getSessionMessages("agent-a2"),
    ]
      .filter((m) => m.skill === "example-skill")
      .map((m) => m.uuid)
      .sort();
    expect(skillUuids).toEqual(["m-a2", "m-a3", "m-c1", "s1-1", "s2-2"]);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM messages WHERE skill IS NOT NULL")).toBe(SKILL_ROWS);

    // Complete pass: gate set, armed marker cleared, lock released.
    expect(store.getMeta(AGENT_ATTRIBUTION_BACKFILL_KEY)).toBe(AGENT_ATTRIBUTION_BACKFILL_VALUE);
    expect(store.getMeta(AGENT_ATTRIBUTION_ARMED_KEY)).toBeFalsy();
    expect(store.getMeta(REPAIR_DEDUPE_LOCK_KEY)).toBeFalsy();
  });

  it("does not duplicate quarantine rows on the byte-0 re-parse", async () => {
    const before = snapshot(dbPath).quarantine;
    expect(before).toHaveLength(2);
    await repairAgentAttribution(store, {}, now);
    expect(snapshot(dbPath).quarantine).toEqual(before);
  });

  it("keeps identical bad lines as a multiset: two of them stay two, not one and not four", async () => {
    const mainFile = path.join(projectsDir, "-home-example-attr-proj", `${MAIN}.jsonl`);
    // A good line follows: a bad line at EOF may be a partial write and is not quarantined yet.
    fs.appendFileSync(
      mainFile,
      "{dup bad line\n{dup bad line\n" + assistant({ sessionId: MAIN, uuid: "m-d1", msgId: "msg_D", out: 90 }) + "\n",
    );
    await collect(store, {}, now);
    const before = snapshot(dbPath).quarantine;
    expect(before).toHaveLength(4);

    await repairAgentAttribution(store, {}, now);
    expect(snapshot(dbPath).quarantine).toEqual(before);
  });

  it("is idempotent: a second run is a no-op once the key is set", async () => {
    await repairAgentAttribution(store, {}, now);
    const settled = wholeDb(dbPath);
    const backups = fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes("pre-repair"));

    const again = await repairAgentAttribution(store, {}, now);
    expect(again.alreadyDone).toBe(true);
    expect(again.files).toBe(0);
    expect(again.backupPath).toBeNull();
    expect(wholeDb(dbPath)).toBe(settled);
    expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes("pre-repair"))).toEqual(backups);
  });

  it("dry run reports counts and writes nothing: no rows, no key, no backup, no lock", async () => {
    const dbBefore = wholeDb(dbPath);
    const summary = await repairAgentAttribution(store, { dryRun: true }, now);

    expect(summary.dryRun).toBe(true);
    expect(summary.files).toBe(FILES);
    expect(summary.sessionsGainingAgentType).toBe(SUBAGENT_SESSIONS);
    expect(summary.messagesGainingSkill).toBe(SKILL_ROWS);
    expect(summary.backupPath).toBeNull();
    // Counts only: the summary has no field that can carry a name.
    expect(JSON.stringify(summary)).not.toMatch(/my-reviewer|acme-critic|example-skill/);

    expect(wholeDb(dbPath)).toBe(dbBefore);
    expect(store.getMeta(AGENT_ATTRIBUTION_BACKFILL_KEY)).toBeNull();
    expect(store.getMeta(AGENT_ATTRIBUTION_ARMED_KEY)).toBeNull();
    expect(store.getMeta(REPAIR_DEDUPE_LOCK_KEY)).toBeNull();
    expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes("pre-repair"))).toHaveLength(0);
  });

  it("refuses cleanly when another process holds the lock, and changes nothing", async () => {
    // The parent of this test process: alive, and not us.
    store.setMeta(REPAIR_DEDUPE_LOCK_KEY, JSON.stringify({ pid: process.ppid, startedAt: now() }));
    const dbBefore = wholeDb(dbPath);

    await expect(repairAgentAttribution(store, {}, now)).rejects.toBeInstanceOf(RepairLockHeldError);

    expect(wholeDb(dbPath)).toBe(dbBefore);
    expect(store.getMeta(AGENT_ATTRIBUTION_BACKFILL_KEY)).toBeNull();
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
    await expect(repairAgentAttribution(store, {}, tick)).rejects.toThrow("simulated crash mid-pass");
    expect(store.getMeta(AGENT_ATTRIBUTION_BACKFILL_KEY)).toBeNull();
    expect(store.getMeta(AGENT_ATTRIBUTION_ARMED_KEY)).toBe("1");
    expect(store.getMeta(REPAIR_DEDUPE_LOCK_KEY)).toBeFalsy();
    // The file that did finish is committed; the one that threw rolled back whole.
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM messages")).toBe(before.messages.length);

    spy.mockRestore();
    const summary = await repairAgentAttribution(store, {}, tick);

    expect(summary.alreadyDone).toBe(false);
    expect(store.getMeta(AGENT_ATTRIBUTION_BACKFILL_KEY)).toBe(AGENT_ATTRIBUTION_BACKFILL_VALUE);
    expect(store.getMeta(AGENT_ATTRIBUTION_ARMED_KEY)).toBeFalsy();
    const after = snapshot(dbPath);
    expect(JSON.stringify(after.sessions)).toBe(JSON.stringify(before.sessions));
    expect(JSON.stringify(after.messages)).toBe(JSON.stringify(before.messages));
    expect(after.quarantine).toEqual(before.quarantine);
    expect(carrierCost(dbPath)).toBe(costBefore);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM messages WHERE skill IS NOT NULL")).toBe(SKILL_ROWS);
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM sessions WHERE agent_type IS NOT NULL")).toBe(SUBAGENT_SESSIONS);
  });

  it("the pre-repair backup is created owner-only (0600) and holds the pre-repair data", async () => {
    const summary = await repairAgentAttribution(store, {}, now);
    expect(summary.backupPath).not.toBeNull();
    expect(fs.statSync(summary.backupPath!).mode & 0o777).toBe(0o600);

    const backup = new DatabaseSync(summary.backupPath!, { readOnly: true });
    const n = backup.prepare("SELECT COUNT(*) AS n FROM messages WHERE skill IS NOT NULL").get() as { n: number };
    backup.close();
    expect(n.n).toBe(0);
  });
});

describe("backupDatabase mode", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir("cs-backup");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the backup 0600 even under a permissive umask", () => {
    const dbPath = path.join(dir, "stats.db");
    const store = new Store(dbPath);
    store.setMeta("k", "v");
    let previous: number | undefined;
    try {
      previous = process.umask(0o000);
    } catch {
      previous = undefined; // worker threads cannot set a umask; the default umask still exercises the mode
    }
    try {
      const backup = backupDatabase(dbPath, "mode-test", () => 1);
      expect(backup).not.toBeNull();
      expect(fs.statSync(backup!).mode & 0o777).toBe(0o600);
      const copy = new DatabaseSync(backup!, { readOnly: true });
      const row = copy.prepare("SELECT value FROM metadata WHERE key = 'k'").get() as { value: string };
      copy.close();
      expect(row.value).toBe("v");
    } finally {
      if (previous !== undefined) process.umask(previous);
      store.close();
    }
  });

  it("refuses to reuse an existing backup path, and leaves the first backup intact", () => {
    const dbPath = path.join(dir, "stats.db");
    const store = new Store(dbPath);
    try {
      // Same label and clock twice: the second attempt must fail rather than
      // reuse (and chmod) a file it did not create, and must not delete it.
      const first = backupDatabase(dbPath, "dup", () => 7)!;
      expect(() => backupDatabase(dbPath, "dup", () => 7)).toThrow();
      expect(fs.existsSync(first)).toBe(true);
      expect(fs.statSync(first).mode & 0o777).toBe(0o600);
    } finally {
      store.close();
    }
  });

  it("returns null when there is no database file", () => {
    expect(backupDatabase(path.join(dir, "missing.db"), "x", () => 1)).toBeNull();
  });
});
