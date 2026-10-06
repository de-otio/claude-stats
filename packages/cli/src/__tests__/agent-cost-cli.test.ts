/**
 * `claude-stats agents` + `get_agent_cost` (MCP) + `agentCost/format.ts`, and
 * the two places agent / skill names must NOT leak by default:
 * `claude-stats export` and the justification pack.
 *
 * Groups:
 *  1. Pure formatting (`formatAgentCostLines`, `printAgentCost`,
 *     `parseAgentsLimit`, export projection helpers) against hand-built reports.
 *  2. `claude-stats agents` and `claude-stats export` end-to-end through
 *     `buildCli`, over a seeded temp store (never the real DB).
 *  3. `get_agent_cost` over an in-memory MCP transport: listed, report-shaped,
 *     no session ids / uuids / paths.
 *  4. Export allowlist: the V25 columns are absent by default, present with
 *     `--include-agent-names`, every other field byte-identical, CSV cells that
 *     start with `@ - + =` are prefixed with `'`.
 *  5. Justification pack: no agent type or skill name in HTML or CSVs, paired
 *     with a positive assertion that the names ARE in the store and in the
 *     `agents` report.
 *
 * Fixture names: `my-reviewer`, `acme-critic`, `example-skill`; `Explore` is a
 * built-in agent type.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SessionRecord, MessageRecord } from "@claude-stats/core/types";
import type { AgentCostReport } from "@claude-stats/core/agentCost";
import { Store } from "../store/index.js";
import { createMcpServer } from "../mcp/index.js";
import { buildAgentCostReport } from "../agentCost/index.js";
import {
  formatAgentCostLines,
  printAgentCost,
  parseAgentsLimit,
  parseAgentsPeriod,
  projectSessionForExport,
  csvNameCell,
  EXPORT_SESSION_FIELDS,
  EXPORT_AGENT_FIELDS,
  type Translate,
} from "../agentCost/format.js";
import { buildJustificationPack } from "../pack/index.js";
import type { Config } from "../config.js";
import { t } from "../i18n.js";

// ─── Group 1: pure formatting ────────────────────────────────────────────────

const RANKING_WORDS = /\b(top|waste|wasted|wasteful|offender|offenders|worst|biggest|heaviest|culprit)\b/i;

function fullReport(): AgentCostReport {
  return {
    coverage: {
      totalCost: 10,
      mainCost: 6,
      subagentCost: 4,
      mainShare: 0.6,
      subagentShare: 0.4,
      messages: 12,
      mainMessages: 6,
      subagentMessages: 6,
      unpricedMessages: 2,
      knownTypeCost: 3,
      knownTypeShare: 0.75,
      periodGranularity: "day",
      byPeriod: [
        { start: Date.UTC(2026, 0, 5), subagentCost: 1, subagentMessages: 2, knownTypeCost: 0, knownTypeShare: 0 },
        { start: Date.UTC(2026, 0, 6), subagentCost: 3, subagentMessages: 4, knownTypeCost: 3, knownTypeShare: 1 },
      ],
      undatedSubagentCost: 0.5,
    },
    byAgentType: [
      { agentType: "my-reviewer", builtIn: false, cost: 2, share: 0.5, messages: 3 },
      { agentType: "Explore", builtIn: true, cost: 1, share: 0.25, messages: 2 },
      { agentType: null, builtIn: false, cost: 1, share: 0.25, messages: 1 },
    ],
    bySkill: [{ skill: "example-skill", costDuringRun: 0.5, share: 0.05, messages: 2 }],
    bySpawnDepth: [
      { depth: 1, cost: 3, share: 0.75, messages: 4 },
      { depth: null, cost: 1, share: 0.25, messages: 2 },
    ],
    other: {
      byAgentType: { buckets: 2, cost: 0.2, share: 0.05, messages: 1 },
      bySkill: { buckets: 1, costDuringRun: 0.1, share: 0.01, messages: 1 },
      bySpawnDepth: { buckets: 1, cost: 0.1, share: 0.02, messages: 1 },
    },
  };
}

function emptyReport(): AgentCostReport {
  return {
    coverage: {
      totalCost: 0,
      mainCost: 0,
      subagentCost: 0,
      mainShare: 0,
      subagentShare: 0,
      messages: 0,
      mainMessages: 0,
      subagentMessages: 0,
      unpricedMessages: 0,
      knownTypeCost: 0,
      knownTypeShare: 0,
      periodGranularity: "day",
      byPeriod: [],
      undatedSubagentCost: 0,
    },
    byAgentType: [],
    bySkill: [],
    bySpawnDepth: [],
    other: { byAgentType: null, bySkill: null, bySpawnDepth: null },
  };
}

describe("formatAgentCostLines", () => {
  it("puts the coverage block before every breakdown", () => {
    const lines = formatAgentCostLines(fullReport(), t);
    const idx = (needle: string): number => lines.findIndex((l) => l.includes(needle));
    expect(idx("Coverage:")).toBeGreaterThan(-1);
    expect(idx("Coverage:")).toBeLessThan(idx("By agent type"));
    expect(idx("By agent type")).toBeLessThan(idx("During a skill's run"));
    expect(idx("During a skill's run")).toBeLessThan(idx("By spawn depth"));
    // The headline split, the known-type line and the unpriced disclosure are all inside coverage.
    expect(idx("main conversation")).toBeLessThan(idx("By agent type"));
    expect(idx("recorded agent type")).toBeLessThan(idx("By agent type"));
    expect(idx("no known rate")).toBeLessThan(idx("By agent type"));
  });

  it("states total, main vs subagent share, known-type share and the unpriced count", () => {
    const text = formatAgentCostLines(fullReport(), t).join("\n");
    expect(text).toContain("Total: $10.00");
    expect(text).toContain("main conversation $6.00 (60.0%)");
    expect(text).toContain("subagents $4.00 (40.0%)");
    expect(text).toContain("recorded agent type: 75.0%");
    expect(text).toContain("2 message(s) use a model with no known rate");
  });

  it("renders a compact per-period known-type line in UTC days", () => {
    const text = formatAgentCostLines(fullReport(), t).join("\n");
    expect(text).toContain("by day: 2026-01-05 0.0% · 2026-01-06 100.0%");
    expect(text).toContain("has no timestamp");
  });

  it("labels the period line by week when the report is bucketed by week", () => {
    const r = fullReport();
    r.coverage.periodGranularity = "week";
    expect(formatAgentCostLines(r, t).join("\n")).toContain("by week (starting Monday)");
  });

  it("marks built-in vs user-named agent types, and the null bucket reads (unrecorded)", () => {
    const text = formatAgentCostLines(fullReport(), t).join("\n");
    expect(text).toContain("my-reviewer [user-named]");
    expect(text).toContain("Explore [built-in]");
    expect(text).toContain("(unrecorded) [not recorded]");
  });

  it("shows the folded remainder rows and the skill-run caveat", () => {
    const text = formatAgentCostLines(fullReport(), t).join("\n");
    expect(text).toContain("(other: 2 more agent types)");
    expect(text).toContain("(other: 1 more skills)");
    expect(text).toContain("(other: 1 more depths)");
    expect(text).toContain("example-skill: $0.50");
    expect(text).toContain("claude-stats context");
  });

  it("renders spawn depth rows, with an unrecorded depth stated as such", () => {
    const text = formatAgentCostLines(fullReport(), t).join("\n");
    expect(text).toContain("Depth 1: $3.00 (75.0%)");
    expect(text).toContain("Depth not recorded: $1.00 (25.0%)");
  });

  it("an empty report is honest: no NaN, no fabricated rows, every section says so", () => {
    const text = formatAgentCostLines(emptyReport(), t).join("\n");
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
    expect(text).toContain("Total: $0.00 across 0 messages");
    expect(text).toContain("No subagent spend in this window.");
    expect(text).toContain("No spend was recorded while a skill ran in this window.");
    expect(text).toContain("Every message in this window was priced.");
    expect(text).not.toContain("by day:");
    expect(text).not.toContain("[user-named]");
  });

  it("never uses ranking or judging words (describe, never judge)", () => {
    for (const report of [fullReport(), emptyReport()]) {
      const text = formatAgentCostLines(report, t).join("\n");
      expect(text).not.toMatch(RANKING_WORDS);
    }
  });

  it("uses only keys the real en catalog defines (no key echoed back)", () => {
    const text = formatAgentCostLines(fullReport(), t).join("\n");
    expect(text).not.toContain("cli:agentCost");
    expect(text).not.toContain("{{");
  });

  it("accepts the real i18n t() as its Translate", () => {
    const fn: Translate = t;
    expect(typeof fn("cli:agentCost.title")).toBe("string");
  });
});

describe("printAgentCost", () => {
  function collect(): { out: Writable; get: () => string } {
    let buf = "";
    const out = new Writable({
      write(chunk, _enc, cb) {
        buf += String(chunk);
        cb();
      },
    });
    return { out, get: () => buf };
  }

  it("writes text by default", () => {
    const { out, get } = collect();
    printAgentCost(fullReport(), out, t);
    expect(get()).toContain("Agent and skill cost");
  });

  it("writes the full report as JSON with --json, round-tripping unchanged", () => {
    const { out, get } = collect();
    const report = fullReport();
    printAgentCost(report, out, t, { json: true });
    expect(JSON.parse(get())).toEqual(report);
  });
});

describe("parseAgentsLimit", () => {
  it("absent flag is undefined (no limit)", () => {
    expect(parseAgentsLimit(undefined)).toBeUndefined();
  });
  it.each(["1", "10", " 25 ", "999999"])("accepts %j", (raw) => {
    expect(parseAgentsLimit(raw)).toBe(Number(raw.trim()));
  });
  it.each(["0", "-3", "1.5", "abc", "", "1e3", "99999999999999999999", "0x10"])("rejects %j", (raw) => {
    expect(parseAgentsLimit(raw)).toBeNull();
  });
});

describe("parseAgentsPeriod", () => {
  it("absent flag is the command's default, month", () => {
    expect(parseAgentsPeriod(undefined)).toBe("month");
  });
  it.each(["day", "week", "month", "all"])("accepts %j", (raw) => {
    expect(parseAgentsPeriod(raw)).toBe(raw);
  });
  it.each(["", "year", "Month", " week", "weekly", "7d", "constructor", "__proto__"])("rejects %j", (raw) => {
    expect(parseAgentsPeriod(raw)).toBeNull();
  });
});

describe("export projection helpers", () => {
  it("the allowlist never contains an agent field, and the two lists are disjoint", () => {
    for (const f of EXPORT_AGENT_FIELDS) expect(EXPORT_SESSION_FIELDS).not.toContain(f);
  });

  it("projects only allowlisted keys, in allowlist order, and drops unknown columns", () => {
    const row = { later_column: "x", session_id: "s", agent_type: "acme-critic", project_path: "/p" };
    expect(Object.keys(projectSessionForExport(row, false))).toEqual(["session_id", "project_path"]);
    expect(Object.keys(projectSessionForExport(row, true))).toEqual(["session_id", "project_path", "agent_type"]);
  });

  it.each([
    ["=cmd", "'=cmd"],
    ["@sum", "'@sum"],
    ["-1+1", "'-1+1"],
    ["+x", "'+x"],
    ["my-reviewer", "my-reviewer"],
    ["a=b", "a=b"],
    ["has,comma", '"has,comma"'],
    [null, ""],
    [undefined, ""],
    [2, "2"],
  ])("csvNameCell(%j) = %j", (input, expected) => {
    expect(csvNameCell(input)).toBe(expected);
  });
});

// ─── Seeded store shared by groups 2-5 ───────────────────────────────────────

const T0 = 1_767_571_200_000; // 2026-01-05T00:00:00Z
const MIN = 60_000;
const MODEL = "claude-sonnet-4-6";
const PROJECT = "/w/SENTINEL-PROJECT-path";
const MAIN_ID = "sess-SENTINEL-main-0001";
const SUB_TYPED_ID = "sess-SENTINEL-sub-0002";
const SUB_UNTYPED_ID = "sess-SENTINEL-sub-0003";
const SUB_BUILTIN_ID = "sess-SENTINEL-sub-0004";
const ACCOUNT = "a0000000-0000-0000-0000-000000000001";

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: id, projectPath: PROJECT, sourceFile: `${PROJECT}/${id}.jsonl`,
    firstTimestamp: T0, lastTimestamp: T0 + 60 * MIN, claudeVersion: "2.1.70",
    entrypoint: "claude", gitBranch: "main", permissionMode: "default",
    isInteractive: true, promptCount: 1, assistantMessageCount: 1,
    inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    webSearchRequests: 0, webFetchRequests: 0, toolUseCounts: [], models: [MODEL],
    repoUrl: null, accountUuid: ACCOUNT, organizationUuid: null, subscriptionType: "max",
    thinkingBlocks: 0, parentSessionId: null, isSubagent: false, sourceDeleted: false,
    throttleEvents: 0, activeDurationMs: null, medianResponseTimeMs: null,
    ...overrides,
  };
}

function message(uuid: string, sessionId: string, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    uuid, sessionId, timestamp: T0, claudeVersion: "2.1.70",
    model: MODEL, stopReason: "end_turn",
    inputTokens: 100_000, outputTokens: 20_000, cacheCreationTokens: 0, cacheReadTokens: 0,
    tools: [], filePaths: [`${PROJECT}/src/SENTINEL-file.ts`], thinkingBlocks: 0,
    serviceTier: null, inferenceGeo: null,
    ephemeral5mCacheTokens: 0, ephemeral1hCacheTokens: 0,
    promptText: "SENTINEL-PROMPT-TEXT", toolErrorCount: 0,
    ...overrides,
  };
}

function seed(store: Store): void {
  store.upsertSession(session(MAIN_ID));
  store.upsertSession(session(SUB_TYPED_ID, {
    isSubagent: true, parentSessionId: MAIN_ID, agentType: "my-reviewer", spawnDepth: 1,
    spawnToolUseId: "toolu_sentinel01",
  }));
  store.upsertSession(session(SUB_UNTYPED_ID, { isSubagent: true, parentSessionId: MAIN_ID }));
  store.upsertSession(session(SUB_BUILTIN_ID, {
    isSubagent: true, parentSessionId: MAIN_ID, agentType: "Explore", spawnDepth: 2,
  }));
  store.upsertMessages([
    message("m-main-1", MAIN_ID, { timestamp: T0 + 1 * MIN }),
    message("m-main-2", MAIN_ID, { timestamp: T0 + 2 * MIN, skill: "example-skill" }),
    message("m-sub-1", SUB_TYPED_ID, { timestamp: T0 + 3 * MIN }),
    message("m-sub-2", SUB_TYPED_ID, { timestamp: T0 + 4 * MIN, skill: "example-skill" }),
    message("m-sub-3", SUB_UNTYPED_ID, { timestamp: T0 + 5 * MIN }),
    message("m-sub-4", SUB_BUILTIN_ID, { timestamp: T0 + 6 * MIN }),
  ]);
}

/** A second typed subagent that carries the `acme-critic` sentinel. */
function seedCritic(store: Store): void {
  store.upsertSession(session("sess-SENTINEL-sub-0005", {
    isSubagent: true, parentSessionId: MAIN_ID, agentType: "acme-critic", spawnDepth: 1,
  }));
  store.upsertMessages([message("m-sub-5", "sess-SENTINEL-sub-0005", { timestamp: T0 + 7 * MIN })]);
}

