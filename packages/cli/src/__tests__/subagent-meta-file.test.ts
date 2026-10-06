/**
 * The cli-side `.meta.json` reader (aggregator/subagentMetaFile.ts) and its use
 * in `collect()` for the `<project>/<sessionId>/subagents/` layout.
 *
 * Threats covered (plan §8.3, §8.4, §8.9): the meta path is derived only from
 * the scanned transcript path; symlinks, directories and FIFOs are refused;
 * oversized files are refused; a FIFO never blocks the (synchronous) caller —
 * checked in a child process with a hard kill timeout because a blocked
 * `openSync` cannot be interrupted by vitest's own timeout.
 *
 * Fixture names are synthetic. Every path is under os.tmpdir().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import {
  MAX_SUBAGENT_META_BYTES,
  readBoundedRegularFile,
  readSubagentMeta,
  subagentMetaPath,
} from "../aggregator/subagentMetaFile.js";
import { collect } from "../aggregator/index.js";
import { Store } from "../store/index.js";
import * as pathsMod from "@claude-stats/core/paths";
import { EMPTY_SUBAGENT_META } from "@claude-stats/core/subagentMeta";
import type { SessionRecord } from "@claude-stats/core/types";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const READER_SRC = path.join(REPO_ROOT, "packages/cli/src/aggregator/subagentMetaFile.ts");
const TSX_LOADER = path.join(REPO_ROOT, "node_modules/tsx/dist/esm/index.mjs");

const GOOD_META = { agentType: "my-reviewer", spawnDepth: 2, toolUseId: "toolu_01Meta_abc" };
const WINDOWS_CONSTANTS = { O_RDONLY: fs.constants.O_RDONLY } as const;

let tmp: string;

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Whether symlink cases can run. Only Windows (no symlink privilege) may skip;
 * anywhere else a failure to create one fails the test instead of passing it
 * vacuously.
 */
function canSymlink(): boolean {
  const probe = path.join(tmp, "symlink-probe");
  try {
    fs.symlinkSync(path.join(tmp, "nowhere"), probe);
    fs.unlinkSync(probe);
    return true;
  } catch (err) {
    if (process.platform === "win32") return false;
    throw err;
  }
}

/** Create a FIFO at `p`; the FIFO tests are skipped on Windows only. */
function mkfifo(p: string): void {
  const r = spawnSync("mkfifo", [p], { timeout: 5_000 });
  expect(r.status).toBe(0);
  expect(fs.lstatSync(p).isFIFO()).toBe(true);
}

// ── path derivation ─────────────────────────────────────────────────────────

describe("subagentMetaPath", () => {
  it("derives same dir + same stem + .meta.json", () => {
    const dir = path.join(os.tmpdir(), "proj", "sess", "subagents");
    expect(subagentMetaPath(path.join(dir, "agent-a1b2_C-3.jsonl"))).toBe(path.join(dir, "agent-a1b2_C-3.meta.json"));
  });

  it.each([
    "child-sess.jsonl",
    "agent-.jsonl",
    "agent-a1.json",
    "agent-a1.jsonl.bak",
    "agent-../x.jsonl",
    "agent-a.b.jsonl",
    "agent-a b.jsonl",
    `agent-${"x".repeat(65)}.jsonl`,
    "AGENT-a1.jsonl",
  ])("rejects a transcript basename that is not agent-<id>.jsonl: %s", (name) => {
    expect(subagentMetaPath(path.join(os.tmpdir(), name))).toBeNull();
  });

  it("accepts the 64-character id bound", () => {
    expect(subagentMetaPath(path.join(os.tmpdir(), `agent-${"x".repeat(64)}.jsonl`))).not.toBeNull();
  });
});

// ── the reader ──────────────────────────────────────────────────────────────

