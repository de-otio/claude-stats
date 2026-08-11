/**
 * Setting `tickets.projectKeys` from the GUI.
 *
 * The allowlist decides whether an attribution can reach `high` confidence at
 * all, and before this field the only way to set it was hand-editing
 * `~/.claude-stats/config.json` — so a reader of the ticket table saw mostly
 * `low` rows and had no route from the symptom to the fix.
 *
 * Two properties are worth more than the markup here, and get the tests:
 *
 *  1. **The client's parse and the server's validator agree.** The field is free
 *     text; the server (`validateTicketsConfig`) is the only validator. If the
 *     client's tokenizer split differently from what the server accepts, the UI
 *     would either lose keys the user typed or report rejections that never
 *     happened. So the parse is EXTRACTED from the rendered page and run against
 *     the real `mergeConfig`.
 *  2. **A refused key is reported, not swallowed.** The validator drops invalid
 *     entries silently — correct for an unattended write path, unacceptable for a
 *     form. The note is computed from the SAVED config in the response, which is
 *     the only source that cannot disagree with what was stored.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { renderDashboard, type TranslateFn } from "../server/template.js";
import { renderTicketTable } from "../server/ticketTable.js";
import { viewForSection } from "../server/nav.js";
import { mergeConfig, ticketProjectKeys, type Config } from "../config.js";
import type { DashboardTicketRow, DashboardTicketTable } from "../dashboard/index.js";
import { goldenDashboard } from "./fixtures/golden-dashboard.js";
import { visibleText } from "./fixtures/figures.js";
import { initI18n } from "@claude-stats/core/i18n";

// Relative into THIS worktree's own source — see ticket-table.test.ts.
const require = createRequire(import.meta.url);
const enDashboard = require("../../../core/src/locales/en/dashboard.json") as Record<string, unknown>;

const i18nInstance = await initI18n({
  lng: "en",
  ns: ["dashboard"],
  resources: { en: { dashboard: enDashboard as unknown as object } },
});
const t: TranslateFn = (key, opts) => i18nInstance.t(key, opts as never) as unknown as string;
const rawT: TranslateFn = (key) => key;

const html = renderDashboard(goldenDashboard, t);

// ─── The client-side helpers, extracted from the page and run ────────────────
//
// Source-pinning these would be theatre: a tokenizer that split on every
// non-alphanumeric run leaves every plausible substring of the page intact while
// changing what gets saved.
function grab(re: RegExp): string {
  const m = html.match(re);
  expect(m, `could not extract ${re}`).not.toBeNull();
  return m![0];
}

const parseTicketKeys = new Function(
  `${grab(/function parseTicketKeys\(raw\) \{[\s\S]*?\n      \}/)}\nreturn parseTicketKeys;`,
)() as (raw: unknown) => string[];

const rejectedTicketKeys = new Function(
  `${grab(/function rejectedTicketKeys\(sent, savedConfig\) \{[\s\S]*?\n      \}/)}\nreturn rejectedTicketKeys;`,
)() as (sent: string[], saved: unknown) => string[];

/** The field-population helper, run against a one-element DOM stub. */
function fieldValueFor(cfg: unknown): string {
  const stub = { value: "untouched" };
  const fn = new Function(
    "document",
    `${grab(/function setTicketKeysField\(cfg\) \{[\s\S]*?\n      \}/)}\nreturn setTicketKeysField;`,
  )({ getElementById: () => stub }) as (cfg: unknown) => void;
  fn(cfg);
  return stub.value;
}

