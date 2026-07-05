/**
 * OTEL/OTLP ingestion tests (Phase 2 D).
 *
 * Confidentiality (plan §7 sec#5 / L3): all account UUIDs / orgs / sessions
 * come from the canonical placeholder fixtures (`00000000-…`). No real values.
 *
 * Determinism: a FIXED clock is injected into ingestOtel; never Date.now().
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  parseOtelFile,
  assertSafeOtelFile,
  foldExportRequest,
  MAX_FILE_BYTES,
  type OtelParseResult,
} from "../otel/parse.js";
import { ingestOtel } from "../otel/ingest.js";
import { Store } from "../store/index.js";
import type { SessionRow } from "../store/index.js";
import {
  ACCOUNT_A_UUID,
  ACCOUNT_B_UUID,
  ORG_A_UUID,
  makeSessionRow,
} from "./fixtures/accounts.js";

const T0 = 1_700_000_000_000;
const fixedClock = (t: number) => () => t;

/**
 * `account_source` / `account_confidence` are real DB columns (V13) but are not
 * declared on the frozen `SessionRow` interface; `getSessions` does
 * `SELECT *`, so the values are present at runtime. Read them via a typed
 * accessor instead of editing the frozen store types.
 */
function attribution(row: SessionRow): { source: string | null; confidence: string | null } {
  const r = row as unknown as Record<string, unknown>;
  return {
    source: (r.account_source as string | null) ?? null,
    confidence: (r.account_confidence as string | null) ?? null,
  };
}

// ─── OTLP fixture builders (neutral; resource-level account/session binding) ──

interface BuildReqOpts {
  accountUuid: string;
  sessionId: string;
  organizationUuid?: string | null;
  entrypoint?: string | null;
  terminalType?: string | null;
  tokens?: Array<{ type: string; model: string; n: number; tsNano?: string }>;
  /** Emit as resourceLogs instead of resourceMetrics. */
  asLogs?: boolean;
}

function kv(key: string, stringValue: string) {
  return { key, value: { stringValue } };
}

function buildExportRequest(o: BuildReqOpts): Record<string, unknown> {
  const attrs: Array<Record<string, unknown>> = [
    kv("user.account_uuid", o.accountUuid),
    kv("session.id", o.sessionId),
  ];
  if (o.organizationUuid) attrs.push(kv("organization.id", o.organizationUuid));
  if (o.entrypoint) attrs.push(kv("app.entrypoint", o.entrypoint));
  if (o.terminalType) attrs.push(kv("terminal.type", o.terminalType));

  const dataPoints = (o.tokens ?? []).map((tok) => ({
    attributes: [kv("type", tok.type), kv("model", tok.model)],
    asInt: String(tok.n),
    timeUnixNano: tok.tsNano ?? String(T0 * 1_000_000),
  }));

  if (o.asLogs) {
    return {
      resourceLogs: [
        {
          resource: { attributes: attrs },
          scopeLogs: [{ logRecords: [{ body: { stringValue: "x" } }] }],
        },
      ],
    };
  }

  return {
    resourceMetrics: [
      {
        resource: { attributes: attrs },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: { dataPoints },
              },
            ],
          },
        ],
      },
    ],
  };
}

function tmpFile(contents: string, ext = "jsonl"): string {
  const p = path.join(
    os.tmpdir(),
    `cs-otel-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`,
  );
  fs.writeFileSync(p, contents);
  return p;
}

