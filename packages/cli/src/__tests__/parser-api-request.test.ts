/**
 * `api-request*` lines are skipped by a prefix test before JSON.parse.
 *
 * The skip must be invisible: same messages, same session totals, same byte
 * offsets (so incremental resume lands in the same place), and it must not
 * swallow any other record type that merely starts with the same letters.
 * A skipped line is never parsed, so a MALFORMED api-request line is the probe
 * that tells "skipped" from "parsed": the former yields no parse error.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseSessionFile, isApiRequestLine } from "@claude-stats/core/parser/session";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let file: string;
beforeEach(() => {
  file = path.join(os.tmpdir(), `cs-apireq-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
});
afterEach(() => {
  try { fs.unlinkSync(file); } catch { /* ok */ }
});

const SID = "sess-apireq";

function user(ts: number): string {
  return JSON.stringify({
    type: "user", sessionId: SID, version: "2.1.311", timestamp: ts, uuid: `u-${ts}`,
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
}

function assistant(ts: number, msgId: string): string {
  return JSON.stringify({
    type: "assistant", sessionId: SID, version: "2.1.311", timestamp: ts, uuid: `a-${ts}`,
    message: {
      id: msgId, model: "claude-opus-4-6", stop_reason: "end_turn", content: [],
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 80 },
    },
  });
}

function apiRequest(kind: "api-request" | "api-request-shape" | "api-request-blob", ts: number, padding = 0): string {
  return JSON.stringify({ type: kind, sessionId: SID, timestamp: ts, version: "2.1.311", shape: "x".repeat(padding) });
}

/** The conversation lines, and the same lines with api-request records interleaved. */
function conversation(): string[] {
  return [user(1_000), assistant(2_000, "msg_1"), user(3_000), assistant(4_000, "msg_2")];
}
function interleaved(): string[] {
  const c = conversation();
  return [
    apiRequest("api-request-shape", 1_000, 200),
    apiRequest("api-request-blob", 1_000, 50),
    c[0]!,
    apiRequest("api-request", 1_000, 100_000), // a big one
    c[1]!,
    apiRequest("api-request", 3_000),
    c[2]!,
    apiRequest("api-request", 3_000, 5_000),
    c[3]!,
    apiRequest("api-request-shape", 4_000),
  ];
}
const body = (lines: string[]) => lines.join("\n") + "\n";

describe("isApiRequestLine", () => {
  it("matches the three variants and nothing that merely shares the letters", () => {
    expect(isApiRequestLine('{"type":"api-request","id":"x"}')).toBe(true);
    expect(isApiRequestLine('{"type":"api-request-shape","shapeHash":"x"}')).toBe(true);
    expect(isApiRequestLine('{"type":"api-request-blob","hash":"x"}')).toBe(true);
    expect(isApiRequestLine('{"type":"api-requests"}')).toBe(false);
    expect(isApiRequestLine('{"type":"api-request-x"}')).toBe(false);
    expect(isApiRequestLine('{"type":"api-request-shapes"}')).toBe(false);
    expect(isApiRequestLine('{"type":"api-requestfoo"}')).toBe(false);
    expect(isApiRequestLine('{"type":"api-reques"}')).toBe(false);
    expect(isApiRequestLine('{"type":"assistant"}')).toBe(false);
    expect(isApiRequestLine(' {"type":"api-request"}')).toBe(false);
    expect(isApiRequestLine("")).toBe(false);
  });
});

describe("parseSessionFile — api-request lines are skipped", () => {
  it("yields identical messages, session totals and offset with and without them", async () => {
    fs.writeFileSync(file, body(conversation()));
    const plain = await parseSessionFile(file, "/proj", 0);

    fs.writeFileSync(file, body(interleaved()));
    const mixed = await parseSessionFile(file, "/proj", 0);

    expect(plain.messages).toHaveLength(2);
    expect(mixed.messages).toEqual(plain.messages);
    expect(mixed.session).toEqual(plain.session);
    expect(mixed.errors).toEqual([]);
    expect(mixed.lastGoodOffset).toBe(fs.statSync(file).size);
  });

  it("does not parse a skipped line: a malformed one produces no parse error", async () => {
    const lines = [
      user(1_000),
      '{"type":"api-request","params":{ this is not json',
      '{"type":"api-request-shape" garbage',
      '{"type":"api-request-blob" garbage',
      assistant(2_000, "msg_1"),
    ];
    fs.writeFileSync(file, body(lines));
    const r = await parseSessionFile(file, "/proj", 0);
    expect(r.errors).toEqual([]);
    expect(r.messages).toHaveLength(1);
    expect(r.lastGoodOffset).toBe(fs.statSync(file).size);
  });

  it("does not skip other types that merely start with the same letters", async () => {
    const lines = [
      user(1_000),
      '{"type":"api-requests" garbage',
      '{"type":"api-request-x" garbage',
      '{"type":"api-request-shapes" garbage',
      '{"type":"api-requestfoo" garbage',
      assistant(2_000, "msg_1"),
    ];
    fs.writeFileSync(file, body(lines));
    const r = await parseSessionFile(file, "/proj", 0);
    // Each of the four was parsed (and failed), not skipped.
    expect(r.errors.map((e) => e.lineNumber)).toEqual([2, 3, 4, 5]);
    expect(r.messages).toHaveLength(1);
  });

  it("a well-formed record of a lookalike type is still processed as before", async () => {
    // Parsed (not skipped), then ignored by type: no error, no message.
    const lookalike = JSON.stringify({ type: "api-requests", sessionId: SID, timestamp: 1_500 });
    fs.writeFileSync(file, body([user(1_000), lookalike, assistant(2_000, "msg_1")]));
    const r = await parseSessionFile(file, "/proj", 0);
    expect(r.errors).toEqual([]);
    expect(r.messages).toHaveLength(1);
    expect(r.session!.lastTimestamp).toBe(2_000);
  });

  it("incremental resume gives the same result as one pass, offsets included", async () => {
    const all = interleaved();
    fs.writeFileSync(file, body(all));
    const full = await parseSessionFile(file, "/proj", 0);

    // First collect sees the file up to and including an api-request line...
    const cut = 6;
    fs.writeFileSync(file, body(all.slice(0, cut)));
    const first = await parseSessionFile(file, "/proj", 0);
    expect(first.lastGoodOffset).toBe(fs.statSync(file).size);

    // ...then the file grows and the second collect resumes from the offset.
    fs.writeFileSync(file, body(all));
    const second = await parseSessionFile(file, "/proj", first.lastGoodOffset);

    expect([...first.messages, ...second.messages]).toEqual(full.messages);
    expect(second.lastGoodOffset).toBe(full.lastGoodOffset);
    expect(second.lastGoodOffset).toBe(fs.statSync(file).size);
  });

  it("a torn (partial-write) final api-request line is withheld, not consumed", async () => {
    const complete = body([user(1_000), assistant(2_000, "msg_1")]);
    const torn = '{"type":"api-request","params":{"model":"x"'; // no closing brace, no newline
    fs.writeFileSync(file, complete + torn);
    const r = await parseSessionFile(file, "/proj", 0);
    expect(r.lastGoodOffset).toBe(Buffer.byteLength(complete));
    expect(r.errors).toEqual([]);

    // Once the write completes, the next collect picks up from the same offset.
    const done = '{"type":"api-request","params":{"model":"x"}}\n';
    fs.writeFileSync(file, complete + done);
    const next = await parseSessionFile(file, "/proj", r.lastGoodOffset);
    expect(next.lastGoodOffset).toBe(fs.statSync(file).size);
    expect(next.errors).toEqual([]);
  });

  it("a complete final api-request line advances the offset to end of file", async () => {
    fs.writeFileSync(file, body([user(1_000), assistant(2_000, "msg_1"), apiRequest("api-request", 2_000)]));
    const r = await parseSessionFile(file, "/proj", 0);
    expect(r.lastGoodOffset).toBe(fs.statSync(file).size);
  });
});
