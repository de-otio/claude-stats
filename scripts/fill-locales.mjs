#!/usr/bin/env node
/**
 * Auto-translate missing locale keys using Claude Opus.
 *
 * Workflow:
 *   1. Read packages/core/src/locales/en/*.json as the source of truth.
 *   2. For every other locale directory, compute the diff: keys present in
 *      en that are missing from the target locale, or whose target value is
 *      byte-identical to the English value (i.e. an untranslated stub).
 *   3. Send each (locale × namespace) batch of missing keys to
 *      claude-opus-4-7 via the Anthropic API. One request per (locale,
 *      namespace) to keep prompts small and parallelizable.
 *   4. Merge translations back, preserving existing keys that are already
 *      translated. Write the result.
 *
 * Usage:
 *   node scripts/fill-locales.mjs                # All locales, all namespaces
 *   node scripts/fill-locales.mjs --locale=ja    # Only ja
 *   node scripts/fill-locales.mjs --locale=ja,fr # Multiple
 *   node scripts/fill-locales.mjs --dry-run      # Report work without calling API
 *   node scripts/fill-locales.mjs --verbose      # Log API requests/responses
 *   node scripts/fill-locales.mjs --force        # Also retranslate keys that equal en (stubs)
 *
 * Auth:
 *   ANTHROPIC_API_KEY must be set. Exits with code 3 if missing (so CI can
 *   distinguish "no key configured" from "translation actually failed").
 *
 * Exit codes:
 *   0  success (or nothing to do)
 *   1  one or more locales failed to translate
 *   2  invalid invocation
 *   3  ANTHROPIC_API_KEY not set
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, "..", "packages", "core", "src", "locales");
const REFERENCE_LOCALE = "en";
const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 8192;

// Human-readable names for each locale we support or plan to support.
// Anything not listed here falls back to just the code.
const LOCALE_NAMES = {
  de: "German (Deutsch)",
  ja: "Japanese (日本語)",
  "zh-CN": "Simplified Chinese (简体中文)",
  "zh-TW": "Traditional Chinese (繁體中文)",
  ko: "Korean (한국어)",
  fr: "French (Français)",
  es: "Spanish (Español)",
  "pt-BR": "Brazilian Portuguese (Português do Brasil)",
  "pt-PT": "European Portuguese (Português de Portugal)",
  ru: "Russian (Русский)",
  it: "Italian (Italiano)",
  nl: "Dutch (Nederlands)",
  pl: "Polish (Polski)",
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { locales: null, dryRun: false, verbose: false, force: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--verbose") out.verbose = true;
    else if (arg === "--force") out.force = true;
    else if (arg.startsWith("--locale=")) {
      out.locales = arg.slice("--locale=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: fill-locales.mjs [--locale=xx[,yy]] [--dry-run] [--verbose] [--force]\n" +
          "\nFills missing translation keys in every non-en locale using claude-opus-4-7.\n" +
          "Requires ANTHROPIC_API_KEY environment variable.",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

/**
 * Flatten a nested object into dot-joined key paths, but treat arrays as
 * leaves (we translate the whole array of objects together — see below).
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

/** Set a dot-joined key on a nested object, creating intermediate objects. */
function setByPath(root, keyPath, value) {
  const parts = keyPath.split(".");
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] === undefined || typeof cur[p] !== "object" || Array.isArray(cur[p])) {
      cur[p] = {};
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n");
}

/** All non-en locale directories currently on disk. */
function listLocales(localesDir) {
  return fs
    .readdirSync(localesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== REFERENCE_LOCALE)
    .map((e) => e.name);
}

/** All namespace JSON files in en. */
function listNamespaces(localesDir) {
  return fs
    .readdirSync(path.join(localesDir, REFERENCE_LOCALE))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
}

/**
 * Compute which keys in `en` need to be (re)translated for `target`.
 * Returns a Map<flattenedKey, englishValue>.
 *
 * A key needs translation if:
 *   - It's missing from the target entirely, OR
 *   - `force` is set AND the target value is byte-identical to en
 *     (i.e. a "didn't actually translate" stub).
 */
