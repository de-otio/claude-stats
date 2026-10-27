/**
 * Claude Code's local GC rewrites a transcript shorter. A byte-0 re-parse of the
 * trimmed file must not shrink ANY session counter: tokens, message count and
 * prompt_count come from the retained `messages` rows, and the two duration
 * columns (which `messages` cannot reproduce) must not be overwritten by the
 * smaller trimmed values. Re-parsing the untrimmed file afterwards must not
 * inflate anything either (no accumulation across re-parses).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import os from "os";
import path from "path";
import fs from "fs";
import { collect } from "../aggregator/index.js";
import { Store } from "../store/index.js";
import * as pathsMod from "@claude-stats/core/paths";
import { parseSessionFile } from "@claude-stats/core/parser/session";
import type { MessageRecord } from "@claude-stats/core/types";

const tmp = (p: string): string =>
  path.join(os.tmpdir(), `${p}-${process.pid}-${Math.random().toString(36).slice(2)}`);

const T0 = 1_700_000_000_000;
const PAIRS = 10;

/** Pair i: a prompt at i minutes, answered (i+1) seconds later. */
function transcriptLines(): string[] {
  const lines: string[] = [];
  for (let i = 0; i < PAIRS; i++) {
    const userTs = T0 + i * 60_000;
    lines.push(JSON.stringify({
      type: "user", sessionId: "sess-gc", version: "2.1.70", uuid: `u${i}`,
      timestamp: new Date(userTs).toISOString(), isMeta: false,
      message: { role: "user", content: [{ type: "text", text: `p${i}` }] },
    }));
    lines.push(JSON.stringify({
      type: "assistant", sessionId: "sess-gc", version: "2.1.70", uuid: `a${i}`,
      timestamp: new Date(userTs + (i + 1) * 1000).toISOString(),
      message: {
        id: `msg_${i}`, model: "claude-sonnet-4", stop_reason: "end_turn", content: [],
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 200 },
      },
    }));
  }
  return lines;
}

interface Counters {
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_creation_tokens: number;
  assistant_message_count: number; prompt_count: number;
  active_duration_ms: number; median_response_time_ms: number;
}

describe("transcript trimmed by Claude Code's local GC", () => {
  let projectsDir: string;
  let dbPath: string;
  let store: Store;
  let file: string;

  const counters = (): Counters => {
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const row = raw.prepare(
      `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              assistant_message_count, prompt_count, active_duration_ms, median_response_time_ms
         FROM sessions WHERE session_id = 'sess-gc'`,
    ).get() as unknown as Counters;
    raw.close();
    return { ...row };
  };

  beforeEach(() => {
    projectsDir = tmp("cs-gc-proj");
    dbPath = `${tmp("cs-gc-db")}.db`;
    const dir = path.join(projectsDir, "-proj-gc");
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "sess-gc.jsonl");
    store = new Store(dbPath);
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({ ...pathsMod.paths, projectsDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    fs.rmSync(projectsDir, { recursive: true, force: true });
    for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${s}`, { force: true });
  });

  it("no counter falls when the file is trimmed by half, and none inflates when it is restored", async () => {
    const lines = transcriptLines();
    fs.writeFileSync(file, lines.join("\n") + "\n");
    await collect(store);
    const full = counters();
    expect(full.assistant_message_count).toBe(PAIRS);
    expect(full.prompt_count).toBe(PAIRS);
    expect(full.active_duration_ms).toBeGreaterThan(0);
    expect(full.median_response_time_ms).toBe(5500);

    // GC drops the first half (starts at a user line).
    fs.writeFileSync(file, lines.slice(lines.length / 2).join("\n") + "\n");
    await collect(store);
    const trimmed = counters();
    expect(trimmed).toEqual(full);

    // The untrimmed file comes back: a byte-0 re-parse again, still no change.
    fs.writeFileSync(file, lines.join("\n") + "\n\n");
    await collect(store);
    expect(counters()).toEqual(full);
  });
});

describe("full re-parse of an untrimmed file", () => {
  it("takes a smaller parsed active_duration_ms over a larger stored one", async () => {
    const projectsDir = tmp("cs-gc-proj");
    const dbPath = `${tmp("cs-gc-db")}.db`;
    const dir = path.join(projectsDir, "-proj-gc");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "sess-gc.jsonl");
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({ ...pathsMod.paths, projectsDir });
    const store = new Store(dbPath);
    const read = (): number => {
      const ro = new DatabaseSync(dbPath, { readOnly: true });
      const v = (ro.prepare("SELECT active_duration_ms AS v FROM sessions WHERE session_id='sess-gc'").get() as { v: number }).v;
      ro.close();
      return v;
    };
    try {
      const lines = transcriptLines();
      fs.writeFileSync(file, lines.join("\n") + "\n");
      await collect(store);
      const parsedValue = read();
      const raw = new DatabaseSync(dbPath);
      raw.prepare("UPDATE sessions SET active_duration_ms = ? WHERE session_id='sess-gc'").run(parsedValue + 999_999);
      raw.close();

      // Same messages, changed head: byte-0 re-parse, not a trim.
      fs.writeFileSync(file, lines.join("\n").replace('"p0"', '"q0"') + "\n");
      await collect(store);
      expect(read()).toBe(parsedValue);
    } finally {
      vi.restoreAllMocks();
      store.close();
      fs.rmSync(projectsDir, { recursive: true, force: true });
      for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${s}`, { force: true });
    }
  });
});

