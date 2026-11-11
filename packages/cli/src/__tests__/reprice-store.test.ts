/**
 * `reprice_period` and `claude-stats reprice` end to end: real parser, real
 * store, the MCP tool over an in-memory transport, and the CLI renderer.
 *
 * Hand-computed from the shipped rates (per MTok), same table as
 * reprice-core.test.ts:
 *   Opus 5.5    4 / 20, read 0.20, write5m 5,     fast x2, us x1.1
 *   Sonnet 5.5  2 / 10, read 0.10, write5m 2.5,   no fast, us x1.1
 *   Haiku 5.5   0.10 / 0.50, read 0.01, write5m 0.125, no fast, us x1.1,
 *               tier (prompt > 100K) 0.50 / 2.50 / 0.05
 *
 * Fixture rows (Opus 5.5 unless noted):
 *   r1  standard, global   1M in, 1M out, 2M read, 1M cache write (5m)
 *   r2  fast, global       1M in, 1M out
 *   r3  standard, US       1M in, 1M out
 *   r4  standard, global   1K in, 1M out, 119K read      (a 120K prompt)
 *   r5  Fable 5.2          1M in, 1M out                  (another model: ignored)
 * r1 and r2 are in project A, r3-r5 in project B.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { parseSessionFile } from "@claude-stats/core/parser/session";
import { applyPricingCache, PRICING_VERIFIED_DATE } from "@claude-stats/core/pricing";
import { Store } from "../store/index.js";
import { createMcpServer } from "../mcp/index.js";
import { buildRepriceResult, toRepriceGroup } from "../reprice/index.js";
import { printReprice } from "../reprice/format.js";
import { t } from "../i18n.js";

applyPricingCache({}, PRICING_VERIFIED_DATE);

const tmpPaths: string[] = [];
function tmp(suffix: string): string {
  const p = path.join(os.tmpdir(), `cs-reprice-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  tmpPaths.push(p);
  return p;
}
afterEach(() => {
  for (const p of tmpPaths.splice(0)) {
    fs.rmSync(p, { force: true });
    fs.rmSync(`${p}-wal`, { force: true });
    fs.rmSync(`${p}-shm`, { force: true });
  }
});

const T0 = 1_700_000_000_000; // 2023-11-14 22:13 UTC
const DAY = "2023-11-14";
const M = 1_000_000;
const OPUS = "claude-opus-5-5";
const FABLE = "claude-fable-5-2";
let seq = 0;

interface Spec {
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  speed?: string;
  geo?: string;
  session: "A" | "B";
}

function line(spec: Spec): Record<string, unknown> {
  seq++;
  return {
    type: "assistant",
    sessionId: `sess-${spec.session}`,
    version: "2.1.311",
    timestamp: T0 + seq * 1000,
    uuid: `rp-${seq}`,
    message: {
      id: `msg_rp_${seq}`,
      model: spec.model,
      stop_reason: "end_turn",
      content: [],
      usage: {
        input_tokens: spec.input,
        output_tokens: spec.output,
        cache_creation_input_tokens: spec.cacheCreation ?? 0,
        cache_read_input_tokens: spec.cacheRead ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: spec.cacheCreation ?? 0, ephemeral_1h_input_tokens: 0 },
        ...(spec.speed !== undefined ? { speed: spec.speed } : {}),
        ...(spec.geo !== undefined ? { inference_geo: spec.geo } : {}),
      },
    },
  };
}

async function seed(store: Store, specs: Spec[]): Promise<void> {
  for (const session of ["A", "B"] as const) {
    const lines = specs.filter((s) => s.session === session).map(line);
    if (lines.length === 0) continue;
    const file = tmp(".jsonl");
    const queue = { type: "queue-operation", operation: "enqueue", sessionId: `sess-${session}`, timestamp: T0 };
    fs.writeFileSync(file, [queue, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const parsed = await parseSessionFile(file, `/proj-${session}`);
    store.upsertSession(parsed.session!);
    store.upsertMessages(parsed.messages);
  }
}

const FIXTURE: Spec[] = [
  { model: OPUS, input: M, output: M, cacheRead: 2 * M, cacheCreation: M, speed: "standard", geo: "global", session: "A" },
  { model: OPUS, input: M, output: M, speed: "fast", geo: "global", session: "A" },
  { model: OPUS, input: M, output: M, speed: "standard", geo: "us", session: "B" },
  { model: OPUS, input: 1_000, output: M, cacheRead: 119_000, speed: "standard", geo: "global", session: "B" },
  { model: FABLE, input: M, output: M, speed: "standard", geo: "global", session: "B" },
];

async function seeded(): Promise<Store> {
  const store = new Store(tmp(".db"));
  await seed(store, FIXTURE);
  return store;
}

const base = { from: DAY, to: DAY, timezone: "UTC" };

describe("buildRepriceResult (store read + core swap)", () => {
  it("Opus 5.5 -> Sonnet 5.5: per-category figures, fast row unpriced and disclosed, geo and long-prompt rows priced", async () => {
    const store = await seeded();
    const out = await buildRepriceResult(store, { ...base, model: OPUS, asModel: "claude-sonnet-5-5" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = out.result;

    // 4 Opus rows; the Fable row is not counted.
    expect(r.rows).toBe(4);
    expect(r.tokens).toEqual({ input: 3_001_000, output: 4 * M, cacheWrite5m: M, cacheWrite1h: 0, cacheRead: 2_119_000 });

    // actual = r1 29.4 + r2 48 + r3 26.4 + r4 20.0278 = 123.8278
    expect(r.actual.total).toBeCloseTo(123.8278, 4);
    // per category: input 4 + 8 + 4.4 + 0.004, output 20 + 40 + 22 + 20, read 0.4 + 0.0238, write 5
    expect(r.actual.input).toBeCloseTo(16.404, 4);
    expect(r.actual.output).toBeCloseTo(102, 4);
    expect(r.actual.cacheRead).toBeCloseTo(0.4238, 4);
    expect(r.actual.cacheWrite5m).toBeCloseTo(5, 4);

    // at Sonnet 5.5 the fast row is unpriced: r1 14.7 + r3 13.2 + r4 10.0139 = 37.9139
    expect(r.counterfactual.total).toBeCloseTo(37.9139, 4);
    expect(r.counterfactual.input).toBeCloseTo(2 + 2.2 + 0.002, 4);
    expect(r.counterfactual.output).toBeCloseTo(10 + 11 + 10, 4);
    expect(r.counterfactual.cacheRead).toBeCloseTo(0.2 + 0.0119, 4);
    expect(r.counterfactual.cacheWrite5m).toBeCloseTo(2.5, 4);

    expect(r.unpriced.counterfactual.rows).toBe(1);
    expect(r.unpriced.counterfactual.byReason).toEqual({ "fast-unpriced": 1 });
    expect(r.unpriced.counterfactual.actualCost).toBeCloseTo(48, 4);
    expect(r.unpriced.actual.rows).toBe(0);
    expect(r.comparable.rows).toBe(3);
    expect(r.comparable.actualTotal).toBeCloseTo(75.8278, 4);
    expect(r.comparable.counterfactualTotal).toBeCloseTo(37.9139, 4);
    store.close();
  });

  it("splits long-context rows by the TARGET's tier: Opus 5.5 -> Haiku 5.5", async () => {
    const store = await seeded();
    const out = await buildRepriceResult(store, { ...base, model: OPUS, asModel: "claude-haiku-5-5" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Every fixture prompt is over Haiku's 100K threshold, so all priced rows take its tier rates
    // (0.50 / 2.50 / 0.05 / 0.625): r1 0.5 + 2.5 + 0.1 + 0.625 = 3.725; r3 (0.5 + 2.5) x 1.1 = 3.3;
    // r4 0.0005 + 2.5 + 0.00595 = 2.50645. r2 (fast) is unpriced: Haiku has no fast rate.
    expect(out.result.counterfactual.total).toBeCloseTo(3.725 + 3.3 + 2.50645, 4);
    expect(out.result.unpriced.counterfactual.byReason).toEqual({ "fast-unpriced": 1 });
    store.close();
  });

  it("applies the target's tier only to the rows over its threshold (a 50K and a 120K prompt)", async () => {
    const store = new Store(tmp(".db"));
    await seed(store, [
      { model: OPUS, input: 50_000, output: M, speed: "standard", geo: "global", session: "A" }, // under 100K
      { model: OPUS, input: 1_000, output: M, cacheRead: 119_000, speed: "standard", geo: "global", session: "A" }, // 120K
    ]);
    const out = await buildRepriceResult(store, { ...base, model: OPUS, asModel: "claude-haiku-5-5" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 50K row at Haiku BASE rates: 50,000 x 0.10 + 1M x 0.50 = 0.005 + 0.5 = 0.505
    // 120K row at Haiku TIER rates: 0.0005 + 2.5 + 0.00595 = 2.50645
    expect(out.result.counterfactual.total).toBeCloseTo(0.505 + 2.50645, 4);
    // Serving side has no tier: both rows at Opus base rates.
    expect(out.result.actual.total).toBeCloseTo((0.2 + 20) + (0.004 + 20 + 0.0238), 4);
    store.close();
  });

  it("a target with a fast rate keeps fast rows fast (Opus 5.5 -> Fable 5.2: nothing unpriced)", async () => {
    const store = await seeded();
    const out = await buildRepriceResult(store, { ...base, model: OPUS, asModel: FABLE });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.unpriced.counterfactual.rows).toBe(0);
    // r1 8 + 40 + 2M read x 0.20 + 1M write x 10 = 58.4; r2 (8 + 40) x 2 = 96;
    // r3 (8 + 40) x 1.1 = 52.8; r4 0.008 + 40 + 119K x 0.20 = 40.0318
    expect(out.result.counterfactual.total).toBeCloseTo(58.4 + 96 + 52.8 + 40.0318, 4);
    store.close();
  });

  it("filters by project", async () => {
    const store = await seeded();
    const out = await buildRepriceResult(store, { ...base, model: OPUS, asModel: "claude-sonnet-5-5", project: "/proj-B" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.rows).toBe(2); // r3, r4
    expect(out.result.actual.total).toBeCloseTo(26.4 + 20.0278, 4);
    expect(out.result.unpriced.counterfactual.rows).toBe(0);
    store.close();
  });

  it("a window with none of the model's messages is an honest zero with rows: 0", async () => {
    const store = await seeded();
    const out = await buildRepriceResult(store, { from: "2020-01-01", to: "2020-01-02", timezone: "UTC", model: OPUS, asModel: FABLE });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.rows).toBe(0);
    expect(out.result.actual.total).toBe(0);
    store.close();
  });

  it("refuses an unknown model id without reading the store (never priced at $0)", async () => {
    const store = await seeded();
    const read = vi.spyOn(store, "getRepriceGroups");
    for (const [model, asModel, field] of [
      ["claude-nonexistent-9", FABLE, "model"],
      [OPUS, "claude-nonexistent-9", "asModel"],
      [OPUS, "claude-fable-5-9", "asModel"], // a point release with no row: not inherited from claude-fable-5
    ] as const) {
      const out = await buildRepriceResult(store, { ...base, model, asModel });
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error).toContain(`\`${field}\``);
        expect(out.error).toMatch(/no known rate/);
      }
    }
    expect(read).not.toHaveBeenCalled();
    store.close();
  });

  it("refuses a malformed id and a bad window", async () => {
    const store = await seeded();
    expect((await buildRepriceResult(store, { ...base, model: "claude opus; DROP", asModel: FABLE })).ok).toBe(false);
    expect((await buildRepriceResult(store, { ...base, model: OPUS, asModel: "" })).ok).toBe(false);
    const impossible = await buildRepriceResult(store, { ...base, from: "2023-02-30", to: "2023-03-01", model: OPUS, asModel: FABLE });
    expect(impossible.ok).toBe(false);
    const backwards = await buildRepriceResult(store, { ...base, from: "2023-11-15", to: "2023-11-14", model: OPUS, asModel: FABLE });
    expect(backwards.ok).toBe(false);
    store.close();
  });

  it("toRepriceGroup maps the store row without losing a field", () => {
    const g = toRepriceGroup({
      model: OPUS, long_context: 1, target_long_context: 0, us_geo: 1, speed_class: "fast",
      input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_creation_tokens: 4,
      ephemeral_5m_cache_tokens: 5, ephemeral_1h_cache_tokens: 6, msg_count: 7,
    });
    expect(g).toEqual({
      model: OPUS, longContext: true, targetLongContext: false, speed: "fast", inferenceGeo: "us",
      rows: 7, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4,
      ephemeral5mTokens: 5, ephemeral1hTokens: 6,
    });
  });
});

describe("reprice_period (MCP)", () => {
  async function connect(store: Store): Promise<Client> {
    const server = createMcpServer(store);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "reprice-test", version: "1" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }
  async function call(client: Client, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown>; text: string }> {
    const res = await client.callTool({ name: "reprice_period", arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* a schema rejection is plain text */ }
    return { isError: res.isError === true, body, text };
  }

  it("is listed with a description that carries the upper-bound contract and an input schema", async () => {
    const store = await seeded();
    const client = await connect(store);
    const tool = (await client.listTools()).tools.find((x) => x.name === "reprice_period");
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/EQUAL TOKEN VOLUME/);
    expect(tool!.description).toMatch(/READ-ONLY/);
    expect(tool!.inputSchema.required).toEqual(expect.arrayContaining(["from", "to", "model", "asModel"]));
    store.close();
  });

  it("returns the result with the localised equal-token-volume label (from the locale, not hard-coded)", async () => {
    const store = await seeded();
    const client = await connect(store);
    const { isError, body } = await call(client, { from: DAY, to: DAY, model: OPUS, asModel: FABLE });
    expect(isError).toBe(false);
    expect(body["model"]).toBe(OPUS);
    expect(body["asModel"]).toBe(FABLE);
    expect(body["window"]).toEqual({ from: DAY, to: DAY });
    expect(body["equalTokenVolumeNote"]).toBe(t("common:reprice.equalTokenVolumeNote"));
    expect(String(body["equalTokenVolumeNote"])).toMatch(/equal token volume/i);
    expect(String(body["equalTokenVolumeNote"])).toMatch(/upper bound/i);
    expect(body["costBasis"]).toBeDefined();
    store.close();
  });

  it("returns an error body, not a figure, for an unknown model", async () => {
    const store = await seeded();
    const client = await connect(store);
    const { body } = await call(client, { from: DAY, to: DAY, model: OPUS, asModel: "claude-nonexistent-9" });
    expect(String(body["error"])).toMatch(/no known rate/);
    expect(body["counterfactual"]).toBeUndefined();
    store.close();
  });

  it("rejects bad input at the schema: id shape, date shape, missing fields", async () => {
    const store = await seeded();
    const client = await connect(store);
    const good = { from: DAY, to: DAY, model: OPUS, asModel: FABLE };
    const bad: Array<Record<string, unknown>> = [
      { ...good, model: "claude opus" },
      { ...good, asModel: "x; DROP TABLE messages" },
      { ...good, model: "" },
      { ...good, asModel: "a".repeat(200) },
      { ...good, from: "14-11-2023" },
      { ...good, to: "2023-11" },
      { ...good, model: 5 },
      { from: DAY, to: DAY, model: OPUS }, // no asModel
      { from: DAY, model: OPUS, asModel: FABLE }, // no to
    ];
    for (const args of bad) {
      const r = await call(client, args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    store.close();
  });
});

