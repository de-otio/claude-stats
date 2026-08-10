import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  displayNameToApiPrefix,
  parsePricingTable,
  loadCachedPricing,
  isCacheStale,
  refreshPricingCache,
  initPricingCache,
} from "../pricing-cache.js";
import { applyPricingCache, lookupPricing, PRICING_VERIFIED_DATE } from "@claude-stats/core/pricing";

/** The shipped verified-date, captured before any test applies a cache over it. */
const ORIGINAL_VERIFIED_DATE = PRICING_VERIFIED_DATE;

/** Restore the built-in rate table — `applyPricingCache` mutates a module global. */
function resetPricingTable(): void {
  applyPricingCache({}, ORIGINAL_VERIFIED_DATE);
}

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(actual.existsSync),
      readFileSync: vi.fn(actual.readFileSync),
      // NEVER default to the actual implementation here: `CACHE_FILE` resolves
      // to the real `~/.claude-stats/pricing.json` (paths.ts has no test-only
      // override for it), and every `refreshPricingCache`/`initPricingCache`
      // test below exercises the write path. A no-op default means a test
      // that forgets to assert on these still cannot touch the real machine.
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

import fs from "node:fs";

/** A minimal pricing-table HTML fixture, reused by the fetch/refresh tests below. */
const REFRESH_HTML = `
  <table>
    <thead>
      <tr><th>Model</th><th>Base Input Tokens</th><th>5m Cache Writes</th><th>1h Cache Writes</th><th>Cache Hits</th><th>Output Tokens</th></tr>
    </thead>
    <tbody>
      <tr><td>Claude Opus 4.6</td><td>$5 / MTok</td><td>$6.25 / MTok</td><td>$10 / MTok</td><td>$0.50 / MTok</td><td>$25 / MTok</td></tr>
    </tbody>
  </table>
`;

