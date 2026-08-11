import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectLocaleFromEnv, normalizeLocale, SUPPORTED_LOCALES } from "@claude-stats/core/i18n";
import { initCliI18n, t } from "../i18n.js";

describe("detectLocaleFromEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns 'en' when no locale env vars are set", () => {
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    delete process.env.LANG;
    expect(detectLocaleFromEnv()).toBe("en");
  });

  it("detects locale from LANG", () => {
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    process.env.LANG = "de_DE.UTF-8";
    expect(detectLocaleFromEnv()).toBe("de");
  });

  it("prefers LC_ALL over LANG", () => {
    process.env.LC_ALL = "fr_FR.UTF-8";
    process.env.LANG = "en_US.UTF-8";
    expect(detectLocaleFromEnv()).toBe("fr");
  });

  it("handles LANG=C (no match) by returning 'en'", () => {
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    process.env.LANG = "C";
    // "C" doesn't match /^([a-z]{2})/i so it falls through to "en"
    expect(detectLocaleFromEnv()).toBe("en");
  });

  it("handles empty LANG by returning 'en'", () => {
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    process.env.LANG = "";
    expect(detectLocaleFromEnv()).toBe("en");
  });

  // Regression: these two used to resolve to "en". The primary subtag was all
  // that was read, and "pt"/"zh" are not bundle codes, so the two regional
  // languages that DO ship were the two a user could not get from the
  // environment. See `normalizeLocale`.
  it.each([
    ["pt_BR.UTF-8", "pt-BR"],
    ["zh_CN.UTF-8", "zh-CN"],
  ])("resolves the regional locale %s to %s, not 'en'", (lang, expected) => {
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    process.env.LANG = lang;
    expect(detectLocaleFromEnv()).toBe(expected);
  });
});

describe("normalizeLocale", () => {
  it.each([
    // Exact regional match, both separators and any casing.
    ["pt_BR", "pt-BR"],
    ["pt-br", "pt-BR"],
    ["PT-BR", "pt-BR"],
    ["zh_CN.UTF-8", "zh-CN"],
    ["zh-cn", "zh-CN"],
    // Primary subtag.
    ["de_DE.UTF-8", "de"],
    ["en_US.UTF-8", "en"],
    ["ja", "ja"],
    ["uk_UA.UTF-8", "uk"],
    // Sole regional variant of a primary subtag with no exact bundle.
    ["pt", "pt-BR"],
    ["pt_PT", "pt-BR"],
    ["zh", "zh-CN"],
    ["zh_TW", "zh-CN"],
    // POSIX modifier suffix is stripped alongside the charset.
    ["de_DE@euro", "de"],
    // Unsupported and degenerate inputs.
    ["C", "en"],
    ["POSIX", "en"],
    ["", "en"],
    ["it_IT.UTF-8", "en"],
    ["klingon", "en"],
  ])("normalizes %s to %s", (raw, expected) => {
    expect(normalizeLocale(raw)).toBe(expected);
  });

  it("returns a bundled code for every supported locale, unchanged", () => {
    // Guards the round trip: every code we claim to support must normalize to
    // itself, so SUPPORTED_LOCALES can never list a code the resolver rejects.
    for (const locale of SUPPORTED_LOCALES) {
      expect(normalizeLocale(locale)).toBe(locale);
    }
  });
});

describe("CLI i18n renders each supported locale (not fallback to en)", () => {
  // Restore the global CLI i18n to "en" so tests run after this suite
  // (which rely on setup.ts's initCliI18n("en")) don't see another locale.
  afterAll(async () => {
    await initCliI18n("en");
  });

  // The canonical en value for the probe key. If a locale silently falls back
  // to en (e.g. because initI18n() dropped it from the resources object),
  // t() returns this string and the assertion below trips.
  const EN_PROBE = "Collect and analyse Claude Code usage statistics";

  // Every locale directory under packages/core/src/locales/ — any locale we
  // ship must actually render its own translations, not silently fall back.
  const LOCALES = ["de", "ja", "zh-CN", "fr", "es", "pt-BR", "pl", "uk", "ru"];

  it.each(LOCALES)("locale %s renders its own translation for commands.programDescription", async (locale) => {
    await initCliI18n(locale);
    const value = t("commands.programDescription");
    expect(value).not.toBe(EN_PROBE);
    expect(value.length).toBeGreaterThan(0);
  });

  it("en renders the canonical English string", async () => {
    await initCliI18n("en");
    expect(t("commands.programDescription")).toBe(EN_PROBE);
  });
});

describe("the CLI keeps stdout free of non-payload output", () => {
  // i18next >= 26 prints a Locize promo banner through console.info on init,
  // and console.info writes to STDOUT. For this CLI stdout is a protocol
  // channel: `dashboard` and `export` emit JSON/CSV on it and `mcp` speaks
  // JSON-RPC over it, so one stray line makes the output unparseable. That
  // regression shipped once — `claude-stats dashboard` emitted invalid JSON —
  // and this guards `showSupportNotice: false` in core's initI18n.
  //
  // It has to run the real binary in a child process. i18next latches the
  // banner behind a module-global set on first init, and setup.ts initializes
  // i18n before any test body runs; vi.resetModules() does not clear it,
  // because i18next is cached by Node outside vitest's registry. An
  // in-process spy therefore can never observe the banner and would pass
  // whether or not the fix is present.
  const CLI = path.resolve(__dirname, "../../dist/index.js");

  // An empty HOME keeps this independent of whatever the developer has
  // collected locally, and keeps the suite from reading real usage data.
  const run = (...args: string[]) => {
    const home = mkdtempSync(path.join(tmpdir(), "cs-stdout-"));
    try {
      return spawnSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
        timeout: 120_000,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  it("prints only the version on `--version`", () => {
    expect(existsSync(CLI)).toBe(true);
    const res = run("--version");
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^\d+\.\d+\.\d+\s*$/);
    expect(res.stdout.toLowerCase()).not.toContain("locize");
  });

  it("emits parseable JSON on `dashboard`", () => {
    expect(existsSync(CLI)).toBe(true);
    const res = run("dashboard");
    expect(res.status).toBe(0);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });
});