describe("carrier tie-break prefers the entry with a stop_reason", () => {
  const tmpFiles: string[] = [];
  afterEach(() => {
    for (const f of tmpFiles.splice(0)) for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${f}${s}`, { force: true });
  });

  const entry = (uuid: string, stop: string | null): string =>
    JSON.stringify({
      type: "assistant", sessionId: "sess-tie", version: "2.1.70", uuid, timestamp: T0,
      message: {
        id: "msg_tie", model: "claude-sonnet-4", ...(stop ? { stop_reason: stop } : {}), content: [],
        usage: { input_tokens: 10, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });

  it("parser: on a magnitude tie the stopped entry carries, even when it comes later", async () => {
    const f = `${tmp("cs-tie")}.jsonl`;
    tmpFiles.push(f);
    fs.writeFileSync(f, [entry("e1", null), entry("e2", "end_turn")].join("\n") + "\n");
    const { messages } = await parseSessionFile(f, "/proj/tie");
    const carriers = messages.filter(m => m.usageCounted).map(m => m.uuid);
    expect(carriers).toEqual(["e2"]);
  });

  it("parser: a tie between two stopped (or two unstopped) entries still keeps the earliest", async () => {
    const f = `${tmp("cs-tie")}.jsonl`;
    tmpFiles.push(f);
    fs.writeFileSync(f, [entry("e1", "end_turn"), entry("e2", "end_turn")].join("\n") + "\n");
    const { messages } = await parseSessionFile(f, "/proj/tie");
    expect(messages.filter(m => m.usageCounted).map(m => m.uuid)).toEqual(["e1"]);
  });

  const rec = (uuid: string, stopReason: string | null): MessageRecord => ({
    uuid, sessionId: "sess-tie", timestamp: T0, claudeVersion: "2.1.70", model: "claude-sonnet-4",
    stopReason, inputTokens: 10, outputTokens: 7, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null, toolErrorCount: 0,
    messageId: "msg_tie", usageCounted: true, costBasis: "per-response",
  });

  const storeCarriers = (dbPath: string): string[] => {
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const rows = raw.prepare("SELECT uuid FROM messages WHERE usage_counted = 1").all() as Array<{ uuid: string }>;
    raw.close();
    return rows.map(r => r.uuid);
  };

  it("store: a later stopped entry takes over a tied unstopped carrier from an earlier batch", () => {
    const dbPath = `${tmp("cs-tie-db")}.db`;
    tmpFiles.push(dbPath);
    const s = new Store(dbPath);
    s.upsertMessages([rec("e1", null)]);
    s.upsertMessages([rec("e2", "end_turn")]);
    s.close();
    expect(storeCarriers(dbPath)).toEqual(["e2"]);
  });

  it("store: a later unstopped tie, or a stopped-vs-stopped tie, keeps the stored carrier", () => {
    const dbPath = `${tmp("cs-tie-db")}.db`;
    tmpFiles.push(dbPath);
    const s = new Store(dbPath);
    s.upsertMessages([rec("e1", "end_turn")]);
    s.upsertMessages([rec("e2", null)]);
    s.upsertMessages([rec("e3", "end_turn")]);
    s.close();
    expect(storeCarriers(dbPath)).toEqual(["e1"]);
  });
});
