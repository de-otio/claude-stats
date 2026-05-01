import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildFingerprint,
  diffFingerprints,
  hasDiff,
  checkSchema,
} from "../schema/monitor.js";
import type { RawSessionEntry, SchemaFingerprint } from "@claude-stats/core/types";
import { Store } from "../store/index.js";
import os from "os";
import path from "path";
import fs from "fs";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<RawSessionEntry> = {}): RawSessionEntry {
  return {
    type: "assistant",
    sessionId: "sess-1",
    version: "2.1.70",
    timestamp: 1000,
    uuid: "msg-1",
    message: {
      model: "claude-opus-4-6",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    ...overrides,
  };
}

function makeFp(
  version: string,
  types: string[],
  fields: Record<string, string[]>,
  usageFields: string[]
): SchemaFingerprint {
  return {
    claudeVersion: version,
    capturedAt: Date.now(),
    messageTypes: types,
    fieldsByType: fields,
    usageFields,
  };
}

// ── buildFingerprint ─────────────────────────────────────────────────────────

describe("buildFingerprint", () => {
  it("collects message types from entries", () => {
    const entries = [
      makeEntry({ type: "assistant" }),
      makeEntry({ type: "user" }),
    ];
    const fp = buildFingerprint("2.1.70", entries);
    expect(fp.messageTypes).toEqual(["assistant", "user"]);
  });

  it("uses __unknown__ for entries without a type", () => {
    const entry: RawSessionEntry = { sessionId: "s" };
    const fp = buildFingerprint("2.1.70", [entry]);
    expect(fp.messageTypes).toContain("__unknown__");
  });

  it("collects top-level field names per type", () => {
    const entry = makeEntry({ type: "assistant" });
    const fp = buildFingerprint("2.1.70", [entry]);
    const fields = fp.fieldsByType["assistant"];
    expect(fields).toContain("type");
    expect(fields).toContain("sessionId");
    expect(fields).toContain("message");
  });

  it("collects usage fields", () => {
    const fp = buildFingerprint("2.1.70", [makeEntry()]);
    expect(fp.usageFields).toContain("input_tokens");
    expect(fp.usageFields).toContain("output_tokens");
  });

  it("sorts all lists for stable comparison", () => {
    const entries = [
      makeEntry({ type: "user" }),
      makeEntry({ type: "assistant" }),
    ];
    const fp = buildFingerprint("2.1.70", entries);
    expect(fp.messageTypes).toEqual([...fp.messageTypes].sort());
  });

  it("handles entries with no usage", () => {
    const entry: RawSessionEntry = { type: "user", sessionId: "s" };
    const fp = buildFingerprint("2.1.70", [entry]);
    expect(fp.usageFields).toEqual([]);
  });
});

// ── diffFingerprints ─────────────────────────────────────────────────────────

describe("diffFingerprints", () => {
  it("reports no diff when fingerprints are equal", () => {
    const fp = makeFp("2.1.70", ["assistant"], { assistant: ["type", "uuid"] }, ["input_tokens"]);
    const diff = diffFingerprints(fp, fp);
    expect(hasDiff(diff)).toBe(false);
  });

  it("detects added message type", () => {
    const old = makeFp("2.1.70", ["assistant"], { assistant: ["type"] }, []);
    const newFp = makeFp("2.1.71", ["assistant", "checkpoint"], { assistant: ["type"], checkpoint: ["id"] }, []);
    const diff = diffFingerprints(newFp, old);
    expect(diff.addedTypes).toContain("checkpoint");
    expect(hasDiff(diff)).toBe(true);
  });

  it("detects removed message type", () => {
    const old = makeFp("2.1.70", ["assistant", "progress"], { assistant: ["type"], progress: ["data"] }, []);
    const newFp = makeFp("2.1.71", ["assistant"], { assistant: ["type"] }, []);
    const diff = diffFingerprints(newFp, old);
    expect(diff.removedTypes).toContain("progress");
  });

  it("detects added field in existing type", () => {
    const old = makeFp("2.1.70", ["assistant"], { assistant: ["type", "uuid"] }, []);
    const newFp = makeFp("2.1.71", ["assistant"], { assistant: ["type", "uuid", "requestId"] }, []);
    const diff = diffFingerprints(newFp, old);
    expect(diff.addedFields["assistant"]).toContain("requestId");
  });

  it("detects added usage field", () => {
    const old = makeFp("2.1.70", ["assistant"], {}, ["input_tokens"]);
    const newFp = makeFp("2.1.71", ["assistant"], {}, ["input_tokens", "thinking_tokens"]);
    const diff = diffFingerprints(newFp, old);
    expect(diff.addedUsageFields).toContain("thinking_tokens");
  });

  it("detects removed usage field", () => {
    const old = makeFp("2.1.70", ["assistant"], {}, ["input_tokens", "legacy_field"]);
    const newFp = makeFp("2.1.71", ["assistant"], {}, ["input_tokens"]);
    const diff = diffFingerprints(newFp, old);
    expect(diff.removedUsageFields).toContain("legacy_field");
  });
});

// ── checkSchema ──────────────────────────────────────────────────────────────

describe("checkSchema", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `cs-schema-test-${Date.now()}.db`);
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ok */ }
  });

  it("returns isNew=true for first-time version", () => {
    const entries = [makeEntry()];
    const result = checkSchema(store, "2.1.70", entries);
    expect(result).not.toBeNull();
    expect(result!.isNew).toBe(true);
  });

  it("returns null when schema is unchanged", () => {
    const entries = [makeEntry()];
    checkSchema(store, "2.1.70", entries); // store initial
    const result = checkSchema(store, "2.1.70", entries); // same entries
    expect(result).toBeNull();
  });

  it("returns diff when schema changes", () => {
    checkSchema(store, "2.1.70", [makeEntry()]);
    const newEntry = makeEntry({ requestId: "req-123" } as RawSessionEntry);
    const result = checkSchema(store, "2.1.70", [newEntry]);
    expect(result).not.toBeNull();
    expect(hasDiff(result!)).toBe(true);
  });

  it("returns null for empty version string", () => {
    expect(checkSchema(store, "", [makeEntry()])).toBeNull();
  });

  it("returns null for empty entries", () => {
    expect(checkSchema(store, "2.1.70", [])).toBeNull();
  });
});
