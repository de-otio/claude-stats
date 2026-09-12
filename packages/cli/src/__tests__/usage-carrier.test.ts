/**
 * V23 — one API response is charged ONCE.
 *
 * A transcript writes one API response as N entries, one per content block, and
 * every one of them repeats the WHOLE response's usage. Deduping on the
 * per-entry `uuid` (what shipped through v22) therefore counted each response
 * 2.03 times on average — 1.94x on cache-read tokens, 2.60x on output.
 *
 * ‼️ THE OBVIOUS TEST DOES NOT WORK. A replay-invariance property — parse the
 *    same bytes twice, assert identical totals — PASSES on the broken build:
 *    the v22 parser is already uuid-replay-invariant, and 59% of multi-entry
 *    groups repeat no uuid at all. A test that cannot fail is worse than no
 *    test, because it certifies. The properties below are the ones that go red
 *    when the carrier model is absent, and each names the defect it catches.
 */
import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import os from "os";
import path from "path";
import fs from "fs";
import { DatabaseSync } from "node:sqlite";

import { parseSessionFile } from "@claude-stats/core/parser/session";
import type { MessageRecord, SessionRecord } from "@claude-stats/core/types";
import { Store } from "../store/index.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const SESSION_ID = "sess-carrier";
const PROJECT = "/home/example/proj";

/** The usage every entry of one response repeats verbatim. */
const RESPONSE_USAGE = {
  input_tokens: 11,
  output_tokens: 324,
  cache_creation_input_tokens: 1_200,
  cache_read_input_tokens: 45_000,
  cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 200 },
  server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 },
  service_tier: "standard",
  speed: "standard",
  output_tokens_details: { thinking_tokens: 96 },
};

