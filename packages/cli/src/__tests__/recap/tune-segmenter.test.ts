/**
 * Tests for scripts/tune-segmenter.ts
 *
 * All tests use dependency injection:
 * - apiClient is injected as the 2nd argument to main()
 * - storeFactory is injected as the 4th argument to main()
 * - node:fs is mocked at module level to prevent real file writes
 * - stdinLines is injected as the 3rd argument for consent prompts
 *
 * No real SQLite database or API calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  redactAuthHeader,
  type TunerStore,
} from "../../recap/tune-segmenter.js";

// ─── node:fs mock (module-level, required for ESM) ─────────────────────────────
//
// We intercept writeFileSync, existsSync, and readFileSync so no real
// file I/O happens. The mutable `fsMocks` object lets each test control
// return values without recreating the module mock.

const fsMocks = {
  writeFileSync: vi.fn((_path: unknown, _data: unknown, _opts?: unknown): void => {}),
  existsSync: vi.fn((_path: unknown): boolean => false),
  readFileSync: vi.fn((_path: unknown, _opts?: unknown): string => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
};

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    writeFileSync: ((...args: unknown[]) => (fsMocks.writeFileSync as (...a: unknown[]) => unknown)(...args)) as typeof original.writeFileSync,
    existsSync: ((...args: unknown[]) => (fsMocks.existsSync as (...a: unknown[]) => unknown)(...args)) as typeof original.existsSync,
    readFileSync: ((...args: unknown[]) => {
      // Only intercept the non-segment-weights reads (those that come from tests).
      // The segment.ts module load reads segment-weights.json at import time — that
      // already happened before our mock is active, so we only need to handle
      // the tune-segmenter's own existsSync/writeFileSync calls.
      return (fsMocks.readFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof original.readFileSync,
  };
});

// ─── Stub store factory ───────────────────────────────────────────────────────

function makeMockStore(options: {
  sessions?: Array<{ session_id: string; sensitiveTag?: boolean }>;
  messages?: Record<string, Array<{
    uuid: string;
    session_id: string;
    timestamp: number;
    prompt_text: string | null;
    file_paths: string;
    tools: string;
  }>>;
} = {}): TunerStore & {
  getSessions: ReturnType<typeof vi.fn>;
  getSessionMessages: ReturnType<typeof vi.fn>;
  getSessionIdsByTag: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const sessions = options.sessions ?? [
    { session_id: "sess-a" },
    { session_id: "sess-b" },
  ];

  const messages = options.messages ?? {
    "sess-a": [
      {
        uuid: "m1", session_id: "sess-a", timestamp: 1_700_000_000_000,
        prompt_text: "implement authentication token validation middleware",
        file_paths: '["src/auth/login.ts"]', tools: "[]",
      },
      {
        uuid: "m2", session_id: "sess-a", timestamp: 1_700_000_120_000,
        prompt_text: "add error handling to auth module",
        file_paths: '["src/auth/login.ts"]', tools: "[]",
      },
    ],
    "sess-b": [
      {
        uuid: "m3", session_id: "sess-b", timestamp: 1_700_000_000_000,
        prompt_text: "configure github actions workflow deployment pipeline",
        file_paths: '["src/ci/workflow.yml"]', tools: "[]",
      },
      {
        uuid: "m4", session_id: "sess-b", timestamp: 1_700_001_800_000,
        prompt_text: "database migration schema changes",
        file_paths: '["src/db/migrations.ts"]', tools: "[]",
      },
    ],
  };

  const sensitiveIds = new Set(
    sessions.filter((s) => s.sensitiveTag).map((s) => s.session_id)
  );

  return {
    getSessions: vi.fn(() => sessions.map((s) => ({ session_id: s.session_id }))),
    getSessionMessages: vi.fn((sessionId: string) =>
      (messages[sessionId] ?? []).map((m) => ({
        uuid: m.uuid,
        session_id: m.session_id,
        timestamp: m.timestamp,
        prompt_text: m.prompt_text,
        file_paths: m.file_paths,
        tools: m.tools,
      }))
    ),
    getSessionIdsByTag: vi.fn((tag: string) =>
      tag === "sensitive" ? [...sensitiveIds] : []
    ),
    close: vi.fn() as unknown as (() => void) & ReturnType<typeof vi.fn>,
  };
}

/** Build a canned Anthropic messages client stub. */
function makeApiClient(labels: Array<"same" | "different" | "parse-error">) {
  let callIndex = 0;
  const calls: unknown[] = [];

  return {
    messages: {
      create: vi.fn(async (_params: unknown) => {
        calls.push(_params);
        const label = labels[callIndex % labels.length];
        callIndex++;

        if (label === "parse-error") {
          return { content: [{ type: "text", text: "not json at all" }] };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ label, reason: "stub reason" }),
          }],
        };
      }),
    },
    get callCount() { return calls.length; },
  };
}