// ─── Groups 2 + 4: CLI end-to-end (agents, export) ───────────────────────────

let tmpRoot: string;
let cliDbPath: string;

vi.mock("../store/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/index.js")>();
  class CliTestStore extends actual.Store {
    constructor() {
      super(cliDbPath);
    }
  }
  return { ...actual, Store: CliTestStore };
});

describe("claude-stats agents / export (CLI, end-to-end)", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cs-agent-cost-cli-"));
    cliDbPath = path.join(tmpRoot, "cli.db");
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  /** Pins the locale to `en` (see `context-carry-cli.test.ts#run`). */
  async function run(args: string[]): Promise<void> {
    const { buildCli } = await import("../cli/index.js");
    const savedArgv = process.argv;
    process.argv = ["node", "claude-stats", "--locale", "en"];
    try {
      const program = await buildCli();
      await program.parseAsync(["node", "claude-stats", ...args]);
    } finally {
      process.argv = savedArgv;
    }
  }

  const stdoutText = (): string => (writeSpy.mock.calls as Array<[string]>).map((c) => c[0]).join("");
  const logText = (): string => (logSpy.mock.calls as Array<unknown[]>).map((c) => c.join(" ")).join("\n");

  function seeded(): void {
    const store = new Store(cliDbPath);
    seed(store);
    seedCritic(store);
    store.close();
  }

  describe("agents", () => {
    it("--json prints the AgentCostReport shape, with the sentinel names and coverage", async () => {
      seeded();
      await run(["agents", "--period", "all", "--json"]);
      const data = JSON.parse(stdoutText()) as AgentCostReport;
      expect(Object.keys(data).sort()).toEqual(["bySkill", "bySpawnDepth", "byAgentType", "coverage", "other"].sort());
      expect(data.coverage.subagentCost).toBeGreaterThan(0);
      expect(data.coverage.mainShare + data.coverage.subagentShare).toBeCloseTo(1, 10);
      const types = data.byAgentType.map((r) => r.agentType);
      expect(types).toContain("my-reviewer");
      expect(types).toContain("acme-critic");
      expect(types).toContain("Explore");
      expect(types).toContain(null);
      expect(data.bySkill.map((r) => r.skill)).toEqual(["example-skill"]);
      expect(data.byAgentType.find((r) => r.agentType === "Explore")?.builtIn).toBe(true);
      expect(data.byAgentType.find((r) => r.agentType === "my-reviewer")?.builtIn).toBe(false);
    });

    it("--json carries no session id, uuid, path or prompt text", async () => {
      seeded();
      await run(["agents", "--period", "all", "--json"]);
      const text = stdoutText();
      expect(text).not.toContain("SENTINEL");
      expect(text).not.toContain("m-sub-");
      expect(text).not.toContain("toolu_");
      expect(text).not.toContain(ACCOUNT);
      // Positive counterpart: the report itself is not empty.
      expect(text).toContain("my-reviewer");
    });

    it("renders text with the coverage line first and no ranking words", async () => {
      seeded();
      await run(["agents", "--period", "all"]);
      const text = stdoutText();
      expect(text.indexOf("Coverage:")).toBeGreaterThan(-1);
      expect(text.indexOf("Coverage:")).toBeLessThan(text.indexOf("By agent type"));
      expect(text).toContain("my-reviewer [user-named]");
      expect(text).toContain("Explore [built-in]");
      expect(text).toContain("(unrecorded)");
      expect(text).not.toMatch(RANKING_WORDS);
    });

    it("--limit folds named rows into one remainder; the unrecorded row stays", async () => {
      seeded();
      await run(["agents", "--period", "all", "--limit", "1", "--json"]);
      const data = JSON.parse(stdoutText()) as AgentCostReport;
      const named = data.byAgentType.filter((r) => r.agentType !== null);
      expect(named).toHaveLength(1);
      expect(data.byAgentType.some((r) => r.agentType === null)).toBe(true);
      expect(data.other.byAgentType?.buckets).toBe(2);
    });

    it.each(["0", "-1", "abc", "1.5"])("rejects --limit %s with exit code 1 and no stdout", async (bad) => {
      seeded();
      await run(["agents", "--period", "all", "--limit", bad]);
      expect(process.exitCode).toBe(1);
      expect(stdoutText()).toBe("");
      expect(String((errSpy.mock.calls as unknown[][])[0]?.[0])).toContain("Invalid --limit");
    });

    it.each(["year", "weekly", "", "Month"])("rejects --period %j with exit code 1 and no stdout", async (bad) => {
      seeded();
      await run(["agents", "--period", bad, "--json"]);
      expect(process.exitCode).toBe(1);
      // Not an all-time report under a wrong label: nothing is printed at all.
      expect(stdoutText()).toBe("");
      const msg = String((errSpy.mock.calls as unknown[][])[0]?.[0]);
      expect(msg).toContain("Invalid date range");
      expect(msg).toContain(`--period "${bad}"`);
    });

    it("--project narrows the window; an unmatched project yields an honest empty report", async () => {
      seeded();
      await run(["agents", "--period", "all", "--project", "/w/does-not-exist", "--json"]);
      const data = JSON.parse(stdoutText()) as AgentCostReport;
      expect(data.coverage.totalCost).toBe(0);
      expect(data.coverage.knownTypeShare).toBe(0);
      expect(data.byAgentType).toEqual([]);
    });

    it("prints an honest empty-window text report on an empty store", async () => {
      new Store(cliDbPath).close();
      await run(["agents", "--period", "all"]);
      const text = stdoutText();
      expect(text).toContain("Total: $0.00 across 0 messages");
      expect(text).not.toMatch(/NaN/);
    });
  });

  describe("export — agent names are opt-in", () => {
    function exportJson(): Array<Record<string, unknown>> {
      return JSON.parse(logText()) as Array<Record<string, unknown>>;
    }

    it("JSON omits agent_type, spawn_depth and spawn_tool_use_id by default", async () => {
      seeded();
      await run(["export", "--format", "json", "--period", "all"]);
      const rows = exportJson();
      expect(rows.length).toBe(5);
      for (const r of rows) {
        for (const f of EXPORT_AGENT_FIELDS) expect(r).not.toHaveProperty(f);
      }
      expect(logText()).not.toContain("my-reviewer");
      expect(logText()).not.toContain("acme-critic");
      expect(logText()).not.toContain("toolu_sentinel01");
      // Positive counterpart: the export still carries the ordinary fields.
      expect(rows.map((r) => r["session_id"])).toContain(SUB_TYPED_ID);
      expect(rows[0]).toHaveProperty("input_tokens");
    });

    it("JSON includes the agent fields with --include-agent-names, and only then", async () => {
      seeded();
      await run(["export", "--format", "json", "--period", "all", "--include-agent-names"]);
      const rows = exportJson();
      const typed = rows.find((r) => r["session_id"] === SUB_TYPED_ID)!;
      expect(typed["agent_type"]).toBe("my-reviewer");
      expect(typed["spawn_depth"]).toBe(1);
      expect(typed["spawn_tool_use_id"]).toBe("toolu_sentinel01");
      const main = rows.find((r) => r["session_id"] === MAIN_ID)!;
      expect(main["agent_type"]).toBeNull();
    });

    it("BEHAVIOUR COMPARISON: every non-new field is identical to a raw SELECT * of the same rows", async () => {
      seeded();
      await run(["export", "--format", "json", "--period", "all"]);
      const exported = logText();

      const store = new Store(cliDbPath);
      const raw = store.getSessions({});
      store.close();
      // What the pre-allowlist export printed, minus the three new columns.
      const expected = JSON.stringify(
        raw.map((row) => {
          const copy = { ...(row as unknown as Record<string, unknown>) };
          for (const f of EXPORT_AGENT_FIELDS) delete copy[f];
          return copy;
        }),
        null,
        2,
      );
      expect(exported).toBe(expected);
    });

    it("CSV has the original 13 columns by default and no agent names", async () => {
      seeded();
      await run(["export", "--format", "csv", "--period", "all"]);
      const lines = logText().split("\n");
      expect(lines[0]).toBe(
        "session_id,project_path,first_timestamp,last_timestamp,claude_version,entrypoint,prompt_count," +
          "input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,account_uuid,subscription_type",
      );
      expect(logText()).not.toContain("my-reviewer");
      for (const line of lines.slice(1)) expect(line.split(",")).toHaveLength(13);
    });

    it("CSV appends the three agent columns with --include-agent-names", async () => {
      seeded();
      await run(["export", "--format", "csv", "--period", "all", "--include-agent-names"]);
      const lines = logText().split("\n");
      expect(lines[0]).toMatch(/,subscription_type,agent_type,spawn_depth,spawn_tool_use_id$/);
      const typed = lines.find((l) => l.startsWith(SUB_TYPED_ID))!;
      expect(typed).toMatch(/,my-reviewer,1,toolu_sentinel01$/);
      const main = lines.find((l) => l.startsWith(MAIN_ID))!;
      expect(main).toMatch(/,max,,,$/);
    });

    it("CSV guard: a name starting with = @ - + gets a leading ' (seeded by raw SQL, past the validator)", async () => {
      seeded();
      const db = new DatabaseSync(cliDbPath);
      db.prepare("UPDATE sessions SET agent_type = ?, spawn_tool_use_id = ? WHERE session_id = ?")
        .run("=cmd", "@evil", SUB_TYPED_ID);
      db.prepare("UPDATE sessions SET agent_type = ? WHERE session_id = ?").run("-1+1", SUB_BUILTIN_ID);
      db.close();

      await run(["export", "--format", "csv", "--period", "all", "--include-agent-names"]);
      const lines = logText().split("\n");
      expect(lines.find((l) => l.startsWith(SUB_TYPED_ID))).toMatch(/,'=cmd,1,'@evil$/);
      expect(lines.find((l) => l.startsWith(SUB_BUILTIN_ID))).toMatch(/,'-1\+1,2,$/);
      // No cell in the agent columns starts with a formula character unprefixed.
      for (const line of lines.slice(1)) {
        const cells = line.split(",");
        for (const cell of [cells[13], cells[15]]) {
          expect(cell ?? "").not.toMatch(/^[@\-+=]/);
        }
      }
    });
  });
});