function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `cs-otel-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function insertSession(store: Store, row: Partial<SessionRow>): void {
  const r = makeSessionRow(row);
  store.upsertSession({
    sessionId: r.session_id,
    projectPath: r.project_path,
    sourceFile: r.source_file,
    firstTimestamp: r.first_timestamp,
    lastTimestamp: r.last_timestamp,
    claudeVersion: r.claude_version,
    entrypoint: r.entrypoint,
    gitBranch: r.git_branch,
    permissionMode: null,
    isInteractive: r.is_interactive === 1,
    promptCount: r.prompt_count,
    assistantMessageCount: r.assistant_message_count,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    cacheReadTokens: r.cache_read_tokens,
    webSearchRequests: r.web_search_requests,
    webFetchRequests: r.web_fetch_requests,
    toolUseCounts: [],
    models: [],
    repoUrl: r.repo_url,
    accountUuid: r.account_uuid,
    organizationUuid: r.organization_uuid,
    subscriptionType: r.subscription_type,
    thinkingBlocks: r.thinking_blocks,
    parentSessionId: r.parent_session_id,
    isSubagent: r.is_subagent === 1,
    sourceDeleted: r.source_deleted === 1,
    throttleEvents: r.throttle_events,
    activeDurationMs: r.active_duration_ms,
    medianResponseTimeMs: r.median_response_time_ms,
  });
}

const SID_1 = "00000000-0000-0000-0000-0000000000c1";
const SID_2 = "00000000-0000-0000-0000-0000000000c2";
const SID_VS = "00000000-0000-0000-0000-0000000000v1";
const SID_DESK = "00000000-0000-0000-0000-0000000000d1";

// ─── parse: JSONL ─────────────────────────────────────────────────────────────

describe("parseOtelFile — JSONL", () => {
  it("extracts account/session/surface + tokens/model from a JSONL file", async () => {
    const lines = [
      buildExportRequest({
        accountUuid: ACCOUNT_A_UUID,
        sessionId: SID_1,
        organizationUuid: ORG_A_UUID,
        entrypoint: "cli",
        tokens: [
          { type: "input", model: "claude-sonnet-4-6", n: 100 },
          { type: "output", model: "claude-sonnet-4-6", n: 250 },
        ],
      }),
      buildExportRequest({
        accountUuid: ACCOUNT_B_UUID,
        sessionId: SID_2,
        entrypoint: "claude-vscode",
        tokens: [{ type: "input", model: "claude-opus-4-8", n: 7 }],
      }),
    ].map((o) => JSON.stringify(o));
    const file = tmpFile(lines.join("\n") + "\n");
    try {
      const res = await parseOtelFile(file);
      expect(res.sessions.size).toBe(2);
      expect(res.accounts.size).toBe(2);
      expect(res.malformed).toBe(0);
      expect(res.truncated).toBe(false);

      const s1 = res.sessions.get(SID_1)!;
      expect(s1.accountUuid).toBe(ACCOUNT_A_UUID);
      expect(s1.organizationUuid).toBe(ORG_A_UUID);
      expect(s1.surface).toBe("cli");
      expect(s1.tokens).toBe(350);
      expect(s1.models).toEqual(["claude-sonnet-4-6"]);
      expect(s1.ts).toBe(T0);

      const s2 = res.sessions.get(SID_2)!;
      expect(s2.surface).toBe("claude-vscode");
      expect(s2.tokens).toBe(7);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("falls back to terminal.type when app.entrypoint is absent", async () => {
    const file = tmpFile(
      JSON.stringify(
        buildExportRequest({
          accountUuid: ACCOUNT_A_UUID,
          sessionId: SID_1,
          terminalType: "iTerm.app",
        }),
      ) + "\n",
    );
    try {
      const res = await parseOtelFile(file);
      expect(res.sessions.get(SID_1)!.surface).toBe("iTerm.app");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("reads account binding from resourceLogs as well as resourceMetrics", async () => {
    const file = tmpFile(
      JSON.stringify(
        buildExportRequest({
          accountUuid: ACCOUNT_A_UUID,
          sessionId: SID_1,
          entrypoint: "claude-desktop",
          asLogs: true,
        }),
      ) + "\n",
    );
    try {
      const res = await parseOtelFile(file);
      const s1 = res.sessions.get(SID_1)!;
      expect(s1.accountUuid).toBe(ACCOUNT_A_UUID);
      expect(s1.surface).toBe("claude-desktop");
      expect(s1.tokens).toBe(0);
      expect(s1.models).toEqual([]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("tolerates malformed lines (counts + skips, never throws)", async () => {
    const good = JSON.stringify(
      buildExportRequest({ accountUuid: ACCOUNT_A_UUID, sessionId: SID_1 }),
    );
    const file = tmpFile(["{not json", good, "", "also { bad"].join("\n"));
    try {
      const res = await parseOtelFile(file);
      expect(res.sessions.size).toBe(1);
      expect(res.malformed).toBe(2);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("ignores records lacking account_uuid or session.id", async () => {
    const noAccount = { resourceMetrics: [{ resource: { attributes: [kv("session.id", SID_1)] }, scopeMetrics: [] }] };
    const noSession = { resourceMetrics: [{ resource: { attributes: [kv("user.account_uuid", ACCOUNT_A_UUID)] }, scopeMetrics: [] }] };
    const file = tmpFile([JSON.stringify(noAccount), JSON.stringify(noSession)].join("\n"));
    try {
      const res = await parseOtelFile(file);
      expect(res.sessions.size).toBe(0);
      expect(res.accounts.size).toBe(0);
      // both records were structurally valid JSON → not malformed
      expect(res.malformed).toBe(0);
      expect(res.recordCount).toBe(2);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

// ─── parse: single-object and array forms ─────────────────────────────────────

describe("parseOtelFile — non-JSONL forms", () => {
  it("parses a single top-level OTLP object (one line)", async () => {
    const file = tmpFile(
      JSON.stringify(
        buildExportRequest({ accountUuid: ACCOUNT_A_UUID, sessionId: SID_1, entrypoint: "cli" }),
      ),
      "json",
    );
    try {
      const res = await parseOtelFile(file);
      expect(res.sessions.size).toBe(1);
      expect(res.sessions.get(SID_1)!.accountUuid).toBe(ACCOUNT_A_UUID);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("parses a top-level JSON array of export requests on one line", async () => {
    const arr = [
      buildExportRequest({ accountUuid: ACCOUNT_A_UUID, sessionId: SID_1 }),
      buildExportRequest({ accountUuid: ACCOUNT_B_UUID, sessionId: SID_2 }),
    ];
    const file = tmpFile(JSON.stringify(arr), "json");
    try {
      const res = await parseOtelFile(file);
      expect(res.sessions.size).toBe(2);
      expect(res.accounts.size).toBe(2);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("counts non-object array items as malformed", async () => {
    const file = tmpFile(JSON.stringify([42, "x", null]), "json");
    try {
      const res = await parseOtelFile(file);
      expect(res.sessions.size).toBe(0);
      expect(res.malformed).toBe(3);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("counts a top-level scalar as malformed", async () => {
    const file = tmpFile("42\n");
    try {
      const res = await parseOtelFile(file);
      expect(res.malformed).toBe(1);
      expect(res.sessions.size).toBe(0);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

// ─── parse: AnyValue coercion (foldExportRequest unit) ────────────────────────

describe("foldExportRequest — AnyValue coercion", () => {
  function empty(): OtelParseResult {
    return { sessions: new Map(), accounts: new Map(), recordCount: 0, malformed: 0, truncated: false };
  }

  it("accepts intValue as number for token count and asDouble fallback", () => {
    const res = empty();
    const consumed = foldExportRequest(
      {
        resourceMetrics: [
          {
            resource: {
              attributes: [
                { key: "user.account_uuid", value: { stringValue: ACCOUNT_A_UUID } },
                { key: "session.id", value: { stringValue: SID_1 } },
              ],
            },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "claude_code.token.usage",
                    sum: {
                      dataPoints: [
                        { attributes: [{ key: "model", value: { stringValue: "m" } }], asDouble: 12.6 },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      res,
    );
    expect(consumed).toBe(1);
    expect(res.sessions.get(SID_1)!.tokens).toBe(13); // rounded asDouble
  });

  it("uses gauge dataPoints when sum is absent", () => {
    const res = empty();
    foldExportRequest(
      {
        resourceMetrics: [
          {
            resource: {
              attributes: [
                { key: "user.account_uuid", value: { stringValue: ACCOUNT_A_UUID } },
                { key: "session.id", value: { stringValue: SID_1 } },
              ],
            },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: "claude_code.token.usage",
                    gauge: { dataPoints: [{ asInt: 5 }] },
                  },
                ],
              },
            ],
          },
        ],
      },
      res,
    );
    expect(res.sessions.get(SID_1)!.tokens).toBe(5);
  });
});

// ─── hardening ────────────────────────────────────────────────────────────────

describe("assertSafeOtelFile — hardening", () => {
  it("rejects an oversize file before reading", () => {
    const file = tmpFile("{}\n");
    try {
      // Truncate-extend to just over the cap without writing 500MB of data.
      const fd = fs.openSync(file, "r+");
      fs.ftruncateSync(fd, MAX_FILE_BYTES + 1);
      fs.closeSync(fd);
      expect(() => assertSafeOtelFile(file)).toThrow(/too large/i);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("rejects a symlink", () => {
    const target = tmpFile("{}\n");
    const link = path.join(
      os.tmpdir(),
      `cs-otel-link-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
    );
    try {
      fs.symlinkSync(target, link);
      expect(() => assertSafeOtelFile(link)).toThrow(/symlink/i);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(target, { force: true });
    }
  });

  it("rejects a non-regular file (directory)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-otel-dir-"));
    try {
      expect(() => assertSafeOtelFile(dir)).toThrow(/not a regular file/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseOtelFile rejects an oversize file", async () => {
    const file = tmpFile("{}\n");
    try {
      const fd = fs.openSync(file, "r+");
      fs.ftruncateSync(fd, MAX_FILE_BYTES + 1);
      fs.closeSync(fd);
      await expect(parseOtelFile(file)).rejects.toThrow(/too large/i);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

// ─── ingest: authoritative attribution, all surfaces ──────────────────────────

describe("ingestOtel", () => {
  it("attributes sessions across ALL surfaces with source=otel/authoritative", async () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      // Pre-insert sessions on four surfaces (NULL account/source).
      insertSession(store, { session_id: SID_1, entrypoint: "cli", first_timestamp: T0 });
      insertSession(store, { session_id: SID_VS, entrypoint: "claude-vscode", first_timestamp: T0 });
      insertSession(store, { session_id: SID_DESK, entrypoint: "claude-desktop", first_timestamp: T0 });
      insertSession(store, { session_id: SID_2, entrypoint: "vscode", first_timestamp: T0 });

      const lines = [
        buildExportRequest({ accountUuid: ACCOUNT_A_UUID, sessionId: SID_1, organizationUuid: ORG_A_UUID, entrypoint: "cli" }),
        buildExportRequest({ accountUuid: ACCOUNT_A_UUID, sessionId: SID_VS, entrypoint: "claude-vscode" }),
        buildExportRequest({ accountUuid: ACCOUNT_B_UUID, sessionId: SID_DESK, entrypoint: "claude-desktop" }),
        buildExportRequest({ accountUuid: ACCOUNT_B_UUID, sessionId: SID_2, entrypoint: "vscode" }),
      ].map((o) => JSON.stringify(o));
      const file = tmpFile(lines.join("\n") + "\n");

      try {
        const summary = await ingestOtel(store, file, fixedClock(T0));
        expect(summary.sessions).toBe(4);
        expect(summary.accounts).toBe(2);
        expect(summary.changed).toBe(4);

        const rows = store.getSessions({ includeCI: true, includeDeleted: true });
        for (const sid of [SID_1, SID_VS, SID_DESK, SID_2]) {
          const row = rows.find((s) => s.session_id === sid)!;
          expect(row.account_uuid).not.toBeNull();
          expect(attribution(row).source).toBe("otel");
          expect(attribution(row).confidence).toBe("authoritative");
        }
        // org id flowed through for the CLI session
        expect(rows.find((s) => s.session_id === SID_1)!.organization_uuid).toBe(ORG_A_UUID);

        // observations + accounts table populated
        const obs = store.getAccountObservations();
        expect(obs.filter((o) => o.source === "otel").length).toBeGreaterThanOrEqual(2);
        const accts = store.listAccountsFull();
        expect(accts.map((a) => a.accountUuid).sort()).toEqual(
          [ACCOUNT_A_UUID, ACCOUNT_B_UUID].sort(),
        );
      } finally {
        fs.rmSync(file, { force: true });
      }
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("does not overwrite an existing override; ingest is monotonic", async () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    try {
      insertSession(store, { session_id: SID_1, entrypoint: "cli", first_timestamp: T0 });
      // Existing manual override → must survive OTEL ingest.
      store.applyAttribution(
        new Map([
          [SID_1, { accountUuid: ACCOUNT_A_UUID, organizationUuid: null, subscriptionType: null, source: "override", confidence: "authoritative" }],
        ]),
        fixedClock(T0),
      );

      const file = tmpFile(
        JSON.stringify(buildExportRequest({ accountUuid: ACCOUNT_B_UUID, sessionId: SID_1 })) + "\n",
      );
      try {
        const summary = await ingestOtel(store, file, fixedClock(T0 + 1));
        expect(summary.changed).toBe(0);
        const row = store
          .getSessions({ includeCI: true, includeDeleted: true })
          .find((s) => s.session_id === SID_1)!;
        expect(row.account_uuid).toBe(ACCOUNT_A_UUID);
        expect(attribution(row).source).toBe("override");
      } finally {
        fs.rmSync(file, { force: true });
      }
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("handles an empty/no-binding file gracefully (no changes)", async () => {
    const dbPath = tmpDbPath();
    const store = new Store(dbPath);
    const file = tmpFile("\n\n");
    try {
      const summary = await ingestOtel(store, file, fixedClock(T0));
      expect(summary.sessions).toBe(0);
      expect(summary.accounts).toBe(0);
      expect(summary.changed).toBe(0);
    } finally {
      store.close();
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(file, { force: true });
    }
  });
});