const tmpPaths: string[] = [];
function tmp(suffix: string): string {
  const p = path.join(
    os.tmpdir(),
    `cs-carrier-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
  );
  tmpPaths.push(p);
  return p;
}

afterEach(() => {
  for (const p of tmpPaths.splice(0)) {
    try {
      fs.rmSync(p, { force: true });
      fs.rmSync(`${p}-wal`, { force: true });
      fs.rmSync(`${p}-shm`, { force: true });
    } catch {
      /* best effort */
    }
  }
});

/** One content block per entry, cycling the three real block types. */
function blockFor(i: number): Record<string, unknown> {
  if (i % 3 === 0) return { type: "thinking", thinking: `reasoning ${i}` };
  if (i % 3 === 1) return { type: "text", text: `answer ${i}` };
  return {
    type: "tool_use",
    id: `tu-${i}`,
    name: "Read",
    input: { file_path: `${PROJECT}/file-${i}.ts` },
  };
}

/**
 * One API response written the way Claude Code writes it: `n` entries sharing
 * ONE `message.id`, each with its own `uuid`, each carrying one content block
 * and a verbatim copy of the whole response's usage.
 */
function responseEntries(messageId: string, n: number): object[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "assistant",
    sessionId: SESSION_ID,
    version: "2.1.72",
    cwd: PROJECT,
    timestamp: new Date(1_700_000_000_000 + i * 1_000).toISOString(),
    uuid: `${messageId}-entry-${i}`,
    effort: "high",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      id: messageId,
      stop_reason: "end_turn",
      content: [blockFor(i)],
      usage: RESPONSE_USAGE,
    },
  }));
}

function writeEntries(filePath: string, entries: object[]): void {
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function appendEntries(filePath: string, entries: object[]): void {
  fs.appendFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function tokensOf(messages: readonly MessageRecord[]) {
  return messages.reduce(
    (acc, m) => ({
      input: acc.input + m.inputTokens,
      output: acc.output + m.outputTokens,
      cacheCreation: acc.cacheCreation + m.cacheCreationTokens,
      cacheRead: acc.cacheRead + m.cacheReadTokens,
    }),
    { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
  );
}

// ── 1. the parser counts one response once, and loses nothing else ───────────

describe("a multi-entry response is charged once (parser)", () => {
  it("token totals equal ONE response's usage for any 1..8 entries", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (n) => {
        const file = tmp(".jsonl");
        writeEntries(file, responseEntries("msg_prop", n));
        const parsed = await parseSessionFile(file, PROJECT);

        // Every entry still has a row — the rows are what hold the per-entry
        // tool / thinking / file-path data.
        expect(parsed.messages).toHaveLength(n);

        // …but exactly one of them counts the usage.
        const carriers = parsed.messages.filter((m) => m.usageCounted !== false);
        expect(carriers).toHaveLength(1);

        const sums = tokensOf(parsed.messages);
        expect(sums.input).toBe(RESPONSE_USAGE.input_tokens);
        expect(sums.output).toBe(RESPONSE_USAGE.output_tokens);
        expect(sums.cacheCreation).toBe(RESPONSE_USAGE.cache_creation_input_tokens);
        expect(sums.cacheRead).toBe(RESPONSE_USAGE.cache_read_input_tokens);

        // The session record must state the same number as the rows it summarises.
        expect(parsed.session!.inputTokens).toBe(sums.input);
        expect(parsed.session!.outputTokens).toBe(sums.output);
        expect(parsed.session!.cacheCreationTokens).toBe(sums.cacheCreation);
        expect(parsed.session!.cacheReadTokens).toBe(sums.cacheRead);
        // Server-tool calls are billed per response too.
        expect(parsed.session!.webSearchRequests).toBe(1);
        expect(parsed.session!.webFetchRequests).toBe(2);
        // Thinking tokens are a usage field: only the carrier reports them.
        const reported = parsed.messages.filter((m) => m.thinkingTokens != null);
        expect(reported).toHaveLength(1);
        expect(reported[0]!.thinkingTokens).toBe(96);
      }),
      { seed: 0x5eed, numRuns: 24 },
    );
  });

  it("tools / thinkingBlocks / filePaths are the UNION across all entries", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (n) => {
        const file = tmp(".jsonl");
        writeEntries(file, responseEntries("msg_union", n));
        const parsed = await parseSessionFile(file, PROJECT);

        const expectedTools: string[] = [];
        const expectedPaths: string[] = [];
        let expectedThinking = 0;
        for (let i = 0; i < n; i++) {
          if (i % 3 === 0) expectedThinking++;
          if (i % 3 === 2) {
            expectedTools.push("Read");
            expectedPaths.push(`${PROJECT}/file-${i}.ts`);
          }
        }

        const tools = parsed.messages.flatMap((m) => m.tools);
        const paths = parsed.messages.flatMap((m) => m.filePaths ?? []);
        const thinking = parsed.messages.reduce((t, m) => t + m.thinkingBlocks, 0);

        expect(tools.sort()).toEqual(expectedTools.sort());
        expect(paths.sort()).toEqual(expectedPaths.sort());
        expect(thinking).toBe(expectedThinking);
        // Which is the point of keeping the rows: 9,955 real groups carry a
        // tool_use on a NON-FIRST entry, so a delete-based dedupe would have
        // destroyed ~92% of tool-use records.
        expect(parsed.session!.thinkingBlocks).toBe(expectedThinking);
        const readCount = parsed.session!.toolUseCounts.find((t) => t.name === "Read")?.count ?? 0;
        expect(readCount).toBe(expectedTools.length);
      }),
      { seed: 0x5eed, numRuns: 24 },
    );
  });

  it("independent responses are each charged once", async () => {
    const file = tmp(".jsonl");
    writeEntries(file, [
      ...responseEntries("msg_a", 3),
      ...responseEntries("msg_b", 2),
      ...responseEntries("msg_c", 1),
    ]);
    const parsed = await parseSessionFile(file, PROJECT);
    expect(parsed.messages).toHaveLength(6);
    expect(tokensOf(parsed.messages).output).toBe(RESPONSE_USAGE.output_tokens * 3);
  });

  it("an entry with no message.id stays its own carrier, labelled honestly", async () => {
    const file = tmp(".jsonl");
    const [entry] = responseEntries("msg_x", 1) as Array<Record<string, unknown>>;
    const message = entry!["message"] as Record<string, unknown>;
    delete message["id"];
    writeEntries(file, [entry!]);
    const parsed = await parseSessionFile(file, PROJECT);
    expect(parsed.messages[0]!.messageId).toBeNull();
    expect(parsed.messages[0]!.usageCounted).toBe(true);
    // It carries real usage and cannot be joined to its siblings, so the parser
    // must NOT claim it is counted per response.
    expect(parsed.messages[0]!.costBasis).toBe("pre-dedupe");
  });
});

// ── 2. the free-text columns are validated where they enter ──────────────────

describe("V23 dimensions are shape-checked at the parser boundary", () => {
  it("keeps well-shaped values and nulls anything else", async () => {
    const file = tmp(".jsonl");
    const entries = responseEntries("msg_shape", 3) as Array<Record<string, unknown>>;
    // `getSessionMessages` is SELECT * and feeds the personal-plane export, so a
    // new column enrols itself in an export automatically. Free text must never
    // reach it.
    entries[0]!["effort"] = "<script>alert(1)</script>";
    (entries[1]!["message"] as Record<string, unknown>)["usage"] = {
      ...RESPONSE_USAGE,
      speed: "a".repeat(200),
    };
    (entries[2]!["message"] as Record<string, unknown>)["id"] = "msg with spaces/../etc";
    writeEntries(file, entries);

    const parsed = await parseSessionFile(file, PROJECT);
    expect(parsed.messages[0]!.effort).toBeNull();
    expect(parsed.messages[1]!.speed).toBeNull();
    expect(parsed.messages[2]!.messageId).toBeNull();
    // A shape check, not an enum: an unannounced tier must survive.
    expect(parsed.messages[1]!.effort).toBe("high");
  });

  it("never coerces an unreported thinking-token count to 0", async () => {
    const file = tmp(".jsonl");
    const entries = responseEntries("msg_th", 2) as Array<Record<string, unknown>>;
    const usage = { ...RESPONSE_USAGE } as Record<string, unknown>;
    delete usage["output_tokens_details"];
    for (const e of entries) (e["message"] as Record<string, unknown>)["usage"] = usage;
    writeEntries(file, entries);

    const parsed = await parseSessionFile(file, PROJECT);
    for (const m of parsed.messages) expect(m.thinkingTokens).toBeNull();
  });
});

// ── 3. the split-parse boundary — the store half of the rule ─────────────────

function storeWith(dbPath: string): Store {
  return new Store(dbPath);
}

async function collectRange(
  store: Store,
  file: string,
  startOffset: number,
): Promise<number> {
  const parsed = await parseSessionFile(file, PROJECT, startOffset);
  store.transaction(() => {
    if (parsed.session) {
      const record: SessionRecord = { ...parsed.session };
      if (startOffset > 0) store.upsertSessionIncremental(record);
      else store.upsertSession(record);
    }
    if (parsed.messages.length > 0) store.upsertMessages(parsed.messages);
    if (parsed.session) store.recomputeSessionAggregates([parsed.session.sessionId]);
  });
  return parsed.lastGoodOffset;
}

function storedTotals(store: Store) {
  const rows = store.getSessionMessages(SESSION_ID);
  return rows.reduce(
    (acc, m) => ({
      input: acc.input + m.input_tokens,
      output: acc.output + m.output_tokens,
      cacheCreation: acc.cacheCreation + m.cache_creation_tokens,
      cacheRead: acc.cacheRead + m.cache_read_tokens,
      rows: acc.rows + 1,
      carriers: acc.carriers + (m.usage_counted ?? 1),
    }),
    { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, rows: 0, carriers: 0 },
  );
}

describe("a group split across a collect boundary is still charged once", () => {
  it("every inter-entry cut gives the totals of a single pass", async () => {
    const n = 5;
    const entries = responseEntries("msg_split", n);

    // Reference: one pass over the whole file.
    const refFile = tmp(".jsonl");
    writeEntries(refFile, entries);
    const refStore = storeWith(tmp(".db"));
    await collectRange(refStore, refFile, 0);
    const reference = storedTotals(refStore);
    refStore.close();
    expect(reference.carriers).toBe(1);
    expect(reference.output).toBe(RESPONSE_USAGE.output_tokens);

    // THE PARSER CANNOT DO THIS ALONE. Parsing resumes from the checkpoint
    // byte offset, and a group's entries are consecutive lines written seconds
    // apart while the session is live — so a boundary lands mid-group as a
    // matter of routine. The second invocation's parser sees only its own half
    // and legitimately marks a carrier in it; only the store knows the first
    // half already counted the response.
    for (let cut = 1; cut < n; cut++) {
      const file = tmp(".jsonl");
      writeEntries(file, entries.slice(0, cut));
      const store = storeWith(tmp(".db"));
      const offset = await collectRange(store, file, 0);
      appendEntries(file, entries.slice(cut));
      await collectRange(store, file, offset);

      const after = storedTotals(store);
      expect(after.rows, `cut ${cut}`).toBe(n);
      expect(after.carriers, `cut ${cut}`).toBe(1);
      expect(after.input, `cut ${cut}`).toBe(reference.input);
      expect(after.output, `cut ${cut}`).toBe(reference.output);
      expect(after.cacheCreation, `cut ${cut}`).toBe(reference.cacheCreation);
      expect(after.cacheRead, `cut ${cut}`).toBe(reference.cacheRead);
      store.close();
    }
  });

  it("re-parsing the whole file after a split converges, never doubles", async () => {
    const entries = responseEntries("msg_reparse", 4);
    const file = tmp(".jsonl");
    writeEntries(file, entries.slice(0, 2));
    const store = storeWith(tmp(".db"));
    const offset = await collectRange(store, file, 0);
    appendEntries(file, entries.slice(2));
    await collectRange(store, file, offset);
    // The rewrite path: re-parse from byte 0 over rows that already exist.
    await collectRange(store, file, 0);

    const after = storedTotals(store);
    expect(after.rows).toBe(4);
    expect(after.carriers).toBe(1);
    expect(after.output).toBe(RESPONSE_USAGE.output_tokens);
    store.close();
  });
});

// ── 4. every real cost surface reads SQL, not ParseResult ────────────────────

describe("the store's aggregates and its rollup agree", () => {
  it("session counters, the raw read and the hourly rollup all state one response", async () => {
    const file = tmp(".jsonl");
    writeEntries(file, responseEntries("msg_e2e", 3));
    const store = storeWith(tmp(".db"));
    await collectRange(store, file, 0);
    store.recomputeMessageHourly();

    const session = store.findSession(SESSION_ID)!;
    expect(session.output_tokens).toBe(RESPONSE_USAGE.output_tokens);
    expect(session.cache_read_tokens).toBe(RESPONSE_USAGE.cache_read_input_tokens);
    expect(session.web_search_requests).toBe(1);
    expect(session.web_fetch_requests).toBe(2);
    // The rows are all still there — only the usage was collapsed.
    expect(session.assistant_message_count).toBe(3);

    // Unbounded → the message_hourly rollup; bounded → the raw seek. Both are
    // real cost surfaces and they must not disagree.
    const rollup = store.getMessageTotals({});
    const raw = store.getMessageTotals({ since: 0 });
    // The rollup deliberately carries no TTL split (it stores 0/0 there, which
    // estimateCost treats as "no split given"), so compare the four token
    // classes that both paths do carry.
    const tokenView = (rows: typeof rollup) =>
      rows.map((r) => ({
        model: r.model,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_creation_tokens: r.cache_creation_tokens,
      }));
    expect(tokenView(rollup)).toEqual(tokenView(raw));
    expect(rollup[0]!.output_tokens).toBe(RESPONSE_USAGE.output_tokens);
    expect(rollup[0]!.cache_read_tokens).toBe(RESPONSE_USAGE.cache_read_input_tokens);
    store.close();
  });

  it("the rollup's freshness watermark notices a repair that changes no row count", () => {
    const store = storeWith(tmp(".db"));
    store.upsertSession(minimalSession());
    store.upsertMessages([
      msgRecord("m1", { messageId: "msg_w", usageCounted: true, outputTokens: 100 }),
      msgRecord("m2", { messageId: "msg_w", usageCounted: true, outputTokens: 100 }),
    ]);
    store.recomputeMessageHourly();
    expect(store.getMessageTotals({})).toEqual(store.getMessageTotals({ since: 0 }));

    // A repair moves usage off a row without adding or removing one. A
    // count-only watermark would leave the stale rollup looking fresh and every
    // rolled-up read would keep serving the pre-fix number.
    store.upsertMessages([
      msgRecord("m2", { messageId: "msg_w", usageCounted: false, outputTokens: 0 }),
    ]);
    const stale = store.getMessageTotals({});
    const truth = store.getMessageTotals({ since: 0 });
    expect(truth[0]!.output_tokens).toBe(100);
    expect(stale).toEqual(truth); // fell back to the raw seek, not the stale rollup
    store.close();
  });
});

// ── 5. upsert-level enforcement and the keepIfNoUsage gate ───────────────────

function minimalSession(): SessionRecord {
  return {
    sessionId: SESSION_ID,
    projectPath: PROJECT,
    sourceFile: `${PROJECT}/x.jsonl`,
    firstTimestamp: 1_700_000_000_000,
    lastTimestamp: 1_700_000_001_000,
    claudeVersion: "2.1.72",
    entrypoint: "cli",
    gitBranch: null,
    permissionMode: null,
    isInteractive: false,
    promptCount: 0,
    assistantMessageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    toolUseCounts: [],
    models: ["claude-opus-5"],
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

function msgRecord(uuid: string, over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid,
    sessionId: SESSION_ID,
    timestamp: 1_700_000_000_000,
    claudeVersion: "2.1.72",
    model: "claude-opus-5",
    stopReason: "end_turn",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools: [],
    filePaths: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: null,
    ...over,
  };
}

describe("upsertMessages enforces the carrier rule", () => {
  it("zeroes a second claimant of a message.id that is already counted", () => {
    const store = storeWith(tmp(".db"));
    store.upsertSession(minimalSession());
    store.upsertMessages([
      msgRecord("m1", { messageId: "msg_1", outputTokens: 300, usageCounted: true }),
    ]);
    // A separate invocation, believing itself the carrier (the split-boundary case).
    store.upsertMessages([
      msgRecord("m2", { messageId: "msg_1", outputTokens: 300, usageCounted: true }),
    ]);
    const rows = store.getSessionMessages(SESSION_ID);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((n, r) => n + r.output_tokens, 0)).toBe(300);
    expect(rows.reduce((n, r) => n + (r.usage_counted ?? 1), 0)).toBe(1);
    store.close();
  });

  it("lets a re-parse MOVE the carrier within a group without losing the usage", () => {
    const store = storeWith(tmp(".db"));
    store.upsertSession(minimalSession());
    store.upsertMessages([
      msgRecord("m1", { messageId: "msg_2", outputTokens: 300, usageCounted: true }),
      msgRecord("m2", { messageId: "msg_2", outputTokens: 0, usageCounted: false }),
    ]);
    // A later, fuller parse picks the other entry as the MAX-usage carrier.
    store.upsertMessages([
      msgRecord("m1", { messageId: "msg_2", outputTokens: 0, usageCounted: false }),
      msgRecord("m2", { messageId: "msg_2", outputTokens: 500, usageCounted: true }),
    ]);
    const rows = store.getSessionMessages(SESSION_ID);
    expect(rows.reduce((n, r) => n + (r.usage_counted ?? 1), 0)).toBe(1);
    expect(rows.reduce((n, r) => n + r.output_tokens, 0)).toBe(500);
    store.close();
  });

  it("a deliberately zeroed non-carrier is written, not mistaken for a replay", () => {
    // `keepIfNoUsage` treats "all four token fields are 0" as "this copy carries
    // no usage information" and keeps what is stored. A demoted non-carrier is
    // byte-identical to that, so without the `excluded.usage_counted = 1` gate
    // the demotion silently no-ops and the whole release fixes nothing.
    const store = storeWith(tmp(".db"));
    store.upsertSession(minimalSession());
    store.upsertMessages([
      msgRecord("m1", { messageId: "msg_3", outputTokens: 300, cacheReadTokens: 900, usageCounted: true }),
    ]);
    store.upsertMessages([
      msgRecord("m1", { messageId: "msg_3", outputTokens: 0, cacheReadTokens: 0, usageCounted: false }),
    ]);
    const [row] = store.getSessionMessages(SESSION_ID);
    expect(row!.output_tokens).toBe(0);
    expect(row!.cache_read_tokens).toBe(0);
    expect(row!.usage_counted).toBe(0);
    store.close();
  });

  it("still refuses a zero-usage REPLAY copy (the guard this gate reuses)", () => {
    const store = storeWith(tmp(".db"));
    store.upsertSession(minimalSession());
    store.upsertMessages([
      msgRecord("m1", { messageId: "msg_4", outputTokens: 490, cacheReadTokens: 420_067, usageCounted: true }),
    ]);
    // Resume/compaction replays the turn with an EMPTY usage block.
    store.upsertMessages([
      msgRecord("m1", { messageId: "msg_4", outputTokens: 0, cacheReadTokens: 0, usageCounted: true }),
    ]);
    const [row] = store.getSessionMessages(SESSION_ID);
    expect(row!.output_tokens).toBe(490);
    expect(row!.cache_read_tokens).toBe(420_067);
    expect(row!.usage_counted).toBe(1);
    store.close();
  });

  it("does not demote a row on account of itself", () => {
    const store = storeWith(tmp(".db"));
    store.upsertSession(minimalSession());
    const rec = msgRecord("m1", { messageId: "msg_5", outputTokens: 77, usageCounted: true });
    store.upsertMessages([rec]);
    store.upsertMessages([rec]);
    store.upsertMessages([rec]);
    const [row] = store.getSessionMessages(SESSION_ID);
    expect(row!.usage_counted).toBe(1);
    expect(row!.output_tokens).toBe(77);
    store.close();
  });

  it("never mutates the caller's records", () => {
    const store = storeWith(tmp(".db"));
    store.upsertSession(minimalSession());
    store.upsertMessages([msgRecord("m1", { messageId: "msg_6", outputTokens: 10 })]);
    const second = msgRecord("m2", { messageId: "msg_6", outputTokens: 10 });
    store.upsertMessages([second]);
    expect(second.outputTokens).toBe(10);
    expect(second.usageCounted).toBeUndefined();
    store.close();
  });
});

// ── 6. the V22 → V23 migration ───────────────────────────────────────────────

/** A database as a v22 build left it: no carrier columns, rows already in it. */
function makeV22Db(): string {
  const dbPath = tmp(".db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  // The `messages` table exactly as V22 leaves it (V1 + V4 + V7 + V8 + V10 +
  // V11 + V13 + V18 + V20). A trimmed fixture would let a migration that
  // references a column added years earlier pass here and fail on real data.
  db.exec(`
    CREATE TABLE messages (
      uuid                      TEXT PRIMARY KEY,
      session_id                TEXT NOT NULL,
      timestamp                 INTEGER,
      claude_version            TEXT,
      model                     TEXT,
      stop_reason               TEXT,
      input_tokens              INTEGER NOT NULL DEFAULT 0,
      output_tokens             INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens         INTEGER NOT NULL DEFAULT 0,
      tools                     TEXT NOT NULL DEFAULT '[]',
      thinking_blocks           INTEGER NOT NULL DEFAULT 0,
      service_tier              TEXT,
      inference_geo             TEXT,
      ephemeral_5m_cache_tokens INTEGER NOT NULL DEFAULT 0,
      ephemeral_1h_cache_tokens INTEGER NOT NULL DEFAULT 0,
      prompt_text               TEXT,
      file_paths                TEXT NOT NULL DEFAULT '[]',
      tool_error_count          INTEGER NOT NULL DEFAULT 0,
      account_uuid              TEXT,
      is_turn_start             INTEGER NOT NULL DEFAULT 0,
      web_search_requests       INTEGER NOT NULL DEFAULT 0,
      web_fetch_requests        INTEGER NOT NULL DEFAULT 0,
      is_throttled              INTEGER NOT NULL DEFAULT 0,
      git_branch                TEXT
    )
  `);
  db.exec(
    `INSERT INTO messages (uuid, session_id, timestamp, output_tokens, thinking_blocks)
     VALUES ('old-1', '${SESSION_ID}', 1700000000000, 500, 2),
            ('old-2', '${SESSION_ID}', 1700000001000, 700, 0)`,
  );
  db.exec(`INSERT INTO metadata (key, value) VALUES ('schema_version', '22')`);
  db.close();
  return dbPath;
}

function rawRows(dbPath: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath);
  const rows = db
    .prepare("SELECT * FROM messages ORDER BY uuid")
    .all() as unknown as Array<Record<string, unknown>>;
  db.close();
  return rows;
}

function rawMeta(dbPath: string, key: string): string | null {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  db.close();
  return row?.value ?? null;
}

describe("V22 → V23 migration", () => {
  it("leaves thinking_tokens NULL on pre-existing rows — never 0", () => {
    const dbPath = makeV22Db();
    storeWith(dbPath).close();
    for (const row of rawRows(dbPath)) {
      // `NOT NULL DEFAULT 0` here would fabricate a measured 0% thinking share
      // for the ~32% of history written before the field existed. That exact
      // bug was produced once already (23.7% reported against a true 38.9%).
      expect(row["thinking_tokens"]).toBeNull();
      expect(row["effort"]).toBeNull();
      expect(row["speed"]).toBeNull();
      expect(row["message_id"]).toBeNull();
    }
  });

  it("stamps every pre-existing row 'pre-dedupe' and counts it", () => {
    const dbPath = makeV22Db();
    storeWith(dbPath).close();
    for (const row of rawRows(dbPath)) {
      expect(row["cost_basis"]).toBe("pre-dedupe");
      expect(row["usage_counted"]).toBe(1);
    }
    expect(rawMeta(dbPath, "schema_version")).toBe("23");
  });

  it("preserves the token values it migrates", () => {
    const dbPath = makeV22Db();
    storeWith(dbPath).close();
    const rows = rawRows(dbPath);
    expect(rows.map((r) => r["output_tokens"])).toEqual([500, 700]);
    expect(rows.map((r) => r["thinking_blocks"])).toEqual([2, 0]);
  });

  it("is idempotent against a PARTIALLY repaired table", () => {
    const dbPath = makeV22Db();
    storeWith(dbPath).close();

    // A repair has corrected one row. Then an older build re-stamps the version
    // down and the migration runs again — a blanket backfill would drag the
    // corrected row back to 'pre-dedupe'.
    const db = new DatabaseSync(dbPath);
    db.exec(
      `UPDATE messages SET cost_basis = 'per-response', message_id = 'msg_r', usage_counted = 1 WHERE uuid = 'old-1'`,
    );
    db.exec(`UPDATE metadata SET value = '22' WHERE key = 'schema_version'`);
    db.close();

    storeWith(dbPath).close();
    const rows = rawRows(dbPath);
    expect(rows[0]!["cost_basis"]).toBe("per-response");
    expect(rows[1]!["cost_basis"]).toBe("pre-dedupe");
  });

  it("makes the one-carrier invariant true before it declares it", () => {
    // Creating the unique index must never be the thing that stops the database
    // opening. If a table somehow carries two carriers for one response, the
    // migration keeps the MAX-usage row — the rule the parser uses — and zeroes
    // the rest, rather than throwing on CREATE UNIQUE INDEX.
    const dbPath = makeV22Db();
    storeWith(dbPath).close();
    const db = new DatabaseSync(dbPath);
    db.exec(`DROP INDEX IF EXISTS idx_messages_usage_carrier`);
    db.exec(
      `UPDATE messages SET message_id = 'msg_dupe', usage_counted = 1, cost_basis = 'per-response'`,
    );
    db.exec(`UPDATE metadata SET value = '22' WHERE key = 'schema_version'`);
    db.close();

    expect(() => storeWith(dbPath).close()).not.toThrow();
    const rows = rawRows(dbPath);
    expect(rows.map((r) => r["usage_counted"])).toEqual([0, 1]); // old-2 has 700 > 500
    expect(rows[0]!["output_tokens"]).toBe(0);
    expect(rows[1]!["output_tokens"]).toBe(700);
  });
});

describe("schema_version is stamped forward only", () => {
  it("leaves a database from the FUTURE exactly as it is", () => {
    const dbPath = makeV22Db();
    storeWith(dbPath).close(); // → v23
    const db = new DatabaseSync(dbPath);
    db.exec(`UPDATE metadata SET value = '99' WHERE key = 'schema_version'`);
    db.close();

    // Three processes (CLI, MCP server, VS Code extension) open this file at
    // whatever version each happens to ship. An unconditional stamp let the
    // older one write its own number back, re-arming every migration above it.
    storeWith(dbPath).close();
    expect(rawMeta(dbPath, "schema_version")).toBe("99");
  });

  it("still migrates a database from the past", () => {
    const dbPath = makeV22Db();
    storeWith(dbPath).close();
    expect(rawMeta(dbPath, "schema_version")).toBe("23");
  });
});
