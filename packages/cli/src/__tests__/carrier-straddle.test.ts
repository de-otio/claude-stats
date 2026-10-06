/**
 * A `message.id` group whose entries straddle an incremental collect must end
 * up with the same usage carrier as a byte-0 parse of the same bytes: the
 * MAX-usage entry, earliest on ties (`markUsageCarriers`). Before this, the
 * store kept whichever entry it stored first, so the two disagreed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import os from "os";
import path from "path";
import fs from "fs";
import { collect } from "../aggregator/index.js";
import { Store } from "../store/index.js";
import * as pathsMod from "@claude-stats/core/paths";
import type { MessageRecord } from "@claude-stats/core/types";

let dbPath: string;
let store: Store;

const tmp = (p: string): string => path.join(os.tmpdir(), `${p}-${process.pid}-${Math.random().toString(36).slice(2)}`);

function msg(uuid: string, outputTokens: number): MessageRecord {
  return {
    uuid, sessionId: "s1", timestamp: 1_000_000, claudeVersion: "2.1.70", model: "claude-sonnet-4",
    stopReason: "tool_use", inputTokens: 10, outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], filePaths: [], thinkingBlocks: 0, serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0, promptText: null, toolErrorCount: 0,
    messageId: "msg_X", usageCounted: true, costBasis: "per-response",
  };
}

function carriers(file = dbPath): Array<{ uuid: string; output_tokens: number }> {
  const raw = new DatabaseSync(file, { readOnly: true });
  const rows = raw
    .prepare("SELECT uuid, output_tokens FROM messages WHERE usage_counted = 1 ORDER BY uuid")
    .all() as Array<{ uuid: string; output_tokens: number }>;
  raw.close();
  return rows;
}

beforeEach(() => {
  dbPath = `${tmp("cs-straddle")}.db`;
  store = new Store(dbPath);
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${s}`, { force: true });
});

describe("upsertMessages — carrier of a group split across two batches", () => {
  it("a later entry with MORE usage becomes the carrier and the stored one is demoted", () => {
    store.upsertMessages([msg("a", 5)]);
    store.upsertMessages([msg("b", 50)]);
    expect(carriers()).toEqual([{ uuid: "b", output_tokens: 50 }]);
  });

  it("a later entry with LESS usage is demoted", () => {
    store.upsertMessages([msg("a", 50)]);
    store.upsertMessages([msg("b", 5)]);
    expect(carriers()).toEqual([{ uuid: "a", output_tokens: 50 }]);
  });

  it("a tie keeps the earlier (stored) entry, like the parser's tiebreak", () => {
    store.upsertMessages([msg("a", 7)]);
    store.upsertMessages([msg("b", 7)]);
    expect(carriers()).toEqual([{ uuid: "a", output_tokens: 7 }]);
  });

  it("an all-zero replay never takes the carrier", () => {
    store.upsertMessages([msg("a", 7)]);
    store.upsertMessages([{ ...msg("b", 0), inputTokens: 0 }]);
    expect(carriers()).toEqual([{ uuid: "a", output_tokens: 7 }]);
  });
});

describe("collect — appended and byte-0 parses pick the same carrier", () => {
  let projectsDir: string;

  beforeEach(() => {
    projectsDir = tmp("cs-straddle-proj");
    fs.mkdirSync(projectsDir, { recursive: true });
    const original = pathsMod.paths;
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({ ...original, projectsDir });
  });

  afterEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  const line = (uuid: string, output: number): string =>
    JSON.stringify({
      type: "assistant", sessionId: "sess-st", version: "2.1.70", timestamp: 1_700_000_000_000, uuid,
      message: {
        id: "msg_straddle", model: "claude-sonnet-4", stop_reason: "tool_use", content: [],
        usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });

  it("agrees whether the group arrived in one pass or two", async () => {
    const dir = path.join(projectsDir, "-proj-st");
    fs.mkdirSync(dir);
    const file = path.join(dir, "sess-st.jsonl");

    fs.writeFileSync(file, line("e1", 3) + "\n");
    await collect(store);
    fs.appendFileSync(file, line("e2", 90) + "\n");
    await collect(store);
    const appended = carriers();

    const fullPath = `${tmp("cs-straddle-full")}.db`;
    const full = new Store(fullPath);
    try {
      await collect(full);
      expect(appended).toEqual(carriers(fullPath));
      expect(appended).toEqual([{ uuid: "e2", output_tokens: 90 }]);
    } finally {
      full.close();
      for (const s of ["", "-wal", "-shm"]) fs.rmSync(`${fullPath}${s}`, { force: true });
    }
  });
});
