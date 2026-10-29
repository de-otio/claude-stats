/**
 * E1 — per-request records from `api-request` lines (schema V28).
 *
 * The bounded head read (`readApiRequestFields`) and its wiring into the
 * parser: adversarial content in `params` changes nothing, `JSON.parse` is
 * never given more than 2,049 characters of an api-request line, the tail is
 * never sliced or parsed, head misses are counted (never thrown, never
 * quarantined), every field is validated where it enters, and `-shape`/`-blob`
 * lines never reach the reader. Assistant `requestRef` is captured and
 * validated on the message records.
 *
 * Spec: plans/claude-code-2.1.311-followup/E1.md §8 tests 1–3, 6, 6b, 7, 8, 9.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseSessionFile } from "@claude-stats/core/parser/session";
import { isPlainApiRequestLine, readApiRequestFields } from "@claude-stats/core/parser/apiRequest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let file: string;
beforeEach(() => {
  file = path.join(os.tmpdir(), `cs-e1-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
});
afterEach(() => {
  try { fs.unlinkSync(file); } catch { /* ok */ }
  vi.restoreAllMocks();
});

const SID = "sess-e1";
const REAL_HASH = "a".repeat(64); // 64 lowercase hex
const FAKE_HASH = "e".repeat(64);
const TS_ISO = "2026-01-01T00:00:00.000Z";
const TS_MS = Date.parse(TS_ISO);

function user(ts: number): string {
  return JSON.stringify({
    type: "user", sessionId: SID, version: "2.1.301", timestamp: ts, uuid: `u-${ts}`,
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
}

function assistant(ts: number, msgId: string, requestRef?: string): string {
  return JSON.stringify({
    type: "assistant", sessionId: SID, version: "2.1.301", timestamp: ts, uuid: `a-${ts}`,
    ...(requestRef !== undefined ? { requestRef } : {}),
    message: {
      id: msgId, model: "claude-opus-4-6", stop_reason: "end_turn", content: [],
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 80 },
    },
  });
}

/** A realistic plain `api-request` line: fixed key order, `params` in the middle, tail at the end. */
function apiRequestLine(o: {
  id?: string;
  agentId?: string;
  timestamp?: string | number;
  shapeHash?: string;
  params?: unknown;
  extraHead?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    type: "api-request",
    sessionId: SID,
    agentId: o.agentId ?? "agent-1",
    id: o.id ?? "req_1",
    timestamp: o.timestamp ?? TS_ISO,
    version: "2.1.301",
    querySource: "repl_main_thread",
    shapeHash: o.shapeHash ?? REAL_HASH,
    ...(o.extraHead ?? {}),
    params: o.params ?? { model: "claude-opus-4-6" },
    keep: { context: "tail" },
    cacheControl: { ephemeral: { type: "ttl", ttl: "5m" } },
    requestDigest: "d".repeat(64),
  });
}

const body = (lines: string[]) => lines.join("\n") + "\n";

async function parse(lines: string[]) {
  fs.writeFileSync(file, body(lines));
  return parseSessionFile(file, "/proj", 0);
}

// ─── §8 test 1 — adversarial content ─────────────────────────────────────────

describe("E1 §8.1 — adversarial content in params changes nothing", () => {
  it("stores the real head fields, not the strings smuggled into params.safeguards", async () => {
    // The strings `,"params":`, `"id":"evil"` and a fake 64-hex `"shapeHash"`
    // inside params.safeguards — JSON-escaped by the writer exactly as the
    // real one would. Inside a JSON string every `"` is escaped, so the byte
    // sequence `,"params":` cannot occur there: the head cut at the FIRST real
    // params key never reaches this content.
    const safeguards =
      'classifier context ,"params": {"id":"evil","shapeHash":"' + FAKE_HASH + '"} trailing';
    const line = apiRequestLine({ id: "req_1", shapeHash: REAL_HASH, params: { safeguards } });
    // On disk the adversarial text is escaped (backslash-quote), so the byte
    // sequence `,"params":` itself never occurs inside the string — see the
    // module doc. The literal below is: ,\"params\":
    expect(line).toContain(',\\"params\\":');
    expect(line.indexOf(',"params":')).toBeLessThan(line.indexOf("safeguards"));

    const r = await parse([user(1_000), line, assistant(2_000, "msg_1", "req_1")]);

    expect(r.apiRequests).toHaveLength(1);
    expect(r.apiRequests[0]).toEqual({
      requestId: "req_1",
      agentId: "agent-1",
      timestamp: TS_MS,
      shapeHash: REAL_HASH,
    });
    expect(r.apiRequestHeadMisses).toBe(0);
    // The assistant row links to the request that was really stored.
    expect(r.messages[0]!.requestRef).toBe("req_1");
  });
});