// ─── Helper ───────────────────────────────────────────────────────────────────

async function getMain() {
  const mod = await import("../../recap/tune-segmenter.js");
  return mod.main;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("tune-segmenter", () => {
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(() => {
    mockStore = makeMockStore();
    vi.spyOn(console, "log").mockImplementation(function () {});
    vi.spyOn(console, "error").mockImplementation(function () {});
    fsMocks.writeFileSync.mockClear();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: --dry-run (default) makes no API calls ─────────────────────────

  it("dry-run (default): prints sample pairs and makes no API calls", async () => {
    const apiClient = makeApiClient(["same"]);
    const main = await getMain();

    await main([], apiClient, undefined, () => mockStore);

    expect(apiClient.messages.create).not.toHaveBeenCalled();

    const logOutput = (console.log as ReturnType<typeof vi.spyOn>).mock.calls
      .flat().join("\n");
    expect(logOutput).toMatch(/DRY.RUN/i);
  });

  // ── Test 2 (SR-7 merge-blocker): no API call without explicit consent ───────

  it("SR-7: does not call the API when --i-have-reviewed-the-data is absent", async () => {
    const apiClient = makeApiClient(["same"]);
    const main = await getMain();

    // --dry-run=false without --i-have-reviewed-the-data still stays in dry-run.
    await main(["--dry-run=false"], apiClient, undefined, () => mockStore);

    expect(apiClient.messages.create).not.toHaveBeenCalled();
    expect(apiClient.callCount).toBe(0);
  });

  // ── Test 3: no API call if user does not type "yes" ───────────────────────

  it("no API call when user does not type yes at consent prompt", async () => {
    const apiClient = makeApiClient(["same"]);
    const main = await getMain();

    await main(["--i-have-reviewed-the-data"], apiClient, ["no"], () => mockStore);

    expect(apiClient.messages.create).not.toHaveBeenCalled();

    const logOutput = (console.log as ReturnType<typeof vi.spyOn>).mock.calls
      .flat().join("\n");
    expect(logOutput).toMatch(/aborted/i);
  });

  // ── Test 4: with consent + fixed labels → writes weights file ─────────────

  it("with consent and stubbed API: writes weights file and reports F1", async () => {
    // Build a store with enough pairs for a train/test split.
    const sessions = Array.from({ length: 5 }, (_, i) => ({ session_id: `sess-fit-${i}` }));
    const messages: Record<string, Array<{
      uuid: string; session_id: string; timestamp: number;
      prompt_text: string; file_paths: string; tools: string;
    }>> = {};
    for (let s = 0; s < 5; s++) {
      const sid = `sess-fit-${s}`;
      messages[sid] = [
        {
          uuid: `${sid}-m1`, session_id: sid, timestamp: 1_700_000_000_000,
          prompt_text: `implement authentication module for session ${s}`,
          file_paths: '["src/auth/login.ts"]', tools: "[]",
        },
        {
          uuid: `${sid}-m2`, session_id: sid, timestamp: 1_700_000_120_000,
          prompt_text: `add error handling to auth ${s}`,
          file_paths: '["src/auth/login.ts"]', tools: "[]",
        },
        {
          uuid: `${sid}-m3`, session_id: sid, timestamp: 1_700_001_800_000,
          prompt_text: `database migration changes ${s}`,
          file_paths: '["src/db/migrations.ts"]', tools: "[]",
        },
      ];
    }
    const largeStore = makeMockStore({ sessions, messages });

    const labelSequence: Array<"same" | "different"> = [];
    for (let i = 0; i < 50; i++) {
      labelSequence.push(i % 2 === 0 ? "same" : "different");
    }
    const apiClient = makeApiClient(labelSequence);

    const main = await getMain();
    await main(
      ["--i-have-reviewed-the-data", "--output=/tmp/test-weights.json", "--sample-size=20"],
      apiClient,
      ["yes"],
      () => largeStore
    );

    // API must have been called at least once.
    expect(apiClient.messages.create).toHaveBeenCalled();

    // writeFileSync must have been called with valid JSON.
    expect(fsMocks.writeFileSync).toHaveBeenCalled();
    const writeArgs = fsMocks.writeFileSync.mock.calls[0];
    expect(writeArgs).toBeDefined();
    const writtenJson = writeArgs?.[1] as string;
    const written = JSON.parse(writtenJson) as Record<string, unknown>;

    expect(written).toHaveProperty("version", 1);
    expect(written).toHaveProperty("model", "claude-haiku-4-5");
    expect(written).toHaveProperty("weights");
    const w = written["weights"] as Record<string, number>;
    expect(typeof w["gap"]).toBe("number");
    expect(typeof w["threshold"]).toBe("number");

    // F1 appears in stdout.
    const logOutput = (console.log as ReturnType<typeof vi.spyOn>).mock.calls
      .flat().join("\n");
    expect(logOutput).toMatch(/F1/);
    expect(logOutput).toMatch(/\d+\.\d+/);
  });

  // ── Test 5: sensitive sessions are excluded ────────────────────────────────

  it("sensitive sessions are excluded from sampling", async () => {
    const sensitiveStore = makeMockStore({
      sessions: [
        { session_id: "sess-normal" },
        { session_id: "sess-sensitive", sensitiveTag: true },
      ],
      messages: {
        "sess-normal": [
          {
            uuid: "n1", session_id: "sess-normal", timestamp: 1_700_000_000_000,
            prompt_text: "normal task one", file_paths: "[]", tools: "[]",
          },
          {
            uuid: "n2", session_id: "sess-normal", timestamp: 1_700_000_120_000,
            prompt_text: "normal task two", file_paths: "[]", tools: "[]",
          },
        ],
        "sess-sensitive": [
          {
            uuid: "s1", session_id: "sess-sensitive", timestamp: 1_700_000_000_000,
            prompt_text: "secret task one", file_paths: "[]", tools: "[]",
          },
          {
            uuid: "s2", session_id: "sess-sensitive", timestamp: 1_700_000_120_000,
            prompt_text: "secret task two", file_paths: "[]", tools: "[]",
          },
        ],
      },
    });

    const apiClient = makeApiClient(["same"]);
    const main = await getMain();

    // Dry-run: observe which sessions are queried.
    await main(["--dry-run"], apiClient, undefined, () => sensitiveStore);

    const messagesCalls = sensitiveStore.getSessionMessages.mock.calls;
    const calledSessionIds = messagesCalls.map((c) => c[0] as string);
    expect(calledSessionIds).not.toContain("sess-sensitive");
    expect(calledSessionIds).toContain("sess-normal");

    // No API calls.
    expect(apiClient.messages.create).not.toHaveBeenCalled();
  });

  // ── Test 6: Authorization header is redacted in error output ──────────────

  it("redactAuthHeader strips Authorization and Bearer tokens from error strings", () => {
    const withBearer = "Request failed: Authorization: Bearer sk-ant-abc123 was rejected";
    const redacted = redactAuthHeader(withBearer);
    expect(redacted).not.toContain("sk-ant-abc123");
    expect(redacted).not.toContain("Bearer sk-ant-abc123");
    expect(redacted).toContain("REDACTED");

    const withKey = "x-api-key: sk-ant-secret999 in headers";
    const redacted2 = redactAuthHeader(withKey);
    expect(redacted2).not.toContain("sk-ant-secret999");
    expect(redacted2).toContain("REDACTED");

    const withAuthHeader = "Authorization: sk-ant-xyz987";
    const redacted3 = redactAuthHeader(withAuthHeader);
    expect(redacted3).not.toMatch(/Authorization:\s*sk-ant-/);
  });

  // ── Test 7: Hold-out F1 is reported in stdout ─────────────────────────────

  it("F1 is printed to stdout after labelling", async () => {
    const sessions = Array.from({ length: 3 }, (_, i) => ({ session_id: `sess-f1-${i}` }));
    const messages: Record<string, Array<{
      uuid: string; session_id: string; timestamp: number;
      prompt_text: string; file_paths: string; tools: string;
    }>> = {};
    for (let s = 0; s < 3; s++) {
      const sid = `sess-f1-${s}`;
      messages[sid] = [
        {
          uuid: `${sid}-a`, session_id: sid, timestamp: 1_700_000_000_000,
          prompt_text: `implement feature ${s}`, file_paths: "[]", tools: "[]",
        },
        {
          uuid: `${sid}-b`, session_id: sid, timestamp: 1_700_000_120_000,
          prompt_text: `test feature ${s}`, file_paths: "[]", tools: "[]",
        },
        {
          uuid: `${sid}-c`, session_id: sid, timestamp: 1_700_001_800_000,
          prompt_text: `deploy feature ${s}`, file_paths: "[]", tools: "[]",
        },
      ];
    }
    const f1Store = makeMockStore({ sessions, messages });

    const apiClient = makeApiClient(["same", "different", "same", "different", "different", "same"]);
    const main = await getMain();

    await main(
      ["--i-have-reviewed-the-data", "--output=/tmp/f1-test-weights.json", "--sample-size=10"],
      apiClient,
      ["yes"],
      () => f1Store
    );

    const logOutput = (console.log as ReturnType<typeof vi.spyOn>).mock.calls
      .flat().join("\n");

    expect(logOutput).toMatch(/F1/);
    expect(logOutput).toMatch(/\d+\.\d+/);
  });

  // ── Test 8: SR-7 redundant check (explicit merge-blocker assertion) ────────

  it("SR-7 merge-blocker: mock API call count is exactly 0 without consent", async () => {
    const apiClient = makeApiClient(["same", "different"]);
    const main = await getMain();

    // No --i-have-reviewed-the-data flag.
    await main([], apiClient, undefined, () => mockStore);

    // THE critical assertion for SR-7.
    expect(apiClient.callCount).toBe(0);
    expect(apiClient.messages.create).not.toHaveBeenCalled();
  });
});

// ─── redactAuthHeader unit tests ──────────────────────────────────────────────

describe("redactAuthHeader", () => {
  it("leaves safe strings unchanged", () => {
    const safe = "Connection failed: timeout after 30s";
    expect(redactAuthHeader(safe)).toBe(safe);
  });

  it("redacts sk-ant- token anywhere in the string", () => {
    const s = "got sk-ant-api03-ABCDEF123 in the response";
    const r = redactAuthHeader(s);
    expect(r).not.toContain("sk-ant-api03-ABCDEF123");
    expect(r).toContain("[REDACTED]");
  });

  it("is case-insensitive for header name and redacts Bearer + token", () => {
    const s = "AUTHORIZATION: Bearer token123";
    const r = redactAuthHeader(s);
    expect(r).not.toContain("token123");
    expect(r).not.toContain("Bearer");
    expect(r).toContain("REDACTED");
  });
});
