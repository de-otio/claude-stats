/**
 * The `tickets` section — the per-ticket cost table, its coverage header and its
 * session drill-down.
 *
 * The defect this section fixes was not a wrong number; it was a MISSING SURFACE
 * that a view's own label promised. So the first suite here asserts the thing
 * that was actually broken — open "Tickets & Value" and tickets are listed — and
 * would fail again if the section were dropped from the view, or if the view's
 * sections were reordered so the ticket table fell below the project charts.
 *
 * The rest pins the honesty properties the surface has to hold: three distinct
 * empty states (never one), a coverage figure that cannot be separated from the
 * rows it qualifies, a confidence tier on every row, and caps that say what they
 * dropped. Each is a way for a per-ticket table to be quietly WRONG rather than
 * merely ugly, which is why they get tests and the CSS does not.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { renderTicketTable } from "../server/ticketTable.js";
import { renderDashboard, type TranslateFn } from "../server/template.js";
import { NAV_VIEWS, viewForSection } from "../server/nav.js";
import { EVIDENCE_TAB } from "../server/insights.js";
import {
  MAX_TICKET_EVIDENCE_CHARS,
  MAX_TICKET_ROWS,
  MAX_TICKET_SESSIONS,
  type DashboardData,
  type DashboardTicketTable,
} from "../dashboard/index.js";
import { goldenDashboard } from "./fixtures/golden-dashboard.js";
import { visibleText } from "./fixtures/figures.js";
import { initI18n } from "@claude-stats/core/i18n";

// Relative into THIS worktree's own source — a bare specifier resolves out of a
// worktree into the parent repo's node_modules, so a key added here would read
// as missing. Same reasoning as nav.test.ts and domain-views.test.ts.
const require = createRequire(import.meta.url);
const enDashboard = require("../../../core/src/locales/en/dashboard.json") as Record<string, unknown>;

const i18nInstance = await initI18n({
  lng: "en",
  ns: ["dashboard"],
  resources: { en: { dashboard: enDashboard as unknown as object } },
});
const t: TranslateFn = (key, opts) => i18nInstance.t(key, opts as never) as unknown as string;
/** Renders every i18n key as the raw key — proves a string came through t(). */
const rawT: TranslateFn = (key) => key;

function table(over: Partial<DashboardTicketTable> = {}): DashboardTicketTable {
  return {
    coverage: {
      attributedCost: 30,
      totalCost: 100,
      ratio: 0.3,
      byConfidence: { high: 20, medium: 7, low: 3 },
      ambiguousSessions: 0,
    },
    rows: [
      {
        ticketKey: "PROJ-42",
        cost: 20,
        sessionCount: 2,
        confidence: "high",
        sources: ["branch", "commit"],
        sessions: [
          {
            sessionIdShort: "aaaabbbb",
            projectLabel: "acme/api",
            cost: 12,
            source: "branch, commit",
            confidence: "high",
            evidence: "feature/PROJ-42-retry-backoff",
          },
          {
            sessionIdShort: "ccccdddd",
            projectLabel: "acme/api",
            cost: 8,
            source: "commit",
            confidence: "medium",
            evidence: "fix(PROJ-42): cap the retry window",
          },
        ],
        sessionsOmitted: 0,
      },
      {
        ticketKey: "PROJ-7",
        cost: 10,
        sessionCount: 1,
        confidence: "low",
        sources: ["prompt"],
        sessions: [
          {
            sessionIdShort: "eeeeffff",
            projectLabel: "acme/web",
            cost: 10,
            source: "prompt",
            confidence: "low",
            evidence: null,
          },
        ],
        sessionsOmitted: 0,
      },
    ],
    rowsOmitted: 0,
    rowsOmittedCost: 0,
    ...over,
  };
}

// ─── The defect ───────────────────────────────────────────────────────────────

describe("the view named Tickets & Value lists tickets", () => {
  const html = renderDashboard({ ...goldenDashboard, ticketTable: table() }, t);

  it("renders the ticket keys inside the tickets-and-value view", () => {
    // The regression, stated as directly as it can be: the keys are on the page,
    // and they are in a panel this view shows.
    expect(html).toContain('id="tab-tickets" data-view="tickets-and-value"');
    const panel = html.slice(html.indexOf('id="tab-tickets"'), html.indexOf('id="tab-projects"'));
    expect(panel).toContain("PROJ-42");
    expect(panel).toContain("PROJ-7");
  });

  it("puts the ticket table ABOVE the project charts in that view", () => {
    // Order is the whole point: a ticket table below five project charts is what
    // the reader scrolled past and concluded was missing.
    const sections = NAV_VIEWS.find((v) => v.id === "tickets-and-value")!.sections;
    expect(sections[0]).toBe("tickets");
    expect(html.indexOf('id="tab-tickets"')).toBeLessThan(html.indexOf('id="tab-projects"'));
  });

  it("owns the section, so an old #tickets deep link resolves to the view", () => {
    expect(viewForSection("tickets")).toBe("tickets-and-value");
  });

  it("is where the Insights ticket card sends the reader for evidence", () => {
    // Previously "projects" — the one link on the page promising ticket evidence
    // landed on per-project charts, because no ticket surface existed.
    expect(EVIDENCE_TAB["tickets-and-value"]).toBe("tickets");
  });

  it("moves the link/negate card out of Insights and into this section", () => {
    const withCard: DashboardData = {
      ...goldenDashboard,
      ticketTable: table(),
      currentSessionTicket: { sessionId: "0123456789abcdef", links: [] },
    };
    const page = renderDashboard(withCard, t);
    const insights = page.slice(page.indexOf('id="tab-insights"'), page.indexOf('id="tab-overview"'));
    const tickets = page.slice(page.indexOf('id="tab-tickets"'), page.indexOf('id="tab-projects"'));
    expect(insights).not.toContain('id="ticket-attribution-card"');
    expect(tickets).toContain('id="ticket-attribution-card"');
  });
});

