/**
 * Tool-name redaction in the AppSync JS resolvers `syncAggregate` (write path)
 * and `myStats` (read path).
 *
 * The resolvers run on the APPSYNC_JS 1.0.0 runtime, deployed unbundled, and
 * import only `@aws-appsync/utils` — which is not installed in this repo, so it
 * is mocked here with just the surface the two resolvers use. These tests
 * exercise the resolvers' logic under Node; they are NOT a substitute for
 * `aws appsync evaluate-code --runtime name=APPSYNC_JS,runtimeVersion=1.0.0`,
 * which is the real compile gate and a human step (needs AWS credentials).
 *
 * Covered:
 *  - syncAggregate.request rewrites raw tool names to built-in / "mcp" /
 *    "custom" BEFORE the entry-count and key-length limits, summing
 *    collisions, so an old client's raw names neither reach DynamoDB nor
 *    reject the batch;
 *  - myStats.response buckets a stored legacy row so it is never served raw;
 *  - pin: both resolvers' inlined built-in list equals core's
 *    `BUILT_IN_TOOL_NAMES` exactly (parsed from source AND checked by
 *    behaviour);
 *  - a static lint for the APPSYNC_JS constructs that have each cost a
 *    publish → deploy → rollback cycle before.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN_TOOL_NAMES } from "@claude-stats/core/identifiers";

class AppSyncError extends Error {
  constructor(
    message: string,
    readonly errorType: string,
  ) {
    super(message);
  }
}

vi.mock("@aws-appsync/utils", () => ({
  util: {
    error: (message: string, type: string) => {
      throw new AppSyncError(message, type);
    },
    time: {
      nowEpochMilliSeconds: () => 1_768_478_400_000, // 2026-01-15T12:00:00Z, pinned
      epochMilliSecondsToFormatted: (ms: number) => new Date(ms).toISOString().slice(0, 10),
    },
    // Identity: the tests inspect the record the resolver built, not its
    // DynamoDB attribute-value encoding.
    dynamodb: { toMapValues: (v: unknown) => v },
  },
}));
vi.mock("@aws-appsync/utils/dynamodb", () => ({
  query: (q: unknown) => ({ operation: "Query", ...(q as object) }),
}));

// @ts-expect-error — plain-JS resolver module, no type declarations.
import * as syncAggregate from "../../../graphql/resolvers/js/syncAggregate.js";
// @ts-expect-error — plain-JS resolver module, no type declarations.
import * as myStats from "../../../graphql/resolvers/js/myStats.js";

const resolverDir = join(dirname(fileURLToPath(import.meta.url)), "../../../graphql/resolvers/js");
const RESOLVERS = ["syncAggregate.js", "myStats.js"] as const;
const source = (file: string): string => readFileSync(join(resolverDir, file), "utf8");

const ALLOWED_KEYS = new Set<string>([...BUILT_IN_TOOL_NAMES, "mcp", "custom"]);

function aggregateItem(toolUseCounts: unknown, over: Record<string, unknown> = {}) {
  return {
    period: "2026-01-15",
    projectId: null,
    sessionCount: 1,
    subagentSessionCount: 0,
    promptCount: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    activeMinutes: 1,
    toolUseCounts,
    models: ["claude-sonnet-4"],
    accountId: "acct-hash",
    estimatedCost: 0.01,
    _version: 0,
    ...over,
  };
}

interface TransactItem {
  attributeValues: { toolUseCounts: unknown };
}

/** Run syncAggregate.request on items; return the stored toolUseCounts per item. */
function storedToolCounts(...items: unknown[]): unknown[] {
  const out = syncAggregate.request({ args: { input: items }, identity: { sub: "user-1" } }) as {
    transactItems: TransactItem[];
  };
  return out.transactItems.map((t) => t.attributeValues.toolUseCounts);
}

function expectValidationError(fn: () => unknown, message: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(AppSyncError);
  expect((caught as AppSyncError).message).toBe(message);
  expect((caught as AppSyncError).errorType).toBe("ValidationError");
}