// ─── Group 3: MCP tool ────────────────────────────────────────────────────────

describe("get_agent_cost (MCP tool)", () => {
  let mcpTmpDir: string;
  let mcpStore: Store;
  let client: Client;

  async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name: "get_agent_cost", arguments: args });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    return JSON.parse(content[0]!.text) as Record<string, unknown>;
  }

  beforeAll(async () => {
    mcpTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-agent-cost-mcp-"));
    mcpStore = new Store(path.join(mcpTmpDir, "test.db"));
    seed(mcpStore);
    seedCritic(mcpStore);

    const server = createMcpServer(mcpStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "agent-cost-test", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    mcpStore.close();
    fs.rmSync(mcpTmpDir, { recursive: true, force: true });
  });

  it("is listed with a description that points at coverage and says it does not judge", async () => {
    const tools = (await client.listTools()).tools;
    const tool = tools.find((x) => x.name === "get_agent_cost");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("coverage");
    expect(tool!.description).toContain("does not judge");
    expect(tool!.description).not.toMatch(RANKING_WORDS);
    expect(tool!.inputSchema.type).toBe("object");
  });

  it("returns a report-shaped payload with a window and costBasis", async () => {
    const payload = await call({ period: "all" });
    expect(payload).toHaveProperty("window");
    expect(payload).toHaveProperty("costBasis");
    for (const k of ["coverage", "byAgentType", "bySkill", "bySpawnDepth", "other"]) {
      expect(payload).toHaveProperty(k);
    }
    const report = payload as unknown as AgentCostReport;
    expect(report.coverage.subagentCost).toBeGreaterThan(0);
    expect(report.byAgentType.map((r) => r.agentType)).toEqual(expect.arrayContaining(["my-reviewer", "acme-critic", "Explore", null]));
    expect(report.bySkill.map((r) => r.skill)).toEqual(["example-skill"]);
  });

  it("matches buildAgentCostReport for the same window (the MCP payload is the report, nothing else)", async () => {
    const payload = await call({ period: "all" });
    const direct = JSON.parse(JSON.stringify(buildAgentCostReport(mcpStore, { limit: 10 }))) as AgentCostReport;
    expect(payload["coverage"]).toEqual(direct.coverage);
    expect(payload["byAgentType"]).toEqual(direct.byAgentType);
    expect(payload["bySkill"]).toEqual(direct.bySkill);
    expect(payload["bySpawnDepth"]).toEqual(direct.bySpawnDepth);
  });

  it("carries no session ids, message uuids, tool-use ids, account uuids or paths", async () => {
    const text = JSON.stringify(await call({ period: "all" }));
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain("m-sub-");
    expect(text).not.toContain("m-main-");
    expect(text).not.toContain("toolu_");
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toContain("/w/");
    expect(text).not.toContain("SENTINEL-PROMPT-TEXT");
    // Positive counterpart: names are present (D4: MCP shows them).
    expect(text).toContain("my-reviewer");
  });

  it("honours limit (folds into other) and rejects a non-positive limit at the schema", async () => {
    const payload = await call({ period: "all", limit: 1 });
    const report = payload as unknown as AgentCostReport;
    expect(report.byAgentType.filter((r) => r.agentType !== null)).toHaveLength(1);
    expect(report.other.byAgentType?.buckets).toBe(2);

    const bad = await client.callTool({ name: "get_agent_cost", arguments: { period: "all", limit: 0 } });
    expect((bad as { isError?: boolean }).isError).toBe(true);
  });

  it("respects the account filter's empty-string rejection, same as every other account-filtered tool", async () => {
    const payload = await call({ period: "all", account: "   " });
    expect(payload["error"]).toBeTruthy();
  });

  it("narrows by project: an unmatched project is an empty report, not an error", async () => {
    const payload = await call({ period: "all", project: "/w/does-not-exist" });
    const report = payload as unknown as AgentCostReport;
    expect(report.coverage.totalCost).toBe(0);
    expect(report.byAgentType).toEqual([]);
  });
});

