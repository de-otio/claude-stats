import { describe, it, expect, vi, afterEach } from "vitest";
import { detectLocaleFromEnv } from "@claude-stats/core/i18n";

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