function diffKeys(enFlat, targetFlat, { force }) {
  const missing = new Map();
  for (const [k, v] of enFlat.entries()) {
    if (!targetFlat.has(k)) {
      missing.set(k, v);
    } else if (force && JSON.stringify(targetFlat.get(k)) === JSON.stringify(v)) {
      missing.set(k, v);
    }
  }
  return missing;
}

// ── Translation prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a professional software localizer translating short UI strings for Claude Stats, a VS Code extension + CLI that visualizes Claude Code (an AI coding assistant CLI by Anthropic) usage statistics.

Non-negotiable rules:

1. Preserve every {{placeholder}} identifier EXACTLY — do not translate, rename, add spaces, or remove. Interpolations like {{tokens}} and {{cost}} are code; if the English has {{count}}, the output must have {{count}}.

2. Preserve every $(codicon) token EXACTLY — these are VS Code icon references like $(graph), $(cloud), $(sync~spin). Never translate or modify.

3. Preserve every backtick-quoted \`code\` fragment VERBATIM — file paths (~/.claude/projects/), commands (claude), config keys (mcpServers), and filenames are code identifiers.

4. Preserve Markdown emphasis, line breaks (\\n), and bullet/numbered list prefixes.

5. Match VS Code's official translation glossary for the target language. "Settings", "Extensions", "Command Palette", "Status Bar", "Webview", "Workspace", "Terminal" — use the exact term VS Code itself uses in the target language, so our UI doesn't feel foreign alongside VS Code chrome.

6. Technical loanwords: leave "token", "cache", "session", "prompt", "MCP", "API", "JSON", "SQLite", "OAuth", "Claude Code", "Anthropic", "Opus", "Sonnet", "Haiku" untranslated where native-speaker developers use the English term. When in doubt, prefer the English loanword to an overtranslation.

7. Keep length similar to the source. Status-bar strings (those containing $(codicon) prefixes) must fit ~40 characters — be concise.

8. Tone: developer-facing, informational, polite. Match the register of the source (mostly neutral; occasionally friendly in welcome/empty-state messages).

9. Arrays of objects (e.g. step lists) must be returned with the same array length and the same object keys ("heading", "body") — only translate the string values.

Output format: a single JSON object whose keys match the input keys exactly and whose values are the translated versions. NO markdown code fences, NO prose commentary, NO extra keys. Just the JSON.`;

function userPrompt(localeName, localeCode, missingEntries) {
  return `Translate the following English UI strings to ${localeName} (${localeCode}). Return a single JSON object with the exact same keys and translated values.

Input:
${JSON.stringify(Object.fromEntries(missingEntries), null, 2)}`;
}

/**
 * Extract the first top-level JSON object from a possibly-messy model reply
 * (handles accidental code fences or leading/trailing prose).
 */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  if (first < 0 || last < 0 || last <= first) {
    throw new Error(`No JSON object in model reply:\n${text.slice(0, 400)}`);
  }
  return JSON.parse(candidate.slice(first, last + 1));
}

/**
 * Shape-validate a translation batch. Ensures the model returned exactly the
 * keys we asked for (no more, no less) and that arrays keep their length.
 */
function validateBatch(request, response) {
  const errors = [];
  const reqKeys = new Set(request.keys());
  const resKeys = new Set(Object.keys(response));
  for (const k of reqKeys) if (!resKeys.has(k)) errors.push(`missing key in response: "${k}"`);
  for (const k of resKeys) if (!reqKeys.has(k)) errors.push(`extra key in response: "${k}"`);
  for (const [k, reqVal] of request.entries()) {
    if (!resKeys.has(k)) continue;
    const resVal = response[k];
    if (Array.isArray(reqVal)) {
      if (!Array.isArray(resVal)) errors.push(`"${k}": expected array, got ${typeof resVal}`);
      else if (reqVal.length !== resVal.length)
        errors.push(`"${k}": array length ${reqVal.length} → ${resVal.length}`);
    } else if (typeof reqVal === "string") {
      if (typeof resVal !== "string") errors.push(`"${k}": expected string, got ${typeof resVal}`);
    }
  }
  return errors;
}

// ── Main per-locale worker ──────────────────────────────────────────────────

