#!/usr/bin/env npx tsx
/**
 * CI script to check that all locale files have matching keys.
 * Compares every non-English locale against the English source of truth.
 *
 * Usage: npx tsx scripts/check-translations.ts
 *
 * Exit code 0: all keys match (or only has [TODO] warnings)
 * Exit code 1: missing keys detected
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, "..", "packages", "core", "src", "locales");
const EN_DIR = join(LOCALES_DIR, "en");

/** Recursively flatten a nested JSON object into dot-separated keys. */
function flatKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      keys.push(...flatKeys(v as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

/** Check if a value starts with [TODO]. */
function isTodo(obj: Record<string, unknown>, keyPath: string): boolean {
  const parts = keyPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" && current.startsWith("[TODO]");
}

// Discover all namespaces from en/ directory
const enFiles = readdirSync(EN_DIR).filter((f) => f.endsWith(".json"));
const langDirs = readdirSync(LOCALES_DIR).filter(
  (d) => d !== "en" && existsSync(join(LOCALES_DIR, d)),
);

let hasErrors = false;
let totalMissing = 0;
let totalExtra = 0;
let totalTodo = 0;

for (const lang of langDirs) {
  const langDir = join(LOCALES_DIR, lang);

  for (const file of enFiles) {
    const ns = basename(file, ".json");
    const enPath = join(EN_DIR, file);
    const langPath = join(langDir, file);

    if (!existsSync(langPath)) {
      console.error(`ERROR: ${lang}/${file} is missing entirely`);
      hasErrors = true;
      continue;
    }

    const enData = JSON.parse(readFileSync(enPath, "utf-8")) as Record<string, unknown>;
    const langData = JSON.parse(readFileSync(langPath, "utf-8")) as Record<string, unknown>;

    const enKeys = flatKeys(enData);
    const langKeys = flatKeys(langData);
    const enSet = new Set(enKeys);
    const langSet = new Set(langKeys);

    const missing = enKeys.filter((k) => !langSet.has(k));
    const extra = langKeys.filter((k) => !enSet.has(k));
    const todos = langKeys.filter((k) => isTodo(langData, k));

    if (missing.length > 0) {
      console.error(`ERROR: ${lang}/${ns}.json missing ${missing.length} keys:`);
      for (const k of missing) console.error(`  - ${k}`);
      hasErrors = true;
      totalMissing += missing.length;
    }

    if (extra.length > 0) {
      console.warn(`WARN:  ${lang}/${ns}.json has ${extra.length} extra keys:`);
      for (const k of extra) console.warn(`  + ${k}`);
      totalExtra += extra.length;
    }

    if (todos.length > 0) {
      console.warn(`WARN:  ${lang}/${ns}.json has ${todos.length} untranslated [TODO] values`);
      totalTodo += todos.length;
    }
  }
}

console.log(
  `\nSummary: ${totalMissing} missing, ${totalExtra} extra, ${totalTodo} [TODO] values across ${langDirs.length} language(s)`,
);

if (hasErrors) {
  process.exit(1);
}