describe("readSubagentMeta / readBoundedRegularFile", () => {
  beforeEach(() => {
    tmp = mkTmp("cs-meta-");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const transcript = (): string => path.join(tmp, "agent-a1.jsonl");
  const metaFile = (): string => path.join(tmp, "agent-a1.meta.json");

  it("reads a present meta file", () => {
    fs.writeFileSync(metaFile(), JSON.stringify({ ...GOOD_META, description: "d", prompt: "p" }));
    const r = readSubagentMeta(transcript());
    expect(r).toEqual({ agentType: "my-reviewer", spawnDepth: 2, spawnToolUseId: "toolu_01Meta_abc" });
    expect(Object.keys(r).sort()).toEqual(["agentType", "spawnDepth", "spawnToolUseId"]);
  });

  it("missing meta file → all-null", () => {
    expect(readSubagentMeta(transcript())).toEqual(EMPTY_SUBAGENT_META);
  });

  it("transcript basename not agent-<id>.jsonl → never opens anything", () => {
    fs.writeFileSync(path.join(tmp, "child.meta.json"), JSON.stringify(GOOD_META));
    const open = vi.spyOn(fs, "openSync");
    expect(readSubagentMeta(path.join(tmp, "child.jsonl"))).toEqual(EMPTY_SUBAGENT_META);
    expect(open).not.toHaveBeenCalled();
  });

  it("malformed JSON → all-null", () => {
    fs.writeFileSync(metaFile(), '{"agentType": "my-reviewer",');
    expect(readSubagentMeta(transcript())).toEqual(EMPTY_SUBAGENT_META);
  });

  it.each([["array", "[1,2]"], ["string", '"my-reviewer"'], ["number", "3"], ["null", "null"]])(
    "%s root → all-null",
    (_l, body) => {
      fs.writeFileSync(metaFile(), body);
      expect(readSubagentMeta(transcript())).toEqual(EMPTY_SUBAGENT_META);
    }
  );

  it("exactly 64 KiB is read; one byte more is refused", () => {
    const base = JSON.stringify(GOOD_META);
    const atCap = base.slice(0, -1) + "," + JSON.stringify("pad") + ":" + JSON.stringify("") + "}";
    const pad = MAX_SUBAGENT_META_BYTES - Buffer.byteLength(atCap);
    const exact = base.slice(0, -1) + ',"pad":"' + "x".repeat(pad) + '"}';
    expect(Buffer.byteLength(exact)).toBe(MAX_SUBAGENT_META_BYTES);

    fs.writeFileSync(metaFile(), exact);
    expect(readSubagentMeta(transcript()).agentType).toBe("my-reviewer");

    fs.writeFileSync(metaFile(), exact + " ");
    expect(readSubagentMeta(transcript())).toEqual(EMPTY_SUBAGENT_META);
  });

  it("> 64 KiB → all-null even when the prefix is valid JSON for the fields", () => {
    fs.writeFileSync(metaFile(), JSON.stringify({ ...GOOD_META, blob: "x".repeat(70_000) }));
    expect(readSubagentMeta(transcript())).toEqual(EMPTY_SUBAGENT_META);
  });

  it("directory at the meta path → all-null", () => {
    fs.mkdirSync(metaFile());
    expect(readSubagentMeta(transcript())).toEqual(EMPTY_SUBAGENT_META);
    expect(readBoundedRegularFile(metaFile(), WINDOWS_CONSTANTS)).toBeNull();
  });

  it("symlink at the meta path → all-null, while the target itself reads fine", () => {
    if (!canSymlink()) return; // platform cannot create one (Windows without privilege)
    const target = path.join(tmp, "real.meta.json");
    fs.writeFileSync(target, JSON.stringify(GOOD_META));
    fs.symlinkSync(target, metaFile());

    expect(readSubagentMeta(transcript())).toEqual(EMPTY_SUBAGENT_META);
    expect(readBoundedRegularFile(metaFile(), WINDOWS_CONSTANTS)).toBeNull();
    // Positive control on the same content: the real file is readable.
    expect(readBoundedRegularFile(target)).not.toBeNull();
    expect(readBoundedRegularFile(target, WINDOWS_CONSTANTS)).not.toBeNull();
  });

  it("no-O_NOFOLLOW fallback (Windows path) reads a regular file", () => {
    fs.writeFileSync(metaFile(), JSON.stringify(GOOD_META));
    expect(readSubagentMeta(transcript(), WINDOWS_CONSTANTS)).toEqual({
      agentType: "my-reviewer",
      spawnDepth: 2,
      spawnToolUseId: "toolu_01Meta_abc",
    });
  });

  it("no-O_NOFOLLOW fallback refuses an fd whose dev/ino differ from the lstat (swap between lstat and open)", () => {
    fs.writeFileSync(metaFile(), JSON.stringify(GOOD_META));
    const realFstat = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const st = realFstat(fd);
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: st.ino + 1 });
    }) as typeof fs.fstatSync);
    const close = vi.spyOn(fs, "closeSync");
    expect(readSubagentMeta(transcript(), WINDOWS_CONSTANTS)).toEqual(EMPTY_SUBAGENT_META);
    expect(close).toHaveBeenCalled();
  });

  it("reads in a loop when readSync returns short counts", () => {
    fs.writeFileSync(metaFile(), JSON.stringify(GOOD_META));
    const realRead = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buf: Buffer, off: number, _len: number, pos: null) =>
      realRead(fd, buf, off, 3, pos)) as unknown as typeof fs.readSync);
    expect(readSubagentMeta(transcript()).agentType).toBe("my-reviewer");
  });

  it("an I/O error mid-read → all-null and the fd is still closed", () => {
    fs.writeFileSync(metaFile(), JSON.stringify(GOOD_META));
    vi.spyOn(fs, "readSync").mockImplementation(() => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    const close = vi.spyOn(fs, "closeSync");
    expect(readSubagentMeta(transcript())).toEqual(EMPTY_SUBAGENT_META);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("never logs the path or the contents", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {})
    );
    fs.writeFileSync(metaFile(), "{not json");
    readSubagentMeta(transcript());
    fs.rmSync(metaFile());
    fs.mkdirSync(metaFile());
    readSubagentMeta(transcript());
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  // FIFO: the synchronous open must not wait for a writer. Run in a child
  // process with a hard SIGKILL timeout so a regression fails instead of
  // hanging the suite.
  describe("FIFO at the meta path (child process, hard timeout)", () => {
    const CHILD_TIMEOUT_MS = 15_000;

    function runChild(script: string, args: string[], timeout: number, useTsx: boolean) {
      const nodeArgs = useTsx ? ["--import", TSX_LOADER] : [];
      return spawnSync(process.execPath, [...nodeArgs, "--input-type=module", "-e", script, ...args], {
        timeout,
        killSignal: "SIGKILL",
        encoding: "utf8",
        cwd: tmp,
        env: { PATH: process.env.PATH ?? "", HOME: tmp },
      });
    }

    it.skipIf(process.platform === "win32")("returns all-null immediately instead of blocking", () => {
      mkfifo(metaFile());

      const useTsx = fs.existsSync(TSX_LOADER);
      const script = useTsx
        ? `
          const m = await import(${JSON.stringify(READER_SRC)});
          const [transcript, meta] = process.argv.slice(1);
          const out = {
            meta: m.readSubagentMeta(transcript),
            bytes: m.readBoundedRegularFile(meta),
            fallbackBytes: m.readBoundedRegularFile(meta, { O_RDONLY: 0 }),
          };
          process.stdout.write(JSON.stringify(out));
        `
        : // No tsx: exercise the same open flags and fstat check the reader uses.
          `
          import fs from "fs";
          const [, meta] = process.argv.slice(1);
          const c = fs.constants;
          const fd = fs.openSync(meta, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
          const regular = fs.fstatSync(fd).isFile();
          fs.closeSync(fd);
          process.stdout.write(JSON.stringify({ meta: ${JSON.stringify(EMPTY_SUBAGENT_META)}, bytes: regular ? "regular" : null, fallbackBytes: null }));
        `;

      const r = runChild(script, [transcript(), metaFile()], CHILD_TIMEOUT_MS, useTsx);
      expect(r.error).toBeUndefined();
      expect(r.signal).toBeNull();
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ meta: EMPTY_SUBAGENT_META, bytes: null, fallbackBytes: null });
    });

    it.skipIf(process.platform === "win32")(
      "positive control: an open WITHOUT O_NONBLOCK does block, and the harness kills it",
      () => {
        mkfifo(metaFile());
        const script = `
          import fs from "fs";
          const c = fs.constants;
          fs.openSync(process.argv[1], c.O_RDONLY | c.O_NOFOLLOW);
          process.stdout.write("opened");
        `;
        const r = runChild(script, [metaFile()], 2_000, false);
        expect(r.signal).toBe("SIGKILL");
        expect(r.stdout).not.toContain("opened");
      }
    );
  });
});

