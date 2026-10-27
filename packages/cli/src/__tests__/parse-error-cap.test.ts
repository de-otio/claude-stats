/**
 * Parse-error records keep only the head of an unparseable line.
 *
 * A bad line can be 100 KB+ of tool output; storing it whole made the
 * quarantine table a second copy of transcript content. The head (200 bytes)
 * plus the original byte length travels in the existing `error` text, so no
 * schema change is needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { parseSessionFile, capRawLine, RAW_LINE_CAP_BYTES } from "@claude-stats/core/parser/session";
import { Store } from "../store/index.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cs-errcap-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const good = (ts: number) =>
  JSON.stringify({ type: "user", sessionId: "s", timestamp: ts, uuid: `u-${ts}`, message: { role: "user", content: "hi" } });

describe("capRawLine", () => {
  it("leaves a line within the cap untouched and reports no original length", () => {
    expect(capRawLine("{short")).toEqual({ text: "{short", originalBytes: null });
    const exact = "x".repeat(RAW_LINE_CAP_BYTES);
    expect(capRawLine(exact)).toEqual({ text: exact, originalBytes: null });
  });

  it("cuts a long line to the cap and reports its byte length", () => {
    const r = capRawLine("y".repeat(5_000));
    expect(r.text).toBe("y".repeat(RAW_LINE_CAP_BYTES));
    expect(r.originalBytes).toBe(5_000);
  });

  it("never splits a multi-byte character, whichever byte the cap lands on", () => {
    // "é" is 2 bytes, an emoji 4; vary the lead-in so the cut hits every offset.
    for (const unit of ["é", "€", "😀"]) {
      for (let lead = 0; lead < 4; lead++) {
        const raw = "a".repeat(lead) + unit.repeat(300);
        const r = capRawLine(raw);
        expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(RAW_LINE_CAP_BYTES);
        expect(r.text).not.toContain("�");
        expect(raw.startsWith(r.text)).toBe(true); // a clean prefix, whole characters only
        expect(r.originalBytes).toBe(Buffer.byteLength(raw, "utf8"));
      }
    }
  });
});

describe("parse errors stored in quarantine", () => {
  it("a 1 MB malformed line is stored as at most 200 bytes plus its length", async () => {
    const file = path.join(root, "s.jsonl");
    const huge = '{"type":"user","message":' + "q".repeat(1_048_576); // never closed
    fs.writeFileSync(file, [good(1_000), huge, good(2_000)].join("\n") + "\n");

    const parsed = await parseSessionFile(file, "/proj", 0);
    expect(parsed.errors).toHaveLength(1);
    expect(Buffer.byteLength(parsed.errors[0]!.rawLine, "utf8")).toBeLessThanOrEqual(RAW_LINE_CAP_BYTES);

    const dbPath = path.join(root, "stats.db");
    const store = new Store(dbPath);
    try {
      store.addToQuarantine(parsed.errors);
    } finally {
      store.close();
    }
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT raw_line, error FROM quarantine").all() as Array<{ raw_line: string; error: string }>;
      expect(rows).toHaveLength(1);
      expect(Buffer.byteLength(rows[0]!.raw_line, "utf8")).toBeLessThanOrEqual(200);
      expect(rows[0]!.raw_line.startsWith('{"type":"user","message":')).toBe(true);
      expect(rows[0]!.error).toContain(`line is ${Buffer.byteLength(huge, "utf8")} bytes`);
    } finally {
      db.close();
    }
  });

  it("a short malformed line is stored whole, with its error text unchanged", async () => {
    const file = path.join(root, "s.jsonl");
    fs.writeFileSync(file, [good(1_000), "{not json", good(2_000)].join("\n") + "\n");
    const parsed = await parseSessionFile(file, "/proj", 0);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]!.rawLine).toBe("{not json");
    expect(parsed.errors[0]!.error).not.toContain("bytes;");
  });
});