// ─── §8 test 2 — no full parse ────────────────────────────────────────────────

describe("E1 §8.2 — JSON.parse is never given more than 2,049 characters", () => {
  it("a 300 KB api-request line is read by head only (fixture pinned: every other line is tiny)", async () => {
    const bigParams = { safeguards: "s".repeat(300_000) };
    const line = apiRequestLine({ id: "req_big", params: bigParams });
    expect(Buffer.byteLength(line, "utf8")).toBeGreaterThan(300_000);

    const lines = [user(1_000), line, assistant(2_000, "msg_1", "req_big")];
    fs.writeFileSync(file, body(lines));

    const parseSpy = vi.spyOn(JSON, "parse");
    let r;
    try {
      r = await parseSessionFile(file, "/proj", 0);
    } finally {
      const calls = parseSpy.mock.calls.map((c) => String(c[0]));
      parseSpy.mockRestore();

      expect(r!.apiRequests).toHaveLength(1);
      expect(r!.apiRequests[0]!.requestId).toBe("req_big");
      // The reader ran: one call received an api-request head slice…
      expect(calls.some((a) => a.includes('"api-request"') && a.length <= 2049)).toBe(true);
      // …and NO call — api-request or otherwise — saw more than 2,049
      // characters. The 300 KB line was never handed to JSON.parse whole.
      // (Fable F6: the fixture is pinned — every other line is <200 chars —
      // so the global bound is the meaningful assertion.)
      expect(calls.length).toBeGreaterThan(0);
      expect(Math.max(...calls.map((a) => a.length))).toBeLessThanOrEqual(2049);
    }
  });

  it("the head bound is exactly 2,048 characters before the params key", () => {
    // `,"params":` starting at index 2048 → head slice is 2,049 chars → read.
    // At 2049 → miss.
    const head = '{"type":"api-request","id":"req_1","pad":"';
    const tail = '","params":{"m":1}}';
    const make = (target: number): string => {
      const filler = "x".repeat(target - head.length - 1);
      const line = head + filler + tail;
      expect(line.indexOf(',"params":')).toBe(target); // premise
      return line;
    };
    expect(readApiRequestFields(make(2048))).toMatchObject({ requestId: "req_1" });
    expect(readApiRequestFields(make(2049))).toBeNull();
    expect(readApiRequestFields(make(339))).toMatchObject({ requestId: "req_1" });
  });
});

// ─── §8 test 3 — offsets ─────────────────────────────────────────────────────