// ─── Three empty states, never one ────────────────────────────────────────────

describe("undefined, null and empty are three different answers", () => {
  it("undefined omits the body — the attach never ran, so nothing is known", () => {
    // Rendering an empty state here would tell a user with a full store that no
    // ticket is attributed, on the strength of a caller's missing attach step.
    expect(renderTicketTable(undefined, t)).toBe("");
  });

  it("null says the schema is too old, and how to fix it", () => {
    const html = renderTicketTable(null, t);
    expect(html).toContain('id="ticket-table"');
    expect(visibleText(html)).toContain("claude-stats collect");
  });

  it("an empty table still shows the coverage figure and the enablement path", () => {
    // The state a new user is in. Omitting the section here would hide the one
    // sentence that says what to configure from the only reader who needs it.
    const empty = table({
      rows: [],
      coverage: {
        attributedCost: 0,
        totalCost: 100,
        ratio: 0,
        byConfidence: { high: 0, medium: 0, low: 0 },
        ambiguousSessions: 0,
      },
    });
    const text = visibleText(renderTicketTable(empty, t));
    // `$100`, not `$100.00` — `formatMoney`'s documented magnitude rule drops
    // decimals at ≥100. Asserted as it actually renders, through the SHARED
    // formatter, so this section can never drift into its own money format.
    expect(text).toContain("$0.00 of $100 attributed (0%)");
    // `confidenceCaveat`'s zero-coverage branch — the shared sentence the CLI
    // report and the MCP tool also emit, naming both signals and the config key.
    expect(text).toContain("config.tickets.projectKeys");
    expect(text).toContain("PROJ-123");
  });

  it("says so plainly when the window has no spend at all", () => {
    const noSpend = table({
      rows: [],
      coverage: {
        attributedCost: 0,
        totalCost: 0,
        ratio: null,
        byConfidence: { high: 0, medium: 0, low: 0 },
        ambiguousSessions: 0,
      },
    });
    const text = visibleText(renderTicketTable(noSpend, t));
    expect(text).toContain("nothing to attribute");
    // …and NOT the "check your branch names" enablement copy, which would be
    // advice for a problem this user does not have.
    expect(text).not.toContain("config.tickets.projectKeys");
  });
});

// ─── The honesty properties ───────────────────────────────────────────────────

describe("the table cannot be read as the whole bill", () => {
  it("states coverage above the rows, always", () => {
    const html = renderTicketTable(table(), t);
    expect(visibleText(html)).toContain("$30.00 of $100 attributed (30%)");
    expect(html.indexOf("cs-tt-coverage")).toBeLessThan(html.indexOf("cs-tt-rows"));
  });

  it("carries the confidence mix, so a low-tier total is not read as measured", () => {
    expect(visibleText(renderTicketTable(table(), t))).toContain("confidence");
  });

  it("warns that ambiguous sessions make the rows sum to more than the total", () => {
    // The one place a per-ticket sum legitimately exceeds attributedCost
    // (`aggregateTicketCosts`' documented no-silent-split rule). Unstated, the
    // reader's only conclusion is that one of the two numbers is wrong.
    const text = visibleText(renderTicketTable(table(), t));
    expect(text).toContain("sum to more than the attributed total");
  });

  it("labels every row with its confidence tier", () => {
    const html = renderTicketTable(table(), t);
    // Not merely "a tier appears somewhere": each row carries its own.
    const rows = [...html.matchAll(/data-ticket-row="([^"]+)"[\s\S]*?<\/tr>/g)];
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]).toContain("cs-tt-high");
    expect(rows[1]![0]).toContain("cs-tt-low");
  });
});

