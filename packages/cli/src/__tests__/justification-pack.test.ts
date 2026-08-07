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
import { join, relative, isAbsolute } from "node:path";
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
import { formatDevTime, costCaveat, confidenceCaveat } from "@claude-stats/core/insight";
// The real `en` translator (setup.ts runs initCliI18n("en")) — the same one the
// pack's own shell injects, so these tests exercise the production path.
import { t } from "../i18n.js";
import { getTicketCostReport } from "../ticketing/index.js";
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

  it("accepts tokens in any case (a typo in casing must not silently shrink the pack)", () => {
    expect(parseSections("HEADLINE, Tickets ,NonTicket")).toEqual(["headline", "tickets", "nonticket"]);
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
    const h = buildPackHeadline(t, { mode: "metered", currency: "USD", coverage: COVERAGE, hourlyRate: 100 });
    expect(h.devTimeLabel).toBe(formatDevTime(t, 100, 100));
    expect(h.costCaveatText).toBe(costCaveat(t, "metered", { reconciledRatio: null, anyFallbackRates: false }));
  });

  it("omits devTimeLabel when no hourly rate is configured", () => {
    const h = buildPackHeadline(t, { mode: "metered", currency: "USD", coverage: COVERAGE });
    expect(h.devTimeLabel).toBeNull();
  });

  it("computes reconciliation only for metered accounts with a positive invoice total", () => {
    const metered = buildPackHeadline(t, {
      mode: "metered",
      currency: "USD",
      coverage: COVERAGE,
      reconciledInvoiceTotal: 105,
      reconciliationTolerance: 0.05,
    });
    expect(metered.reconciliation).not.toBeNull();
    expect(metered.reconciliation!.ratio).toBeCloseTo(100 / 105, 6);
    expect(metered.reconciliation!.withinTolerance).toBe(true);

    const outOfTolerance = buildPackHeadline(t, {
      mode: "metered",
      currency: "USD",
      coverage: COVERAGE,
      reconciledInvoiceTotal: 200,
      reconciliationTolerance: 0.05,
    });
    expect(outOfTolerance.reconciliation!.withinTolerance).toBe(false);

    const plan = buildPackHeadline(t, {
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

  it("reports the cost-weighted majority confidence tier per class, and null when no breakdown was supplied (I-5)", () => {
    const byClass = new Map([
      ["debug", { cost: 10, sessionCount: 2, byConfidence: { high: 2, medium: 8, low: 0 } }],
      ["explore", { cost: 5, sessionCount: 1 }], // no byConfidence at all
    ]);
    const rows = buildNonTicketRows(byClass);
    const debug = rows.find((r) => r.taskClass === "debug")!;
    const explore = rows.find((r) => r.taskClass === "explore")!;
    expect(debug.confidence).toBe("medium"); // 8 > 2
    expect(explore.confidence).toBeNull(); // never fabricated when there's no data
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
    const model = buildJustificationPackModel(t, {
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
    const optedOut = buildJustificationPackModel(t, { ...baseInput, sections: ["headline"] });
    expect(optedOut.unavailableSections).toEqual({ hygiene: null, constraint: null, calibration: null });

    const optedIn = buildJustificationPackModel(t, { ...baseInput, sections: ["headline", "hygiene", "calibration"] });
    expect(optedIn.unavailableSections.hygiene).not.toBeNull();
    expect(optedIn.unavailableSections.calibration).not.toBeNull();
    expect(optedIn.unavailableSections.constraint).toBeNull();
  });

  it("canonicalizes section order regardless of input order", () => {
    const model = buildJustificationPackModel(t, { ...baseInput, sections: ["calibration", "headline", "tickets"] });
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
      scope: { projectPath: null, accountUuid: null },
      sections: ["tickets"],
      headline: buildPackHeadline(t, { mode: "metered", currency: "USD", coverage: COVERAGE }),
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

// ─── The headline's honesty obligations must reach the DOCUMENT ─────────────
// Building the model right is only half of it: every one of these figures and
// caveats can be silently dropped in the renderer without any model-level test
// noticing. Each assertion below was verified to fail against a mutation that
// removes exactly the thing it names.

describe("renderJustificationPackHtml — headline", () => {
  const METHODOLOGY = {
    pricingVerifiedDate: "2026-07-03",
    taskClassVersion: 2,
    languageMode: "metered" as const,
    policyEvents: [],
  };
  const render = (over: Partial<Parameters<typeof buildPackHeadline>[0]> = {}) =>
    renderJustificationPackHtml(
      buildJustificationPackModel(t, {
        generatedAt: FIXED_NOW,
        period: { since: 0, until: 1, label: "2026-01" },
        sections: ["headline"],
        headline: {
          mode: "metered",
          currency: "USD",
          coverage: COVERAGE,
          hourlyRate: 100,
          ...over,
        },
        methodology: METHODOLOGY,
      }),
    );

  it("renders the total WITH its currency symbol, and honours a non-USD currency", () => {
    expect(render()).toContain(`<div class="figure">$100.00</div>`);
    expect(render({ currency: "EUR" })).toContain(`<div class="figure">€100.00</div>`);
  });

  it("renders the coverage denominator, numerically equal to coverage.ratio (I1)", () => {
    const m = /([\d.]+)% of spend is ticket-attributable/.exec(render());
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeCloseTo(COVERAGE.ratio! * 100, 1);
  });

  it("renders the confidence-tier caveat verbatim from confidenceCaveat (I1)", () => {
    const caveat = confidenceCaveat(t, COVERAGE);
    expect(caveat).not.toBeNull();
    expect(render()).toContain(caveat!);
  });

  it("renders the dev-time equivalence line quoted from formatDevTime", () => {
    expect(render()).toContain(formatDevTime(t, COVERAGE.totalCost, 100));
  });

  it("renders the fallback-rate caveat rather than asserting 'Actual metered cost.'", () => {
    expect(render({ anyFallbackRates: true })).toContain(
      costCaveat(t, "metered", { reconciledRatio: null, anyFallbackRates: true }),
    );
    expect(render({ anyFallbackRates: true })).not.toContain("Actual metered cost.");
    expect(render({ anyFallbackRates: false })).toContain("Actual metered cost.");
  });

  it("states the reconciliation verdict the right way round, with the configured tolerance", () => {
    // totalCost 100 vs invoice 200 → ratio 50%: outside ±5%, inside ±80%.
    const strict = render({ reconciledInvoiceTotal: 200, reconciliationTolerance: 0.05 });
    expect(strict).toContain("does not reconcile within ±5%.");

    const loose = render({ reconciledInvoiceTotal: 200, reconciliationTolerance: 0.8 });
    expect(loose).toContain("— reconciles within ±80%.");
    expect(loose).not.toContain("does not reconcile");
  });
});

describe("renderJustificationPackHtml — unavailable sections carry the RIGHT heading", () => {
  it("pairs each opted-in placeholder with its own heading, never another section's", () => {
    const html = renderJustificationPackHtml(
      buildJustificationPackModel(t, {
        generatedAt: FIXED_NOW,
        period: { since: 0, until: 1, label: "2026-01" },
        sections: ["constraint"],
        headline: { mode: "metered", currency: "USD", coverage: COVERAGE },
        methodology: { pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered", policyEvents: [] },
      }),
    );
    expect(html).toContain("<h2>Constraint impact</h2>");
    expect(html).not.toContain("<h2>Calibration</h2>");
    expect(html).not.toContain("<h2>Hygiene trend</h2>");
    // …and the placeholder under that heading is the constraint one.
    expect(html.slice(html.indexOf("<h2>Constraint impact</h2>"))).toContain("Constraint-impact before/after");
  });
});

// ─── CSV escaping ─────────────────────────────────────────────────────────────

describe("CSV bundle rendering", () => {
  it("quotes a field containing a comma or a quote", () => {
    const model: JustificationPackModel = {
      generatedAt: FIXED_NOW,
      period: { since: 0, until: 1, label: "2026-01, has a comma" },
      scope: { projectPath: null, accountUuid: null },
      sections: ["tickets"],
      headline: buildPackHeadline(t, { mode: "metered", currency: "USD", coverage: COVERAGE }),
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
      scope: { projectPath: null, accountUuid: null },
      sections: ["tickets"],
      headline: buildPackHeadline(t, { mode: "metered", currency: "USD", coverage: COVERAGE }),
      tickets: [{ ticketKey: "PROJ-9", cost: 12.5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5, sessionCount: 3, confidence: "medium" }],
      nonTicket: null,
      methodology: buildPackMethodology({ pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered", policyEvents: [] }),
      unavailableSections: { hygiene: null, constraint: null, calibration: null },
    };
    const lines = renderTicketsCsv(model).trim().split("\r\n");
    expect(lines[0]).toBe(
      "ticketKey,period,projectPath,accountUuid,cost,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,sessionCount,confidence",
    );
    expect(lines[1]).toBe("PROJ-9,2026-05,,,12.50,100,50,10,5,3,medium");
  });

  it("carries the scope columns through when the pack was filtered (I-2)", () => {
    const model: JustificationPackModel = {
      generatedAt: FIXED_NOW,
      period: { since: 0, until: 1, label: "2026-05" },
      scope: { projectPath: "/w/proj-a", accountUuid: "acct-1234" },
      sections: ["tickets"],
      headline: buildPackHeadline(t, { mode: "metered", currency: "USD", coverage: COVERAGE }),
      tickets: [{ ticketKey: "PROJ-9", cost: 12.5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5, sessionCount: 3, confidence: "medium" }],
      nonTicket: null,
      methodology: buildPackMethodology({ pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered", policyEvents: [] }),
      unavailableSections: { hygiene: null, constraint: null, calibration: null },
    };
    const lines = renderTicketsCsv(model).trim().split("\r\n");
    expect(lines[1]).toBe("PROJ-9,2026-05,/w/proj-a,acct-1234,12.50,100,50,10,5,3,medium");
    const html = renderJustificationPackHtml(model);
    expect(html).toContain("/w/proj-a");
    expect(html).toContain("acct-1234");
    // An UNscoped pack must say so explicitly, not just omit the line.
    const unscoped = renderJustificationPackHtml({ ...model, scope: { projectPath: null, accountUuid: null } });
    expect(unscoped).toContain("unscoped");
  });

  it("doubles an embedded quote rather than emitting malformed CSV", () => {
    const model: JustificationPackModel = {
      generatedAt: FIXED_NOW,
      period: { since: 0, until: 1, label: `2026-01 "Q1"` },
      scope: { projectPath: null, accountUuid: null },
      sections: ["tickets"],
      headline: buildPackHeadline(t, { mode: "metered", currency: "USD", coverage: COVERAGE }),
      tickets: [{ ticketKey: "PROJ-1", cost: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessionCount: 1, confidence: "high" }],
      nonTicket: null,
      methodology: buildPackMethodology({ pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered", policyEvents: [] }),
      unavailableSections: { hygiene: null, constraint: null, calibration: null },
    };
    expect(renderTicketsCsv(model)).toContain(`"2026-01 ""Q1"""`);
  });

  // The two CSVs below had no content assertion at all: emptying either of
  // them left every other test green.
  it("summary.csv carries the headline figures, not just a header row", () => {
    const model = buildJustificationPackModel(t, {
      generatedAt: FIXED_NOW,
      period: { since: 0, until: 1, label: "2026-04" },
      sections: ["headline"],
      headline: {
        mode: "metered",
        currency: "USD",
        coverage: COVERAGE,
        reconciledInvoiceTotal: 200,
        reconciliationTolerance: 0.05,
      },
      methodology: { pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered", policyEvents: [] },
    });
    const lines = renderSummaryCsv(model).trim().split("\r\n");
    expect(lines[0]).toBe(
      "period,projectPath,accountUuid,mode,currency,totalCost,coverageRatio,confidenceHigh,confidenceMedium,confidenceLow," +
        "anyFallbackRates,unknownTokens,planFee,reconciledInvoiceTotal,reconciledRatio,withinTolerance," +
        "reconciliationResidual,reconciliationScopeNote,reconciliationCandidateCauses",
    );
    // COVERAGE: byConfidence {high:40,medium:20,low:0}, attributedCost 60 → 0.6667/0.3333/0.0000.
    // bottomUp 100 vs invoice 200 → ratio 0.5, outside ±5% tolerance → residual
    // 100.00, and with no scopeNote configured "scope-mismatch" is named as a
    // candidate cause (nothing rules it out).
    expect(lines[1]).toBe(
      "2026-04,,,metered,USD,100.00,0.6000,0.6667,0.3333,0.0000,false,0,,200.00,0.5000,false,100.00,,scope-mismatch",
    );
  });

  it("summary.csv carries the unpriced-token count and the fallback-rate flag (I-3, I-5)", () => {
    const model = buildJustificationPackModel(t, {
      generatedAt: FIXED_NOW,
      period: { since: 0, until: 1, label: "2026-04" },
      sections: ["headline"],
      headline: {
        mode: "metered",
        currency: "USD",
        coverage: COVERAGE,
        anyFallbackRates: true,
        unknownTokens: 4500,
      },
      methodology: { pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered", policyEvents: [] },
    });
    const lines = renderSummaryCsv(model).trim().split("\r\n");
    expect(lines[1]).toContain(",true,4500,");
  });

  it("summary.csv carries the plan fee for a plan-mode pack, and blanks it for metered (I-4)", () => {
    const plan = buildJustificationPackModel(t, {
      generatedAt: FIXED_NOW,
      period: { since: 0, until: 1, label: "2026-04" },
      sections: ["headline"],
      headline: { mode: "plan", currency: "USD", coverage: COVERAGE, planFee: 200 },
      methodology: { pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "plan", policyEvents: [] },
    });
    const planLines = renderSummaryCsv(plan).trim().split("\r\n");
    expect(planLines[1]!.split(",")).toContain("200.00");
    expect(plan.headline.planFee).toBe(200);
    expect(renderJustificationPackHtml(plan)).toContain("Plan fee: $200.00/mo");

    const metered = buildJustificationPackModel(t, {
      generatedAt: FIXED_NOW,
      period: { since: 0, until: 1, label: "2026-04" },
      sections: ["headline"],
      // A stray planFee on a metered account must not leak into the pack —
      // only plan mode states a plan fee (I-4).
      headline: { mode: "metered", currency: "USD", coverage: COVERAGE, planFee: 200 },
      methodology: { pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered", policyEvents: [] },
    });
    expect(metered.headline.planFee).toBeNull();
    expect(renderJustificationPackHtml(metered)).not.toContain("Plan fee");
  });

  it("nonticket.csv carries one row per task class, not just a header row", () => {
    const model = buildJustificationPackModel(t, {
      generatedAt: FIXED_NOW,
      period: { since: 0, until: 1, label: "2026-04" },
      sections: ["nonticket"],
      headline: { mode: "metered", currency: "USD", coverage: COVERAGE },
      nonTicketByClass: new Map([
        ["explore", { cost: 12.5, sessionCount: 4, byConfidence: { high: 12.5, medium: 0, low: 0 } }],
        ["debug", { cost: 3, sessionCount: 1 }],
      ]),
      methodology: { pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered", policyEvents: [] },
    });
    const lines = renderNonTicketCsv(model).trim().split("\r\n");
    expect(lines[0]).toBe("taskClass,period,projectPath,accountUuid,cost,sessionCount,confidence");
    // "explore" carries its classifier confidence through; "debug" was given
    // no byConfidence breakdown at all, so it's reported "n/a" rather than a
    // fabricated tier (I-5).
    expect(lines.slice(1)).toEqual(["explore,2026-04,,,12.50,4,high", "debug,2026-04,,,3.00,1,n/a"]);
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

  it("resolves a relative outDir against the process cwd rather than leaving it ambiguous (I-7)", () => {
    // The MCP tool's `outDir` param comes from an agent that has no reliable
    // idea what the server process's cwd is — a relative path must not
    // silently land somewhere neither of them expected.
    const relOutDir = relative(process.cwd(), tmpDir);
    const written = generateJustificationPack(
      store,
      config,
      { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW },
      relOutDir,
    );
    expect(isAbsolute(written.dir)).toBe(true);
    expect(written.dir).toBe(join(tmpDir, "claude-stats-pack-2026-01"));
    expect(existsSync(written.htmlPath)).toBe(true);
  });

  it("respects the default section set (headline,tickets,nonticket) when --sections is omitted", () => {
    const result = buildJustificationPack(store, config, { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW });
    expect(result.model.sections).toEqual(["headline", "tickets", "nonticket"]);
    expect(result.html).not.toContain("Hygiene trend");
    expect(result.html).not.toContain("Constraint impact");
  });

  it("ARITHMETIC: the non-ticket breakdown is the REMAINDER, so the two tables sum to the headline", () => {
    // The non-ticket table's whole claim is that it explains the gap between
    // attributed spend and the total. Without this identity, a bug that let
    // already-attributed sessions back into the breakdown double-counts the
    // month and nothing else notices.
    const result = buildJustificationPack(store, config, {
      period: "2026-01",
      timezone: "UTC",
      sections: [...ALL_PACK_SECTIONS],
      now: () => FIXED_NOW,
    });
    const window = resolvePackPeriod("2026-01", "UTC");
    const report = getTicketCostReport(store, { since: window.since, until: window.until });
    const nonTicketSum = result.model.nonTicket!.reduce((s, r) => s + r.cost, 0);

    expect(report.unattributedSessions.length).toBeGreaterThan(0);
    expect(report.unattributedSessions.length).toBeLessThan(
      new Set(report.tickets.flatMap((t) => t.sessionIds)).size + report.unattributedSessions.length,
    );
    expect(report.coverage.attributedCost + nonTicketSum).toBeCloseTo(result.model.headline.totalCost, 8);
  });

  it("takes the reconciliation tolerance from config, not a hardcoded one", () => {
    const opts = { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW } as const;
    const strict = buildJustificationPack(store, config, opts); // tolerancePercent: 5
    const loose = buildJustificationPack(
      store,
      { ...config, reconciliation: { invoiceTotal: 500, tolerancePercent: 100 } },
      opts,
    );
    expect(strict.model.headline.reconciliation!.tolerancePercent).toBe(5);
    expect(strict.model.headline.reconciliation!.withinTolerance).toBe(false);
    expect(loose.model.headline.reconciliation!.tolerancePercent).toBe(100);
    expect(loose.model.headline.reconciliation!.withinTolerance).toBe(true);
  });

  it("--invoice-csv's parsed total overrides config.reconciliation.invoiceTotal for this run, without mutating config", () => {
    const opts = { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW } as const;
    const withoutOverride = buildJustificationPack(store, config, opts); // config.invoiceTotal: 500
    const withOverride = buildJustificationPack(store, config, { ...opts, invoiceTotalOverride: 60 });

    expect(withoutOverride.model.headline.reconciliation!.invoiceTotal).toBe(500);
    expect(withOverride.model.headline.reconciliation!.invoiceTotal).toBe(60);
    // The override is a per-call option, not a config write — the caller's
    // config object is never touched.
    expect(config.reconciliation!.invoiceTotal).toBe(500);
  });

  it("does NOT carry config's scopeNote onto a --invoice-csv total — that note describes a different figure", () => {
    const opts = { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW } as const;
    const scoped = { ...config, reconciliation: { ...config.reconciliation, scopeNote: "AWS account 111122223333, March 2026 invoice" } };

    // Without an override the note describes the configured figure, so it shows.
    const fromConfig = buildJustificationPack(store, scoped, opts);
    expect(fromConfig.model.headline.reconciliation!.scopeNote).toBe("AWS account 111122223333, March 2026 invoice");

    // With `--invoice-csv`, the total came from the CSV and its scope is
    // precisely what nobody confirmed — reusing the config note would both
    // mislabel the figure and silently drop `scope-mismatch` from the causes.
    const fromCsv = buildJustificationPack(store, scoped, { ...opts, invoiceTotalOverride: 60 });
    expect(fromCsv.model.headline.reconciliation!.invoiceTotal).toBe(60);
    expect(fromCsv.model.headline.reconciliation!.scopeNote).toBeNull();
    expect(fromCsv.model.headline.reconciliation!.withinTolerance).toBe(false);
    expect(fromCsv.model.headline.reconciliation!.candidateCauses).toContain("scope-mismatch");
  });

  it("scopeNote from config reaches the pack's reconciliation block, and suppresses the scope-mismatch cause", () => {
    const opts = { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW } as const;
    const withNote = buildJustificationPack(store, { ...config, reconciliation: { ...config.reconciliation, scopeNote: "AWS 111122223333" } }, opts);
    expect(withNote.model.headline.reconciliation!.scopeNote).toBe("AWS 111122223333");
    expect(withNote.model.headline.reconciliation!.candidateCauses).not.toContain("scope-mismatch");
    expect(withNote.html).toContain("AWS 111122223333");

    const withoutNote = buildJustificationPack(store, config, opts);
    expect(withoutNote.model.headline.reconciliation!.scopeNote).toBeNull();
    expect(withoutNote.model.headline.reconciliation!.candidateCauses).toContain("scope-mismatch");
    expect(withoutNote.html).toContain("not confirmed in config");
  });

  it("names candidate causes for a residual in the HTML, and states 'not confirmed' scope when unset", () => {
    const opts = { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW } as const;
    const result = buildJustificationPack(store, config, opts); // invoiceTotal 500, well outside tolerance
    expect(result.model.headline.reconciliation!.withinTolerance).toBe(false);
    expect(result.html).toContain("Residual:");
    expect(result.html).toContain("Candidate cause");
  });

  it("infers plan mode from a configured plan fee, and says so instead of claiming metered cost", () => {
    const planned = buildJustificationPack(
      store,
      { ...config, plan: { monthly_fee: 200 } },
      { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW },
    );
    expect(planned.model.headline.mode).toBe("plan");
    expect(planned.model.headline.costCaveatText).toBe(costCaveat(t, "plan"));
    expect(planned.html).toContain("Equivalent API cost");
    // A flat-rate plan has no invoice to reconcile a bottom-up total against.
    expect(planned.model.headline.reconciliation).toBeNull();

    const metered = buildJustificationPack(store, config, { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW });
    expect(metered.model.headline.mode).toBe("metered");
    expect(metered.html).not.toContain("Equivalent API cost");
  });

  it("carries the fallback-rate provenance through to the pack's caveat (I1)", () => {
    // "anthropic.claude-opus-5" is a Bedrock model id that prices via the
    // first-party fallback (see dashboard.test.ts's equivalent assertion).
    // The pack must not present that as exact metered cost.
    const window = resolvePackPeriod("2026-01", "UTC");
    store.upsertSession({
      sessionId: "s-bedrock-pack",
      projectPath: "/p",
      sourceFile: "/p/s.jsonl",
      firstTimestamp: window.since + 5_000,
      lastTimestamp: window.since + 6_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude-cli",
      gitBranch: null,
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
      models: ["anthropic.claude-opus-5"],
      repoUrl: null,
      accountUuid: null,
      organizationUuid: null,
      subscriptionType: null,
      thinkingBlocks: 0,
      parentSessionId: null,
      isSubagent: false,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: 1000,
      medianResponseTimeMs: 4000,
    });
    store.upsertMessages([
      {
        uuid: "s-bedrock-pack-m0",
        sessionId: "s-bedrock-pack",
        timestamp: window.since + 5_000,
        claudeVersion: "2.1.70",
        model: "anthropic.claude-opus-5",
        stopReason: "end_turn",
        inputTokens: 10_000,
        outputTokens: 2_000,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        tools: [],
        thinkingBlocks: 0,
        serviceTier: null,
        inferenceGeo: null,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
        promptText: null,
      },
    ]);

    const withFallback = buildJustificationPack(store, config, { period: "2026-01", timezone: "UTC", now: () => FIXED_NOW });
    // `config` (this describe block's shared fixture) sets `reconciliation:
    // {invoiceTotal: 500, tolerancePercent: 5}`, so the caveat now ALSO
    // states the reconciliation verdict — the same figure the headline's
    // own `reconciliation` block computes, quoted rather than re-derived.
    const recon = withFallback.model.headline.reconciliation;
    expect(recon).not.toBeNull();
    expect(withFallback.model.headline.costCaveatText).toBe(
      costCaveat(t, "metered", {
        reconciledRatio: recon!.ratio,
        reconciledWithinTolerance: recon!.withinTolerance,
        anyFallbackRates: true,
      }),
    );
    expect(withFallback.html).not.toContain("Actual metered cost.");

    // A window with no partner-priced usage keeps the plain caveat.
    const clean = buildJustificationPack(store, config, { period: "2020-01", timezone: "UTC", now: () => FIXED_NOW });
    expect(clean.model.headline.costCaveatText).toBe("Actual metered cost.");
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

  // ── I-2: scope must be visible, not just applied ──────────────────────────

  it("a project-filtered pack states its scope, and an unfiltered one says 'unscoped' (I-2)", () => {
    const filtered = buildJustificationPack(store, config, {
      period: "2026-01",
      timezone: "UTC",
      sections: [...ALL_PACK_SECTIONS],
      projectPath: "/w/alpha",
      now: () => FIXED_NOW,
    });
    expect(filtered.model.scope).toEqual({ projectPath: "/w/alpha", accountUuid: null });
    expect(filtered.html).toContain("/w/alpha");
    expect(filtered.ticketsCsv.split("\r\n")[0]).toContain("projectPath");
    // Every data row (not just the header) carries the scope, so a reader who
    // only sees one row of a spreadsheet still knows what it was filtered to.
    const ticketDataLines = filtered.ticketsCsv.trim().split("\r\n").slice(1);
    for (const line of ticketDataLines) expect(line).toContain("/w/alpha");

    const unfiltered = buildJustificationPack(store, config, {
      period: "2026-01",
      timezone: "UTC",
      sections: [...ALL_PACK_SECTIONS],
      now: () => FIXED_NOW,
    });
    expect(unfiltered.model.scope).toEqual({ projectPath: null, accountUuid: null });
    // MUTATION-CAUGHT: a build that always renders the same "unscoped" text
    // regardless of the actual filter would pass a bare toContain("unscoped")
    // check on this branch alone — the assertion above on `filtered` (which
    // must NOT contain "unscoped") is what makes that mutation visible.
    expect(unfiltered.html).toContain("unscoped");
    expect(filtered.html).not.toContain("unscoped");
  });

  // ── I-3: unpriced usage must reach the headline, not vanish ───────────────

  it("a session on a model with no pricing row shows up as unpriced tokens, not a silent zero (I-3)", () => {
    const window = resolvePackPeriod("2026-01", "UTC");
    store.upsertSession({
      sessionId: "s-unpriced-model",
      projectPath: "/w/alpha",
      sourceFile: "/w/alpha/s.jsonl",
      firstTimestamp: window.since + 5_000,
      lastTimestamp: window.since + 6_000,
      claudeVersion: "2.1.70",
      entrypoint: "claude-cli",
      gitBranch: null,
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
      models: ["totally-unrecognized-future-model-9000"],
      repoUrl: null,
      accountUuid: null,
      organizationUuid: null,
      subscriptionType: null,
      thinkingBlocks: 0,
      parentSessionId: null,
      isSubagent: false,
      sourceDeleted: false,
      throttleEvents: 0,
      activeDurationMs: 1000,
      medianResponseTimeMs: 4000,
    });
    store.upsertMessages([
      {
        uuid: "s-unpriced-model-m0",
        sessionId: "s-unpriced-model",
        timestamp: window.since + 5_000,
        claudeVersion: "2.1.70",
        model: "totally-unrecognized-future-model-9000",
        stopReason: "end_turn",
        inputTokens: 900,
        outputTokens: 300,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        tools: [],
        thinkingBlocks: 0,
        serviceTier: null,
        inferenceGeo: null,
        ephemeral5mCacheTokens: 0,
        ephemeral1hCacheTokens: 0,
        promptText: null,
      },
    ]);

    const result = buildJustificationPack(store, config, {
      period: "2026-01",
      timezone: "UTC",
      sections: [...ALL_PACK_SECTIONS],
      now: () => FIXED_NOW,
    });
    expect(result.model.headline.unknownTokens).toBe(1200); // 900 + 300
    expect(result.html).toContain("1,200 tokens from unpriced models");
    expect(result.summaryCsv).toContain(",1200,");

    // A window with no unpriced usage at all must not render the caveat, and
    // must report the count as exactly 0 (never omitted, per BuildHeadlineInput
    // doc — a caller that forgets to wire it should see "0", not a vanished
    // field it can mistake for "handled elsewhere").
    const clean = buildJustificationPack(store, config, { period: "2020-01", timezone: "UTC", now: () => FIXED_NOW });
    expect(clean.model.headline.unknownTokens).toBe(0);
    expect(clean.html).not.toContain("unpriced models");
  });

  // ── I-5: the non-ticket breakdown must carry its own confidence ───────────

  it("the non-ticket breakdown reports the classifier's own confidence per bucket, not a blank column (I-5)", () => {
    const result = buildJustificationPack(store, config, {
      period: "2026-01",
      timezone: "UTC",
      sections: [...ALL_PACK_SECTIONS],
      now: () => FIXED_NOW,
    });
    expect(result.model.nonTicket).not.toBeNull();
    expect(result.model.nonTicket!.length).toBeGreaterThan(0);
    // At least one row was actually classified — proves the classifier
    // confidence made it from `session_task_class` all the way into the pack
    // row, not just the taskClass label.
    expect(result.model.nonTicket!.some((r) => r.confidence !== null)).toBe(true);
    const dataLines = result.nonTicketCsv.trim().split("\r\n").slice(1);
    expect(dataLines.some((line) => !line.endsWith(",n/a"))).toBe(true);
  });
});
