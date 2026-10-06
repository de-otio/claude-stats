/**
 * Org-plane tool counts: the format fix and the redaction, together.
 *
 * `sessions.tool_use_counts` is stored as an ARRAY of `{name, count}` (the
 * projection from `messages`, schema V24). The org projection used to read only
 * the object form, so every synced row carried `toolUseCounts: {}` — team tool
 * counts were always empty. Reading the array form without redaction would
 * start sending raw `mcp__<server>__<tool>` names (user-configured server
 * names) to the org backend. These tests cover both halves:
 *
 *  - rows are seeded THROUGH THE STORE (`upsertSession` + `upsertMessages` +
 *    `recomputeSessionAggregates`) and the payload is built by the real
 *    `buildAggregatePayload` → `store.getSessions` → `projectUserAggregates`
 *    path, never from hand-written column JSON;
 *  - the payload's tool counts are non-empty and conserve every call (the
 *    functional bug is fixed);
 *  - no seeded tool name, agent type or skill reaches the serialised payload;
 *    only built-in tool names, "mcp" and "custom" do (the privacy property);
 *  - the projection reads only an allowlist of session columns, and never
 *    `agent_type`, `spawn_tool_use_id`, `spawn_depth` or `skill`.
 *
 * All names are invented (`AcmeCorp`, `globex-internal`, …).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type SessionRow } from "../../store/index.js";
import { buildAccountMappings, buildAggregatePayload, type PersistedSyncConfig } from "../../sync/index.js";
import { BUILT_IN_TOOL_NAMES, isBuiltInToolName } from "@claude-stats/core/identifiers";
import type { MessageRecord, SessionRecord } from "@claude-stats/core/types";

const ACCOUNT = "acct-redaction-test";
const SALT = "b".repeat(64);
const DAY = Date.UTC(2026, 0, 15, 12, 0, 0);

const ALLOWED_TOOL_KEYS = new Set<string>([...BUILT_IN_TOOL_NAMES, "mcp", "custom"]);

function makeSession(sessionId: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId,
    projectPath: "/home/dev/repos/example-project",
    sourceFile: `/home/dev/.claude/projects/example/${sessionId}.jsonl`,
    firstTimestamp: DAY,
    lastTimestamp: DAY + 60_000,
    claudeVersion: "2.1.70",
    entrypoint: "claude",
    gitBranch: "main",
    permissionMode: "default",
    isInteractive: true,
    promptCount: 1,
    assistantMessageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    // Deliberately empty: the stored value must come from the messages projection.
    toolUseCounts: [],
    models: [],
    repoUrl: null,
    accountUuid: ACCOUNT,
    organizationUuid: null,
    subscriptionType: null,
    thinkingBlocks: 0,
    parentSessionId: null,
    isSubagent: false,
    sourceDeleted: false,
    throttleEvents: 0,
    activeDurationMs: 60_000,
    medianResponseTimeMs: null,
    ...over,
  };
}

function makeMessage(uuid: string, sessionId: string, tools: string[], over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid,
    sessionId,
    timestamp: DAY,
    claudeVersion: "2.1.70",
    model: "claude-sonnet-4",
    stopReason: "tool_use",
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    tools,
    filePaths: [],
    thinkingBlocks: 0,
    serviceTier: null,
    inferenceGeo: null,
    ephemeral5mCacheTokens: 0,
    ephemeral1hCacheTokens: 0,
    promptText: null,
    toolErrorCount: 0,
    isTurnStart: false,
    ...over,
  };
}

function persistedConfig(): PersistedSyncConfig {
  return {
    endpoint: "https://example.invalid/graphql",
    userPoolId: "us-east-1_test",
    clientId: "test-client",
    region: "us-east-1",
    userSalt: SALT,
    accountMappings: buildAccountMappings([{ accountUuid: ACCOUNT, label: "test" }], SALT),
  };
}

interface SeedSession {
  readonly agentType?: string;
  /** One entry per assistant message: the tool calls it made. */
  readonly messages: ReadonlyArray<{ readonly tools: readonly string[]; readonly skill?: string }>;
}

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh store seeded through the real write path, projected through the real read path. */
function withSeededStore<T>(sessions: readonly SeedSession[], fn: (store: Store) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cs-tool-redaction-"));
  dirs.push(dir);
  const store = new Store(join(dir, "test.db"));
  try {
    const ids: string[] = [];
    sessions.forEach((s, si) => {
      const sessionId = `sess-${si}`;
      ids.push(sessionId);
      store.upsertSession(makeSession(sessionId, s.agentType !== undefined ? { agentType: s.agentType } : {}));
      store.upsertMessages(
        s.messages.map((m, mi) =>
          makeMessage(`msg-${si}-${mi}`, sessionId, [...m.tools], m.skill !== undefined ? { skill: m.skill } : {}),
        ),
      );
    });
    store.recomputeSessionAggregates(ids);
    return fn(store);
  } finally {
    store.close();
  }
}

