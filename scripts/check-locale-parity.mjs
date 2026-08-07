#!/usr/bin/env node
/**
 * Locale parity checker for claude-stats.
 *
 * Reads `en` as the source of truth and verifies every other locale directory
 * under packages/core/src/locales/ has:
 *   1. Exactly the same set of JSON namespace files (cli, common, dashboard,
 *      extension, frontend).
 *   2. Exactly the same set of keys in each file (dot-flattened).
 *   3. The same {{placeholder}} identifiers in each value (order-insensitive).
 *   4. The same $(codicon) tokens in each value (order-insensitive).
 *
 * Exits non-zero and prints a readable report on any drift. Designed to be
 * fast (<1 s), dependency-free, and runnable in CI before the test suite.
 *
 * Why each check:
 *   - Missing/extra keys break i18next resolution and render raw keys to
 *     users (e.g. "extension:mcp.registered" instead of the English fallback).
 *   - Missing {{placeholders}} break string interpolation — translators
 *     sometimes drop them by accident when restructuring a sentence.
 *   - Missing $(codicons) break status-bar icons silently — the string still
 *     renders, just without the icon.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, "..", "packages", "core", "src", "locales");
const REFERENCE_LOCALE = "en";

/**
 * Flatten a nested object to a map of dot-joined key → leaf value.
 * Arrays are treated as leaves (they show up as one key).
 */
function flatten(obj, prefix = "", out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      flatten(v, key, out);
    } else {
      out.set(key, v);
    }
  }
  return out;
}

/**
 * CLDR plural-category suffixes, as i18next v4 spells them (`key_one`,
 * `key_few`, …).
 *
 * These need special handling because **plural sets are not the same size in
 * every language**. English has two categories (`one`, `other`); Polish,
 * Russian and Ukrainian have four (`one`, `few`, `many`, `other`) and select
 * `few` for 2–4 and `many` for 5+. A strict key-for-key comparison against `en`
 * therefore rejects exactly the keys those languages are *required* to have —
 * and that is not hypothetical: it silently shipped English sentences to three
 * locales on the dashboard's default tab, because i18next found no `_few` and
 * fell through to the fallback language.
 */
const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];

/** Split `foo.bar_few` into `{ base: "foo.bar", category: "few" }`, else null. */
function splitPlural(key) {
  const i = key.lastIndexOf("_");
  if (i <= 0) return null;
  const category = key.slice(i + 1);
  if (!PLURAL_SUFFIXES.includes(category)) return null;
  return { base: key.slice(0, i), category };
}

/**
 * The plural categories a locale actually uses, from the runtime's own CLDR
 * data — never a hardcoded table, which would rot as locales are added.
 * Falls back to the English pair if the locale tag is unknown to Intl.
 */
function pluralCategories(locale) {
  try {
    return new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
  } catch {
    return new Set(["one", "other"]);
  }
}

/** Return the sorted list of `{{name}}` placeholders in a string. */
function placeholders(value) {
  if (typeof value !== "string") return [];
  const set = new Set();
  for (const m of value.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) set.add(m[1]);
  return [...set].sort();
}

