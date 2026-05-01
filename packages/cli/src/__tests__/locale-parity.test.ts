/**
 * Tests for scripts/check-locale-parity.mjs.
 *
 * The script is executed against the real repo in CI (`npm run locales:check`);
 * here we exercise its `runCheck()` function against synthetic fixtures to
 * confirm it detects the three classes of drift it's meant to catch.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — script is plain ESM, no type declarations needed for test use
import { runCheck } from "../../../../scripts/check-locale-parity.mjs";

describe("locale parity check", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-stats-locale-parity-"));
    mkdirSync(join(dir, "en"));
    mkdirSync(join(dir, "xx"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(locale: string, file: string, obj: unknown): void {
    writeFileSync(join(dir, locale, file), JSON.stringify(obj, null, 2));
  }

  it("reports no problems when locales are in parity", () => {
    const content = { greeting: "hello", nested: { item: "thing" } };
    write("en", "common.json", content);
    write("xx", "common.json", { greeting: "hola", nested: { item: "cosa" } });

    const results = runCheck(dir, "en");
    expect(results.get("xx")).toEqual([]);
  });

  it("detects missing keys in a non-reference locale", () => {
    write("en", "common.json", { a: "A", b: "B", c: "C" });
    write("xx", "common.json", { a: "A-xx" });

    const problems = runCheck(dir, "en").get("xx") as string[];
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/missing key "b"/),
        expect.stringMatching(/missing key "c"/),
      ]),
    );
  });

  it("detects extra keys in a non-reference locale", () => {
    write("en", "common.json", { a: "A" });
    write("xx", "common.json", { a: "A-xx", extra: "oops" });

    const problems = runCheck(dir, "en").get("xx") as string[];
    expect(problems.some((p) => /extra key "extra"/.test(p))).toBe(true);
  });

  it("detects missing namespace files", () => {
    write("en", "common.json", { a: "A" });
    write("en", "extension.json", { b: "B" });
    write("xx", "common.json", { a: "A" });
    // xx is missing extension.json entirely

    const problems = runCheck(dir, "en").get("xx") as string[];
    expect(problems.some((p) => /missing file: extension\.json/.test(p))).toBe(true);
  });

  it("detects placeholder mismatches in translated values", () => {
    write("en", "common.json", { greet: "Hello {{name}}, you have {{count}} items" });
    // xx translator forgot the {{count}} placeholder
    write("xx", "common.json", { greet: "Hola {{name}}" });

    const problems = runCheck(dir, "en").get("xx") as string[];
    expect(problems.some((p) => /placeholders mismatch at "greet"/.test(p))).toBe(true);
  });

  it("detects codicon mismatches in status-bar-style strings", () => {
    write("en", "common.json", { bar: "$(graph) Claude Stats" });
    // xx translator dropped the icon
    write("xx", "common.json", { bar: "Claude Stats" });

    const problems = runCheck(dir, "en").get("xx") as string[];
    expect(problems.some((p) => /codicons mismatch at "bar"/.test(p))).toBe(true);
  });

  it("treats nested objects as dot-joined key paths", () => {
    write("en", "common.json", { a: { b: { c: "deep" } } });
    write("xx", "common.json", { a: { b: {} } });

    const problems = runCheck(dir, "en").get("xx") as string[];
    expect(problems.some((p) => /missing key "a\.b\.c"/.test(p))).toBe(true);
  });

  it("reports the current repo as in parity (integration guard)", async () => {
    // This is the actual contract: whatever state master is in, it must be
    // clean. If this fails, either a key was added to en without a matching
    // entry in every other locale, or a placeholder/icon was dropped.
    const repoLocales = join(__dirname, "..", "..", "..", "core", "src", "locales");
    const results = runCheck(repoLocales, "en");
    for (const [locale, problems] of results) {
      expect(problems, `Locale "${locale}" has parity problems:\n${problems.join("\n")}`).toEqual([]);
    }
  });
});