// ── syncAggregate (write path) ──────────────────────────────────────────────

describe("syncAggregate.request — toolUseCounts redaction", () => {
  it("stores built-in names verbatim and buckets mcp__ / custom names, summing collisions", () => {
    const [stored] = storedToolCounts(
      aggregateItem({
        Read: 3,
        Edit: 1,
        "mcp__AcmeCorp__query": 2,
        "mcp__globex-internal__search": 5,
        InitechDeploy: 1,
        "umbrella-labs-tool": 4,
      }),
    );
    expect(stored).toEqual({ Read: 3, Edit: 1, mcp: 7, custom: 5 });
    expect(JSON.stringify(stored)).not.toContain("AcmeCorp");
    expect(JSON.stringify(stored)).not.toContain("globex");
  });

  it("accepts the AWSJSON string form too", () => {
    const [stored] = storedToolCounts(aggregateItem(JSON.stringify({ Bash: 2, "mcp__AcmeCorp__x": 1 })));
    expect(stored).toEqual({ Bash: 2, mcp: 1 });
  });

  it("100 distinct mcp__ names (over MAX_TOOL_ENTRIES before bucketing) now PASS as one 'mcp' entry", () => {
    const counts: Record<string, number> = {};
    Array.from({ length: 100 }, (_, i) => {
      counts[`mcp__globex-internal-${i}__tool`] = 1;
    });
    const [stored] = storedToolCounts(aggregateItem(counts));
    expect(stored).toEqual({ mcp: 100 });
  });

  it("an over-long raw name (over MAX_TOOL_NAME_LENGTH before bucketing) now PASSES as 'mcp' / 'custom'", () => {
    const long = "x".repeat(200);
    const [stored] = storedToolCounts(aggregateItem({ [`mcp__${long}__t`]: 1, [`AcmeCorp${long}`]: 2 }));
    expect(stored).toEqual({ mcp: 1, custom: 2 });
  });

  it("prototype-key names are bucketed as custom and cannot corrupt the tally", () => {
    const raw = JSON.parse('{"__proto__":2,"constructor":3,"toString":1,"hasOwnProperty":1,"Read":1}') as unknown;
    const [stored] = storedToolCounts(aggregateItem(raw));
    expect(stored).toEqual({ custom: 7, Read: 1 });
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
  });

  it("every stored key is a built-in name, 'mcp' or 'custom' across a batch", () => {
    const stored = storedToolCounts(
      aggregateItem({ Grep: 1, "mcp__a__b": 1 }),
      aggregateItem({ "vandelay-import": 2, WebFetch: 1 }, { period: "2026-01-16" }),
    );
    for (const s of stored) {
      for (const key of Object.keys(s as object)) expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
  });

  it("keeps null/undefined toolUseCounts as-is (no counts sent)", () => {
    expect(storedToolCounts(aggregateItem(null), aggregateItem(undefined, { period: "2026-01-16" }))).toEqual([
      null,
      undefined,
    ]);
  });

  it("still rejects non-numeric, negative and non-finite values (checked on the RAW entries)", () => {
    expectValidationError(
      () => storedToolCounts(aggregateItem({ Read: "lots" })),
      "toolUseCounts values must be non-negative numbers",
    );
    expectValidationError(
      () => storedToolCounts(aggregateItem({ "mcp__AcmeCorp__q": -1 })),
      "toolUseCounts values must be non-negative numbers",
    );
    expectValidationError(
      () => storedToolCounts(aggregateItem({ Read: Number.POSITIVE_INFINITY })),
      "toolUseCounts values must be non-negative numbers",
    );
  });

  it("rejects a toolUseCounts value that is not an object", () => {
    expectValidationError(() => storedToolCounts(aggregateItem(JSON.stringify(5))), "toolUseCounts must be an object");
  });

  it("keeps the models-list validation", () => {
    expectValidationError(
      () => storedToolCounts(aggregateItem({}, { models: Array.from({ length: 33 }, (_, i) => `m${i}`) })),
      "models list too long",
    );
    expectValidationError(
      () => storedToolCounts(aggregateItem({}, { models: ["m".repeat(129)] })),
      "model name too long",
    );
  });
});

// ── myStats (read path) ─────────────────────────────────────────────────────

describe("myStats.response — a legacy stored row is never served raw", () => {
  function respond(items: unknown[]) {
    return myStats.response({ result: { items }, args: { period: "week" } }) as { topTools: string[] };
  }

  it("buckets raw mcp__ / custom names from rows stored before redaction", () => {
    const out = respond([
      { sessionCount: 1, toolUseCounts: { Read: 2, "mcp__AcmeCorp__query": 3, "globex-internal": 1 } },
      { sessionCount: 1, toolUseCounts: JSON.stringify({ "mcp__vandelay__x": 1, Edit: 1 }) },
    ]);
    expect([...out.topTools].sort()).toEqual(["Edit", "Read", "custom", "mcp"]);
    expect(JSON.stringify(out)).not.toContain("AcmeCorp");
    expect(JSON.stringify(out)).not.toContain("vandelay");
    expect(JSON.stringify(out)).not.toContain("globex");
  });

  it("prototype-key names neither corrupt the tally nor leak", () => {
    const raw = JSON.parse('{"__proto__":2,"constructor":1,"Bash":1}') as unknown;
    const out = respond([{ sessionCount: 1, toolUseCounts: raw }]);
    expect([...out.topTools].sort()).toEqual(["Bash", "custom"]);
  });

  it("ignores non-numeric counts and a null toolUseCounts payload", () => {
    const out = respond([
      { sessionCount: 1, toolUseCounts: { Read: "x" } },
      { sessionCount: 1, toolUseCounts: "null" },
      { sessionCount: 1, toolUseCounts: { Grep: 1 } },
    ]);
    expect(out.topTools).toEqual(["Grep"]);
  });
});

// ── pin: the inlined lists equal core's BUILT_IN_TOOL_NAMES ─────────────────

/** Keys of the `const BUILT_IN_TOOLS = { … };` literal in a resolver's source. */
function inlinedBuiltIns(file: string): string[] {
  const src = source(file);
  const start = src.indexOf("const BUILT_IN_TOOLS = {");
  expect(start, `${file} must inline BUILT_IN_TOOLS`).toBeGreaterThanOrEqual(0);
  const body = src.slice(start, src.indexOf("};", start));
  return [...body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*true\b/g)].map((m) => m[1]!);
}

