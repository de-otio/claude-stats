/**
 * `repair dedupe` — the in-place re-parse that turns pre-V23 rows (one API
 * response counted once per content block) into carrier-model rows.
 *
 * The seed is the OLD parser's output reconstructed faithfully: every entry
 * of a response carries the full usage, `message_id` is NULL, `usage_counted`
 * is 1 and `cost_basis` is `'pre-dedupe'` — exactly what V23's migration
 * stamps on a database that predates it. The repair then has to reach the
 * corrected state through the collector, without deleting a row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { parseSessionFile } from "@claude-stats/core/parser/session";
import type { MessageRecord } from "@claude-stats/core/types";
import * as pathsMod from "@claude-stats/core/paths";
import { Store } from "../store/index.js";
import { collect, USAGE_WINDOW_BASIS, USAGE_WINDOW_BASIS_KEY } from "../aggregator/index.js";
import { getFileStats } from "../scanner/index.js";
import { hashFirstKb } from "@claude-stats/core/parser/session";
import { repairDedupe, RepairLockHeldError, REPAIR_DEDUPE_LOCK_KEY } from "../repair/dedupe.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const PROJECT = "/home/example/dedupe-proj";
const USAGE = {
  input_tokens: 10,
  output_tokens: 300,
  cache_creation_input_tokens: 1_000,
  cache_read_input_tokens: 40_000,
};

function tmpDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** One response as two entries (thinking + tool_use), Claude Code's real shape. */
function response(sessionId: string, messageId: string, i: number): object[] {
  const base = {
    type: "assistant",
    sessionId,
    version: "2.1.72",
    cwd: PROJECT,
    uuid: "",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      id: messageId,
      stop_reason: "end_turn",
      content: [] as unknown[],
      usage: USAGE,
    },
  };
  const ts = 1_700_000_000_000 + i * 60_000;
  return [
    {
      ...base,
      uuid: `${messageId}-thinking`,
      timestamp: new Date(ts).toISOString(),
      message: { ...base.message, content: [{ type: "thinking", thinking: "…" }] },
    },
    {
      ...base,
      uuid: `${messageId}-tool`,
      timestamp: new Date(ts + 1_000).toISOString(),
      message: {
        ...base.message,
        content: [{ type: "tool_use", id: `tu-${i}`, name: "Read", input: { file_path: `${PROJECT}/f${i}.ts` } }],
      },
    },
  ];
}

function userLine(sessionId: string): object {
  return {
    type: "user",
    sessionId,
    version: "2.1.72",
    cwd: PROJECT,
    timestamp: new Date(1_699_999_000_000).toISOString(),
    uuid: `usr-${sessionId}`,
    message: { role: "user", content: [{ type: "text", text: "hi" }] },
  };
}

