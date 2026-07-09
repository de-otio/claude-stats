/**
 * projectUserAggregates — the per-user, per-day projection matching the
 * deployed `syncAggregate` / `AggregateSyncInput` contract (PK=userId/SK=period).
 *
 * Fixtures use only synthetic values (fake session ids, example domains).
 */
import { describe, it, expect } from "vitest";
import { projectUserAggregates } from "../../org/aggregate.js";
import type { SessionRow } from "../../store/index.js";

let seq = 0;
function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  seq += 1;
  return {
    session_id: `sess-${seq}`,
    project_path: "/home/dev/repos/example-project",
    source_file: `/home/dev/.claude/projects/example/sess-${seq}.jsonl`,
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
    tool_use_counts: "{}",
    models: JSON.stringify(["claude-sonnet-4-20250514"]),
    repo_url: null,
    account_uuid: "acct-aaaa",
    organization_uuid: null,
    subscription_type: null,
    thinking_blocks: 0,
    parent_session_id: null,
    is_subagent: 0,
    source_deleted: 0,
    throttle_events: 0,
    active_duration_ms: 600_000, // 10 minutes
    median_response_time_ms: null,
    ...overrides,
  };
}

const OPTS = { accountId: "acct-hash-xyz" } as const;

describe("projectUserAggregates", () => {
  it("rolls a day's sessions into one row keyed by period", () => {
    const rows = [
      makeRow({ prompt_count: 3, input_tokens: 1000, output_tokens: 500 }),
      makeRow({ prompt_count: 2, input_tokens: 400, output_tokens: 200 }),
    ];
    const out = projectUserAggregates(rows, OPTS);
    expect(out).toHaveLength(1);
    const r = out[0]!;
    expect(r.period).toBe("2026-01-15");
    expect(r.projectId).toBeNull();
    expect(r.sessionCount).toBe(2);
    expect(r.promptCount).toBe(5);
    expect(r.inputTokens).toBe(1400);
    expect(r.outputTokens).toBe(700);
    expect(r.accountId).toBe("acct-hash-xyz");
    expect(r._version).toBe(0);
  });

  it("separates buckets by day and sorts by period", () => {
    const out = projectUserAggregates(
      [
        makeRow({ first_timestamp: Date.UTC(2026, 0, 17, 9, 0, 0) }),
        makeRow({ first_timestamp: Date.UTC(2026, 0, 15, 9, 0, 0) }),
      ],
      OPTS,
    );
    expect(out.map((r) => r.period)).toEqual(["2026-01-15", "2026-01-17"]);
  });

  it("counts subagent sessions and sums activeMinutes from active_duration_ms", () => {
    const out = projectUserAggregates(
      [
        makeRow({ is_subagent: 1, active_duration_ms: 600_000 }),
        makeRow({ is_subagent: 0, active_duration_ms: 300_000 }),
      ],
      OPTS,
    );
    expect(out[0]!.subagentSessionCount).toBe(1);
    expect(out[0]!.activeMinutes).toBe(15); // (600000+300000)/60000
  });

  it("merges tool_use_counts across sessions and tolerates malformed columns", () => {
    const out = projectUserAggregates(
      [
        makeRow({ tool_use_counts: JSON.stringify({ Read: 2, Edit: 1 }) }),
        makeRow({ tool_use_counts: JSON.stringify({ Read: 3 }) }),
        makeRow({ tool_use_counts: "not json" }),
        makeRow({ tool_use_counts: "[]" }), // array, not a map → ignored
      ],
      OPTS,
    );
    expect(out[0]!.toolUseCounts).toEqual({ Read: 5, Edit: 1 });
  });

  it("unions and sorts models, and skips rows with no timestamp", () => {
    const out = projectUserAggregates(
      [
        makeRow({ models: JSON.stringify(["claude-sonnet-4-20250514"]) }),
        makeRow({ models: JSON.stringify(["claude-opus-4-20250514"]) }),
        makeRow({ first_timestamp: null, last_timestamp: null }), // un-bucketable
      ],
      OPTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.sessionCount).toBe(2);
    expect(out[0]!.models).toEqual([
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
    ]);
  });

  it("is deterministic (byte-stable across runs)", () => {
    const rows = [makeRow(), makeRow({ first_timestamp: Date.UTC(2026, 1, 1, 0, 0, 0) })];
    expect(JSON.stringify(projectUserAggregates(rows, OPTS))).toEqual(
      JSON.stringify(projectUserAggregates(rows, OPTS)),
    );
  });
});