describe("E1 §8.3 — incremental resume lands on the same offsets", () => {
  // The conversation, with and without the api-request lines interleaved.
  // "The same offset as A1" means: the mixed file resumes exactly where the
  // plain file does, plus the api-request lines' own bytes — the skip advances
  // the offset exactly as a parsed line would, and yields the same messages.
  const plain = () => [
    user(1_000),
    assistant(2_000, "msg_1", "req_1"),
    user(3_000),
    assistant(4_000, "msg_2", "req_2"),
  ];
  const mixed = () => [
    user(1_000),
    apiRequestLine({ id: "req_1" }),
    assistant(2_000, "msg_1", "req_1"),
    user(3_000),
    apiRequestLine({ id: "req_2" }),
    assistant(4_000, "msg_2", "req_2"),
  ];
  const reqBytes = (lines: string[]): number =>
    lines.filter((l) => l.startsWith('{"type":"api-request"')).reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);

  it("a full parse of the mixed file yields the plain file's messages", async () => {
    fs.writeFileSync(file, body(plain()));
    const plainFull = await parseSessionFile(file, "/proj", 0);
    fs.writeFileSync(file, body(mixed()));
    const mixedFull = await parseSessionFile(file, "/proj", 0);
    expect(mixedFull.messages).toEqual(plainFull.messages);
    expect(mixedFull.lastGoodOffset).toBe(fs.statSync(file).size);
    expect(mixedFull.apiRequests.map((r) => r.requestId)).toEqual(["req_1", "req_2"]);
    expect(mixedFull.apiRequestHeadMisses).toBe(0);
  });

  it("stopping just before, and just after, an api-request line resumes like A1", async () => {
    const plainLines = plain();
    const mixedLines = mixed();
    // Cut the mixed file just BEFORE the first api-request line (after the
    // user line) and just AFTER it. The plain file's equivalent cut is after
    // the same one conversation line.
    for (const mixedCut of [1, 2]) {
      // Phase 1 on the truncated files.
      fs.writeFileSync(file, body(mixedLines.slice(0, mixedCut)));
      const mixedTruncSize = fs.statSync(file).size;
      const m1 = await parseSessionFile(file, "/proj", 0);
      fs.writeFileSync(file, body(plainLines.slice(0, 1)));
      const p1 = await parseSessionFile(file, "/proj", 0);

      // Same messages (both empty: the cut is before the first assistant).
      expect(m1.messages).toEqual(p1.messages);
      // The truncated mixed file is fully consumed.
      expect(m1.lastGoodOffset).toBe(mixedTruncSize);
      // The offset lands exactly where A1's does, plus the api-request
      // lines' own bytes — the resume point is the next line's first byte.
      expect(m1.lastGoodOffset).toBe(p1.lastGoodOffset + reqBytes(mixedLines.slice(0, mixedCut)));

      // Phase 2 over the full files, from each phase-1 offset.
      fs.writeFileSync(file, body(mixedLines));
      const m2 = await parseSessionFile(file, "/proj", m1.lastGoodOffset);
      fs.writeFileSync(file, body(plainLines));
      const p2 = await parseSessionFile(file, "/proj", p1.lastGoodOffset);

      // Same messages as A1's two-phase parse of the plain file (promptText
      // and isTurnStart are range-local by design; both phases agree here).
      expect([...m1.messages, ...m2.messages]).toEqual([...p1.messages, ...p2.messages]);
      // Both land on their own file's end — the final offset is the full size.
      expect(m2.lastGoodOffset).toBe(Buffer.byteLength(body(mixedLines), "utf8"));
      expect(p2.lastGoodOffset).toBe(Buffer.byteLength(body(plainLines), "utf8"));
      // The api-request rows split across the two runs are both present.
      expect([...m1.apiRequests, ...m2.apiRequests].map((r) => r.requestId).sort())
        .toEqual(["req_1", "req_2"]);
      expect(m1.apiRequestHeadMisses + m2.apiRequestHeadMisses).toBe(0);
      expect(m1.errors).toEqual([]);
      expect(m2.errors).toEqual([]);
    }
  });
});

// ─── §8 test 6 / 6b — head misses ────────────────────────────────────────────

describe("E1 §8.6 — a head miss is counted, never thrown", () => {
  it("no params key in the first 2,048 characters: no row, miss counted, offset advances", async () => {
    const filler = "q".repeat(3_000);
    const lateParams = JSON.stringify({
      type: "api-request", sessionId: SID, id: "req_late", timestamp: TS_ISO, fillerKey: filler,
      params: { model: "m" },
    });
    expect(lateParams.indexOf(',"params":')).toBeGreaterThan(2048); // premise
    const noParams = JSON.stringify({
      type: "api-request", sessionId: SID, id: "req_none", timestamp: TS_ISO,
    });
    expect(noParams.indexOf(',"params":')).toBe(-1); // premise

    const r = await parse([user(1_000), lateParams, noParams, assistant(2_000, "msg_1")]);

    expect(r.apiRequests).toHaveLength(0);
    expect(r.apiRequestHeadMisses).toBe(2);
    expect(r.errors).toEqual([]); // never quarantined
    expect(r.lastGoodOffset).toBe(fs.statSync(file).size); // offset advanced past both
    expect(r.messages).toHaveLength(1);
  });
});

