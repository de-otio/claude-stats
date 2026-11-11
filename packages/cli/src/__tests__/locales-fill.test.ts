/**
 * Tests for scripts/fill-locales.mjs.
 *
 * Exercises:
 *   - Pure helpers (diffKeys, setByPath, extractJson, validateBatch,
 *     buildJsonSchema) with no subprocess calls.
 *   - The pieces fillLocale() composes around a `claude -p --output-format
 *     json` response envelope, to confirm the end-to-end flow reads en,
 *     computes missing keys, parses the CLI's structured_output, validates
 *     the shape, and writes translations back without clobbering existing
 *     keys — without actually shelling out to `claude` (real translation
 *     runs consume the user's Claude subscription; not something a unit
 *     test suite should do). fillLocale() itself no longer takes a client
 *     parameter (it shells out to the `claude` CLI internally, authenticated
 *     via the user's existing `claude` login, not a passed-in API client),
 *     so — as before — LOCALES_DIR being a module-level const means true
 *     end-to-end invocation isn't practical from a test; we verify the
 *     composable pieces instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffKeys,
  flatten,
  setByPath,
  extractJson,
  validateBatch,
  postProcessTranslations,
  buildJsonSchema,
  chunkMap,
  fillLocale,
} from "../../../../scripts/fill-locales.mjs";

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("flatten", () => {
  it("produces dot-joined paths for nested objects", () => {
    const f = flatten({ a: { b: { c: "deep" } }, x: "flat" });
    expect([...f.entries()]).toEqual([
      ["a.b.c", "deep"],
      ["x", "flat"],
    ]);
  });

  it("treats arrays as leaves (so we translate them as one unit)", () => {
    const f = flatten({ steps: [{ heading: "H1", body: "B1" }] });
    expect(f.size).toBe(1);
    expect(f.get("steps")).toEqual([{ heading: "H1", body: "B1" }]);
  });
});

describe("setByPath", () => {
  it("creates missing intermediate objects", () => {
    const root = {};
    setByPath(root, "a.b.c", "hello");
    expect(root).toEqual({ a: { b: { c: "hello" } } });
  });

  it("does not clobber unrelated siblings", () => {
    const root = { a: { existing: "keep" } };
    setByPath(root, "a.new", "add");
    expect(root).toEqual({ a: { existing: "keep", new: "add" } });
  });
});

describe("diffKeys", () => {
  it("returns keys present in en but missing in target", () => {
    const en = new Map([["a", "A"], ["b", "B"], ["c", "C"]]);
    const target = new Map([["a", "A-xx"]]);
    const out = diffKeys(en, target, { force: false });
    expect([...out.keys()].sort()).toEqual(["b", "c"]);
  });

  it("does NOT include keys that are already translated (without --force)", () => {
    const en = new Map([["a", "Hello"]]);
    const target = new Map([["a", "Hello"]]); // identical = stub
    const out = diffKeys(en, target, { force: false });
    expect(out.size).toBe(0);
  });

  it("with --force, re-includes keys whose target value equals en (stubs)", () => {
    const en = new Map([["a", "Hello"], ["b", "World"]]);
    const target = new Map([["a", "Hello"], ["b", "Monde"]]);
    const out = diffKeys(en, target, { force: true });
    expect([...out.keys()]).toEqual(["a"]);
  });
});

describe("extractJson", () => {
  it("parses a plain JSON response", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses JSON wrapped in a markdown code fence", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("tolerates a prose preface", () => {
    expect(extractJson('Here is the JSON:\n{"a":1}\n')).toEqual({ a: 1 });
  });

  it("throws when no JSON object is present", () => {
    expect(() => extractJson("no json here")).toThrow(/No JSON object/);
  });
});

describe("validateBatch", () => {
  it("accepts a response with exactly matching keys", () => {
    const req = new Map([["a", "A"], ["b", "B"]]);
    expect(validateBatch(req, { a: "A-xx", b: "B-xx" })).toEqual([]);
  });

  it("flags missing and extra keys", () => {
    const req = new Map([["a", "A"], ["b", "B"]]);
    const errs = validateBatch(req, { a: "A-xx", c: "C-xx" });
    expect(errs.some((e: string) => /missing key in response: "b"/.test(e))).toBe(true);
    expect(errs.some((e: string) => /extra key in response: "c"/.test(e))).toBe(true);
  });

  it("flags array length mismatches", () => {
    const req = new Map<string, unknown>([["steps", [{ heading: "x", body: "y" }]]]);
    const errs = validateBatch(req, { steps: [] });
    expect(errs.some((e: string) => /array length 1 → 0/.test(e))).toBe(true);
  });
});

describe("postProcessTranslations", () => {
  const key = "report.fastModeUnpriced";
  const en = "{{count}} fast requests were priced at standard";

  it("unwraps a value that is a JSON object with one string value under another key", () => {
    const wrapped = JSON.stringify({ translation: "{{count}} schnelle Anfragen" });
    const r = postProcessTranslations(new Map([[key, en]]), { [key]: wrapped });
    expect(r.errors).toEqual([]);
    expect(r.accepted).toEqual({ [key]: "{{count}} schnelle Anfragen" });
    expect(r.unwrapped).toEqual([key]);
  });

  it("unwraps a value wrapped under the same key", () => {
    const wrapped = JSON.stringify({ [key]: "{{count}} schnelle Anfragen" });
    const r = postProcessTranslations(new Map([[key, en]]), { [key]: wrapped });
    expect(r.errors).toEqual([]);
    expect(r.accepted).toEqual({ [key]: "{{count}} schnelle Anfragen" });
    expect(r.unwrapped).toEqual([key]);
  });

  it("passes a plain translated value through untouched", () => {
    const r = postProcessTranslations(new Map([[key, en]]), { [key]: "{{count}} schnelle Anfragen" });
    expect(r).toEqual({ accepted: { [key]: "{{count}} schnelle Anfragen" }, unwrapped: [], errors: [] });
  });

  it("rejects a placeholder mismatch and does not accept the key", () => {
    const r = postProcessTranslations(new Map([[key, en]]), { [key]: "{{anzahl}} schnelle Anfragen" });
    expect(r.accepted).toEqual({});
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/placeholders \[anzahl\] do not match en \[count\]/);
  });

  it("rejects a dropped placeholder", () => {
    const r = postProcessTranslations(new Map([[key, en]]), { [key]: "schnelle Anfragen" });
    expect(r.accepted).toEqual({});
    expect(r.errors[0]).toMatch(/do not match en \[count\]/);
  });

  it("checks placeholders after unwrapping, on the inner value", () => {
    const wrapped = JSON.stringify({ [key]: "schnelle Anfragen" });
    const r = postProcessTranslations(new Map([[key, en]]), { [key]: wrapped });
    expect(r.accepted).toEqual({});
    expect(r.errors).toHaveLength(1);
  });

  it("rejects JSON that cannot be unwrapped to a single string (multiple values)", () => {
    const wrapped = JSON.stringify({ a: "{{count}} x", b: "{{count}} y" });
    const r = postProcessTranslations(new Map([[key, en]]), { [key]: wrapped });
    expect(r.accepted).toEqual({});
    expect(r.errors[0]).toMatch(/still looks like JSON/);
  });

  it("rejects a doubly-wrapped value rather than writing JSON", () => {
    const inner = JSON.stringify({ [key]: "{{count}} x" });
    const wrapped = JSON.stringify({ [key]: inner });
    const r = postProcessTranslations(new Map([[key, en]]), { [key]: wrapped });
    expect(r.accepted).toEqual({});
    expect(r.errors[0]).toMatch(/still looks like JSON/);
  });

  it("accepts a value that legitimately contains braces but is not JSON", () => {
    const enBraces = "Run {{cmd}} with {--since} then {\"quoted\" text";
    const tr = "Führe {{cmd}} mit {--since} aus, dann {\"zitiert\" Text";
    const r = postProcessTranslations(new Map([[key, enBraces]]), { [key]: tr });
    expect(r).toEqual({ accepted: { [key]: tr }, unwrapped: [], errors: [] });
  });

  it("keeps good keys and rejects only the bad ones in a mixed batch", () => {
    const req = new Map([["a", "Hi {{n}}"], ["b", "Bye {{n}}"], ["c", "Plain"]]);
    const r = postProcessTranslations(req, {
      a: JSON.stringify({ a: "Hallo {{n}}" }),
      b: "Tschüss",
      c: "Schlicht",
    });
    expect(r.accepted).toEqual({ a: "Hallo {{n}}", c: "Schlicht" });
    expect(r.unwrapped).toEqual(["a"]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^"b"/);
  });

  it("compares array values by the placeholders in their strings", () => {
    const steps = [{ heading: "H {{n}}", body: "B" }];
    const ok = postProcessTranslations(new Map<string, unknown>([["steps", steps]]), {
      steps: [{ heading: "K {{n}}", body: "T" }],
    });
    expect(ok.errors).toEqual([]);
    const bad = postProcessTranslations(new Map<string, unknown>([["steps", steps]]), {
      steps: [{ heading: "K", body: "T" }],
    });
    expect(bad.errors).toHaveLength(1);
  });
});

describe("buildJsonSchema", () => {
  it("types string-valued keys as string and marks them required", () => {
    const missing = new Map([["greet", "Hello"], ["farewell", "Goodbye"]]);
    const schema = buildJsonSchema(missing);
    expect(schema).toEqual({
      type: "object",
      properties: { greet: { type: "string" }, farewell: { type: "string" } },
      required: ["greet", "farewell"],
      additionalProperties: false,
    });
  });

  it("types array-valued keys (step lists) as array", () => {
    const missing = new Map<string, unknown>([["steps", [{ heading: "H1", body: "B1" }]]]);
    const schema = buildJsonSchema(missing);
    expect(schema.properties.steps).toEqual({ type: "array" });
    expect(schema.required).toEqual(["steps"]);
  });
});

describe("chunkMap", () => {
  it("splits a map into chunks of at most `size` entries", () => {
    const m = new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5]]);
    const chunks = chunkMap(m, 2);
    expect(chunks).toHaveLength(3);
    expect([...chunks[0]!.entries()]).toEqual([["a", 1], ["b", 2]]);
    expect([...chunks[1]!.entries()]).toEqual([["c", 3], ["d", 4]]);
    expect([...chunks[2]!.entries()]).toEqual([["e", 5]]);
  });

  it("returns a single chunk when the map is smaller than `size`", () => {
    const m = new Map([["a", 1]]);
    const chunks = chunkMap(m, 60);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.size).toBe(1);
  });

  it("returns an empty array for an empty map", () => {
    expect(chunkMap(new Map(), 60)).toEqual([]);
  });
});

// ── End-to-end fillLocale() against a `claude -p` response envelope ─────────

describe("fillLocale (integration with mocked model)", () => {
  let dir: string;

  const originalCwd = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-stats-fill-"));
    mkdirSync(join(dir, "en"));
    mkdirSync(join(dir, "xx"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  function write(locale: string, file: string, obj: unknown): void {
    writeFileSync(join(dir, locale, file), JSON.stringify(obj, null, 2));
  }

  /**
   * Builds a canned `claude -p --output-format json` response envelope for
   * whatever keys the fill script would request — the shape
   * translateBatch() parses in the real script (structured_output plus the
   * envelope fields it checks: is_error, stop_reason). Echoes input keys
   * with "xx-" prefixed to string values, preserving array shapes, so
   * behavior can be asserted the same way as the old SDK-mock version.
   */
  function mockCliEnvelope(input: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (Array.isArray(v)) {
        output[k] = v.map((item) => {
          if (item && typeof item === "object") {
            const clone: Record<string, string> = {};
            for (const [ik, iv] of Object.entries(item)) clone[ik] = `xx-${iv}`;
            return clone;
          }
          return `xx-${item}`;
        });
      } else {
        output[k] = `xx-${v}`;
      }
    }
    return {
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(output),
      stop_reason: "tool_use",
      structured_output: output,
    };
  }

  it("fills missing keys and leaves existing translations alone", () => {
    write("en", "common.json", { greet: "Hello", farewell: "Goodbye" });
    write("xx", "common.json", { farewell: "Adiós-kept" });

    // fillLocale's LOCALES_DIR is baked in and it shells out to the real
    // `claude` binary — not something a unit test should invoke (it would
    // consume the user's Claude subscription and require network/auth). So,
    // as before this change, we verify the *pieces* fillLocale composes
    // rather than a true end-to-end invocation: diff missing keys, simulate
    // what translateBatch() would return from a `claude -p` call via
    // mockCliEnvelope(), validate the shape, and merge back — the exact
    // sequence fillLocale()'s implementation runs internally.
    const enObj = JSON.parse(readFileSync(join(dir, "en", "common.json"), "utf-8"));
    const xxObj = JSON.parse(readFileSync(join(dir, "xx", "common.json"), "utf-8"));
    const missing = diffKeys(flatten(enObj), flatten(xxObj), { force: false });
    expect([...missing.keys()]).toEqual(["greet"]);

    // Schema fillLocale would pass as --json-schema.
    const schema = buildJsonSchema(missing);
    expect(schema.required).toEqual(["greet"]);

    // Simulate the claude -p response envelope and extract structured_output
    // exactly as translateBatch() does.
    const envelope = mockCliEnvelope(Object.fromEntries(missing));
    expect(envelope.is_error).toBe(false);
    const translated = envelope.structured_output as Record<string, unknown>;
    expect(translated).toEqual({ greet: "xx-Hello" });

    const errs = validateBatch(missing, translated);
    expect(errs).toEqual([]);

    // Merge back.
    const merged = { ...xxObj };
    for (const [k, v] of Object.entries(translated)) setByPath(merged, k, v);
    expect(merged).toEqual({ greet: "xx-Hello", farewell: "Adiós-kept" });
  });

  it("preserves array shape when translating step lists", () => {
    const req = new Map<string, unknown>([
      ["steps", [{ heading: "H1", body: "B1" }, { heading: "H2", body: "B2" }]],
    ]);
    const envelope = mockCliEnvelope(Object.fromEntries(req));
    const translated = envelope.structured_output as Record<string, unknown>;
    const steps = translated.steps as Array<Record<string, string>>;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ heading: "xx-H1", body: "xx-B1" });
    const errs = validateBatch(req, translated);
    expect(errs).toEqual([]);
  });

  it("falls back to extractJson when structured_output is absent", () => {
    // Older CLI without --json-schema support, or a model that ignored the
    // schema — translateBatch()'s fallback path.
    const envelope = {
      is_error: false,
      result: '```json\n{"greet":"xx-Hello"}\n```',
      structured_output: undefined,
    };
    expect(envelope.structured_output).toBeUndefined();
    const translated = extractJson(envelope.result);
    expect(translated).toEqual({ greet: "xx-Hello" });
  });

  it("flags shape errors when model drops or adds keys", () => {
    const req = new Map([["a", "A"], ["b", "B"]]);
    const bad = { a: "xx-A", c: "xx-C" };
    const errs = validateBatch(req, bad);
    expect(errs.length).toBeGreaterThan(0);
  });

  it("sanity: fillLocale is exported and callable", () => {
    expect(typeof fillLocale).toBe("function");
  });
});