/** Expected bucketed tally, computed independently of the code under test. */
function expectedBuckets(sessions: readonly SeedSession[]): Record<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    for (const m of s.messages) {
      for (const t of m.tools) {
        const b = isBuiltInToolName(t) ? t : t.startsWith("mcp__") ? "mcp" : "custom";
        out.set(b, (out.get(b) ?? 0) + 1);
      }
    }
  }
  return Object.fromEntries([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ── generators ──────────────────────────────────────────────────────────────

/** Company-like, user-authored names. The random suffix makes a substring hit unambiguous. */
const companyLike = fc
  .tuple(
    fc.constantFrom("AcmeCorp", "globex-internal", "InitechTools", "umbrella-labs", "Hooli", "vandelay"),
    fc.stringMatching(/^[a-z0-9]{3,8}$/),
  )
  .map(([base, suffix]) => `${base}-${suffix}`);

/** Names that would corrupt a plain `{}` tally. */
const prototypeKeys = fc.constantFrom("__proto__", "constructor", "toString", "hasOwnProperty", "valueOf");

const mcpName = fc
  .tuple(fc.oneof(companyLike, prototypeKeys), fc.oneof(companyLike, fc.constantFrom("query", "search", "deploy")))
  .map(([server, tool]) => `mcp__${server}__${tool}`);

/** Any user-authored tool name: never a built-in by construction. */
const userToolName = fc.oneof(companyLike, prototypeKeys, mcpName);

const builtInName = fc.constantFrom(...BUILT_IN_TOOL_NAMES);

const seedSessions = fc.array(
  fc.record(
    {
      agentType: fc.oneof(companyLike, prototypeKeys),
      messages: fc.array(
        fc.record(
          {
            tools: fc.array(fc.oneof(userToolName, builtInName), { minLength: 1, maxLength: 5 }),
            skill: fc.oneof(companyLike, prototypeKeys),
          },
          { requiredKeys: ["tools"] },
        ),
        { minLength: 1, maxLength: 4 },
      ),
    },
    { requiredKeys: ["messages"] },
  ),
  { minLength: 1, maxLength: 4 },
);

function userAuthoredNames(sessions: readonly SeedSession[]): string[] {
  const names = new Set<string>();
  for (const s of sessions) {
    if (s.agentType !== undefined) names.add(s.agentType);
    for (const m of s.messages) {
      if (m.skill !== undefined) names.add(m.skill);
      for (const t of m.tools) if (!isBuiltInToolName(t)) names.add(t);
    }
  }
  return [...names];
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("org projection tool counts — seeded through the store", () => {
  it("team tool counts are NON-EMPTY and conserve every call (the array-form bug is fixed)", () => {
    const sessions: SeedSession[] = [
      { messages: [{ tools: ["Read", "Read", "Edit"] }, { tools: ["Bash"] }] },
      { messages: [{ tools: ["mcp__AcmeCorp-x1__query", "mcp__globex-internal__search"] }, { tools: ["Read"] }] },
      { messages: [{ tools: ["InitechTools-deploy"] }] },
    ];
    withSeededStore(sessions, (store) => {
      // The stored column really is the array form (the shape this test guards).
      const stored = store.getSessions({ includeCI: true }).map((r) => JSON.parse(r.tool_use_counts) as unknown);
      expect(stored.every((v) => Array.isArray(v))).toBe(true);

      const payload = buildAggregatePayload(store, persistedConfig());
      expect(payload).toHaveLength(1);
      expect(payload[0]!.toolUseCounts).toEqual({ Bash: 1, Edit: 1, Read: 3, custom: 1, mcp: 2 });
    });
  });

  it("privacy property: no tool name, agent type or skill a user authored reaches the serialised payload", () => {
    fc.assert(
      fc.property(seedSessions, (sessions) => {
        withSeededStore(sessions, (store) => {
          const payload = buildAggregatePayload(store, persistedConfig());

          // Positive half, so the negative half cannot pass on an empty payload:
          // one row, carrying exactly the bucketed tally of every seeded call.
          expect(payload).toHaveLength(1);
          const counts = payload[0]!.toolUseCounts ?? {};
          expect(Object.keys(counts).length).toBeGreaterThan(0);
          expect(counts).toEqual(expectedBuckets(sessions));

          // Only built-in names, "mcp" and "custom" as keys.
          for (const key of Object.keys(counts)) expect(ALLOWED_TOOL_KEYS.has(key)).toBe(true);

          // No user-authored string anywhere in the serialised payload.
          const serialised = JSON.stringify(payload);
          for (const name of userAuthoredNames(sessions)) {
            expect(serialised).not.toContain(name);
          }
        });
      }),
      { numRuns: 40, seed: 0x5eed_b4 },
    );
  });

  it("a `__proto__` / `constructor` tool name is counted as custom without corrupting the tally", () => {
    const sessions: SeedSession[] = [
      { messages: [{ tools: ["__proto__", "constructor", "toString", "Read"] }] },
    ];
    withSeededStore(sessions, (store) => {
      const counts = buildAggregatePayload(store, persistedConfig())[0]!.toolUseCounts!;
      expect(counts).toEqual({ Read: 1, custom: 3 });
      expect(Object.getPrototypeOf(counts)).toBe(Object.prototype);
    });
  });
});

describe("org projection column allowlist", () => {
  /**
   * Every session column the org projection (the `buildAggregatePayload` filter
   * plus `projectUserAggregates`) is allowed to read. A new column is invisible
   * to the payload unless it is added here deliberately.
   */
  const ALLOWED_COLUMNS = new Set<string>([
    "account_uuid",
    "first_timestamp",
    "last_timestamp",
    "is_subagent",
    "prompt_count",
    "input_tokens",
    "output_tokens",
    "cache_creation_tokens",
    "cache_read_tokens",
    "active_duration_ms",
    "models",
    "tool_use_counts",
  ]);
  const FORBIDDEN_COLUMNS = ["agent_type", "spawn_depth", "spawn_tool_use_id", "skill"];

  it("reads only allowlisted columns — never agent_type, spawn_depth, spawn_tool_use_id or skill", () => {
    const sessions: SeedSession[] = [
      { agentType: "acme-critic", messages: [{ tools: ["Read", "mcp__AcmeCorp-q9__query"], skill: "example-skill" }] },
    ];
    withSeededStore(sessions, (store) => {
      // The sentinel really is in the row the projection receives (schema V25
      // column, `SELECT *`), so "never read" below is not vacuous.
      expect(store.getSessions({ includeCI: true })[0]!.agent_type).toBe("acme-critic");

      const accessed = new Set<string>();
      const realGetSessions = store.getSessions.bind(store);
      vi.spyOn(store, "getSessions").mockImplementation((filters) =>
        realGetSessions(filters).map(
          (row) =>
            new Proxy(row, {
              get(target, prop, receiver) {
                if (typeof prop === "string") accessed.add(prop);
                return Reflect.get(target, prop, receiver) as unknown;
              },
            }) as SessionRow,
        ),
      );

      const payload = buildAggregatePayload(store, persistedConfig());
      expect(payload).toHaveLength(1); // the proxied rows really were projected
      expect(accessed.size).toBeGreaterThan(0);

      for (const col of accessed) expect(ALLOWED_COLUMNS.has(col), `unexpected column read: ${col}`).toBe(true);
      for (const col of FORBIDDEN_COLUMNS) expect(accessed.has(col)).toBe(false);
      expect(JSON.stringify(payload)).not.toContain("acme-critic");
      expect(JSON.stringify(payload)).not.toContain("example-skill");
    });
  });
});