describe("no silent caps", () => {
  it("reports omitted tickets AND their cost, not just a row count", () => {
    // A dropped row count alone leaves the reader unable to tell whether the
    // remainder is rounding or a third of the spend.
    const text = visibleText(renderTicketTable(table({ rowsOmitted: 4, rowsOmittedCost: 55.5 }), t));
    expect(text).toContain("4 further tickets not shown ($55.50)");
  });

  it("reports omitted sessions inside a row's drill-down", () => {
    const capped = table();
    const rows = [{ ...capped.rows[0]!, sessionsOmitted: 3 }];
    const text = visibleText(renderTicketTable({ ...capped, rows }, t));
    expect(text).toContain("3 further sessions not shown");
  });

  it("uses the singular form for one", () => {
    const text = visibleText(renderTicketTable(table({ rowsOmitted: 1, rowsOmittedCost: 2 }), t));
    expect(text).toContain("1 further ticket not shown ($2.00)");
  });

  it("says nothing when nothing was dropped", () => {
    expect(visibleText(renderTicketTable(table(), t))).not.toContain("not shown");
  });

  it("keeps the caps to values a forwarded report can carry", () => {
    // These bound what lands in every generated HTML file, including one the
    // user forwards. A later edit is free to change them — but a cap of 10,000
    // rows would silently make the payload unbounded again, which is the thing
    // `DashboardTicketTable` exists to prevent.
    expect(MAX_TICKET_ROWS).toBeLessThanOrEqual(50);
    expect(MAX_TICKET_SESSIONS).toBeLessThanOrEqual(25);
    expect(MAX_TICKET_EVIDENCE_CHARS).toBeLessThanOrEqual(200);
  });
});

// ─── Drill-down ───────────────────────────────────────────────────────────────

describe("ticket → sessions drill-down", () => {
  const html = renderTicketTable(table(), t);

  it("shows each session's project, cost, source and matched evidence", () => {
    const text = visibleText(html);
    expect(text).toContain("aaaabbbb");
    expect(text).toContain("acme/api");
    expect(text).toContain("$12.00");
    expect(text).toContain("feature/PROJ-42-retry-backoff");
  });

  it("needs no JavaScript — a native <details>, so both hosts behave alike", () => {
    // `ticketCard.ts`'s buttons are inert on the served page because only
    // panel.ts wires them. A drill-down built the same way would be unusable
    // for exactly the reader who ran `claude-stats serve`.
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>");
    expect(html).not.toContain("onclick");
  });

  it("names the absent-evidence case instead of rendering a blank cell", () => {
    // A prompt-sourced link stores no evidence text BY DESIGN (see
    // `ExtractedLink.evidence`); an empty cell reads as data that went missing.
    expect(visibleText(html)).toContain("not kept (prompt match)");
  });
});

// ─── Escaping and i18n ────────────────────────────────────────────────────────

describe("hostile input and translation", () => {
  it("escapes a ticket key, a project label and evidence text", () => {
    const evil = table({
      rows: [
        {
          ticketKey: '<img src=x onerror=alert(1)>',
          cost: 1,
          sessionCount: 1,
          confidence: "low",
          sources: ['"><script>'],
          sessions: [
            {
              sessionIdShort: "<b>",
              projectLabel: '"><svg onload=alert(2)>',
              cost: 1,
              source: "prompt",
              confidence: "low",
              evidence: "<script>alert(3)</script>",
            },
          ],
          sessionsOmitted: 0,
        },
      ],
    });
    const html = renderTicketTable(evil, t);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg onload");
    expect(html).not.toContain("<script>alert(3)");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("routes every visible string through t() — no hardcoded English", () => {
    // Rendered with an identity translator: anything the section says must show
    // up as its own i18n key. A literal would survive and read as translated.
    const raw = visibleText(renderTicketTable(table(), rawT));
    for (const key of [
      "dashboard:tickets.title",
      "dashboard:tickets.colTicket",
      "dashboard:tickets.colCost",
      "dashboard:tickets.colEvidence",
      "dashboard:tickets.ambiguityNote",
      "dashboard:tickets.coverage",
    ]) {
      expect(raw, `"${key}" is not rendered through t()`).toContain(key);
    }
  });

  it("has every key it renders, in the shipped locale bundle", () => {
    // The hole nav.test.ts closes for tab labels, closed here for this section:
    // i18next falls back to the raw key silently, so a missing key ships as
    // "dashboard:tickets.colCost" in the table header with every test green.
    const tickets = (enDashboard as { tickets?: Record<string, unknown> }).tickets ?? {};
    for (const key of [
      "title",
      "coverage",
      "noSpend",
      "unavailable",
      "empty",
      "colTicket",
      "colCost",
      "colSessions",
      "colConfidence",
      "colSources",
      "colSession",
      "colProject",
      "colSource",
      "colEvidence",
      "drillDown_one",
      "drillDown_other",
      "noSessions",
      "noEvidence",
      "sessionsOmitted_one",
      "sessionsOmitted_other",
      "rowsOmitted_one",
      "rowsOmitted_other",
      "ambiguityNote",
    ]) {
      expect(tickets, `missing dashboard:tickets.${key}`).toHaveProperty(key);
    }
  });
});