describe("the settings form carries the ticket project keys", () => {
  it("renders the input, its two hints and the rejection slot", () => {
    expect(html).toContain('id="cfg-ticket-keys"');
    expect(html).toContain('id="cfg-ticket-keys-note"');
    // Inside the settings form, not floating elsewhere on the page.
    const form = html.slice(html.indexOf('id="settings-form"'), html.indexOf('id="settings-status"'));
    expect(form).toContain('id="cfg-ticket-keys"');
    expect(form).toContain('for="cfg-ticket-keys"');
    // The label reaches the reader…
    expect(visibleText(html)).toContain("Ticket project keys");
    // …and so does the consequence of leaving it empty, which is the whole
    // reason the field is worth having.
    expect(visibleText(html)).toContain("caps at medium confidence");
  });

  it("states that the setting is not retroactive, and names the way to make it so", () => {
    // A user who sets keys and sees the same low-confidence rows would report
    // this as a second bug. Extraction runs at collect time and only ADDS links,
    // so the form has to say both halves: future sessions, and the route that
    // applies the keys to everything already stored.
    const text = visibleText(html);
    expect(text).toContain("collected from now on");
    expect(text).toContain("Re-extract");
    expect(text).toContain("repair ticket-links");
  });

  it("offers re-extraction, hidden until a host that can write is confirmed", () => {
    expect(html).toContain('id="reextract-block"');
    expect(html).toContain('id="reextract-preview"');
    expect(html).toContain('id="reextract-run"');
    // Hidden in the markup: a `report --html` file opened from disk never runs
    // the reveal, so the buttons never appear where they could only fail.
    const block = html.slice(html.indexOf('id="reextract-block"'), html.indexOf('id="reextract-result"'));
    expect(block).toContain("display:none");
    expect(html).toContain("window.location.protocol === 'http:'");
    // Both transports are wired, so the webview and the served page agree.
    expect(html).toContain("'/api/tickets/reextract'");
    expect(html).toContain("command: 'reextractTickets'");
    // Preview must ask for a dry run, and the real button must not.
    expect(html).toContain("runReextract(true)");
    expect(html).toContain("runReextract(false)");
  });

  it("refuses to re-extract while the typed keys differ from the saved ones", () => {
    // The trap this closes: re-extraction reads the SAVED allowlist, so typing
    // keys and pressing Re-extract without pressing Save would rebuild every
    // link under the OLD list and then report a confident summary of a run the
    // user did not ask for. Both halves are asserted — the comparison against
    // the saved value, and that it happens BEFORE the request goes out.
    const fn = grab(/function runReextract\(dryRun\) \{[\s\S]*?\n      \}/);
    expect(fn).toContain("savedTicketKeys.join(',')");
    expect(fn).toContain("RX.unsaved");
    expect(fn.indexOf("RX.unsaved")).toBeLessThan(fn.indexOf("reextractAsync"));
    // The saved value is only ever set from the config — the load and the save
    // response — never from what is in the input.
    const setter = grab(/function setTicketKeysField\(cfg\) \{[\s\S]*?\n      \}/);
    expect(setter).toContain("savedTicketKeys = keys.slice()");
    // …and the order is stated up front, not only after the mistake.
    expect(visibleText(html)).toContain("press Save first");
  });

  it("promises what re-extraction keeps, on the screen that triggers it", () => {
    // The destructive half is stated where the button is, not only in the docs.
    const text = visibleText(html);
    expect(text).toContain("manual links and negations are kept");
    expect(text).toContain("backed up");
  });

  it("sends tickets.projectKeys on every save, so the field can be cleared", () => {
    // Guarding the empty case with `if (ticketKeys.length)` would make the field
    // one-way: prefixes could be added but the last one never removed.
    expect(html).toContain("config.tickets = { projectKeys: ticketKeys };");
    expect(html).not.toMatch(/if \(ticketKeys\.length\)[^\n]*config\.tickets/);
  });

  it("renders every one of its strings through t()", () => {
    const raw = renderDashboard(goldenDashboard, rawT);
    for (const key of [
      "dashboard:settings.ticketKeys",
      "dashboard:settings.ticketKeysPlaceholder",
      "dashboard:settings.ticketKeysHint",
      "dashboard:settings.ticketKeysRetroHint",
      "dashboard:settings.ticketKeysRejected",
      "dashboard:settings.reextract.title",
      "dashboard:settings.reextract.intro",
      "dashboard:settings.reextract.preview",
      "dashboard:settings.reextract.run",
      "dashboard:settings.reextract.working",
      "dashboard:settings.reextract.previewHeader",
      "dashboard:settings.reextract.doneHeader",
      "dashboard:settings.reextract.sessions",
      "dashboard:settings.reextract.removed",
      "dashboard:settings.reextract.created",
      "dashboard:settings.reextract.manual",
      "dashboard:settings.reextract.keys",
      "dashboard:settings.reextract.failed",
      "dashboard:settings.reextract.unsaved",
    ]) {
      expect(raw, `${key} is not rendered through t()`).toContain(key);
      // …and the key resolves in the shipped bundle, so no host shows the key.
      expect(t(key), `${key} missing from the en bundle`).not.toBe(key);
    }
  });
});