describe("printReprice (CLI)", () => {
  async function render(asModel: string, json = false): Promise<string> {
    const store = await seeded();
    const out = await buildRepriceResult(store, { ...base, model: OPUS, asModel });
    store.close();
    if (!out.ok) throw new Error(out.error);
    let text = "";
    printReprice(out.result, { from: DAY, to: DAY }, { write: (s: string) => { text += s; return true; } } as unknown as NodeJS.WritableStream, { json });
    return text;
  }

  it("prints the table, the unpriced disclosure and the translated upper-bound label", async () => {
    const text = await render("claude-sonnet-5-5");
    expect(text).toContain(t("common:reprice.equalTokenVolumeNote"));
    expect(text).toContain(t("cli:reprice.cacheWrite5m"));
    expect(text).toContain(t("cli:reprice.reason.fastUnpriced"));
    expect(text).toContain("$123.83"); // actual total
    expect(text).toContain("$37.91"); // repriced total
  });

  it("JSON output carries the same label and figures", async () => {
    const parsed = JSON.parse(await render("claude-sonnet-5-5", true)) as Record<string, unknown> & { actual: { total: number } };
    expect(parsed["equalTokenVolumeNote"]).toBe(t("common:reprice.equalTokenVolumeNote"));
    expect(parsed.actual.total).toBeCloseTo(123.8278, 4);
  });
});
