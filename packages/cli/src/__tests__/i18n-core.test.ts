import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { detectLocaleFromEnv } from "@claude-stats/core/i18n";
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