describe("E1 §8.6b — a head-parse throw is a miss, not an abort (Fable F1)", () => {
  it("a nested params key in the head (slice ends mid-object): no throw, miss counted, offset advances", async () => {
    // The FIRST `,"params":` is a nested key inside an earlier head value (it
    // follows a sibling, so the comma is really there). The slice ends just
    // before it and appends `}` — which closes the INNER object only, leaving
    // the outer one unclosed — so JSON.parse throws inside the reader's
    // try/catch, which returns null.
    const line = '{"type":"api-request","sessionId":"' + SID + '","id":"req_1","wrapper":{"x":1,"params":2},"params":{"model":"m"}}';
    expect(line.indexOf(',"params":')).toBe(line.indexOf('"params":2') - 1); // premise: the nested key, not the real one
    // If the reader threw, this await would reject and the test would fail —
    // the no-throw property is proven by the parse resolving at all.
    const r = await parse([user(1_000), line, assistant(2_000, "msg_1")]);

    expect(r.apiRequests).toHaveLength(0);
    expect(r.apiRequestHeadMisses).toBe(1);
    expect(r.errors).toEqual([]);
    expect(r.lastGoodOffset).toBe(fs.statSync(file).size);
    expect(r.messages).toHaveLength(1); // the rest of the file parsed fine
  });

  it("a raw control character inside a head string: same miss path", async () => {
    // \u0001 is not a line terminator, so the line survives readline intact —
    // and is invalid JSON for the head slice.
    const line = '{"type":"api-request","sessionId":"' + SID + '","id":"req_1","querySource":"a\u0001b","params":{"model":"m"}}';
    const r = await parse([user(1_000), line, assistant(2_000, "msg_1")]);
    expect(r.apiRequests).toHaveLength(0);
    expect(r.apiRequestHeadMisses).toBe(1);
    expect(r.errors).toEqual([]);
    expect(r.lastGoodOffset).toBe(fs.statSync(file).size);
  });
});

// ─── §8 test 7 — no tail read ────────────────────────────────────────────────

describe("E1 §8.7 — the tail is never sliced or parsed (Fable F2 silence rule)", () => {
  it("a truncated cacheControl tail still stores the row, with zero error output of any kind", async () => {
    // The line ends mid-object inside the tail. It is not valid JSON overall,
    // but an api-request* line's only completeness test is newline termination.
    const line =
      '{"type":"api-request","sessionId":"' + SID + '","agentId":"agent-1","id":"req_1",' +
      '"timestamp":"' + TS_ISO + '","version":"2.1.301","shapeHash":"' + REAL_HASH + '",' +
      '"params":{"model":"m"},"cacheControl":{"ephemeral":{"type":"ttl","ttl":"';
    const lines = [user(1_000), line, assistant(2_000, "msg_1", "req_1")];
    fs.writeFileSync(file, body(lines));

    const parseSpy = vi.spyOn(JSON, "parse");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let r;
    try {
      r = await parseSessionFile(file, "/proj", 0);
    } finally {
      const args = parseSpy.mock.calls.map((c) => String(c[0]));
      parseSpy.mockRestore();
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();

      // The row is stored, with shape_hash from the head.
      expect(r!.apiRequests).toHaveLength(1);
      expect(r!.apiRequests[0]).toEqual({
        requestId: "req_1",
        agentId: "agent-1",
        timestamp: TS_MS,
        shapeHash: REAL_HASH,
      });
      // No call's argument starts with the tail — the tail was never sliced.
      expect(args.some((a) => a.startsWith('{"cacheControl"'))).toBe(false);
      // Zero error output of any kind: no quarantine, no console output.
      expect(r!.errors).toEqual([]);
      expect(r!.apiRequestHeadMisses).toBe(0);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
    }
  });
});

// ─── §8 test 8 — validation ──────────────────────────────────────────────────

