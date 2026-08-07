/**
 * Lane I — the justification pack.
 *
 * Design: doc/analysis/ticket-attribution/05-justification-pack.md,
 *         04-reporting-and-roi.md.
 *
 * Three properties are load-bearing (05 §5.3) and each gets its own section
 * below: determinism (byte-identical regeneration), sync-grade redaction (the
 * pack leaves the machine), and section opt-in (never more than asked for).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store/index.js";
import type { Config } from "../config.js";
import {
  buildJustificationPack,
  generateJustificationPack,
  resolvePackPeriod,
  parseSections,
  DEFAULT_PACK_SECTIONS,
  ALL_PACK_SECTIONS,
} from "../pack/index.js";
import { seedStore, buildCorpus, FIXED_NOW } from "./fixtures/synthetic.js";
import { runTaskClassPass } from "../task-class/index.js";
import {
  buildPackHeadline,
  buildTicketRows,
  buildNonTicketRows,
  buildPackMethodology,
  buildJustificationPackModel,
  renderJustificationPackHtml,
  renderTicketsCsv,
  renderSummaryCsv,
  renderNonTicketCsv,
  type RawPackTicketRow,
} from "@claude-stats/core/pack";
import { formatDevTime, costCaveat } from "@claude-stats/core/insight";
import type { TicketCoverage } from "@claude-stats/core/types/insight";
import type { JustificationPackModel } from "@claude-stats/core/types/pack";

// ─── resolvePackPeriod / parseSections (pure) ────────────────────────────────

describe("resolvePackPeriod", () => {
  it("resolves a calendar month to [start of month, start of next month)", () => {
    const { since, until, label } = resolvePackPeriod("2026-02", "UTC");
    expect(label).toBe("2026-02");
    expect(new Date(since).toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(new Date(until).toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("rolls over the year at December", () => {
    const { since, until } = resolvePackPeriod("2026-12", "UTC");
    expect(new Date(since).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(new Date(until).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it.each(["2026-13", "2026/02", "26-02", "not-a-period", ""])(
    "rejects %s",
    (bad) => {
      expect(() => resolvePackPeriod(bad, "UTC")).toThrow(RangeError);
    },
  );

  it("is pure: the same (period, tz) always resolves to the same window (no Date.now dependency)", () => {
    const a = resolvePackPeriod("2020-06", "UTC");
    const b = resolvePackPeriod("2020-06", "UTC");
    expect(a).toEqual(b);
  });
});

describe("parseSections", () => {
  it("defaults to headline,tickets,nonticket when omitted or blank", () => {
    expect(parseSections(undefined)).toEqual([...DEFAULT_PACK_SECTIONS]);
    expect(parseSections("")).toEqual([...DEFAULT_PACK_SECTIONS]);
    expect(parseSections("   ")).toEqual([...DEFAULT_PACK_SECTIONS]);
  });

  it("drops unknown tokens rather than throwing (unattended-safe default)", () => {
    expect(parseSections("headline,bogus,tickets")).toEqual(["headline", "tickets"]);
  });

  it("normalizes to canonical ALL_PACK_SECTIONS order regardless of input order", () => {
    expect(parseSections("calibration,headline")).toEqual(["headline", "calibration"]);
  });

  it("dedupes repeated tokens", () => {
    expect(parseSections("tickets,tickets,tickets")).toEqual(["tickets"]);
  });
});

// ─── Pure model builders ─────────────────────────────────────────────────────

const COVERAGE: TicketCoverage = {
  attributedCost: 60,
  totalCost: 100,
  ratio: 0.6,
  byConfidence: { high: 40, medium: 20, low: 0 },
  ambiguousSessions: 0,
};

describe("buildPackHeadline", () => {
  it("quotes formatDevTime and costCaveat rather than re-deriving the sentence (anti-drift)", () => {
    const h = buildPackHeadline({ mode: "metered", currency: "USD", coverage: COVERAGE, hourlyRate: 100 });
    expect(h.devTimeLabel).toBe(formatDevTime(100, 100));
    expect(h.costCaveatText).toBe(costCaveat("metered", { reconciledRatio: null, anyFallbackRates: false }));
  });

  it("omits devTimeLabel when no hourly rate is configured", () => {
    const h = buildPackHeadline({ mode: "metered", currency: "USD", coverage: COVERAGE });
    expect(h.devTimeLabel).toBeNull();
  });

  it("computes reconciliation only for metered accounts with a positive invoice total", () => {
    const metered = buildPackHeadline({
      mode: "metered",
      currency: "USD",
      coverage: COVERAGE,
      reconciledInvoiceTotal: 105,
      reconciliationTolerance: 0.05,
    });
    expect(metered.reconciliation).not.toBeNull();
    expect(metered.reconciliation!.ratio).toBeCloseTo(100 / 105, 6);
    expect(metered.reconciliation!.withinTolerance).toBe(true);

    const outOfTolerance = buildPackHeadline({
      mode: "metered",
      currency: "USD",
      coverage: COVERAGE,
      reconciledInvoiceTotal: 200,
      reconciliationTolerance: 0.05,
    });
    expect(outOfTolerance.reconciliation!.withinTolerance).toBe(false);

    const plan = buildPackHeadline({
      mode: "plan",
      currency: "USD",
      coverage: COVERAGE,
      reconciledInvoiceTotal: 105,
    });
    expect(plan.reconciliation).toBeNull(); // plan accounts don't reconcile against an invoice
  });
});

describe("buildTicketRows", () => {
  const valid: RawPackTicketRow = {
    ticketKey: "PROJ-1",
    cost: 5,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    sessionCount: 1,
    confidence: "high",
  };

  it("drops rows whose key fails ticket-key validation (defence in depth)", () => {
    const bad: RawPackTicketRow = { ...valid, ticketKey: "<script>alert(1)</script>" };
    const rows = buildTicketRows([valid, bad]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ticketKey).toBe("PROJ-1");
  });

  it("sorts by cost descending, ticketKey ascending on ties", () => {
    const a: RawPackTicketRow = { ...valid, ticketKey: "PROJ-2", cost: 5 };
    const b: RawPackTicketRow = { ...valid, ticketKey: "PROJ-1", cost: 5 };
    const c: RawPackTicketRow = { ...valid, ticketKey: "PROJ-3", cost: 10 };
    expect(buildTicketRows([a, b, c]).map((r) => r.ticketKey)).toEqual(["PROJ-3", "PROJ-1", "PROJ-2"]);
  });

  it("carries no field outside the minimized shape (no sessionIds, no evidence)", () => {
    const row = buildTicketRows([valid])[0]!;
    expect(Object.keys(row).sort()).toEqual(
      [
        "cacheCreationTokens",
        "cacheReadTokens",
        "confidence",
        "cost",
        "inputTokens",
        "outputTokens",
        "sessionCount",
        "ticketKey",
      ].sort(),
    );
  });
});

describe("buildNonTicketRows", () => {
  it("sorts by cost descending, class ascending on ties", () => {
    const byClass = new Map([
      ["debug", { cost: 5, sessionCount: 1 }],
      ["review", { cost: 5, sessionCount: 1 }],
      ["explore", { cost: 20, sessionCount: 2 }],
    ]);
    expect(buildNonTicketRows(byClass).map((r) => r.taskClass)).toEqual(["explore", "debug", "review"]);
  });
});

describe("buildPackMethodology — LOCAL-ONLY detail must never cross into the pack", () => {
  const MARKER = "internal-only-detail-must-not-leak";

  it("drops PolicyEvent.detail even though the input object carries it", () => {
    const result = buildPackMethodology({
      pricingVerifiedDate: "2026-07-03",
      taskClassVersion: 2,
      languageMode: "metered",
      policyEvents: [
        // `detail` is present on the real PolicyEvent type (structurally
        // assignable here) — buildPackMethodology must not copy it forward.
        { date: "2026-01-01", kind: "model-removal", scope: "org", detail: MARKER } as never,
      ],
    });
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(result.policyEvents).toEqual([{ date: "2026-01-01", kind: "model-removal", scope: "org" }]);
  });

  it("sorts policy events chronologically", () => {
    const result = buildPackMethodology({
      pricingVerifiedDate: "2026-07-03",
      taskClassVersion: 2,
      languageMode: "metered",
      policyEvents: [
        { date: "2026-03-01", kind: "budget-cap" },
        { date: "2026-01-01", kind: "model-removal" },
      ],
    });
    expect(result.policyEvents.map((e) => e.date)).toEqual(["2026-01-01", "2026-03-01"]);
  });
});

describe("buildJustificationPackModel — section opt-in", () => {
  const baseInput = {
    generatedAt: FIXED_NOW,
    period: { since: 0, until: 1, label: "2026-01" },
    headline: { mode: "metered" as const, currency: "USD", coverage: COVERAGE },
    methodology: { pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered" as const, policyEvents: [] },
  };

  it("omits tickets/nonTicket entirely when not opted into, even if data is supplied", () => {
    const model = buildJustificationPackModel({
      ...baseInput,
      sections: ["headline"],
      tickets: [{ ticketKey: "PROJ-1", cost: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessionCount: 1, confidence: "high" }],
      nonTicketByClass: new Map([["debug", { cost: 1, sessionCount: 1 }]]),
    });
    expect(model.tickets).toBeNull();
    expect(model.nonTicket).toBeNull();
    expect(model.sections).toEqual(["headline"]);
  });

  it("marks hygiene/constraint/calibration unavailable ONLY when opted into", () => {
    const optedOut = buildJustificationPackModel({ ...baseInput, sections: ["headline"] });
    expect(optedOut.unavailableSections).toEqual({ hygiene: null, constraint: null, calibration: null });

    const optedIn = buildJustificationPackModel({ ...baseInput, sections: ["headline", "hygiene", "calibration"] });
    expect(optedIn.unavailableSections.hygiene).not.toBeNull();
    expect(optedIn.unavailableSections.calibration).not.toBeNull();
    expect(optedIn.unavailableSections.constraint).toBeNull();
  });

  it("canonicalizes section order regardless of input order", () => {
    const model = buildJustificationPackModel({ ...baseInput, sections: ["calibration", "headline", "tickets"] });
    expect(model.sections).toEqual(["headline", "tickets", "calibration"]);
  });
});

// ─── Rendering: HTML escaping is defence in depth, not decoration ───────────

describe("renderJustificationPackHtml — escaping", () => {
  it("escapes an unsafe ticketKey rather than emitting it raw, even if it reached the model", () => {
    // Bypasses buildTicketRows on purpose: proves the RENDERER itself never
    // trusts its input, as a second layer behind the builder-level filter.
    const model: JustificationPackModel = {
      generatedAt: FIXED_NOW,
      period: { since: 0, until: 1, label: "2026-01" },
      sections: ["tickets"],
      headline: buildPackHeadline({ mode: "metered", currency: "USD", coverage: COVERAGE }),
      tickets: [
        {
          ticketKey: "<script>alert(1)</script>",
          cost: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          sessionCount: 1,
          confidence: "high",
        },
      ],
      nonTicket: null,
      methodology: buildPackMethodology({ pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered", policyEvents: [] }),
      unavailableSections: { hygiene: null, constraint: null, calibration: null },
    };
    const html = renderJustificationPackHtml(model);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

// ─── CSV escaping ─────────────────────────────────────────────────────────────

describe("CSV bundle rendering", () => {
  it("quotes a field containing a comma or a quote", () => {
    const model: JustificationPackModel = {
      generatedAt: FIXED_NOW,
      period: { since: 0, until: 1, label: "2026-01, has a comma" },
      sections: ["tickets"],
      headline: buildPackHeadline({ mode: "metered", currency: "USD", coverage: COVERAGE }),
      tickets: [{ ticketKey: "PROJ-1", cost: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessionCount: 1, confidence: "high" }],
      nonTicket: null,
      methodology: buildPackMethodology({ pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered", policyEvents: [] }),
      unavailableSections: { hygiene: null, constraint: null, calibration: null },
    };
    const csv = renderTicketsCsv(model);
    expect(csv).toContain('"2026-01, has a comma"');
  });

  it("renders the exact ticketKey, period, cost, tokens, confidence, sessionCount shape (04 §4.1)", () => {
    const model: JustificationPackModel = {
      generatedAt: FIXED_NOW,
      period: { since: 0, until: 1, label: "2026-05" },
      sections: ["tickets"],
      headline: buildPackHeadline({ mode: "metered", currency: "USD", coverage: COVERAGE }),
      tickets: [{ ticketKey: "PROJ-9", cost: 12.5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5, sessionCount: 3, confidence: "medium" }],
      nonTicket: null,
      methodology: buildPackMethodology({ pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered", policyEvents: [] }),
      unavailableSections: { hygiene: null, constraint: null, calibration: null },
    };
    const lines = renderTicketsCsv(model).trim().split("\r\n");
    expect(lines[0]).toBe("ticketKey,period,cost,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,sessionCount,confidence");
    expect(lines[1]).toBe("PROJ-9,2026-05,12.50,100,50,10,5,3,medium");
  });
});

// ─── End-to-end: seeded store → generated pack ──────────────────────────────

describe("justification pack — generated against a seeded store", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: Store;
  const config: Config = {
    rate: { hourly: 80, currency: "USD" },
    reconciliation: { invoiceTotal: 500, tolerancePercent: 5 },
    policyEvents: [{ date: "2026-01-10", kind: "model-removal", scope: "org", detail: "internal budget note" }],
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-stats-pack-test-"));
    dbPath = join(tmpDir, "test.db");
    store = new Store(dbPath);
    seedStore(store, { sessions: 20, seed: 7, startAt: resolvePackPeriod("2026-01", "UTC").since + 3600_000 });
    runTaskClassPass(store, { now: () => FIXED_NOW });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("produces a headline, a per-ticket table, and a non-ticket breakdown with real task classes", () => {
    const result = buildJustificationPack(store, config, {
      period: "2026-01",
      timezone: "UTC",
      sections: [...ALL_PACK_SECTIONS],
      now: () => FIXED_NOW,
    });
    expect(result.model.headline.totalCost).toBeGreaterThan(0);
    expect(result.model.tickets).not.toBeNull();
    expect(result.model.tickets!.length).toBeGreaterThan(0);
    expect(result.model.nonTicket).not.toBeNull();
    // At least one non-ticket row was actually classified (not just the
    // "unclassified" bucket) — proves runTaskClassPass's output is wired in,
    // not silently dropped.
    expect(result.model.nonTicket!.some((r) => r.taskClass !== "unclassified")).toBe(true);
    expect(result.model.unavailableSections.hygiene).toContain("not available");
    expect(result.model.unavailableSections.constraint).toContain("not available");
    expect(result.model.unavailableSections.calibration).toContain("not available");
  });

  it("DETERMINISM: regenerating under the same frozen clock produces byte-identical html and csv", () => {
    const opts = { period: "2026-01", timezone: "UTC", sections: [...ALL_PACK_SECTIONS], now: () => FIXED_NOW } as const;
    const first = buildJustificationPack(store, config, opts);
    const second = buildJustificationPack(store, config, opts);
    expect(second.html).toBe(first.html);
    expect(second.ticketsCsv).toBe(first.ticketsCsv);
    expect(second.nonTicketCsv).toBe(first.nonTicketCsv);
    expect(second.summaryCsv).toBe(first.summaryCsv);
  });

  it("a different generation clock produces a different document (proves the timestamp is real, not hardcoded)", () => {
    const a = buildJustificationPack(store, config, { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW });
    const b = buildJustificationPack(store, config, { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW + 86_400_000 });
    expect(a.html).not.toBe(b.html);
    expect(a.model.generatedAt).not.toBe(b.model.generatedAt);
  });

  it("REDACTION: no prompt text, project path, source file, git branch, or policy-event detail crosses into the pack", () => {
    const MARKER = "kx7-confidential-marker-9f3a";
    const leaky = {
      sessionId: "leaky-001",
      projectPath: `/w/${MARKER}`,
      sourceFile: `/transcripts/${MARKER}.jsonl`,
      firstTimestamp: resolvePackPeriod("2026-01", "UTC").since + 10_000,
      lastTimestamp: resolvePackPeriod("2026-01", "UTC").since + 20_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude-cli",
      gitBranch: `feature/${MARKER}`,
      permissionMode: "default",
      isInteractive: true,
      promptCount: 1,
      assistantMessageCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      webFetchRequests: 0,
      toolUseCounts: [],
      models: ["claude-sonnet-5"],
      repoUrl: null,
      accountUuid: "acct-leak-test",
      organizationUuid: null,
      subscriptionType: null,
      thinkingBlocks: 0,
      parentSessionId: null,
      isSubagent: false,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: 1000,
      medianResponseTimeMs: 4000,
    };
    store.upsertSession(leaky);
    store.upsertMessages([
      {
        uuid: "leaky-001-m0",
        sessionId: "leaky-001",
        timestamp: leaky.firstTimestamp!,
        claudeVersion: "2.1.70",
        model: "claude-sonnet-5",
        stopReason: "end_turn",
        inputTokens: 500,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        tools: [],
        thinkingBlocks: 0,
        serviceTier: null,
        inferenceGeo: null,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
        promptText: `Investigate the outage for ${MARKER} in prod, see /home/user/${MARKER}/notes.txt`,
      },
    ]);
    // Also link it to a ticket with evidence text that must not leak.
    store.addTicketLink({
      sessionId: "leaky-001",
      ticketKey: "PROJ-999",
      source: "branch",
      confidence: "high",
      evidence: `feature/${MARKER}`,
    });

    const result = buildJustificationPack(store, config, {
      period: "2026-01",
      timezone: "UTC",
      sections: [...ALL_PACK_SECTIONS],
      now: () => FIXED_NOW,
    });

    const everything = result.html + result.ticketsCsv + result.nonTicketCsv + result.summaryCsv;
    expect(everything).not.toContain(MARKER);
    expect(everything).not.toContain("leaky-001"); // session id
    // No session id — attributed OR unattributed — may appear anywhere. This
    // is the assertion that actually exercises the non-ticket breakdown's
    // grouping key (the synthetic corpus's own `syn-NNN` ids), not just the
    // one hand-crafted session above.
    expect(everything).not.toMatch(/\bsyn-\d{3}\b/);
    expect(everything).not.toContain("internal budget note"); // PolicyEvent.detail (LOCAL-ONLY)
    // The ticket this leaky session fed IS allowed to appear (that's the point
    // of attribution) — only its raw evidence/paths/prompt/session id are not.
    expect(result.html).toContain("PROJ-999");
  });

  it("writes the bundle to disk and the files round-trip byte-for-byte", () => {
    const written = generateJustificationPack(
      store,
      config,
      { period: "2026-01", timezone: "UTC", sections: [...ALL_PACK_SECTIONS], now: () => FIXED_NOW },
      tmpDir,
    );
    expect(existsSync(written.htmlPath)).toBe(true);
    expect(existsSync(written.ticketsCsvPath)).toBe(true);
    expect(existsSync(written.nonTicketCsvPath)).toBe(true);
    expect(existsSync(written.summaryCsvPath)).toBe(true);
    expect(readFileSync(written.htmlPath, "utf-8")).toBe(written.html);
    expect(readFileSync(written.ticketsCsvPath, "utf-8")).toBe(written.ticketsCsv);
    expect(written.dir).toContain("claude-stats-pack-2026-01");
  });

  it("respects the default section set (headline,tickets,nonticket) when --sections is omitted", () => {
    const result = buildJustificationPack(store, config, { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW });
    expect(result.model.sections).toEqual(["headline", "tickets", "nonticket"]);
    expect(result.html).not.toContain("Hygiene trend");
    expect(result.html).not.toContain("Constraint impact");
  });

  it("an empty period is an honest empty state, not a stub or an error", () => {
    // No sessions exist in 2020-01 — the corpus starts at 2026-01.
    const result = buildJustificationPack(store, config, { period: "2020-01", timezone: "UTC", now: () => FIXED_NOW });
    expect(result.model.headline.totalCost).toBe(0);
    expect(result.model.tickets).toEqual([]);
    expect(result.model.nonTicket).toEqual([]);
    expect(result.html).toContain("No ticket-attributed spend in this period.");
    expect(result.html).toContain("No non-ticket spend in this period.");
  });
});