describe("what the field parses is what the server stores", () => {
  /** The real write path: parse as the browser does, merge as the server does. */
  function save(raw: string, current: Config = {}): Config {
    return mergeConfig(current, { tickets: { projectKeys: parseTicketKeys(raw) } });
  }

  it("accepts the separators a human actually types", () => {
    for (const raw of ["PROJ, OPS", "PROJ OPS", "PROJ,OPS", "PROJ;OPS", "PROJ\nOPS", " PROJ ,  OPS "]) {
      expect(save(raw).tickets?.projectKeys, `separator case: ${JSON.stringify(raw)}`).toEqual(["PROJ", "OPS"]);
    }
  });

  it("upper-cases and de-duplicates, and the field shows the stored form", () => {
    const saved = save("proj, Proj, OPS");
    expect(saved.tickets?.projectKeys).toEqual(["PROJ", "OPS"]);
    // The input is repopulated from the response, so the reader sees the keys
    // that are in effect rather than the casing they happened to type.
    expect(fieldValueFor(saved)).toBe("PROJ, OPS");
  });

  it("keeps a full issue id as one token, so the rejection names what was typed", () => {
    // Splitting inside 'PROJ-123' would save PROJ and then report a bare '123'
    // the reader never typed — a message about a string they cannot find.
    expect(parseTicketKeys("PROJ-123")).toEqual(["PROJ-123"]);
    const saved = save("PROJ-123, OPS");
    expect(saved.tickets?.projectKeys).toEqual(["OPS"]);
    expect(rejectedTicketKeys(parseTicketKeys("PROJ-123, OPS"), saved)).toEqual(["PROJ-123"]);
  });

  it("reports every refused entry, and nothing when all were kept", () => {
    const sent = parseTicketKeys("ok, toolongtobeakey, 1bad, OPS");
    const saved = save("ok, toolongtobeakey, 1bad, OPS");
    expect(saved.tickets?.projectKeys).toEqual(["OK", "OPS"]);
    // Both refusals are named — the over-long one and the digit-initial one.
    expect(rejectedTicketKeys(sent, saved)).toEqual(["TOOLONGTOBEAKEY", "1BAD"]);
    expect(rejectedTicketKeys(parseTicketKeys("PROJ, OPS"), save("PROJ, OPS"))).toEqual([]);
  });

  it("an emptied field clears the allowlist rather than keeping the old keys", () => {
    const configured = save("PROJ, OPS");
    expect(ticketProjectKeys(configured)).toEqual(["PROJ", "OPS"]);
    const cleared = save("", configured);
    // Empty is a real, documented mode (extraction runs, capped at medium) —
    // `ticketProjectKeys` reports "none configured" for it, which is what the
    // extraction path reads.
    expect(cleared.tickets?.projectKeys).toEqual([]);
    expect(ticketProjectKeys(cleared)).toBeUndefined();
    expect(fieldValueFor(cleared)).toBe("");
  });

  it("leaves an absent config alone rather than inventing an empty field", () => {
    // `undefined` config or a config with no tickets block: the field renders
    // empty, and no rejection is claimed.
    expect(fieldValueFor(undefined)).toBe("");
    expect(fieldValueFor({})).toBe("");
    expect(rejectedTicketKeys([], undefined)).toEqual([]);
  });
});

describe("the ticket table points at the setting", () => {
  function row(over: Partial<DashboardTicketRow> = {}): DashboardTicketRow {
    return {
      ticketKey: "PROJ-42",
      cost: 10,
      sessionCount: 1,
      confidence: "high",
      sources: ["branch"],
      sessions: [],
      sessionsOmitted: 0,
      ...over,
    };
  }
  function table(rows: DashboardTicketRow[]): DashboardTicketTable {
    return {
      coverage: {
        attributedCost: 10,
        totalCost: 100,
        ratio: 0.1,
        byConfidence: { high: 10, medium: 0, low: 0 },
        ambiguousSessions: 0,
      },
      rows,
      rowsOmitted: 0,
      rowsOmittedCost: 0,
    };
  }

  it("offers the hint exactly when the allowlist would change the answer", () => {
    // A low-confidence row IS the symptom the setting fixes.
    expect(renderTicketTable(table([row({ confidence: "low" })]), t)).toContain('href="#settings"');
    expect(renderTicketTable(table([row({ confidence: "medium" })]), t)).toContain('href="#settings"');
    // Nothing attributed yet — the state where being told what to configure is
    // worth the most.
    expect(renderTicketTable(table([]), t)).toContain('href="#settings"');
    // Every row already `high`: the allowlist is demonstrably doing its job, so
    // the advice would be furniture.
    expect(renderTicketTable(table([row()]), t)).not.toContain('href="#settings"');
  });

  it("the hint's anchor lands on the settings surface", () => {
    // '#settings' resolves through the section→view map the template embeds, so
    // this is a working link in the served page and the webview alike.
    expect(viewForSection("settings")).toBe("settings");
    expect(html).toContain("function resolveHashTarget(target)");
  });

  it("renders the hint through t(), and both keys resolve", () => {
    const raw = renderTicketTable(table([]), rawT);
    expect(raw).toContain("dashboard:tickets.tuneHint");
    expect(raw).toContain("dashboard:tickets.tuneHintLink");
    expect(t("dashboard:tickets.tuneHint")).not.toBe("dashboard:tickets.tuneHint");
    expect(t("dashboard:tickets.tuneHintLink")).not.toBe("dashboard:tickets.tuneHintLink");
  });
});