describe("E1 §8.8 — every field is validated where it enters", () => {
  it("a non-hex or short shapeHash → NULL with the row kept", async () => {
    const upper = await parse([apiRequestLine({ id: "req_upper", shapeHash: "A".repeat(64) })]);
    expect(upper.apiRequests).toHaveLength(1);
    expect(upper.apiRequests[0]!.shapeHash).toBeNull();
    expect(upper.apiRequests[0]!.requestId).toBe("req_upper");

    const short = await parse([apiRequestLine({ id: "req_short", shapeHash: "abc" })]);
    expect(short.apiRequests).toHaveLength(1);
    expect(short.apiRequests[0]!.shapeHash).toBeNull();
  });

  it("an agentId with a control character → NULL, row kept", async () => {
    const r = await parse([apiRequestLine({ id: "req_agent", agentId: "ag\u0001ent" })]);
    expect(r.apiRequests).toHaveLength(1);
    expect(r.apiRequests[0]!.agentId).toBeNull();
    expect(r.apiRequests[0]!.requestId).toBe("req_agent");
  });

  it("an id with a space → no row at all (invalid PK), counted as a miss", async () => {
    const r = await parse([apiRequestLine({ id: "req 1" })]);
    expect(r.apiRequests).toHaveLength(0);
    expect(r.apiRequestHeadMisses).toBe(1);
  });

  it("unknown extra keys in the head are ignored, row stored", async () => {
    const r = await parse([
      apiRequestLine({ id: "req_extra", extraHead: { futureField: "x", another: { nested: [1, 2] } } }),
    ]);
    expect(r.apiRequests).toHaveLength(1);
    expect(r.apiRequests[0]).toEqual({
      requestId: "req_extra",
      agentId: "agent-1",
      timestamp: TS_MS,
      shapeHash: REAL_HASH,
    });
    expect(r.apiRequestHeadMisses).toBe(0);
  });

  it("timestamps: ISO string → epoch-ms, number → passthrough, garbage → NULL", async () => {
    const iso = await parse([apiRequestLine({ id: "req_ts1", timestamp: TS_ISO })]);
    expect(iso.apiRequests[0]!.timestamp).toBe(TS_MS);
    const num = await parse([apiRequestLine({ id: "req_ts2", timestamp: 1_700_000_000_000 })]);
    expect(num.apiRequests[0]!.timestamp).toBe(1_700_000_000_000);
    const garbage = await parse([apiRequestLine({ id: "req_ts3", timestamp: "not a date" })]);
    expect(garbage.apiRequests[0]!.timestamp).toBeNull();
  });
});

// ─── §8 test 9 — shape/blob exclusion ────────────────────────────────────────

describe("E1 §8.9 — api-request-shape and api-request-blob never produce a row", () => {
  it("only plain api-request lines reach the reader", async () => {
    expect(isPlainApiRequestLine('{"type":"api-request","id":"x"}')).toBe(true);
    expect(isPlainApiRequestLine('{"type":"api-request-shape","id":"x"}')).toBe(false);
    expect(isPlainApiRequestLine('{"type":"api-request-blob","id":"x"}')).toBe(false);
    expect(isPlainApiRequestLine('{"type":"api-requests"}')).toBe(false);

    // Both variants carry a perfectly readable head — the A1 prefix test
    // routes them away before the reader is called.
    const shape = JSON.stringify({
      type: "api-request-shape", sessionId: SID, id: "req_shape", shapeHash: REAL_HASH,
      params: { model: "m" }, shape: { tools: [] },
    });
    const blob = JSON.stringify({
      type: "api-request-blob", sessionId: SID, id: "req_blob", shapeHash: REAL_HASH,
      params: { model: "m" }, hash: "h",
    });
    const r = await parse([
      user(1_000), shape, blob, apiRequestLine({ id: "req_plain" }), assistant(2_000, "msg_1", "req_plain"),
    ]);
    expect(r.apiRequests.map((x) => x.requestId)).toEqual(["req_plain"]);
    expect(r.apiRequestHeadMisses).toBe(0);
    expect(r.errors).toEqual([]);
  });
});

// ─── requestRef on assistant messages ────────────────────────────────────────

describe("E1 — assistant requestRef is captured and validated", () => {
  it("a valid requestRef lands on the message record; invalid or absent → null", async () => {
    const r = await parse([
      user(1_000),
      assistant(2_000, "msg_1", "req_1"),
      assistant(3_000, "msg_2", "bad ref"), // space → invalid identifier
      assistant(4_000, "msg_3"),             // absent
    ]);
    expect(r.messages.map((m) => m.requestRef)).toEqual(["req_1", null, null]);
  });

  it("a file with no api-request lines still carries the (empty) result fields", async () => {
    const r = await parse([user(1_000), assistant(2_000, "msg_1")]);
    expect(r.apiRequests).toEqual([]);
    expect(r.apiRequestHeadMisses).toBe(0);
    expect(r.unprefixedApiRequestLines).toBe(0);
  });
});
