import { describe, it, expect } from "vitest";
import { renderCard, CARD_TOKENS_CSS, CARD_CSS } from "../server/card.js";
import { answerCost, unavailable } from "@claude-stats/core/insight";

describe("renderCard — the shared card primitive", () => {
  it("renders the answer sentence, value, and evidence link for a normal answer", () => {
    const answer = answerCost({ mode: "metered", cost: 12.5, previousCost: 10 });
    const html = renderCard(answer);
    expect(html).toContain("cs-card");
    expect(html).not.toContain("cs-card-unavailable");
    expect(html).toContain("$12.50");
    expect(html).toContain(`data-evidence-link="${answer.evidenceLink}"`);
    expect(html).toContain(answer.answer);
  });

  it("renders a trend glyph when trend is up or down, and none when unknown", () => {
    const up = answerCost({ mode: "metered", cost: 20, previousCost: 10 }); // +100% -> up
    expect(renderCard(up)).toContain("cs-trend-up");

    const down = answerCost({ mode: "metered", cost: 5, previousCost: 10 }); // -50% -> down
    expect(renderCard(down)).toContain("cs-trend-down");

    const unknown = answerCost({ mode: "metered", cost: 5, previousCost: null });
    expect(renderCard(unknown)).not.toContain("cs-trend-up");
    expect(renderCard(unknown)).not.toContain("cs-trend-down");
  });

  it("renders the caveat when present", () => {
    const answer = answerCost({ mode: "plan", cost: 5, previousCost: null });
    const html = renderCard(answer);
    expect(answer.caveat).not.toBeNull();
    expect(html).toContain(answer.caveat!);
  });

  it("renders the honest-unavailable state as a first-class branch, never as an empty widget", () => {
    const answer = unavailable("cost", "No usage recorded for this period.", {
      reason: "no-data",
      enablement: "Run a Claude Code session, then refresh — collection is automatic.",
    });
    const html = renderCard(answer);
    expect(html).toContain("cs-card-unavailable");
    expect(html).toContain("No usage recorded for this period.");
    expect(html).toContain("Run a Claude Code session, then refresh");
    // No headline value, no trend glyph, no evidence link in the unavailable branch.
    expect(html).not.toContain("cs-card-value");
    expect(html).not.toContain("cs-card-evidence");
  });

  it("does not render an empty title block when no title is given", () => {
    const answer = answerCost({ mode: "metered", cost: 1, previousCost: null });
    const html = renderCard(answer);
    expect(html).not.toContain("cs-card-title");
  });

  it("renders a title when given", () => {
    const answer = answerCost({ mode: "metered", cost: 1, previousCost: null });
    const html = renderCard(answer, { title: "Estimated Cost" });
    expect(html).toContain("cs-card-title");
    expect(html).toContain("Estimated Cost");
  });

  it("sets the DOM id when given, for the two-click evidence path", () => {
    const answer = answerCost({ mode: "metered", cost: 1, previousCost: null });
    const html = renderCard(answer, { id: "card-cost" });
    expect(html).toContain('id="card-cost"');
  });

  it("escapes HTML in the answer sentence and caveat", () => {
    const answer = unavailable("cost", "<script>alert(1)</script>", {
      reason: "no-data",
      enablement: "<img src=x onerror=alert(1)>",
    });
    const html = renderCard(answer);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("is pure — identical input renders identical output", () => {
    const answer = answerCost({ mode: "metered", cost: 12.5, previousCost: 10 });
    expect(renderCard(answer)).toBe(renderCard(answer));
  });

  it("token and card CSS reference the same custom property names", () => {
    // A sanity check that the two blocks aren't allowed to drift silently:
    // every --cs-card-* var used in CARD_CSS must be declared in
    // CARD_TOKENS_CSS.
    const declared = new Set([...CARD_TOKENS_CSS.matchAll(/--cs-card-[a-z-]+(?=:)/g)].map((m) => m[0]));
    const used = new Set([...CARD_CSS.matchAll(/var\((--cs-card-[a-z-]+)/g)].map((m) => m[1]));
    for (const name of used) {
      expect(declared.has(name!)).toBe(true);
    }
  });

  it("maps every design token to a --vscode- variable with a fallback, so both hosts render sensibly", () => {
    const lines = CARD_TOKENS_CSS.split("\n").filter((l) => l.includes("--cs-card-"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/var\(--vscode-[a-zA-Z-]+,\s*#?[0-9a-zA-Z]+\)/);
    }
  });
});
