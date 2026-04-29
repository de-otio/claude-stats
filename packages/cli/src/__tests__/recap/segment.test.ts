import { describe, it, expect } from "vitest";
import { segmentSession } from "../../recap/segment.js";
import type { MessageRow } from "../../store/index.js";
import type { ShiftWeights } from "../../recap/types.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

let _uuidCounter = 0;
function nextUuid(): string {
  return `msg-${String(++_uuidCounter).padStart(4, "0")}`;
}

/** Construct a minimal MessageRow for testing. */
function makeMsg(overrides: Partial<MessageRow> & { timestamp: number }): MessageRow {
  const base: MessageRow = {
    uuid: nextUuid(),
    session_id: "sess-test-default",
    timestamp: 0,
    claude_version: null,
    model: null,
    stop_reason: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    tools: "[]",
    thinking_blocks: 0,
    service_tier: null,
    inference_geo: null,
    ephemeral_5m_cache_tokens: 0,
    ephemeral_1h_cache_tokens: 0,
    prompt_text: null,
  };
  return { ...base, ...overrides };
}

/** Offset in ms for a given number of minutes from t0. */
const T0 = 1_700_000_000_000;
const min = (n: number): number => T0 + n * 60_000;

/** Build a tools JSON string with rich params (future shape for file-path extraction). */
function richTools(
  entries: Array<{ name: string; params: Record<string, unknown> }>,
): string {
  return JSON.stringify(entries);
}

/**
 * Custom weights that make a single gap signal exceed the threshold.
 * gap=1.0 means a 30-min gap alone scores 1.0 > 0.5 threshold.
 */
const GAP_ONLY_WEIGHTS: ShiftWeights = {
  gap: 1.0, path: 0.0, vocab: 0.0, marker: 0.0, commit: 0.0, threshold: 0.5,
};

/**
 * Custom weights that make a single marker signal exceed the threshold.
 */
const MARKER_ONLY_WEIGHTS: ShiftWeights = {
  gap: 0.0, path: 0.0, vocab: 0.0, marker: 1.0, commit: 0.0, threshold: 0.5,
};

/**
 * Custom weights that make a single commit signal exceed the threshold.
 */
const COMMIT_ONLY_WEIGHTS: ShiftWeights = {
  gap: 0.0, path: 0.0, vocab: 0.0, marker: 0.0, commit: 1.0, threshold: 0.5,
};

/**
 * Custom weights that make a single path signal exceed the threshold
 * (path signal is Jaccard distance, max=1.0).
 */
const PATH_ONLY_WEIGHTS: ShiftWeights = {
  gap: 0.0, path: 1.0, vocab: 0.0, marker: 0.0, commit: 0.0, threshold: 0.5,
};

/**
 * Custom weights that make a single vocab signal exceed the threshold
 * (vocab Jaccard distance ≈ 1.0 for completely different token sets).
 */