function mockFetchOnce(impl: () => Promise<Partial<Response>>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("displayNameToApiPrefix", () => {
  it("converts modern model names (4.x+)", () => {
    expect(displayNameToApiPrefix("Claude Opus 4.6")).toBe("claude-opus-4-6");
    expect(displayNameToApiPrefix("Claude Sonnet 4.6")).toBe("claude-sonnet-4-6");
    expect(displayNameToApiPrefix("Claude Opus 4.5")).toBe("claude-opus-4-5");
    expect(displayNameToApiPrefix("Claude Opus 4.1")).toBe("claude-opus-4-1");
    expect(displayNameToApiPrefix("Claude Opus 4")).toBe("claude-opus-4");
    expect(displayNameToApiPrefix("Claude Haiku 4.5")).toBe("claude-haiku-4-5");
  });

  it("converts legacy model names (3.x)", () => {
    expect(displayNameToApiPrefix("Claude Haiku 3.5")).toBe("claude-3-5-haiku");
    expect(displayNameToApiPrefix("Claude Haiku 3")).toBe("claude-3-haiku");
    expect(displayNameToApiPrefix("Claude Opus 3")).toBe("claude-3-opus");
    expect(displayNameToApiPrefix("Claude Sonnet 3.7")).toBe("claude-3-7-sonnet");
  });

  it("strips (deprecated) annotation", () => {
    expect(displayNameToApiPrefix("Claude Opus 3 (deprecated)")).toBe("claude-3-opus");
    expect(displayNameToApiPrefix("Claude Sonnet 3.7 (deprecated)")).toBe("claude-3-7-sonnet");
  });

  it("handles names without standard format", () => {
    expect(displayNameToApiPrefix("SomeModel")).toBe("somemodel");
  });
});

describe("parsePricingTable", () => {
  const sampleHtml = `
    <table>
      <thead>
        <tr>
          <th>Model</th>
          <th>Base Input Tokens</th>
          <th>5m Cache Writes</th>
          <th>1h Cache Writes</th>
          <th>Cache Hits &amp; Refreshes</th>
          <th>Output Tokens</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Claude Opus 4.6</td>
          <td>$5 / MTok</td>
          <td>$6.25 / MTok</td>
          <td>$10 / MTok</td>
          <td>$0.50 / MTok</td>
          <td>$25 / MTok</td>
        </tr>
        <tr>
          <td>Claude Sonnet 4.6</td>
          <td>$3 / MTok</td>
          <td>$3.75 / MTok</td>
          <td>$6 / MTok</td>
          <td>$0.30 / MTok</td>
          <td>$15 / MTok</td>
        </tr>
        <tr>
          <td>Claude Haiku 3.5</td>
          <td>$0.80 / MTok</td>
          <td>$1 / MTok</td>
          <td>$1.6 / MTok</td>
          <td>$0.08 / MTok</td>
          <td>$4 / MTok</td>
        </tr>
      </tbody>
    </table>
  `;

  it("parses a well-formed pricing table", () => {
    const models = parsePricingTable(sampleHtml);
    expect(Object.keys(models)).toHaveLength(3);

    const opus = models["claude-opus-4-6"];
    expect(opus).toBeDefined();
    expect(opus!.inputPerMillion).toBe(5);
    expect(opus!.outputPerMillion).toBe(25);
    expect(opus!.cacheReadPerMillion).toBe(0.5);
    expect(opus!.cacheWritePerMillion).toBe(6.25);

    const sonnet = models["claude-sonnet-4-6"];
    expect(sonnet).toBeDefined();
    expect(sonnet!.inputPerMillion).toBe(3);

    const haiku = models["claude-3-5-haiku"];
    expect(haiku).toBeDefined();
    expect(haiku!.inputPerMillion).toBe(0.8);
    expect(haiku!.outputPerMillion).toBe(4);
  });

  it("returns empty for HTML without pricing table", () => {
    const models = parsePricingTable("<html><body>No tables here</body></html>");
    expect(Object.keys(models)).toHaveLength(0);
  });

  it("returns empty for tables without matching headers", () => {
    const html = `<table><thead><tr><th>Feature</th><th>Description</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table>`;
    const models = parsePricingTable(html);
    expect(Object.keys(models)).toHaveLength(0);
  });

  it("skips non-pricing tables and finds the right one", () => {
    const html = `
      <table><tr><th>Feature</th><th>Description</th></tr><tr><td>X</td><td>Y</td></tr></table>
      ${sampleHtml}
    `;
    const models = parsePricingTable(html);
    expect(Object.keys(models).length).toBeGreaterThan(0);
  });

  it("handles deprecated model annotations", () => {
    const html = `
      <table>
        <thead>
          <tr><th>Model</th><th>Base Input Tokens</th><th>5m Cache Writes</th><th>Cache Hits</th><th>Output Tokens</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Claude Opus 3 <a href="/deprecated">(deprecated)</a></td>
            <td>$15 / MTok</td>
            <td>$18.75 / MTok</td>
            <td>$1.50 / MTok</td>
            <td>$75 / MTok</td>
          </tr>
        </tbody>
      </table>
    `;
    const models = parsePricingTable(html);
    expect(models["claude-3-opus"]).toBeDefined();
    expect(models["claude-3-opus"]!.inputPerMillion).toBe(15);
  });

  it("falls back to computed cache prices when cache columns are missing", () => {
    const html = `
      <table>
        <thead>
          <tr><th>Model</th><th>Base Input Tokens</th><th>Output Tokens</th></tr>
        </thead>
        <tbody>
          <tr><td>Claude Opus 4.6</td><td>$5 / MTok</td><td>$25 / MTok</td></tr>
        </tbody>
      </table>
    `;
    const models = parsePricingTable(html);
    const opus = models["claude-opus-4-6"];
    expect(opus).toBeDefined();
    expect(opus!.cacheReadPerMillion).toBeCloseTo(0.5);   // 0.1x base input
    expect(opus!.cacheWritePerMillion).toBeCloseTo(6.25);  // 1.25x base input
  });

  it("skips rows with non-Claude model names", () => {
    const html = `
      <table>
        <thead>
          <tr><th>Model</th><th>Base Input Tokens</th><th>Output Tokens</th></tr>
        </thead>
        <tbody>
          <tr><td>GPT-4</td><td>$30 / MTok</td><td>$60 / MTok</td></tr>
          <tr><td>Claude Opus 4.6</td><td>$5 / MTok</td><td>$25 / MTok</td></tr>
        </tbody>
      </table>
    `;
    const models = parsePricingTable(html);
    expect(models["gpt-4"]).toBeUndefined();
    expect(models["claude-opus-4-6"]).toBeDefined();
  });

  // ── TTL columns ────────────────────────────────────────────────────────────
  //
  // The 1-hour rate has to be PARSED, not defaulted: the whole TTL analysis is a
  // comparison between the two write rates, and a guessed premium is not a
  // measurement. These cases pin both the parse and the honest fallback.

  it("parses both cache-write columns and marks the 1h rate as read, not guessed", () => {
    const models = parsePricingTable(sampleHtml);
    const opus = models["claude-opus-4-6"]!;
    expect(opus.cacheWritePerMillion).toBe(6.25);
    expect(opus.cacheWrite1hPerMillion).toBe(10);
    expect(opus.ttlRateBasis).toBe("parsed");

    const haiku = models["claude-3-5-haiku"]!;
    expect(haiku.cacheWritePerMillion).toBe(1);
    expect(haiku.cacheWrite1hPerMillion).toBe(1.6);
  });

  it("matches the write columns by TTL marker, not by position", () => {
    const reversed = `
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Base Input Tokens</th>
            <th>1h Cache Writes</th>
            <th>5m Cache Writes</th>
            <th>Cache Hits &amp; Refreshes</th>
            <th>Output Tokens</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Claude Opus 4.6</td>
            <td>$5 / MTok</td>
            <td>$10 / MTok</td>
            <td>$6.25 / MTok</td>
            <td>$0.50 / MTok</td>
            <td>$25 / MTok</td>
          </tr>
        </tbody>
      </table>
    `;
    const opus = parsePricingTable(reversed)["claude-opus-4-6"]!;
    expect(opus.cacheWritePerMillion).toBe(6.25);
    expect(opus.cacheWrite1hPerMillion).toBe(10);
    expect(opus.ttlRateBasis).toBe("parsed");
  });

  it("synthesizes the 1h rate — and says so — when the page has no 1h column", () => {
    const html = `
      <table>
        <thead>
          <tr><th>Model</th><th>Base Input Tokens</th><th>5m Cache Writes</th><th>Cache Hits</th><th>Output Tokens</th></tr>
        </thead>
        <tbody>
          <tr><td>Claude Opus 4.6</td><td>$5 / MTok</td><td>$6.25 / MTok</td><td>$0.50 / MTok</td><td>$25 / MTok</td></tr>
        </tbody>
      </table>
    `;
    const opus = parsePricingTable(html)["claude-opus-4-6"]!;
    expect(opus.cacheWritePerMillion).toBe(6.25);
    expect(opus.cacheWrite1hPerMillion).toBe(10); // 2× input, the published multiplier
    expect(opus.ttlRateBasis).toBe("synthesized");
  });

  it("refuses an unmarked 'Cache Writes' column rather than guessing which TTL it is", () => {
    // A page that renders only the 1-hour column, headed generically. The old
    // rule claimed the first unclaimed `cache write` header as the 5-minute
    // column, which would silently land $9 in `cacheWritePerMillion` — write
    // premium zero, verdict pinned to "prefer 1h", no error anywhere.
    const html = `
      <table>
        <thead>
          <tr><th>Model</th><th>Base Input Tokens</th><th>Cache Writes</th><th>Output Tokens</th></tr>
        </thead>
        <tbody>
          <tr><td>Claude Opus 4.6</td><td>$5 / MTok</td><td>$9 / MTok</td><td>$25 / MTok</td></tr>
        </tbody>
      </table>
    `;
    const opus = parsePricingTable(html)["claude-opus-4-6"]!;
    expect(opus.cacheWritePerMillion).toBe(6.25); // 1.25× input, not the $9 cell
    expect(opus.cacheWrite1hPerMillion).toBe(10); // 2× input, not the $9 cell
    expect(opus.ttlRateBasis).toBe("synthesized");
  });

  it("degrades to synthesized rates on a ragged row rather than throwing", () => {
    // Header promises six columns; the data row carries four. The optional
    // column reads must not run off the end and lose the whole table.
    const html = `
      <table>
        <thead>
          <tr><th>Model</th><th>Base Input Tokens</th><th>Output Tokens</th><th>5m Cache Writes</th><th>1h Cache Writes</th></tr>
        </thead>
        <tbody>
          <tr><td>Claude Opus 4.6</td><td>$5 / MTok</td><td>$25 / MTok</td></tr>
        </tbody>
      </table>
    `;
    const opus = parsePricingTable(html)["claude-opus-4-6"]!;
    expect(opus.cacheWritePerMillion).toBe(6.25);
    expect(opus.cacheWrite1hPerMillion).toBe(10);
    expect(opus.ttlRateBasis).toBe("synthesized");
  });

  it("skips rows with unparseable dollar amounts", () => {
    const html = `
      <table>
        <thead>
          <tr><th>Model</th><th>Base Input Tokens</th><th>Output Tokens</th></tr>
        </thead>
        <tbody>
          <tr><td>Claude Opus 4.6</td><td>N/A</td><td>$25 / MTok</td></tr>
          <tr><td>Claude Sonnet 4.6</td><td>$3 / MTok</td><td>$15 / MTok</td></tr>
        </tbody>
      </table>
    `;
    const models = parsePricingTable(html);
    expect(models["claude-opus-4-6"]).toBeUndefined();
    expect(models["claude-sonnet-4-6"]).toBeDefined();
  });
});

describe("loadCachedPricing", () => {
  afterEach(() => {
    vi.mocked(fs.existsSync).mockRestore();
    vi.mocked(fs.readFileSync).mockRestore();
    resetPricingTable();
  });

  it("returns false when cache file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadCachedPricing()).toBe(false);
  });

  it("returns true and applies cache when file is valid", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      fetchedAt: "2026-04-01",
      models: { "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.5, cacheWritePerMillion: 6.25 } },
    }));
    expect(loadCachedPricing()).toBe(true);
  });

  it("fills a 1h rate for a cache file written before the field existed", () => {
    // Every user's existing ~/.claude-stats/pricing.json looks exactly like
    // this, and `loadCachedPricing` JSON.parses it unchecked. Left undefined,
    // the field turns every cache write on the model into NaN.
    //
    // The basis must come out `parsed`, NOT `synthesized`: this row agrees with
    // DEFAULT_PRICING on the input rate, so the verified 1-hour rate we already
    // ship applies and is inherited. Asserting `synthesized` here is what the
    // first cut did, and it made `ttlFit`'s D10 guard withhold pricing on every
    // model for every existing user — a permanently `insufficient-data` verdict
    // that no unit test caught and only running the command exposed.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      fetchedAt: "2026-04-01",
      models: { "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.5, cacheWritePerMillion: 6.25 } },
    }));
    expect(loadCachedPricing()).toBe(true);
    const opus = lookupPricing("claude-opus-4-6")!;
    expect(opus.cacheWrite1hPerMillion).toBe(10);
    expect(Number.isFinite(opus.cacheWrite1hPerMillion)).toBe(true);
    expect(opus.ttlRateBasis).toBe("parsed");
  });

  it("returns false when cache data is missing models", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ fetchedAt: "2026-04-01", models: {} }));
    expect(loadCachedPricing()).toBe(false);
  });

  it("returns false when cache data is missing fetchedAt", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ models: { "x": {} } }));
    expect(loadCachedPricing()).toBe(false);
  });

  it("returns false when file read throws", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("EACCES"); });
    expect(loadCachedPricing()).toBe(false);
  });
});

