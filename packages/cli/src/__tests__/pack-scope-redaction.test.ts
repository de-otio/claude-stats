/**
 * The pack's scope line and CSV columns must not carry a raw local path.
 *
 * Found while auditing the privacy amendment: a pack generated with
 * `--project` embedded the absolute filesystem path in its scope line AND as a
 * column on every row of tickets.csv and summary.csv. The pack is the one
 * artifact this tool builds specifically to be handed to someone outside the
 * machine, and an absolute path routinely names an employer, a client, or an
 * unreleased product in a parent directory.
 *
 * The reader still needs to know the pack WAS scoped - a one-project total and
 * a whole-machine total must never read alike - so the fact survives and only
 * the value is withheld, behind an explicit `--disclose-scope` opt-in.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { TicketCoverage } from "@claude-stats/core/types/insight";
import {
  buildJustificationPackModel,
  renderJustificationPackHtml,
  renderTicketsCsv,
  renderSummaryCsv,
  setDiscloseScopeValues,
} from "@claude-stats/core/pack";

// Shaped like the real hazard: a client name in a parent directory.
const SENSITIVE_PATH = "/Users/someone/repos/northwind-consulting/orders-rewrite";
const SENSITIVE_ACCOUNT = "11111111-2222-3333-4444-555555555555";
const CLIENT_SEGMENT = "northwind-consulting";

const t = ((key: string) => key) as never;

const COVERAGE: TicketCoverage = {
  attributedCost: 60,
  totalCost: 100,
  ratio: 0.6,
  byConfidence: { high: 40, medium: 20, low: 0 },
  ambiguousSessions: 0,
};

function modelScopedTo(projectPath: string | null, accountUuid: string | null = null) {
  return buildJustificationPackModel(t, {
    generatedAt: 0,
    period: { since: 0, until: 1, label: "2026-01" },
    scope: { projectPath, accountUuid },
    sections: ["headline", "tickets", "nonticket"],
    headline: { mode: "metered" as const, currency: "USD", coverage: COVERAGE },
    tickets: [{ ticketKey: "PROJ-1", cost: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, sessionCount: 1, confidence: "high" }],
    nonTicketByClass: new Map([["debug", { cost: 1, sessionCount: 1 }]]),
    methodology: { pricingVerifiedDate: "2026-07-03", taskClassVersion: 2, languageMode: "metered" as const, policyEvents: [] },
  });
}

afterEach(() => {
  setDiscloseScopeValues(false);
});

describe("pack scope redaction", () => {
  it("keeps the raw project path and account uuid out of the HTML by default", () => {
    const html = renderJustificationPackHtml(modelScopedTo(SENSITIVE_PATH, SENSITIVE_ACCOUNT));
    expect(html).not.toContain(SENSITIVE_PATH);
    expect(html).not.toContain(CLIENT_SEGMENT);
    expect(html).not.toContain(SENSITIVE_ACCOUNT);
    // The FACT of scoping must survive - otherwise a filtered pack reads as a
    // whole-machine one, which is the opposite failure.
    expect(html).toContain("withheld:");
  });

  it("keeps them out of every CSV row, not just the scope line", () => {
    const model = modelScopedTo(SENSITIVE_PATH, SENSITIVE_ACCOUNT);
    for (const csv of [renderTicketsCsv(model), renderSummaryCsv(model)]) {
      expect(csv).not.toContain(SENSITIVE_PATH);
      expect(csv).not.toContain(CLIENT_SEGMENT);
      expect(csv).not.toContain(SENSITIVE_ACCOUNT);
    }
  });

  it("discloses the literal values only when explicitly asked", () => {
    setDiscloseScopeValues(true);
    expect(renderJustificationPackHtml(modelScopedTo(SENSITIVE_PATH))).toContain(SENSITIVE_PATH);
    expect(renderTicketsCsv(modelScopedTo(SENSITIVE_PATH))).toContain(SENSITIVE_PATH);
  });

  it("says plainly that a pack is unscoped rather than omitting the line", () => {
    const html = renderJustificationPackHtml(modelScopedTo(null, null));
    expect(html).toContain("unscoped");
    expect(html).not.toContain("withheld:");
  });

  it("gives the same marker for the same scope, so a series stays comparable", () => {
    expect(renderJustificationPackHtml(modelScopedTo(SENSITIVE_PATH)))
      .toEqual(renderJustificationPackHtml(modelScopedTo(SENSITIVE_PATH)));
  });

  it("gives different markers to different scopes, so two packs stay distinguishable", () => {
    const marker = (s: string) => s.match(/withheld:([0-9a-f]{8})/)?.[1];
    const one = marker(renderJustificationPackHtml(modelScopedTo(SENSITIVE_PATH)));
    const other = marker(renderJustificationPackHtml(modelScopedTo("/Users/someone/repos/other-client/thing")));
    expect(one).toBeDefined();
    expect(one).not.toEqual(other);
  });
});