const VOCAB_ONLY_WEIGHTS: ShiftWeights = {
  gap: 0.0, path: 0.0, vocab: 1.0, marker: 0.0, commit: 0.0, threshold: 0.5,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("segmentSession", () => {

  // ── 12 spec test cases ─────────────────────────────────────────────────────

  // Test 1: Empty messages → []
  it("returns empty array for empty messages input", () => {
    const result = segmentSession([]);
    expect(result).toEqual([]);
  });

  // Test 2: Single message → one segment with one message
  it("returns one segment for a single message", () => {
    const msg = makeMsg({ timestamp: T0, session_id: "sess-single", prompt_text: "hello" });
    const result = segmentSession([msg]);
    expect(result).toHaveLength(1);
    // Non-null assertions are appropriate here: we asserted length above.
    expect(result[0]!.index).toBe(0);
    expect(result[0]!.messageUuids).toEqual([msg.uuid]);
    expect(result[0]!.sessionId).toBe("sess-single");
    expect(result[0]!.openingPromptText).toBe("hello");
  });

  // Test 3: Short session, no shifts → one segment, all messages
  it("keeps short sessions with similar content as one segment", () => {
    const sessionId = "sess-short";
    const tools = richTools([{ name: "Edit", params: { file_path: "src/auth/login.ts" } }]);
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), tools, prompt_text: "fix the login function" }),
      makeMsg({ session_id: sessionId, timestamp: min(1), tools, prompt_text: "update the auth check" }),
      makeMsg({ session_id: sessionId, timestamp: min(2), tools, prompt_text: "add error handling to login" }),
      makeMsg({ session_id: sessionId, timestamp: min(3), tools, prompt_text: "write a test for the auth module" }),
      makeMsg({ session_id: sessionId, timestamp: min(4), tools, prompt_text: "refactor the login handler" }),
    ];
    const result = segmentSession(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.messageUuids).toHaveLength(5);
  });

  // Test 4: Gap split → two segments split at gap.
  // Uses GAP_ONLY_WEIGHTS so the gap signal alone fires (gap weight=1.0 > threshold=0.5).
  it("splits on a 30-minute gap between messages", () => {
    const sessionId = "sess-gap";
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), prompt_text: "start working on feature" }),
      makeMsg({ session_id: sessionId, timestamp: min(1), prompt_text: "continue feature work" }),
      // 30-minute gap here
      makeMsg({ session_id: sessionId, timestamp: min(31), prompt_text: "resume after break" }),
      makeMsg({ session_id: sessionId, timestamp: min(32), prompt_text: "keep working" }),
    ];
    const result = segmentSession(messages, { weights: GAP_ONLY_WEIGHTS });
    expect(result).toHaveLength(2);
    expect(result[0]!.index).toBe(0);
    expect(result[1]!.index).toBe(1);
    expect(result[0]!.messageUuids).toEqual([messages[0]!.uuid, messages[1]!.uuid]);
    expect(result[1]!.messageUuids).toEqual([messages[2]!.uuid, messages[3]!.uuid]);
  });

  // Test 5: File-path divergence → two segments.
  // Places a >20-min gap at the file-switch boundary so the combined path+gap
  // signal clearly exceeds the default threshold. The segment filePaths confirm
  // the correct file groups end up in each segment.
  it("splits when edited files switch from src/auth to src/render", () => {
    const sessionId = "sess-path";
    const authTools = richTools([{ name: "Edit", params: { file_path: "src/auth/login.ts" } }]);
    const renderTools = richTools([{ name: "Edit", params: { file_path: "src/render/template.ts" } }]);
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0),  tools: authTools, prompt_text: "auth work" }),
      makeMsg({ session_id: sessionId, timestamp: min(1),  tools: authTools, prompt_text: "more auth" }),
      makeMsg({ session_id: sessionId, timestamp: min(2),  tools: authTools, prompt_text: "still auth" }),
      // >20-min gap + file switch: gap signal (0.4) + path signal (0.25 * 1.0) = 0.65 ≥ 0.5
      makeMsg({ session_id: sessionId, timestamp: min(25), tools: renderTools, prompt_text: "render work" }),
      makeMsg({ session_id: sessionId, timestamp: min(26), tools: renderTools, prompt_text: "more render" }),
      makeMsg({ session_id: sessionId, timestamp: min(27), tools: renderTools, prompt_text: "still render" }),
    ];
    const result = segmentSession(messages);
    expect(result).toHaveLength(2);
    expect(result[0]!.filePaths.some((p) => p.includes("auth"))).toBe(true);
    expect(result[1]!.filePaths.some((p) => p.includes("render"))).toBe(true);
  });

  // Test 6: Imperative marker → two segments split at prompt 3.
  // Uses MARKER_ONLY_WEIGHTS so the marker signal alone fires.
  it("splits when a prompt starts with an imperative-shift marker", () => {
    const sessionId = "sess-marker";
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), prompt_text: "let us fix the bug in auth" }),
      makeMsg({ session_id: sessionId, timestamp: min(1), prompt_text: "here is the error message" }),
      // Prompt 3 starts with imperative marker
      makeMsg({ session_id: sessionId, timestamp: min(2), prompt_text: "okay, now let's switch to the CI pipeline" }),
      makeMsg({ session_id: sessionId, timestamp: min(3), prompt_text: "update the workflow file" }),
    ];
    const result = segmentSession(messages, { weights: MARKER_ONLY_WEIGHTS });
    expect(result).toHaveLength(2);
    // The split happens at the "okay, now let's..." message
    expect(result[0]!.messageUuids).toEqual([messages[0]!.uuid, messages[1]!.uuid]);
    expect(result[1]!.messageUuids).toEqual([messages[2]!.uuid, messages[3]!.uuid]);
  });

  // Test 7: Vocab jump → two segments.
  // Uses VOCAB_ONLY_WEIGHTS so vocab Jaccard distance alone fires.
  it("splits on vocabulary jump between auth and CI topics", () => {
    const sessionId = "sess-vocab";
    const messages = [
      makeMsg({
        session_id: sessionId,
        timestamp: min(0),
        prompt_text: "implement authentication token validation middleware",
      }),
      makeMsg({
        session_id: sessionId,
        timestamp: min(1),
        // Completely different vocabulary: CI/CD terminology, no overlapping tokens
        prompt_text: "configure github actions workflow deployment pipeline",
      }),
    ];
    const result = segmentSession(messages, { weights: VOCAB_ONLY_WEIGHTS });
    // auth vocab vs CI vocab: zero token overlap → Jaccard=1.0 → score=1.0 ≥ 0.5
    expect(result).toHaveLength(2);
  });

  // Test 8: Commit between messages → two segments.
  // Uses COMMIT_ONLY_WEIGHTS so the commit signal alone fires.
  it("splits when a commit timestamp falls between two messages", () => {
    const sessionId = "sess-commit";
    const t1 = min(0);
    const t2 = min(5);
    const commitBetween = min(3); // strictly in (t1, t2]

    const messages = [
      makeMsg({ session_id: sessionId, timestamp: t1, prompt_text: "pre-commit work" }),
      makeMsg({ session_id: sessionId, timestamp: t2, prompt_text: "post-commit work" }),
    ];
    const result = segmentSession(messages, {
      weights: COMMIT_ONLY_WEIGHTS,
      commitTimestamps: [commitBetween],
    });
    expect(result).toHaveLength(2);
  });

  // Test 9: Three unrelated topics → three segments.
  // Combines gap + commit signals to trigger two splits.
  it("produces three segments for three distinct file sets and distinct prompts", () => {
    const sessionId = "sess-three";
    const authTools = richTools([{ name: "Edit", params: { file_path: "src/auth/login.ts" } }]);
    const renderTools = richTools([{ name: "Edit", params: { file_path: "src/render/template.ts" } }]);
    const dbTools = richTools([{ name: "Edit", params: { file_path: "src/db/migrations.ts" } }]);

    const messages = [
      // Topic 1: auth
      makeMsg({ session_id: sessionId, timestamp: min(0),  tools: authTools, prompt_text: "auth login" }),
      makeMsg({ session_id: sessionId, timestamp: min(1),  tools: authTools, prompt_text: "auth session" }),
      makeMsg({ session_id: sessionId, timestamp: min(2),  tools: authTools, prompt_text: "auth token" }),
      // Topic 2: render (30-min gap from topic 1)
      makeMsg({ session_id: sessionId, timestamp: min(25), tools: renderTools, prompt_text: "render layout" }),
      makeMsg({ session_id: sessionId, timestamp: min(26), tools: renderTools, prompt_text: "render view" }),
      makeMsg({ session_id: sessionId, timestamp: min(27), tools: renderTools, prompt_text: "render template" }),
      // Topic 3: db (30-min gap from topic 2)
      makeMsg({ session_id: sessionId, timestamp: min(55), tools: dbTools, prompt_text: "database migration" }),
      makeMsg({ session_id: sessionId, timestamp: min(56), tools: dbTools, prompt_text: "database schema" }),
    ];

    // Use weights that allow gap (>20 min) alone to trigger a split
    const result = segmentSession(messages, { weights: GAP_ONLY_WEIGHTS });

    expect(result).toHaveLength(3);
    expect(result.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  // Test 10: All weak signals below threshold → one segment.
  // Same file, overlapping vocab, no markers, no commit, 5-min gaps (below 20-min threshold).
  it("keeps messages as one segment when all signals are below threshold", () => {
    const sessionId = "sess-weak";
    const tools = richTools([{ name: "Edit", params: { file_path: "src/utils/helpers.ts" } }]);
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0),  tools, prompt_text: "update helpers utility function" }),
      makeMsg({ session_id: sessionId, timestamp: min(5),  tools, prompt_text: "modify helpers utility method" }),
      makeMsg({ session_id: sessionId, timestamp: min(10), tools, prompt_text: "refactor helpers utility class" }),
      makeMsg({ session_id: sessionId, timestamp: min(15), tools, prompt_text: "improve helpers utility code" }),
    ];
    const result = segmentSession(messages);
    expect(result).toHaveLength(1);
  });

  // Test 11: Custom weights — gap=1.0, threshold=0.5, 30-min gap → splits even with
  // default gap threshold (>20 min). Verifies threshold tunability via custom weights.
  it("respects custom weights: gap=1.0 splits on 30-min gap, surpassing threshold", () => {
    const sessionId = "sess-custom-weights";
    const customWeights: ShiftWeights = {
      gap: 1.0,
      path: 0.0,
      vocab: 0.0,
      marker: 0.0,
      commit: 0.0,
      threshold: 0.5,
    };
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0),  prompt_text: "start" }),
      makeMsg({ session_id: sessionId, timestamp: min(30), prompt_text: "after gap" }),
    ];
    const result = segmentSession(messages, { weights: customWeights });
    expect(result).toHaveLength(2);
  });

  // Test 12: Determinism — byte-identical output across two runs.
  it("produces byte-identical output for the same input (determinism)", () => {
    const sessionId = "sess-determinism";
    const authTools = richTools([{ name: "Edit", params: { file_path: "src/auth/login.ts" } }]);
    const renderTools = richTools([{ name: "Edit", params: { file_path: "src/render/template.ts" } }]);
    const messages: MessageRow[] = [
      makeMsg({ session_id: sessionId, timestamp: min(0),  tools: authTools, prompt_text: "auth work here" }),
      makeMsg({ session_id: sessionId, timestamp: min(1),  tools: authTools, prompt_text: "more auth changes" }),
      makeMsg({ session_id: sessionId, timestamp: min(31), tools: renderTools, prompt_text: "render refactor now" }),
      makeMsg({ session_id: sessionId, timestamp: min(32), tools: renderTools, prompt_text: "render template update" }),
    ];
    const commitTs = [min(15)] as const;

    const run1 = segmentSession(messages, { weights: GAP_ONLY_WEIGHTS, commitTimestamps: commitTs });
    const run2 = segmentSession(messages, { weights: GAP_ONLY_WEIGHTS, commitTimestamps: commitTs });

    // Serialise both to JSON and compare byte-for-byte
    expect(JSON.stringify(run1)).toBe(JSON.stringify(run2));

    // segmentIds must be stable sha256 hex strings (64 hex chars)
    for (const seg of run1) {
      expect(seg.segmentId).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // ── Additional coverage tests ───────────────────────────────────────────────

  it("computes segmentId as sha256 hex of sessionId:index:openingUuid", async () => {
    const { createHash } = await import("node:crypto");
    const sessionId = "sess-hash-check";
    const msg = makeMsg({ session_id: sessionId, timestamp: T0, prompt_text: "hello" });
    const result = segmentSession([msg]);
    const expected = createHash("sha256")
      .update(`${sessionId}:0:${msg.uuid}`)
      .digest("hex");
    expect(result[0]!.segmentId).toBe(expected);
  });

  it("handles messages with zero timestamps gracefully", () => {
    const sessionId = "sess-zero-ts";
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: 0, prompt_text: "first" }),
      makeMsg({ session_id: sessionId, timestamp: 0, prompt_text: "second" }),
    ];
    // Both timestamps are 0 → gap = 0 ms → no gap signal → one segment
    const result = segmentSession(messages);
    expect(result).toHaveLength(1);
    // Segment timestamps reflect the messages (0 since that's the timestamp)
    expect(result[0]!.startTs).toBe(0);
    expect(result[0]!.endTs).toBe(0);
  });

  it("handles malformed tools JSON by returning empty paths", () => {
    const sessionId = "sess-bad-tools";
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), tools: "not-json", prompt_text: "first" }),
      makeMsg({ session_id: sessionId, timestamp: min(1), tools: "}", prompt_text: "second" }),
    ];
    // Should not throw; malformed tools → no file paths extracted
    const result = segmentSession(messages);
    expect(result[0]!.filePaths).toEqual([]);
  });

  it("builds correct tool histogram for plain string-array tools (current store format)", () => {
    const sessionId = "sess-histogram";
    const tools1 = JSON.stringify(["Read", "Edit"]);
    const tools2 = JSON.stringify(["Edit", "Bash"]);
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), tools: tools1, prompt_text: "read and edit" }),
      makeMsg({ session_id: sessionId, timestamp: min(1), tools: tools2, prompt_text: "edit and bash" }),
    ];
    const result = segmentSession(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.toolHistogram["Read"]).toBe(1);
    expect(result[0]!.toolHistogram["Edit"]).toBe(2);
    expect(result[0]!.toolHistogram["Bash"]).toBe(1);
  });

  it("vocab signal is 0 when prev prompt_text is null — no split even with high vocab weight", () => {
    const sessionId = "sess-null-vocab";
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), prompt_text: null }),
      makeMsg({ session_id: sessionId, timestamp: min(1), prompt_text: "completely different topic database sql migrations" }),
    ];
    const result = segmentSession(messages, { weights: VOCAB_ONLY_WEIGHTS });
    // vocab signal = 0 (null side) → score = 0 < threshold → one segment
    expect(result).toHaveLength(1);
  });

  it("shift markers are case-insensitive and anchored to prompt start", () => {
    const sessionId = "sess-marker-case";
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), prompt_text: "first thing to do" }),
      makeMsg({ session_id: sessionId, timestamp: min(1), prompt_text: "NEXT, let us handle the CI" }),
    ];
    const result = segmentSession(messages, { weights: MARKER_ONLY_WEIGHTS });
    expect(result).toHaveLength(2);
  });

  it("does NOT split when shift marker appears mid-sentence (not anchored to start)", () => {
    const sessionId = "sess-marker-mid";
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), prompt_text: "first task here" }),
      makeMsg({ session_id: sessionId, timestamp: min(1), prompt_text: "I want to do next the cleanup" }),
    ];
    const result = segmentSession(messages, { weights: MARKER_ONLY_WEIGHTS });
    expect(result).toHaveLength(1);
  });

  it("commit signal fires when commit timestamp equals message timestamp (inclusive upper bound)", () => {
    const sessionId = "sess-commit-exact";
    const t1 = min(0);
    const t2 = min(5);
    // Commit exactly at t2 — interval is (t1, t2], so t2 is included
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: t1, prompt_text: "pre" }),
      makeMsg({ session_id: sessionId, timestamp: t2, prompt_text: "post" }),
    ];
    const result = segmentSession(messages, {
      weights: COMMIT_ONLY_WEIGHTS,
      commitTimestamps: [t2],
    });
    expect(result).toHaveLength(2);
  });

  it("commit signal does NOT fire when commit timestamp equals t[i-1] (exclusive lower bound)", () => {
    const sessionId = "sess-commit-exclusive";
    const t1 = min(0);
    const t2 = min(5);
    // Commit exactly at t1 — interval is (t1, t2], t1 is NOT included
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: t1, prompt_text: "pre" }),
      makeMsg({ session_id: sessionId, timestamp: t2, prompt_text: "post" }),
    ];
    const result = segmentSession(messages, {
      weights: COMMIT_ONLY_WEIGHTS,
      commitTimestamps: [t1],
    });
    expect(result).toHaveLength(1);
  });

  it("filePaths within a segment are sorted for determinism", () => {
    const sessionId = "sess-sorted-paths";
    const tools = richTools([
      { name: "Edit", params: { file_path: "src/z-last.ts" } },
      { name: "Read", params: { file_path: "src/a-first.ts" } },
    ]);
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), tools, prompt_text: "work" }),
    ];
    const result = segmentSession(messages);
    const paths = result[0]!.filePaths;
    expect(paths).toEqual([...paths].sort());
    // Both files should appear
    expect(paths).toContain("src/z-last.ts");
    expect(paths).toContain("src/a-first.ts");
  });

  it("Glob tool extracts directory portion of the pattern", () => {
    const sessionId = "sess-glob";
    const tools = richTools([{ name: "Glob", params: { pattern: "src/utils/*.ts" } }]);
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), tools, prompt_text: "glob work" }),
    ];
    const result = segmentSession(messages);
    expect(result[0]!.filePaths).toContain("src/utils");
  });

  it("Bash tool extracts cwd when present", () => {
    const sessionId = "sess-bash-cwd";
    const tools = richTools([{ name: "Bash", params: { cwd: "/home/user/project", command: "ls" } }]);
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), tools, prompt_text: "bash work" }),
    ];
    const result = segmentSession(messages);
    expect(result[0]!.filePaths).toContain("/home/user/project");
  });

  it("unknown tools contribute no file paths", () => {
    const sessionId = "sess-unknown-tools";
    const tools = richTools([{ name: "WebSearch", params: { query: "how to sort" } }]);
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), tools, prompt_text: "search work" }),
    ];
    const result = segmentSession(messages);
    expect(result[0]!.filePaths).toEqual([]);
  });

  it("openingPromptText is from first message with non-null prompt_text", () => {
    const sessionId = "sess-opening-prompt";
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), prompt_text: null }),
      makeMsg({ session_id: sessionId, timestamp: min(1), prompt_text: "the real first prompt" }),
      makeMsg({ session_id: sessionId, timestamp: min(2), prompt_text: "second prompt" }),
    ];
    const result = segmentSession(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.openingPromptText).toBe("the real first prompt");
  });

  it("startTs and endTs are correct for multi-message segments", () => {
    const sessionId = "sess-ts-range";
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), prompt_text: "first" }),
      makeMsg({ session_id: sessionId, timestamp: min(2), prompt_text: "middle" }),
      makeMsg({ session_id: sessionId, timestamp: min(4), prompt_text: "last" }),
    ];
    const result = segmentSession(messages);
    expect(result[0]!.startTs).toBe(min(0));
    expect(result[0]!.endTs).toBe(min(4));
  });

  it("handles rich tools with MultiEdit shape", () => {
    const sessionId = "sess-multiedit";
    const tools = richTools([{ name: "MultiEdit", params: { file_path: "src/complex.ts" } }]);
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), tools, prompt_text: "multi-edit work" }),
    ];
    const result = segmentSession(messages);
    expect(result[0]!.filePaths).toContain("src/complex.ts");
  });

  it("Jaccard distance is 0 when both sets are empty (no paths on either side)", () => {
    // When no file paths exist on either side, path signal should be 0 → no split
    const sessionId = "sess-empty-paths";
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), tools: "[]", prompt_text: "first" }),
      makeMsg({ session_id: sessionId, timestamp: min(1), tools: "[]", prompt_text: "second" }),
    ];
    const result = segmentSession(messages, { weights: PATH_ONLY_WEIGHTS });
    expect(result).toHaveLength(1);
  });

  it("ignores object entries without a string name field in tools array", () => {
    // Covers the guard branch: entry is object but lacks a string 'name' → continue
    const sessionId = "sess-bad-entry";
    const tools = JSON.stringify([
      null,               // null entry
      { noName: true },   // object without 'name' field
      { name: 42 },       // 'name' is not a string
      "Read",             // valid string entry (counts in histogram)
    ]);
    const messages = [
      makeMsg({ session_id: sessionId, timestamp: min(0), tools, prompt_text: "work" }),
    ];
    // Should not throw; bad entries are skipped, valid string entry is counted
    const result = segmentSession(messages);
    expect(result[0]!.toolHistogram["Read"]).toBe(1);
    // No file paths from any of the malformed entries
    expect(result[0]!.filePaths).toEqual([]);
  });
});