/** Return the sorted list of `$(name)` codicon tokens in a string. */
function codicons(value) {
  if (typeof value !== "string") return [];
  const set = new Set();
  for (const m of value.matchAll(/\$\(([a-zA-Z0-9-]+)\)/g)) set.add(m[1]);
  return [...set].sort();
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Compare one locale against the reference and return a list of human-readable
 * problem strings. Empty list = locale is in parity.
 */
function compareLocale(refLocale, otherLocale, localesDir) {
  const problems = [];

  const refFiles = fs.readdirSync(path.join(localesDir, refLocale))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const otherFiles = fs.readdirSync(path.join(localesDir, otherLocale))
    .filter((f) => f.endsWith(".json"))
    .sort();

  // Namespace parity
  const refFileSet = new Set(refFiles);
  const otherFileSet = new Set(otherFiles);
  for (const f of refFiles) {
    if (!otherFileSet.has(f)) problems.push(`missing file: ${f}`);
  }
  for (const f of otherFiles) {
    if (!refFileSet.has(f)) problems.push(`extra file: ${f}`);
  }

  // Key + placeholder + codicon parity per shared namespace
  for (const file of refFiles) {
    if (!otherFileSet.has(file)) continue;
    const refPath = path.join(localesDir, refLocale, file);
    const otherPath = path.join(localesDir, otherLocale, file);

    let refJson;
    let otherJson;
    try {
      refJson = JSON.parse(fs.readFileSync(refPath, "utf-8"));
    } catch (err) {
      problems.push(`${file}: ${refLocale} is not valid JSON (${err.message})`);
      continue;
    }
    try {
      otherJson = JSON.parse(fs.readFileSync(otherPath, "utf-8"));
    } catch (err) {
      problems.push(`${file}: not valid JSON (${err.message})`);
      continue;
    }

    const refMap = flatten(refJson);
    const otherMap = flatten(otherJson);

    // Every plural base `en` declares, so a locale's extra categories for that
    // same base can be recognised as required rather than rejected as noise.
    const refPluralBases = new Set();
    for (const key of refMap.keys()) {
      const p = splitPlural(key);
      if (p) refPluralBases.add(p.base);
    }
    const otherCategories = pluralCategories(otherLocale);

    for (const key of refMap.keys()) {
      if (otherMap.has(key)) continue;
      const p = splitPlural(key);
      // A category `en` has and this locale does not (e.g. `en` needs no
      // `_few`) is not a gap — the locale cannot use a form its grammar
      // lacks. `other` is always required: i18next's final fallback.
      if (p && p.category !== "other" && !otherCategories.has(p.category)) continue;
      problems.push(`${file}: missing key "${key}"`);
    }

    // The categories this locale must supply for each plural base, beyond what
    // `en` happens to spell. Reported as missing, because a Slavic locale
    // without `_few` renders English at count 2 — the defect this check exists
    // to catch, and the one a naive key-for-key comparison caused.
    for (const base of refPluralBases) {
      for (const category of otherCategories) {
        const key = `${base}_${category}`;
        if (!otherMap.has(key)) {
          problems.push(`${file}: missing plural form "${key}" (${otherLocale} uses the "${category}" category)`);
        }
      }
    }

    for (const key of otherMap.keys()) {
      if (refMap.has(key)) continue;
      const p = splitPlural(key);
      // A plural variant of a base `en` declares, in a category this locale
      // genuinely uses, is required — not extra.
      if (p && refPluralBases.has(p.base) && otherCategories.has(p.category)) continue;
      problems.push(`${file}: extra key "${key}"`);
    }

    // Shared keys: check placeholders and codicons.
    for (const [key, refValue] of refMap.entries()) {
      if (!otherMap.has(key)) continue;
      const otherValue = otherMap.get(key);

      const refPh = placeholders(refValue);
      const otherPh = placeholders(otherValue);
      if (!arraysEqual(refPh, otherPh)) {
        problems.push(
          `${file}: placeholders mismatch at "${key}" — ${refLocale}=[${refPh.join(",")}] vs ${otherLocale}=[${otherPh.join(",")}]`,
        );
      }

      const refCi = codicons(refValue);
      const otherCi = codicons(otherValue);
      if (!arraysEqual(refCi, otherCi)) {
        problems.push(
          `${file}: codicons mismatch at "${key}" — ${refLocale}=[${refCi.join(",")}] vs ${otherLocale}=[${otherCi.join(",")}]`,
        );
      }
    }
  }

  return problems;
}

/**
 * Run the check against a given locales directory.
 * Returns a Map<locale, string[]> of problems by locale.
 */
export function runCheck(localesDir = LOCALES_DIR, referenceLocale = REFERENCE_LOCALE) {
  if (!fs.existsSync(localesDir)) {
    throw new Error(`Locales directory not found: ${localesDir}`);
  }

  const entries = fs.readdirSync(localesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);

  if (!entries.includes(referenceLocale)) {
    throw new Error(`Reference locale "${referenceLocale}" not found in ${localesDir}`);
  }

  const results = new Map();
  for (const locale of entries) {
    if (locale === referenceLocale) continue;
    results.set(locale, compareLocale(referenceLocale, locale, localesDir));
  }
  return results;
}

// ── CLI entry ────────────────────────────────────────────────────────────────

// Run when invoked directly (node scripts/check-locale-parity.mjs), but not when
// imported from a test or another script.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  let results;
  try {
    results = runCheck();
  } catch (err) {
    console.error(`locale parity check: ${err.message}`);
    process.exit(2);
  }

  let totalProblems = 0;
  const sortedLocales = [...results.keys()].sort();

  for (const locale of sortedLocales) {
    const problems = results.get(locale);
    if (problems.length === 0) {
      console.log(`  ${locale}: ok`);
    } else {
      totalProblems += problems.length;
      console.log(`  ${locale}: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
      for (const p of problems) console.log(`    - ${p}`);
    }
  }

  if (totalProblems === 0) {
    console.log(`\nAll ${sortedLocales.length} non-reference locale(s) are in parity with "${REFERENCE_LOCALE}".`);
    process.exit(0);
  } else {
    console.log(`\nLocale parity check FAILED: ${totalProblems} problem(s) across ${sortedLocales.length} locale(s).`);
    console.log(`Reference locale: "${REFERENCE_LOCALE}" in ${path.relative(process.cwd(), LOCALES_DIR)}`);
    process.exit(1);
  }
}