describe("isCacheStale", () => {
  afterEach(() => {
    vi.mocked(fs.existsSync).mockRestore();
    vi.mocked(fs.readFileSync).mockRestore();
  });

  it("returns true when cache file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(isCacheStale()).toBe(true);
  });

  it("returns false when cache is fresh (within 7 days)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ fetchedAt: new Date().toISOString() }));
    expect(isCacheStale()).toBe(false);
  });

  it("returns true when cache is older than 7 days", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ fetchedAt: old }));
    expect(isCacheStale()).toBe(true);
  });

  it("returns true when file read throws", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("EACCES"); });
    expect(isCacheStale()).toBe(true);
  });
});

describe("refreshPricingCache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(fs.mkdirSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    resetPricingTable();
  });

  it("fetches, parses, writes the cache file, and applies the parsed table — on success", async () => {
    mockFetchOnce(async () => ({ ok: true, text: async () => REFRESH_HTML }) as Partial<Response>);

    const ok = await refreshPricingCache();
    expect(ok).toBe(true);

    // The parsed table was actually applied to the live rate table, not just
    // written to disk — a caller relying on `lookupPricing` right after this
    // call must see the fetched rate, not the shipped default.
    const opus = lookupPricing("claude-opus-4-6")!;
    expect(opus.cacheWritePerMillion).toBe(6.25);
    expect(opus.cacheWrite1hPerMillion).toBe(10);
    expect(opus.ttlRateBasis).toBe("parsed");

    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenBody] = vi.mocked(fs.writeFileSync).mock.calls[0]!;
    expect(String(writtenPath)).toContain("pricing.json");
    const written = JSON.parse(writtenBody as string) as { fetchedAt: string; models: Record<string, unknown> };
    expect(written.models["claude-opus-4-6"]).toBeDefined();
    expect(typeof written.fetchedAt).toBe("string");
  });

  it("returns false and does not write when the HTTP response is not ok", async () => {
    // The body is a genuinely parseable pricing table — if the `!resp.ok`
    // check were ever dropped, this would parse successfully and return
    // `true`. An empty body would make this assertion pass for the wrong
    // reason (nothing to parse either way), which is exactly the gap a
    // mutation check caught while writing this test.
    mockFetchOnce(async () => ({ ok: false, status: 503, text: async () => REFRESH_HTML }) as Partial<Response>);

    const ok = await refreshPricingCache();
    expect(ok).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("returns false and does not write when the page yields no parseable models", async () => {
    mockFetchOnce(async () => ({ ok: true, text: async () => "<html><body>nothing here</body></html>" }) as Partial<Response>);

    const ok = await refreshPricingCache();
    expect(ok).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("returns false rather than throwing when the fetch itself rejects (network failure)", async () => {
    mockFetchOnce(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });

    await expect(refreshPricingCache()).resolves.toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("initPricingCache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(fs.existsSync).mockRestore();
    vi.mocked(fs.readFileSync).mockRestore();
    vi.mocked(fs.mkdirSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
    resetPricingTable();
  });

  /** Poll with real timers for the fire-and-forget background refresh to
   *  observably run (or not) — `initPricingCache` deliberately does not await
   *  `refreshPricingCache()`, so a plain `await initPricingCache()` alone
   *  cannot tell the two cases apart. */
  async function flushBackgroundWork(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  it("does not fetch when the cache is fresh", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        models: { "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.5, cacheWritePerMillion: 6.25 } },
      }),
    );
    const fetchMock = mockFetchOnce(async () => ({ ok: true, text: async () => REFRESH_HTML }) as Partial<Response>);

    await initPricingCache();
    await flushBackgroundWork();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the on-disk cache AND fetches a refresh in the background when the cache is stale", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        fetchedAt: old,
        models: { "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25, cacheReadPerMillion: 0.5, cacheWritePerMillion: 6.25 } },
      }),
    );
    const fetchMock = mockFetchOnce(async () => ({ ok: true, text: async () => REFRESH_HTML }) as Partial<Response>);

    await initPricingCache();
    // The on-disk (stale) cache was still loaded synchronously before the
    // background refresh — applied immediately, not left at the shipped default.
    expect(lookupPricing("claude-opus-4-6")!.cacheWritePerMillion).toBe(6.25);

    await flushBackgroundWork();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("swallows a background refresh failure — never rejects, never throws", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false); // no on-disk cache ⇒ stale
    mockFetchOnce(async () => {
      throw new Error("network down");
    });

    await expect(initPricingCache()).resolves.toBeUndefined();
    await flushBackgroundWork(); // the rejected background promise must not surface as an unhandled rejection
  });
});
