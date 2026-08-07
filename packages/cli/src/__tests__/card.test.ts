import { describe, it, expect } from "vitest";
import { renderCard, CARD_TOKENS_CSS, CARD_CSS } from "../server/card.js";
import { answerCost, unavailable } from "@claude-stats/core/insight";

describe("renderCard — the shared card primitive", () => {
  it("renders the answer sentence, value, and evidence link for a normal answer", () => {
    const answer = answerCost({ mode: "metered", cost: 12.5, previousCost: 10 });
    const html = renderCard(answer);
    expect(html).toContain("cs-card");
    expect(html).not.toContain("cs-card-unavailable");
    // The answer SENTENCE also embeds "$12.50", so a bare
    // `toContain("$12.50")` passes even when the headline value element is
    // deleted entirely (verified by mutation). Assert the value element.
    expect(html).toMatch(/<div class="cs-card-value">[\s\S]*?<span>\$12\.50<\/span>/);
    expect(html).toContain(`data-evidence-link="${answer.evidenceLink}"`);
    expect(html).toContain(answer.answer);
  });

  it("renders a trend glyph when trend is up or down, and none when unknown", () => {
    const up = answerCost({ mode: "metered", cost: 20, previousCost: 10 }); // +100% -> up
    expect(renderCard(up)).toContain("cs-trend-up");

    const down = answerCost({ mode: "metered", cost: 5, previousCost: 10 }); // -50% -> down
    expect(renderCard(down)).toContain("cs-trend-down");

    // Boundary: within trendOf's ±2% epsilon is "flat" — its own glyph and
    // class, not a silent fall-through to the no-glyph "unknown" rendering.
    const flat = answerCost({ mode: "metered", cost: 10.1, previousCost: 10 });
    expect(flat.trend).toBe("flat");
    expect(renderCard(flat)).toContain("cs-trend-flat");
    expect(renderCard(flat)).toContain("—");

    const unknown = answerCost({ mode: "metered", cost: 5, previousCost: null });
    expect(unknown.trend).toBe("unknown");
    expect(renderCard(unknown)).not.toContain("cs-trend-up");
    expect(renderCard(unknown)).not.toContain("cs-trend-down");
    // "unknown" must render NO glyph at all — not a flat dash standing in for
    // a comparison that was never made.
    expect(renderCard(unknown)).not.toContain("cs-trend-flat");
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

  it("escapes every caller-supplied field that lands in an attribute", () => {
    // The unavailable-branch test above never exercises the caveat, value,
    // evidence-link or title paths at all — and `title`/`evidenceLink` are
    // interpolated into quoted ATTRIBUTES, where an unescaped `"` breaks out
    // of the attribute rather than merely rendering a stray tag.
    const answer = {
      question: "cost" as const,
      answer: 'a"b',
      value: '<b>1</b>',
      trend: "up" as const,
      caveat: '<i>c</i>',
      evidenceLink: 'x" onmouseover="alert(1)',
    };
    const html = renderCard(answer, { title: 'T" onclick="alert(1)', id: 'i" onfocus="alert(1)' });
    // The payloads must survive whole INSIDE their attribute — i.e. the
    // caller's `"` became `&quot;` and never terminated the attribute early.
    // (`onfocus=` still appears as inert text within the quoted value; that is
    // correct, so don't assert on the substring.)
    expect(html).toContain('id="i&quot; onfocus=&quot;alert(1)"');
    expect(html).toContain('data-evidence-link="x&quot; onmouseover=&quot;alert(1)"');
    expect(html).toContain('href="#x&quot; onmouseover=&quot;alert(1)"');
    // No attribute-delimiting quote is ever contributed by caller data.
    expect(html.match(/\bid="/g)?.length).toBe(1);
    expect(html).toContain("&lt;b&gt;1&lt;/b&gt;");
    expect(html).toContain("&lt;i&gt;c&lt;/i&gt;");
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
    // Without these guards the loop below is vacuously green whenever the
    // regexes stop matching — the exact way a drift check silently dies.
    expect(declared.size).toBeGreaterThan(0);
    expect(used.size).toBeGreaterThan(0);
    // Every `var(--cs-card-*)` in CARD_CSS must resolve, and the count must
    // match what a naive scan finds, so a token name outside the `[a-z-]`
    // character class can't slip past the regex unnoticed.
    expect(used.size).toBe(new Set([...CARD_CSS.matchAll(/var\((--[^,)]+)/g)].map((m) => m[1])).size);
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