describe("inlined built-in tool list is pinned to core", () => {
  it.each(RESOLVERS)("%s inlines exactly BUILT_IN_TOOL_NAMES (source)", (file) => {
    const inlined = inlinedBuiltIns(file);
    expect(new Set(inlined).size).toBe(inlined.length); // no duplicates
    expect([...inlined].sort()).toEqual([...BUILT_IN_TOOL_NAMES].sort());
  });

  it("aggregate-stats.ts inlines exactly BUILT_IN_TOOL_NAMES and imports nothing from core", () => {
    const src = readFileSync(join(resolverDir, "..", "..", "..", "lambda", "api", "aggregate-stats.ts"), "utf8");
    // No runtime dependency on core: the deployed bundle resolves only what it always has.
    expect(src).not.toMatch(/from\s+["']@claude-stats\/core/);
    const start = src.indexOf("const BUILT_IN_TOOLS = {");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = src.slice(start, src.indexOf("};", start));
    const inlined = [...body.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*true\b/g)].map((m) => m[1]!);
    expect(new Set(inlined).size).toBe(inlined.length);
    expect([...inlined].sort()).toEqual([...BUILT_IN_TOOL_NAMES].sort());
  });

  it("syncAggregate passes every core built-in through verbatim (behaviour)", () => {
    const counts = Object.fromEntries(BUILT_IN_TOOL_NAMES.map((n) => [n, 1]));
    const [stored] = storedToolCounts(aggregateItem(counts));
    expect(stored).toEqual(counts);
  });

  it("myStats serves every core built-in verbatim (behaviour)", () => {
    const counts = Object.fromEntries(BUILT_IN_TOOL_NAMES.map((n) => [n, 1]));
    const out = myStats.response({ result: { items: [{ toolUseCounts: counts }] }, args: { period: "week" } }) as {
      topTools: string[];
    };
    expect([...out.topTools].sort()).toEqual([...BUILT_IN_TOOL_NAMES].sort());
  });
});

// ── static APPSYNC_JS 1.0.0 lint ────────────────────────────────────────────

/**
 * Replace comments and string/template literals with spaces so the checks
 * below see code only. Heuristic, not a parser: it does not handle `${…}`
 * nesting inside template literals or regex literals containing quotes —
 * neither construct may appear in these files anyway (no regex is checked
 * below; template literals do not occur outside comments).
 */
function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += " ".repeat(j + 1 - i);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * A `/` opening a regex literal, by the classic heuristic: a slash whose
 * previous significant character cannot end an expression (an operator,
 * opening bracket, comma, colon, semicolon, or the start of input) or that
 * follows a keyword such as `return`. Division always follows an identifier,
 * number or closing bracket, so `a / b` and `(x) / 1000` are not flagged.
 */
function regexLiterals(code: string): string[] {
  const hits: string[] = [];
  const re = /\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const before = code.slice(0, m.index).trimEnd();
    const prev = before.slice(-1);
    const startsExpression = before === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(return|typeof|case|in|of)$/.test(before);
    if (startsExpression) hits.push(code.slice(m.index, m.index + 20));
  }
  return hits;
}

const BANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ["`new `", /\bnew\s/],
  ["`for (`", /\bfor\s*\(/],
  ["`while (`", /\bwhile\s*\(/],
  ["`++`", /\+\+/],
  ["`--`", /--/],
  ["`.sort(`", /\.sort\s*\(/],
  ["`Date`", /\bDate\b/],
  ["`String(`", /\bString\s*\(/],
  ["`Number(`", /\bNumber\s*\(/],
  ["`charCodeAt`", /\bcharCodeAt\b/],
];

describe("APPSYNC_JS 1.0.0 static lint", () => {
  it.each(RESOLVERS)("%s uses no banned construct", (file) => {
    const code = codeOnly(source(file));
    // Sanity: stripping kept the code (so a clean result is not vacuous).
    expect(code).toContain("export function request");
    expect(code).toContain("export function response");
    for (const [label, re] of BANNED) expect(re.test(code), `${file} contains ${label}`).toBe(false);
    expect(regexLiterals(code), `${file} contains a regex literal`).toEqual([]);
  });

  it("the lint itself flags each banned construct (so a pass is meaningful)", () => {
    const samples = [
      "const m = new Map();",
      "for (const k of ks) {}",
      "while (x) {}",
      "i++;",
      "i--;",
      "a.sort((x, y) => x - y);",
      "const d = Date.now();",
      "String(5);",
      "Number('5');",
      "s.charCodeAt(0);",
    ];
    for (const s of samples) {
      expect(BANNED.some(([, re]) => re.test(codeOnly(s))), s).toBe(true);
    }
    expect(regexLiterals(codeOnly("const r = /^mcp__/;"))).toHaveLength(1);
    expect(regexLiterals(codeOnly("return /x/.test(s);"))).toHaveLength(1);
    expect(regexLiterals(codeOnly("const v = (a + b) / 1000; const w = c / d;"))).toEqual([]);
    // Comments and strings are ignored.
    expect(BANNED.some(([, re]) => re.test(codeOnly('// no for (\nconst s = "new Date()";')))).toBe(false);
  });
});