// ── collect() integration ───────────────────────────────────────────────────

describe("collect — subagent agent attribution", () => {
  const parentId = "0f0e0d0c-0000-4000-8000-0000000000b2";
  let root: string;
  let projectsDir: string;
  let dbPath: string;
  let store: Store;
  let upserts: SessionRecord[];

  function line(overrides: Record<string, unknown>): string {
    return JSON.stringify({
      type: "assistant",
      sessionId: parentId,
      version: "2.1.70",
      timestamp: 1_700_000_000_000,
      uuid: `msg-${Math.random()}`,
      entrypoint: "claude",
      message: {
        model: "claude-opus-4-6",
        stop_reason: "end_turn",
        content: [],
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      ...overrides,
    });
  }

  function subLine(uuid: string, extra: Record<string, unknown> = {}): string {
    return line({ uuid, isSidechain: true, agentId: "a1", parentUuid: null, ...extra });
  }

  function nestedDir(): string {
    const d = path.join(projectsDir, "-proj-attr", parentId, "subagents");
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  function upsertFor(id: string): SessionRecord {
    const hits = upserts.filter((s) => s.sessionId === id);
    expect(hits.length).toBeGreaterThan(0);
    return hits[hits.length - 1]!;
  }

  beforeEach(() => {
    root = mkTmp("cs-meta-agg-");
    tmp = root;
    projectsDir = path.join(root, "projects");
    fs.mkdirSync(projectsDir);
    dbPath = path.join(root, "stats.db");
    store = new Store(dbPath);
    upserts = [];

    const original = pathsMod.paths;
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({
      ...original,
      claudeDir: path.join(root, "claude"),
      projectsDir,
      historyFile: path.join(root, "claude", "history.jsonl"),
      changelogFile: path.join(root, "claude", "changelog.md"),
      sessionsDir: path.join(root, "claude", "sessions"),
      statsDir: path.join(root, "stats"),
      statsDb: dbPath,
      quarantineDir: path.join(root, "stats", "quarantine"),
      archiveDir: path.join(root, "stats", "archive"),
      bundleDir: path.join(root, "stats", "bundle"),
      configFile: path.join(root, "stats", "config.json"),
      claudeConfigFile: path.join(root, "claude.json"),
    });

    const capture = (s: SessionRecord) => {
      upserts.push({ ...s });
    };
    const full = store.upsertSession.bind(store);
    const incr = store.upsertSessionIncremental.bind(store);
    vi.spyOn(store, "upsertSession").mockImplementation((s) => {
      capture(s);
      return full(s);
    });
    vi.spyOn(store, "upsertSessionIncremental").mockImplementation((s) => {
      capture(s);
      return incr(s);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("meta present → its agentType, spawnDepth and toolUseId reach the store, beating the parser fallback", async () => {
    const d = nestedDir();
    fs.writeFileSync(path.join(d, "agent-a1.jsonl"), subLine("s1", { attributionAgent: "acme-critic" }) + "\n");
    fs.writeFileSync(path.join(d, "agent-a1.meta.json"), JSON.stringify({ ...GOOD_META, description: "d", prompt: "p" }));
    await collect(store);

    const s = upsertFor("agent-a1");
    expect(s.isSubagent).toBe(true);
    expect(s.agentType).toBe("my-reviewer");
    expect(s.spawnDepth).toBe(2);
    expect(s.spawnToolUseId).toBe("toolu_01Meta_abc");
    expect(JSON.stringify(s)).not.toContain('"description"');
    expect(JSON.stringify(s)).not.toContain('"prompt"');
  });

  it("meta missing → parser's attributionAgent fallback; spawn fields null", async () => {
    const d = nestedDir();
    fs.writeFileSync(path.join(d, "agent-a1.jsonl"), subLine("s1", { attributionAgent: "acme-critic" }) + "\n");
    await collect(store);

    const s = upsertFor("agent-a1");
    expect(s.agentType).toBe("acme-critic");
    expect(s.spawnDepth).toBeNull();
    expect(s.spawnToolUseId).toBeNull();
  });

  it("meta missing and no fallback → all null (never undefined)", async () => {
    const d = nestedDir();
    fs.writeFileSync(path.join(d, "agent-a1.jsonl"), subLine("s1") + "\n");
    await collect(store);

    const s = upsertFor("agent-a1");
    expect(s.agentType).toBeNull();
    expect(s.spawnDepth).toBeNull();
    expect(s.spawnToolUseId).toBeNull();
  });

  it("meta agentType failing validation does not erase a valid fallback; valid sibling fields still apply", async () => {
    const d = nestedDir();
    fs.writeFileSync(path.join(d, "agent-a1.jsonl"), subLine("s1", { attributionAgent: "acme-critic" }) + "\n");
    fs.writeFileSync(
      path.join(d, "agent-a1.meta.json"),
      JSON.stringify({ agentType: "=HYPERLINK(1)", spawnDepth: 1, toolUseId: "toolu_ok" })
    );
    await collect(store);

    const s = upsertFor("agent-a1");
    expect(s.agentType).toBe("acme-critic");
    expect(s.spawnDepth).toBe(1);
    expect(s.spawnToolUseId).toBe("toolu_ok");
  });

  it("malformed meta → fallback kept, spawn fields null", async () => {
    const d = nestedDir();
    fs.writeFileSync(path.join(d, "agent-a1.jsonl"), subLine("s1", { attributionAgent: "acme-critic" }) + "\n");
    fs.writeFileSync(path.join(d, "agent-a1.meta.json"), "{nope");
    await collect(store);

    const s = upsertFor("agent-a1");
    expect(s.agentType).toBe("acme-critic");
    expect(s.spawnDepth).toBeNull();
  });

  it("symlinked meta is not followed", async () => {
    if (!canSymlink()) return;
    const d = nestedDir();
    const elsewhere = path.join(root, "elsewhere.meta.json");
    fs.writeFileSync(elsewhere, JSON.stringify({ agentType: "example-skill", spawnDepth: 3, toolUseId: "toolu_link" }));
    fs.writeFileSync(path.join(d, "agent-a1.jsonl"), subLine("s1", { attributionAgent: "acme-critic" }) + "\n");
    fs.symlinkSync(elsewhere, path.join(d, "agent-a1.meta.json"));
    await collect(store);

    const s = upsertFor("agent-a1");
    expect(s.agentType).toBe("acme-critic");
    expect(s.spawnDepth).toBeNull();
    expect(s.spawnToolUseId).toBeNull();
  });

  it("main sessions never carry agent attribution, even if the transcript claims one", async () => {
    const projDir = path.join(projectsDir, "-proj-attr");
    fs.mkdirSync(projDir, { recursive: true });
    const queue = JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: parentId, timestamp: 1_699_998_000_000 });
    fs.writeFileSync(
      path.join(projDir, `${parentId}.jsonl`),
      [queue, line({ uuid: "p1", attributionAgent: "acme-critic" })].join("\n") + "\n"
    );
    // A meta file beside a MAIN transcript is never consulted either.
    fs.writeFileSync(path.join(projDir, `${parentId}.meta.json`), JSON.stringify(GOOD_META));
    await collect(store);

    const s = upsertFor(parentId);
    expect(s.isSubagent).toBe(false);
    expect(s.agentType).toBeNull();
    expect(s.spawnDepth).toBeNull();
    expect(s.spawnToolUseId).toBeNull();
  });

  it("older <project>/subagents/ layout keeps only the parser fallback (meta not consulted)", async () => {
    const d = path.join(projectsDir, "-proj-attr", "subagents");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, "agent-a2.jsonl"),
      line({ sessionId: "old-child", uuid: "o1", attributionAgent: "acme-critic" }) + "\n"
    );
    fs.writeFileSync(path.join(d, "agent-a2.meta.json"), JSON.stringify(GOOD_META));
    await collect(store);

    const s = upsertFor("old-child");
    expect(s.isSubagent).toBe(true);
    expect(s.agentType).toBe("acme-critic");
    expect(s.spawnDepth).toBeNull();
  });

  it("a hostile stored source_file is never used to build the meta path", async () => {
    const d = nestedDir();
    const transcript = path.join(d, "agent-a1.jsonl");
    fs.writeFileSync(transcript, subLine("s1") + "\n");
    fs.writeFileSync(path.join(d, "agent-a1.meta.json"), JSON.stringify(GOOD_META));
    await collect(store);

    // A sync peer rewrites source_file to point at a decoy with its own meta.
    const decoyDir = path.join(root, "decoy");
    fs.mkdirSync(decoyDir);
    fs.writeFileSync(path.join(decoyDir, "agent-a1.jsonl"), "");
    fs.writeFileSync(
      path.join(decoyDir, "agent-a1.meta.json"),
      JSON.stringify({ agentType: "example-skill", spawnDepth: 9, toolUseId: "toolu_decoy" })
    );
    const first = upsertFor("agent-a1");
    store.upsertSession({ ...first, sourceFile: path.join(decoyDir, "agent-a1.jsonl") });
    upserts = [];

    const opened: string[] = [];
    const realOpen = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(p));
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);

    fs.appendFileSync(transcript, subLine("s2") + "\n");
    await collect(store);

    const s = upsertFor("agent-a1");
    expect(s.agentType).toBe("my-reviewer");
    expect(s.spawnDepth).toBe(2);
    expect(s.spawnToolUseId).toBe("toolu_01Meta_abc");
    expect(opened).toContain(path.join(d, "agent-a1.meta.json"));
    expect(opened.some((p) => p.startsWith(decoyDir))).toBe(false);
  });
});