// ─── Group 5: justification pack exclusion ───────────────────────────────────

describe("justification pack carries no agent type or skill name", () => {
  let tmpDir: string;
  let store: Store;
  const config: Config = { rate: { hourly: 80, currency: "USD" } };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cs-agent-cost-pack-"));
    store = new Store(path.join(tmpDir, "pack.db"));
    seed(store);
    seedCritic(store);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("HTML and all three CSVs contain none of the sentinel names", () => {
    const pack = buildJustificationPack(store, config, {
      period: "2026-01",
      timezone: "UTC",
      sections: ["headline", "tickets", "nonticket", "hygiene", "constraint", "calibration"],
      now: () => T0,
    });
    // The pack really covers this data: its headline has the seeded spend.
    expect(pack.model.headline.totalCost).toBeGreaterThan(0);

    const everything = pack.html + pack.ticketsCsv + pack.nonTicketCsv + pack.summaryCsv;
    for (const name of ["acme-critic", "my-reviewer", "example-skill", "toolu_sentinel01"]) {
      expect(everything).not.toContain(name);
    }
    // Built-in type names are not emitted either (no agent-type column at all).
    expect(everything).not.toMatch(/\bExplore\b/);
  });

  it("POSITIVE: the sentinels ARE in the store and in the agents report, so the absence above is meaningful", () => {
    const rows = store.getSessions({ includeCI: true });
    const types = rows.map((r) => r.agent_type);
    expect(types).toContain("acme-critic");
    expect(types).toContain("my-reviewer");

    const report = buildAgentCostReport(store, {});
    expect(report.byAgentType.map((r) => r.agentType)).toContain("acme-critic");
    expect(report.bySkill.map((r) => r.skill)).toContain("example-skill");
  });
});
