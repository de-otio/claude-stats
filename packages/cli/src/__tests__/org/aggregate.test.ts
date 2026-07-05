/**
 * Org-plane aggregate projection + plane-separation invariant.
 *
 * Two things are under test:
 *  1. The PLANE-SEPARATION INVARIANT — the aggregate payload is structurally
 *     incapable of carrying `prompt_text`/`file_paths`/transcript/session-id/key
 *     material — enforced both at COMPILE time (type-level assertions checked by
 *     `tsc`) and at RUNTIME (every emitted record's keys are on a fixed
 *     aggregate allowlist and match none of the forbidden field names).
 *  2. PROJECTION CORRECTNESS on synthetic rows — grouping, summation, model
 *     union, period bucketing, malformed-data tolerance, and determinism.
 *
 * Fixtures use only synthetic values (fake session ids, IETF-reserved example
 * domains) — never real MCP output.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";

import {
  projectAggregates,
  bucketStart,
  AGGREGATE_SCHEMA_VERSION,
  type AggregateProjectionOptions,
} from "../../org/aggregate.js";
import type { SessionRow } from "../../store/index.js";
import type {
  AggregateProjection,
  ForbiddenPersonalField,
  HasNoPersonalFields,
} from "@claude-stats/core/types/shard";

// ─── Compile-time plane-separation assertions (checked by `tsc`, not vitest) ──

// If `AggregateProjection` ever grows a forbidden field, THIS fails to compile.
const _invariantHolds: HasNoPersonalFields<AggregateProjection> = true;
void _invariantHolds;

// A projection that DOES carry a forbidden field must be REJECTED by the guard:
// `HasNoPersonalFields<_Leaky>` resolves to the literal `false`.
interface _Leaky {
  readonly periodStart: string;
  readonly prompt_text: string;
}
const _leakyRejected: HasNoPersonalFields<_Leaky> = false;
void _leakyRejected;
// And prove it is genuinely `false` (not widened to `boolean`): `true` is NOT assignable.
// @ts-expect-error — a payload carrying `prompt_text` must fail the guard.
const _leakyNotTrue: HasNoPersonalFields<_Leaky> = true;
void _leakyNotTrue;

// ─── Synthetic row builder ────────────────────────────────────────────────────

let rowSeq = 0;
function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  rowSeq += 1;
  return {
    session_id: `sess-${rowSeq}`,
    project_path: "/home/dev/repos/example-project",
    source_file: `/home/dev/.claude/projects/example/sess-${rowSeq}.jsonl`,
    first_timestamp: Date.UTC(2026, 0, 15, 12, 0, 0), // 2026-01-15
    last_timestamp: Date.UTC(2026, 0, 15, 13, 0, 0),
    claude_version: "2.1.70",
    entrypoint: "cli",
    git_branch: "main",
    is_interactive: 1,
    prompt_count: 3,
    assistant_message_count: 4,
    input_tokens: 1000,
    output_tokens: 500,
    cache_creation_tokens: 200,
    cache_read_tokens: 100,
    web_search_requests: 0,
    web_fetch_requests: 0,
    tool_use_counts: "[]",
    models: JSON.stringify(["claude-sonnet-4-20250514"]),
    repo_url: "https://github.com/example-org/example-project.git",
    account_uuid: "acct-aaaa",
    organization_uuid: null,
    subscription_type: null,
    thinking_blocks: 0,
    parent_session_id: null,
    is_subagent: 0,
    source_deleted: 0,
    throttle_events: 0,
    active_duration_ms: null,
    median_response_time_ms: null,
    ...overrides,
  };
}

const OPTS: AggregateProjectionOptions = {
  periodKind: "day",
  cohortIdFor: (uuid) => `cohort:${uuid}`,
  unattributedCohortId: "unattributed",
};

// The complete, closed set of keys an aggregate record may carry.
const ALLOWED_KEYS = new Set<string>([
  "periodStart",
  "periodKind",
  "cohortId",
  "sessionCount",
  "promptCount",
  "assistantMessageCount",
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "estimatedCostUsd",
  "models",
  "_schema",
]);

const FORBIDDEN_KEYS: readonly ForbiddenPersonalField[] = [
  "promptText",
  "prompt_text",
  "filePaths",
  "file_paths",
  "transcript",
  "content",
  "sourceFile",
  "source_file",
  "sessionId",
  "session_id",
  "sealedBody",
  "wrappedDek",
  "secretKey",
  "wrapSecretKey",
  "signingSecretKey",
  "dek",
];

// ─── Plane-separation invariant (runtime) ─────────────────────────────────────

describe("plane-separation invariant (runtime)", () => {
  it("every emitted record carries ONLY allowlisted aggregate keys", () => {
    const rows = [
      makeRow({ account_uuid: "acct-aaaa", project_path: "/secret/path" }),
      makeRow({ account_uuid: "acct-bbbb" }),
    ];
    const out = projectAggregates(rows, OPTS);
    expect(out.length).toBeGreaterThan(0);
    for (const rec of out) {
      for (const key of Object.keys(rec)) {
        expect(ALLOWED_KEYS.has(key), `unexpected key "${key}" on aggregate`).toBe(true);
      }
    }
  });

  it("no emitted record carries any forbidden personal-plane field", () => {
    const out = projectAggregates([makeRow(), makeRow({ account_uuid: null })], OPTS);
    for (const rec of out) {
      const keys = Object.keys(rec);
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });

  it("does not leak the raw project path, source file, session id, or raw account uuid into any value", () => {
    // A genuinely minimizing cohort mapper (opaque handle, not the raw uuid).
    const minimizing: AggregateProjectionOptions = {
      ...OPTS,
      cohortIdFor: () => "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    };
    const rows = [
      makeRow({
        session_id: "sess-SECRET-ID",
        project_path: "/Users/leak/secret-project",
        source_file: "/Users/leak/.claude/leak.jsonl",
        account_uuid: "acct-RAW-uuid",
      }),
    ];
    const serialized = JSON.stringify(projectAggregates(rows, minimizing));
    expect(serialized).not.toContain("sess-SECRET-ID");
    expect(serialized).not.toContain("secret-project");
    expect(serialized).not.toContain("leak.jsonl");
    // The projection never emits the raw account uuid — only the mapper's handle.
    expect(serialized).not.toContain("acct-RAW-uuid");
    expect(serialized).toContain("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  });
});

// ─── Projection correctness ───────────────────────────────────────────────────

describe("projectAggregates — grouping & summation", () => {
  it("rolls same-day same-cohort sessions into one record with summed counters", () => {
    const rows = [
      makeRow({ account_uuid: "acct-aaaa", prompt_count: 3, input_tokens: 1000, output_tokens: 500 }),
      makeRow({ account_uuid: "acct-aaaa", prompt_count: 2, input_tokens: 400, output_tokens: 100 }),
    ];
    const out = projectAggregates(rows, OPTS);
    expect(out).toHaveLength(1);
    const rec = out[0]!;
    expect(rec.sessionCount).toBe(2);
    expect(rec.promptCount).toBe(5);
    expect(rec.inputTokens).toBe(1400);
    expect(rec.outputTokens).toBe(600);
    expect(rec.cohortId).toBe("cohort:acct-aaaa");
    expect(rec.periodStart).toBe("2026-01-15");
    expect(rec.periodKind).toBe("day");
    expect(rec._schema).toBe(AGGREGATE_SCHEMA_VERSION);
  });

  it("separates records by cohort", () => {
    const rows = [
      makeRow({ account_uuid: "acct-aaaa" }),
      makeRow({ account_uuid: "acct-bbbb" }),
    ];
    const out = projectAggregates(rows, OPTS);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.cohortId)).toEqual(["cohort:acct-aaaa", "cohort:acct-bbbb"]);
  });

  it("separates records by period", () => {
    const rows = [
      makeRow({ first_timestamp: Date.UTC(2026, 0, 15) }),
      makeRow({ first_timestamp: Date.UTC(2026, 0, 16) }),
    ];
    const out = projectAggregates(rows, OPTS);
    expect(out.map((r) => r.periodStart)).toEqual(["2026-01-15", "2026-01-16"]);
  });

  it("uses the unattributed cohort for rows with no account_uuid", () => {
    const out = projectAggregates([makeRow({ account_uuid: null })], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]!.cohortId).toBe("unattributed");
  });

  it("unions model labels across a bucket, sorted", () => {
    const rows = [
      makeRow({ account_uuid: "acct-aaaa", models: JSON.stringify(["claude-opus-4", "claude-sonnet-4"]) }),
      makeRow({ account_uuid: "acct-aaaa", models: JSON.stringify(["claude-sonnet-4", "claude-haiku-4"]) }),
    ];
    const out = projectAggregates(rows, OPTS);
    expect(out[0]!.models).toEqual(["claude-haiku-4", "claude-opus-4", "claude-sonnet-4"]);
  });

  it("produces a non-negative cost estimate that scales with token volume", () => {
    const small = projectAggregates([makeRow({ input_tokens: 100, output_tokens: 50 })], OPTS);
    const large = projectAggregates([makeRow({ input_tokens: 100_000, output_tokens: 50_000 })], OPTS);
    expect(small[0]!.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    expect(large[0]!.estimatedCostUsd).toBeGreaterThan(small[0]!.estimatedCostUsd);
  });
});

describe("projectAggregates — boundary & failure paths", () => {
  it("skips rows that cannot be placed in time (both timestamps null)", () => {
    const rows = [makeRow({ first_timestamp: null, last_timestamp: null })];
    expect(projectAggregates(rows, OPTS)).toEqual([]);
  });

  it("falls back to last_timestamp when first_timestamp is null", () => {
    const rows = [makeRow({ first_timestamp: null, last_timestamp: Date.UTC(2026, 2, 3, 9, 0, 0) })];
    const out = projectAggregates(rows, OPTS);
    expect(out[0]!.periodStart).toBe("2026-03-03");
  });

  it("tolerates a malformed models column (no crash, empty model list)", () => {
    const out = projectAggregates([makeRow({ models: "not json" })], OPTS);
    expect(out).toHaveLength(1);
    expect(out[0]!.models).toEqual([]);
    // No primary model → no cost contribution.
    expect(out[0]!.estimatedCostUsd).toBe(0);
  });

  it("returns an empty array for no rows", () => {
    expect(projectAggregates([], OPTS)).toEqual([]);
  });

  it("does not call cohortIdFor for rows without an account_uuid", () => {
    let called = 0;
    projectAggregates([makeRow({ account_uuid: null })], {
      ...OPTS,
      cohortIdFor: (u) => {
        called += 1;
        return `cohort:${u}`;
      },
    });
    expect(called).toBe(0);
  });
});

describe("bucketStart", () => {
  it("day buckets to the UTC calendar day", () => {
    expect(bucketStart(Date.UTC(2026, 0, 15, 23, 59, 59), "day")).toBe("2026-01-15");
  });

  it("month buckets to the 1st, including single-digit months", () => {
    expect(bucketStart(Date.UTC(2026, 2, 31), "month")).toBe("2026-03-01");
  });

  it("week buckets to the ISO Monday", () => {
    // 2026-01-15 is a Thursday → ISO Monday is 2026-01-12.
    expect(bucketStart(Date.UTC(2026, 0, 15), "week")).toBe("2026-01-12");
    // A Monday buckets to itself.
    expect(bucketStart(Date.UTC(2026, 0, 12), "week")).toBe("2026-01-12");
    // A Sunday buckets back to the prior Monday.
    expect(bucketStart(Date.UTC(2026, 0, 18), "week")).toBe("2026-01-12");
  });

  it("week bucketing crosses a month/year boundary correctly", () => {
    // 2026-01-01 is a Thursday → ISO Monday is 2025-12-29.
    expect(bucketStart(Date.UTC(2026, 0, 1), "week")).toBe("2025-12-29");
  });
});

// ─── Determinism (property-based) ─────────────────────────────────────────────

describe("projectAggregates — determinism", () => {
  interface RowSpec {
    account: string;
    dayOffset: number;
    input: number;
    output: number;
    prompts: number;
  }

  const rowArb: fc.Arbitrary<RowSpec> = fc.record({
    account: fc.constantFrom("acct-aaaa", "acct-bbbb", "acct-cccc"),
    dayOffset: fc.integer({ min: 0, max: 20 }),
    input: fc.nat({ max: 100_000 }),
    output: fc.nat({ max: 100_000 }),
    prompts: fc.nat({ max: 50 }),
  });

  function toRows(specs: readonly RowSpec[]): SessionRow[] {
    return specs.map((s) =>
      makeRow({
        account_uuid: s.account,
        first_timestamp: Date.UTC(2026, 0, 1 + s.dayOffset, 10, 0, 0),
        input_tokens: s.input,
        output_tokens: s.output,
        prompt_count: s.prompts,
      }),
    );
  }

  it("is invariant to input row order (shuffling yields identical output)", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 40 }), (specs) => {
        const rows = toRows(specs);
        const shuffled = [...rows].reverse();
        const a = projectAggregates(rows, OPTS);
        const b = projectAggregates(shuffled, OPTS);
        expect(a).toEqual(b);
      }),
      { seed: 42, numRuns: 100 },
    );
  });

  it("conserves totals: summed aggregate tokens equal summed row tokens", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 1, maxLength: 40 }), (specs) => {
        const rows = toRows(specs);
        const out = projectAggregates(rows, OPTS);
        const aggInput = out.reduce((n, r) => n + r.inputTokens, 0);
        const aggSessions = out.reduce((n, r) => n + r.sessionCount, 0);
        const rowInput = specs.reduce((n, s) => n + s.input, 0);
        expect(aggInput).toBe(rowInput);
        expect(aggSessions).toBe(rows.length);
      }),
      { seed: 7, numRuns: 100 },
    );
  });
});