async function fillLocale(client, locale, opts) {
  const localeName = LOCALE_NAMES[locale] ?? locale;
  const namespaces = listNamespaces(LOCALES_DIR);
  const summary = { locale, totalMissing: 0, filled: 0, namespaces: {} };

  // Ensure target dir exists.
  fs.mkdirSync(path.join(LOCALES_DIR, locale), { recursive: true });

  for (const ns of namespaces) {
    const enPath = path.join(LOCALES_DIR, REFERENCE_LOCALE, `${ns}.json`);
    const targetPath = path.join(LOCALES_DIR, locale, `${ns}.json`);

    const en = readJson(enPath);
    const target = readJson(targetPath);
    const enFlat = flatten(en);
    const targetFlat = flatten(target);

    const missing = diffKeys(enFlat, targetFlat, { force: opts.force });
    summary.namespaces[ns] = { missing: missing.size, filled: 0 };
    summary.totalMissing += missing.size;

    if (missing.size === 0) continue;

    if (opts.verbose) {
      console.log(`  [${locale}/${ns}] ${missing.size} keys to translate`);
    }

    if (opts.dryRun) {
      for (const k of missing.keys()) {
        console.log(`    would fill: ${locale}/${ns}: ${k}`);
      }
      continue;
    }

    // Call Opus.
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt(localeName, locale, missing) }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(`[${locale}/${ns}] model returned no text block`);
    }

    let translated;
    try {
      translated = extractJson(textBlock.text);
    } catch (err) {
      throw new Error(`[${locale}/${ns}] failed to parse model reply: ${err.message}`);
    }

    const errors = validateBatch(missing, translated);
    if (errors.length > 0) {
      throw new Error(`[${locale}/${ns}] shape validation failed:\n  ${errors.join("\n  ")}`);
    }

    // Merge translations into target, by path.
    for (const [keyPath, value] of Object.entries(translated)) {
      setByPath(target, keyPath, value);
    }

    writeJson(targetPath, target);
    summary.namespaces[ns].filled = Object.keys(translated).length;
    summary.filled += summary.namespaces[ns].filled;

    if (opts.verbose) {
      console.log(`  [${locale}/${ns}] wrote ${summary.namespaces[ns].filled} keys to ${path.relative(process.cwd(), targetPath)}`);
    }
  }

  return summary;
}

// ── CLI entry ────────────────────────────────────────────────────────────────

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const opts = parseArgs(process.argv);
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!opts.dryRun && !apiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Set it in your environment (or in CI secrets) and retry.");
    console.error("Use --dry-run to preview without calling the API.");
    process.exit(3);
  }

  const client = opts.dryRun
    ? null
    : new Anthropic({ apiKey });

  const locales = opts.locales ?? listLocales(LOCALES_DIR);
  if (locales.length === 0) {
    console.log(`No non-${REFERENCE_LOCALE} locales found under ${path.relative(process.cwd(), LOCALES_DIR)}.`);
    console.log(`Create a directory (e.g. packages/core/src/locales/ja/) and rerun to scaffold translations.`);
    process.exit(0);
  }

  let anyFailed = false;
  let grandTotalMissing = 0;
  let grandTotalFilled = 0;

  for (const locale of locales) {
    try {
      console.log(`\n→ ${locale} (${LOCALE_NAMES[locale] ?? locale})`);
      const summary = await fillLocale(client, locale, opts);
      grandTotalMissing += summary.totalMissing;
      grandTotalFilled += summary.filled;

      if (summary.totalMissing === 0) {
        console.log(`  up-to-date (no missing keys)`);
      } else if (opts.dryRun) {
        console.log(`  ${summary.totalMissing} keys would be filled (dry-run; no API calls made)`);
      } else {
        console.log(`  filled ${summary.filled}/${summary.totalMissing} keys`);
      }
    } catch (err) {
      anyFailed = true;
      console.error(`  FAILED: ${err.message}`);
    }
  }

  console.log(
    `\nTotal: ${grandTotalFilled}/${grandTotalMissing} key${grandTotalMissing === 1 ? "" : "s"} filled across ${locales.length} locale${locales.length === 1 ? "" : "s"}.`,
  );

  if (anyFailed) process.exit(1);
}

// Exported for tests.
export { diffKeys, flatten, setByPath, extractJson, validateBatch, fillLocale };