function writeTranscript(file: string, sessionId: string, responses: number): void {
  const entries = [userLine(sessionId)];
  for (let i = 0; i < responses; i++) entries.push(...response(sessionId, `msg_${sessionId}_${i}`, i));
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/**
 * Seed the store the way the OLD parser would have written this transcript:
 * every entry a carrier with the full usage, no message id, basis pre-dedupe.
 * Returns the number of rows written.
 */
async function seedPreDedupe(store: Store, file: string, checkpoint: boolean): Promise<number> {
  const parsed = await parseSessionFile(file, PROJECT);
  const old: MessageRecord[] = parsed.messages.map((m) => ({
    ...m,
    inputTokens: USAGE.input_tokens,
    outputTokens: USAGE.output_tokens,
    cacheCreationTokens: USAGE.cache_creation_input_tokens,
    cacheReadTokens: USAGE.cache_read_input_tokens,
    messageId: null,
    usageCounted: true,
    costBasis: "pre-dedupe",
    thinkingTokens: null,
  }));
  store.transaction(() => {
    store.upsertSession({ ...parsed.session!, sourceFile: file });
    store.upsertMessages(old);
    store.recomputeSessionAggregates([parsed.session!.sessionId]);
    if (checkpoint) {
      const st = getFileStats(file)!;
      store.upsertCheckpoint({
        filePath: file,
        fileSize: st.size,
        lastByteOffset: st.size,
        lastMtime: st.mtime,
        firstKbHash: hashFirstKb(file, Math.min(st.size, 1024)),
        sourceDeleted: false,
      });
    }
  });
  return old.length;
}

function rowsOf(store: Store, sessionId: string) {
  return store.getSessionMessages(sessionId);
}

function tokenSum(rows: ReturnType<Store["getSessionMessages"]>) {
  return rows.reduce(
    (a, m) => ({
      input: a.input + m.input_tokens,
      output: a.output + m.output_tokens,
      cacheRead: a.cacheRead + m.cache_read_tokens,
      cacheCreation: a.cacheCreation + m.cache_creation_tokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  );
}

// ── the suite ────────────────────────────────────────────────────────────────

describe("repairDedupe", () => {
  let projectsDir: string;
  let elsewhere: string;
  let dbPath: string;
  let store: Store;
  let transcript: string;
  let orphanTranscript: string;
  const RESPONSES = 5;
  const SESS = "sess-dedupe-1";
  const ORPHAN = "sess-dedupe-orphan";
  const now = () => 1_700_100_000_000;

  beforeEach(async () => {
    projectsDir = tmpDir("cs-dedupe-projects");
    elsewhere = tmpDir("cs-dedupe-elsewhere");
    dbPath = path.join(tmpDir("cs-dedupe-db"), "stats.db");
    store = new Store(dbPath);

    const original = pathsMod.paths;
    vi.spyOn(pathsMod, "paths", "get").mockReturnValue({ ...original, projectsDir });

    const projDir = path.join(projectsDir, "-home-example-dedupe-proj");
    fs.mkdirSync(projDir);
    transcript = path.join(projDir, `${SESS}.jsonl`);
    writeTranscript(transcript, SESS, RESPONSES);
    await seedPreDedupe(store, transcript, true);

    // A session whose transcript is NOT under the projects directory — the
    // 90% case on a real machine. Its source_file points at a path the
    // scanner will never produce, so the repair must leave it alone.
    orphanTranscript = path.join(elsewhere, `${ORPHAN}.jsonl`);
    writeTranscript(orphanTranscript, ORPHAN, 2);
    await seedPreDedupe(store, orphanTranscript, true);
    fs.rmSync(orphanTranscript);
    // …and, as the collector would have done on noticing the deletion, the
    // session is flagged source_deleted. Most unrepairable history is.
    store.markSourceDeleted(orphanTranscript);

    store.recomputeMessageHourly();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it("the seed is the pre-fix state: every entry counted, totals 2x, no message ids", () => {
    const rows = rowsOf(store, SESS);
    expect(rows).toHaveLength(RESPONSES * 2);
    expect(rows.every((r) => r.cost_basis === "pre-dedupe" && r.usage_counted === 1 && r.message_id == null)).toBe(true);
    expect(tokenSum(rows).output).toBe(USAGE.output_tokens * RESPONSES * 2);
    // And a plain collect does NOT touch it — the checkpoint says "unchanged".
    // That is what makes the repair's checkpoint reset load-bearing.
  });

  it("a plain collect skips the seeded file (so the repair, not collect, is what re-parses)", async () => {
    const result = await collect(store, {}, now);
    expect(result.filesSkipped).toBe(1);
    expect(result.filesProcessed).toBe(0);
    expect(rowsOf(store, SESS).every((r) => r.cost_basis === "pre-dedupe")).toBe(true);
  });

  it("dry run reports the plan and writes nothing", async () => {
    const summary = await repairDedupe(store, { dryRun: true }, now);
    expect(summary.dryRun).toBe(true);
    expect(summary.sessionsRepaired).toBe(1);
    expect(summary.sessionsSkippedNoTranscript).toBe(1);
    expect(summary.preDedupeRowsInScope).toBe(RESPONSES * 2);
    expect(summary.rowsRelabelled).toBe(0);
    expect(summary.preDedupeRowsRemaining).toBe(RESPONSES * 2 + 4);
    expect(summary.backupPath).toBeNull();
    expect(summary.after).toEqual(summary.before);
    expect(rowsOf(store, SESS).every((r) => r.cost_basis === "pre-dedupe")).toBe(true);
    expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes("pre-repair"))).toHaveLength(0);
    expect(store.getMeta(REPAIR_DEDUPE_LOCK_KEY)).toBeNull();
  });

  it("repairs in place: same rows, same tool data, half the tokens, relabelled per-response", async () => {
    const before = rowsOf(store, SESS);
    const toolsBefore = new Map(before.map((r) => [r.uuid, r.tools]));
    const beforeSums = tokenSum(before);

    const summary = await repairDedupe(store, {}, now);

    expect(summary.dryRun).toBe(false);
    expect(summary.sessionsRepaired).toBe(1);
    expect(summary.sessionsSkippedNoTranscript).toBe(1);
    expect(summary.rowsRelabelled).toBe(RESPONSES * 2);
    expect(summary.parseErrors).toBe(0);
    expect(summary.backupPath).not.toBeNull();
    expect(fs.existsSync(summary.backupPath!)).toBe(true);

    const after = rowsOf(store, SESS);
    // Nothing deleted, nothing added: uuids are per entry and stable.
    expect(after.map((r) => r.uuid).sort()).toEqual(before.map((r) => r.uuid).sort());
    // Tool data lives on the non-carrier entries and must survive untouched.
    for (const r of after) expect(r.tools).toBe(toolsBefore.get(r.uuid));
    expect(after.filter((r) => JSON.parse(r.tools).includes("Read"))).toHaveLength(RESPONSES);
    // Exactly one carrier per response; the rest zeroed.
    expect(after.filter((r) => r.usage_counted === 1)).toHaveLength(RESPONSES);
    expect(after.every((r) => r.cost_basis === "per-response" && r.message_id != null)).toBe(true);
    const afterSums = tokenSum(after);
    expect(afterSums.output).toBe(beforeSums.output / 2);
    expect(afterSums.cacheRead).toBe(beforeSums.cacheRead / 2);
    expect(afterSums.input).toBe(beforeSums.input / 2);
    expect(afterSums.cacheCreation).toBe(beforeSums.cacheCreation / 2);
    // The summary's before/after are the session counters, which must agree
    // with the rows they summarise.
    expect(summary.before.outputTokens).toBe(beforeSums.output);
    expect(summary.after.outputTokens).toBe(afterSums.output);

    // The session with no transcript is untouched and still disclosed.
    const orphan = rowsOf(store, ORPHAN);
    expect(orphan).toHaveLength(4);
    expect(orphan.every((r) => r.cost_basis === "pre-dedupe" && r.usage_counted === 1)).toBe(true);
    expect(summary.preDedupeRowsRemaining).toBe(4);

    // The backup is the PRE-repair database.
    const backup = new DatabaseSync(summary.backupPath!, { readOnly: true });
    const n = backup.prepare("SELECT COUNT(*) AS n FROM messages WHERE cost_basis = 'pre-dedupe'").get() as { n: number };
    backup.close();
    expect(n.n).toBe(RESPONSES * 2 + 4);
  });

  it("the hourly rollup and the usage windows are rebuilt against the repaired rows", async () => {
    // Rollup was built over the inflated seed in beforeEach.
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const rolledBefore = raw.prepare("SELECT SUM(output_tokens) AS o FROM message_hourly").get() as { o: number };
    expect(rolledBefore.o).toBe(USAGE.output_tokens * (RESPONSES * 2 + 4));
    raw.close();

    // A routine collect first: it prices every usage window off the inflated
    // rows and stamps the basis marker, so the repair has to force a reprice
    // rather than trust the marker.
    await collect(store, {}, now);
    expect(store.getMeta(USAGE_WINDOW_BASIS_KEY)).toBe(USAGE_WINDOW_BASIS);
    const windowTokens = () =>
      store.getUsageWindows().reduce((n, w) => n + (w.tokensByModel["claude-opus-5"] ?? 0), 0);
    const perResponse = USAGE.input_tokens + USAGE.output_tokens;
    expect(windowTokens()).toBe(perResponse * (RESPONSES * 2 + 4));

    await repairDedupe(store, {}, now);

    const rawAfter = new DatabaseSync(dbPath, { readOnly: true });
    const rolled = rawAfter.prepare("SELECT SUM(output_tokens) AS o FROM message_hourly").get() as { o: number };
    rawAfter.close();
    expect(rolled.o).toBe(USAGE.output_tokens * (RESPONSES + 4));

    // The rollup fast path (unbounded) and the raw seek (any bound) agree.
    const viaRollup = store.getMessageTotals({});
    const viaRaw = store.getMessageTotals({ since: 0 });
    expect(viaRollup.map((r) => [r.model, r.output_tokens])).toEqual(viaRaw.map((r) => [r.model, r.output_tokens]));

    // usage_windows was repriced against the repaired rows: the repaired
    // session counts once per response, the orphan still counts every entry.
    expect(store.getMeta(USAGE_WINDOW_BASIS_KEY)).toBe(USAGE_WINDOW_BASIS);
    expect(windowTokens()).toBe(perResponse * (RESPONSES + 4));
  });

  it("a second run is a no-op", async () => {
    await repairDedupe(store, {}, now);
    const snapshot = rowsOf(store, SESS);
    const second = await repairDedupe(store, {}, () => now() + 1);
    expect(second.sessionsRepaired).toBe(0);
    expect(second.sessionsAlreadyClean).toBe(1);
    expect(second.sessionsSkippedNoTranscript).toBe(1);
    expect(second.rowsRelabelled).toBe(0);
    expect(second.backupPath).toBeNull();
    expect(rowsOf(store, SESS)).toEqual(snapshot);
  });

  it("refuses to start while another live process holds a fresh lock", async () => {
    // The parent process is alive and is not us.
    store.setMeta(REPAIR_DEDUPE_LOCK_KEY, JSON.stringify({ pid: process.ppid, startedAt: now() - 1_000 }));
    await expect(repairDedupe(store, {}, now)).rejects.toBeInstanceOf(RepairLockHeldError);
    // Nothing happened, and the other holder's lock is intact.
    expect(rowsOf(store, SESS).every((r) => r.cost_basis === "pre-dedupe")).toBe(true);
    expect(JSON.parse(store.getMeta(REPAIR_DEDUPE_LOCK_KEY)!).pid).toBe(process.ppid);
  });

  it("reclaims a lock whose process is gone, and one older than the TTL", async () => {
    store.setMeta(REPAIR_DEDUPE_LOCK_KEY, JSON.stringify({ pid: 2_147_483_000, startedAt: now() - 1_000 }));
    const summary = await repairDedupe(store, {}, now);
    expect(summary.sessionsRepaired).toBe(1);
    expect(store.getMeta(REPAIR_DEDUPE_LOCK_KEY)).toBe("");
  });

  it("releases the lock on error", async () => {
    // Make the backup fail: the DB path's directory becomes read-only for
    // the copy by pointing dbPath at a directory, which copyFileSync rejects.
    await expect(repairDedupe(store, { dbPath: path.dirname(dbPath) }, now)).rejects.toThrow();
    expect(store.getMeta(REPAIR_DEDUPE_LOCK_KEY)).toBe("");
  });
});
