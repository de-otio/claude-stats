/**
 * Phase-0 foundations: config validation (F2), answer formatters (F6), and the
 * synthetic corpus (F7).
 *
 * The formatter tests matter more than they look. Every insight surface — the
 * dashboard cards, the exported pack, the CLI header — renders these sentences,
 * so a drift here is a drift between the screen a developer showed their
 * manager and the document they handed over. The determinism test is the one
 * that keeps that honest.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  mergeConfig,
  validateTicketsConfig,
  validatePolicyEvents,
  validateRateConfig,
  validatePricingConfig,
  validateReconciliationConfig,
  validateHygieneConfig,
  resolveAccountMode,
  reconciliationTolerance,
  isAllowedTicketKey,
  ticketProjectKeys,
  type Config,
} from "../config.js";
import {
  answerCost,
  answerBought,
  answerEfficiency,
  answerSetup,
  answerChange,
  formatMoney,
  formatPercent,
  formatDevTime,
  trendOf,
  confidenceCaveat,
} from "@claude-stats/core/insight";
import type { TicketCoverage } from "@claude-stats/core/types/insight";
import { parseTicketKey, isTicketKey, matchesProjectAllowlist } from "@claude-stats/core/tickets";
import { buildCorpus, seedStore, FIXED_NOW, seededRandom } from "./fixtures/synthetic.js";
import { estimateCost } from "@claude-stats/core/pricing";
import { Store } from "../store/index.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// ─── F3 / tickets: key validation ────────────────────────────────────────────

describe("ticket key validation", () => {
  it.each(["PROJ-123", "AB-1", "A1B2C3-9999999", "CORE-1"])("accepts %s", (k) => {
    expect(isTicketKey(k)).toBe(true);
  });

  it.each([
    "proj-123", // lowercase — parse normalises, but the raw form is not valid
    "A-1", // single-char prefix matches far too much prose
    "PROJ123", // no separator
    "PROJ-", // no number
    "PROJ-12345678", // 8 digits, over the bound
    "VERYLONGPREFIX-1", // 14-char prefix, over the bound
    "",
  ])("rejects %s", (k) => {
    expect(isTicketKey(k)).toBe(false);
  });

  it("normalises case so one ticket never becomes two rows", () => {
    expect(parseTicketKey("proj-42")).toBe("PROJ-42");
    expect(parseTicketKey("  Proj-42  ")).toBe("PROJ-42");
  });

  it("treats an absent allowlist as 'no filter configured'", () => {
    const key = parseTicketKey("ANY-1")!;
    expect(matchesProjectAllowlist(key)).toBe(true);
    expect(matchesProjectAllowlist(key, [])).toBe(true);
    expect(matchesProjectAllowlist(key, ["PROJ"])).toBe(false);
    expect(matchesProjectAllowlist(key, ["ANY"])).toBe(true);
  });
});

// ─── F2: config validation ───────────────────────────────────────────────────

describe("insight config validation", () => {
  it("keeps only well-formed project keys and upper-cases them", () => {
    const out = validateTicketsConfig({ projectKeys: ["proj", "CORE", "x", "PROJ", 42, "TOOLONGPREFIXX"] });
    expect(out.projectKeys).toEqual(["PROJ", "CORE"]);
  });

  it("drops policy events with an unusable date or kind, and sorts the rest", () => {
    const out = validatePolicyEvents([
      { date: "2026-05-01", kind: "model-removal", detail: "opus" },
      { date: "not-a-date", kind: "model-removal" },
      { date: "2026-02-01", kind: "budget-cap" },
      { date: "2026-06-01", kind: "nonsense" },
      { date: "2026-13-45", kind: "budget-cap" }, // shape ok, not a real date
      "garbage",
    ]);
    expect(out.map((e) => e.date)).toEqual(["2026-02-01", "2026-05-01"]);
    expect(out[1]!.detail).toBe("opus");
  });

  it("rejects a non-positive or absurd hourly rate", () => {
    expect(validateRateConfig({ hourly: 95, currency: "EUR" })).toEqual({ hourly: 95, currency: "EUR" });
    expect(validateRateConfig({ hourly: 0 }).hourly).toBeUndefined();
    expect(validateRateConfig({ hourly: -5 }).hourly).toBeUndefined();
    expect(validateRateConfig({ hourly: 1e9 }).hourly).toBeUndefined();
    expect(validateRateConfig({ currency: "euro" }).currency).toBeUndefined();
  });

  it("keeps only complete partner rate rows", () => {
    const out = validatePricingConfig({
      mode: "metered",
      rates: {
        bedrock: {
          "claude-opus-5": { inputPerMillion: 6, outputPerMillion: 30, cacheReadPerMillion: 0.6, cacheWritePerMillion: 7.5 },
          "claude-bad": { inputPerMillion: 6 }, // incomplete — dropped
        },
        nonsense: { x: {} },
      },
    });
    expect(out.mode).toBe("metered");
    expect(Object.keys(out.rates?.bedrock ?? {})).toEqual(["claude-opus-5"]);
    expect(out.rates).not.toHaveProperty("nonsense");
  });

  it("clamps reconciliation tolerance and defaults it to 5%", () => {
    expect(validateReconciliationConfig({ tolerancePercent: 500 }).tolerancePercent).toBe(100);
    expect(validateReconciliationConfig({ tolerancePercent: -1 }).tolerancePercent).toBe(0);
    expect(reconciliationTolerance({})).toBeCloseTo(0.05);
    expect(reconciliationTolerance({ reconciliation: { tolerancePercent: 2 } })).toBeCloseTo(0.02);
  });

  it("de-duplicates and bounds hygiene suppressions", () => {
    const out = validateHygieneConfig({ suppressions: ["a", "a", "b", 1, ""] });
    expect(out.suppressions).toEqual(["a", "b"]);
  });

  it("merges insight blocks without wiping siblings", () => {
    const current: Config = {
      tickets: { projectKeys: ["PROJ"] },
      rate: { hourly: 90, currency: "EUR" },
      pricing: { mode: "plan" },
    };
    const merged = mergeConfig(current, { rate: { hourly: 100 } });
    expect(merged.rate).toEqual({ hourly: 100, currency: "EUR" });
    expect(merged.tickets?.projectKeys).toEqual(["PROJ"]);
    expect(merged.pricing?.mode).toBe("plan");
  });

  it("replaces the policy timeline wholesale rather than merging arrays", () => {
    const current: Config = { policyEvents: [{ date: "2026-01-01", kind: "budget-cap" }] };
    const merged = mergeConfig(current, { policyEvents: [{ date: "2026-05-01", kind: "model-removal" }] });
    expect(merged.policyEvents).toHaveLength(1);
    expect(merged.policyEvents![0]!.date).toBe("2026-05-01");
  });

  it("never lets an unknown top-level key into config", () => {
    const merged = mergeConfig({}, { evil: true, tickets: { projectKeys: ["PROJ"] } });
    expect(merged).not.toHaveProperty("evil");
    expect(merged.tickets?.projectKeys).toEqual(["PROJ"]);
  });

  it("infers the cost vocabulary from the subscription when unset", () => {
    expect(resolveAccountMode({}, "max_20x")).toBe("plan");
    expect(resolveAccountMode({}, null)).toBe("metered");
    expect(resolveAccountMode({ pricing: { mode: "metered" } }, "max_20x")).toBe("metered");
  });

  it("gates ticket keys on the configured allowlist", () => {
    const cfg: Config = { tickets: { projectKeys: ["PROJ"] } };
    expect(isAllowedTicketKey(cfg, "PROJ-1")).toBe(true);
    expect(isAllowedTicketKey(cfg, "proj-1")).toBe(true);
    expect(isAllowedTicketKey(cfg, "CORE-1")).toBe(false);
    expect(isAllowedTicketKey(cfg, "garbage")).toBe(false);
    expect(isAllowedTicketKey({}, "ANY-1")).toBe(true);
    expect(ticketProjectKeys({})).toBeUndefined();
  });
});

// ─── F6: answer formatters ───────────────────────────────────────────────────

const coverage = (over: Partial<TicketCoverage> = {}): TicketCoverage => ({
  attributedCost: 100,
  totalCost: 125,
  ratio: 0.8,
  byConfidence: { high: 70, medium: 20, low: 10 },
  ambiguousSessions: 0,
  ...over,
});

describe("answer formatters", () => {
  it("formats money, percent and dev-time deterministically", () => {
    expect(formatMoney(41.5)).toBe("$41.50");
    expect(formatMoney(4150)).toBe("$4,150");
    expect(formatMoney(1234.56, "EUR")).toBe("€1,235");
    expect(formatPercent(0.834)).toBe("83%");
    expect(formatPercent(null)).toBe("—");
    expect(formatDevTime(45, 90)).toBe("30 dev-minutes");
    expect(formatDevTime(360, 90)).toBe("4.0 dev-hours");
    expect(formatDevTime(1440, 90)).toBe("2.0 dev-days");
    expect(formatDevTime(100, 0)).toBe("—");
  });

  it("reports trend only when a comparison is possible", () => {
    expect(trendOf(110, 100)).toBe("up");
    expect(trendOf(90, 100)).toBe("down");
    expect(trendOf(100, 100)).toBe("flat");
    expect(trendOf(100, null)).toBe("unknown");
    expect(trendOf(100, 0)).toBe("unknown");
  });

  it("carries the plan-vs-metered vocabulary into Q1's caveat", () => {
    const plan = answerCost({ mode: "plan", cost: 540, previousCost: 500, planFee: 100, planMultiplier: 5.4 });
    expect(plan.answer).toContain("5.4× your $100/mo plan");
    expect(plan.caveat).toContain("not what your plan charges");

    const metered = answerCost({ mode: "metered", cost: 312, previousCost: 280, reconciledRatio: 0.987 });
    expect(metered.answer).toContain("$312");
    expect(metered.caveat).toContain("econciles with the invoice at 99%");
    expect(metered.caveat).not.toContain("not what your plan charges");
  });

  it("warns when partner usage was priced at fallback rates", () => {
    const a = answerCost({ mode: "metered", cost: 100, previousCost: null, anyFallbackRates: true });
    expect(a.caveat).toContain("first-party rates");
  });

  it("adds the salary denominator only when a rate is configured", () => {
    const withRate = answerCost({ mode: "metered", cost: 720, previousCost: null, hourlyRate: 90 });
    expect(withRate.answer).toContain("dev-days");
    const without = answerCost({ mode: "metered", cost: 720, previousCost: null });
    expect(without.answer).not.toContain("dev-");
  });

  it("states an enablement path instead of rendering an empty card", () => {
    const noCost = answerCost({ mode: "metered", cost: 0, previousCost: null });
    expect(noCost.value).toBeNull();
    expect(noCost.unavailable?.reason).toBe("no-data");
    expect(noCost.unavailable?.enablement.length).toBeGreaterThan(0);

    const noTickets = answerBought({ completedTasks: 3, coverage: null, topTicket: null });
    expect(noTickets.unavailable?.reason).toBe("not-enabled");
    expect(noTickets.unavailable?.enablement).toContain("project keys");
  });

  it("never reports coverage without its confidence mix", () => {
    const a = answerBought({
      completedTasks: 41,
      coverage: coverage(),
      topTicket: { key: "PROJ-123", cost: 41 },
    });
    expect(a.answer).toContain("80% of spend attributed");
    expect(a.answer).toContain("PROJ-123");
    expect(a.caveat).toContain("70% high");
    expect(a.caveat).toContain("20% medium");
  });

  it("surfaces ambiguity in the caveat rather than hiding it", () => {
    const c = confidenceCaveat(coverage({ ambiguousSessions: 2 }));
    expect(c).toContain("2 sessions ambiguous");
  });

  // A2/I1: 0% ticket coverage must never render as a bare, unexplained zero —
  // it's the exact "confidently-wrong-looking-absent" case I1 exists to catch
  // (e.g. a team on a lowercase branch convention with no allowlist configured).
  it("gives a diagnostic hint instead of a bare null when there IS spend but NONE of it is attributed", () => {
    const c = confidenceCaveat(coverage({ attributedCost: 0, totalCost: 200, ratio: 0, byConfidence: { high: 0, medium: 0, low: 0 } }));
    expect(c).not.toBeNull();
    expect(c).toContain("config.tickets.projectKeys");
  });

  it("stays null when there is no spend at all (nothing to enable)", () => {
    const c = confidenceCaveat(coverage({ attributedCost: 0, totalCost: 0, ratio: null, byConfidence: { high: 0, medium: 0, low: 0 } }));
    expect(c).toBeNull();
  });

  it("frames a measured policy impact as evidence, not proof", () => {
    const a = answerSetup({
      planVerdict: null,
      recommendedPlan: null,
      projectedSaving: null,
      policyImpact: { date: "2026-05-01", classes: 3, costPerTaskDelta: 0.28 },
    });
    expect(a.answer).toContain("28%");
    expect(a.answer).toContain("3 task classes");
    expect(a.caveat).toContain("Evidence, not proof");
  });

  it("falls back to plan fit when no policy event is configured", () => {
    const a = answerSetup({
      planVerdict: "Your usage fits Max 5x with headroom",
      recommendedPlan: "Max 5x",
      projectedSaving: 80,
    });
    expect(a.answer).toContain("save about $80");
  });

  it("says nothing needs attention rather than inventing a recommendation", () => {
    const a = answerChange({ recommendations: [], doingWell: "Cache hit rate is healthy." });
    expect(a.answer).toBe("Cache hit rate is healthy.");
    expect(a.value).toBeNull();
  });

  it("leads with the top recommendation and counts the rest", () => {
    const a = answerChange({
      recommendations: [
        { title: "Downshift model tier on config chores", impact: "~$40/mo" },
        { title: "Trim context on long sessions" },
      ],
    });
    expect(a.answer).toContain("Downshift model tier");
    expect(a.answer).toContain("~$40/mo");
    expect(a.answer).toContain("+1 more");
  });

  it("handles a missing efficiency frontier honestly", () => {
    const a = answerEfficiency({ recoverableWaste: null, cost: 100 });
    expect(a.unavailable?.reason).toBe("no-data");
  });

  it("is deterministic — identical inputs always render identical output", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 1e6, noNaN: true }),
        fc.constantFrom("plan" as const, "metered" as const),
        (cost, mode) => {
          const once = JSON.stringify(answerCost({ mode, cost, previousCost: null }));
          const twice = JSON.stringify(answerCost({ mode, cost, previousCost: null }));
          expect(once).toBe(twice);
        },
      ),
    );
  });
});

// ─── F7: the synthetic corpus ────────────────────────────────────────────────

describe("synthetic corpus", () => {
  it("is reproducible from its seed", () => {
    const a = buildCorpus({ seed: 7 });
    const b = buildCorpus({ seed: 7 });
    expect(JSON.stringify(a.sessions)).toBe(JSON.stringify(b.sessions));
    expect(a.links).toEqual(b.links);
  });

  it("differs between seeds (so tests aren't accidentally testing one shape)", () => {
    const a = buildCorpus({ seed: 1 });
    const b = buildCorpus({ seed: 2 });
    expect(JSON.stringify(a.links)).not.toBe(JSON.stringify(b.links));
  });

  it("leaves some sessions unattributed so coverage is never trivially 100%", () => {
    const c = buildCorpus({ seed: 42, sessions: 20 });
    expect(c.unattributed.length).toBeGreaterThan(0);
    expect(c.links.length).toBeGreaterThan(0);
    expect(c.links.length + c.unattributed.length).toBe(20);
  });

  it("covers subagents, throttles and mixed model families", () => {
    const c = buildCorpus({ seed: 42, sessions: 20 });
    expect(c.sessions.some((s) => s.isSubagent)).toBe(true);
    expect(c.sessions.some((s) => s.throttleEvents > 0)).toBe(true);
    const models = new Set(c.sessions.flatMap((s) => s.models));
    expect(models.size).toBeGreaterThan(2);
  });

  it("contains no real-world identifiers", () => {
    const c = buildCorpus({ seed: 42 });
    const blob = JSON.stringify(c);
    expect(blob).not.toMatch(/\/Users\//);
    expect(blob).not.toMatch(/@[a-z0-9.-]+\.(com|org|net|de)/i);
  });

  it("uses a frozen origin, never the wall clock", () => {
    const c = buildCorpus({ seed: 42 });
    expect(c.sessions[0]!.firstTimestamp).toBeLessThan(FIXED_NOW);
    const rand = seededRandom(1);
    expect(rand()).toBe(seededRandom(1)());
  });

  it("round-trips through a real store, priced across all model families", () => {
    const dbPath = path.join(os.tmpdir(), `cs-corpus-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
    const store = new Store(dbPath);
    try {
      const corpus = seedStore(store, { seed: 42, sessions: 12 });

      // Every seeded link is retrievable, and the key index agrees with it.
      const keyed = store.getTicketKeys();
      const expectedKeys = new Set(corpus.links.map((l) => l.ticketKey));
      expect(new Set(keyed.map((k) => k.ticket_key))).toEqual(expectedKeys);

      // The corpus prices to a real, non-zero figure — the regression guard for
      // the Bedrock/Vertex ids that used to cost nothing at all.
      const totals = store.getMessageTotals({ includeCI: true, includeDeleted: true });
      const priced = totals.map((t) =>
        estimateCost(t.model, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_creation_tokens),
      );
      expect(priced.length).toBeGreaterThan(0);
      expect(priced.every((p) => p.known)).toBe(true);
      expect(priced.reduce((s, p) => s + p.cost, 0)).toBeGreaterThan(0);

      // Attributed spend is a strict subset of total spend — a corpus that
      // couldn't express a coverage gap couldn't test the honesty rules.
      const attributedSessions = new Set(corpus.links.map((l) => l.sessionId));
      expect(attributedSessions.size).toBeLessThan(corpus.sessions.length);
    } finally {
      store.close();
      try {
        fs.unlinkSync(dbPath);
      } catch {
        /* best effort */
      }
    }
  });
});
