#!/usr/bin/env node
/**
 * Auto-translate missing locale keys using the Claude Code CLI.
 *
 * Workflow:
 *   1. Read packages/core/src/locales/en/*.json as the source of truth.
 *   2. For every other locale directory, compute the diff: keys present in
 *      en that are missing from the target locale (or, with --force, whose
 *      target value is byte-identical to the English value — an
 *      untranslated stub).
 *   3. Send each (locale × namespace) batch of missing keys to `claude -p`
 *      (headless/print mode) — one subprocess call per (locale, namespace)
 *      to keep prompts small and each batch independently retriable. Output
 *      is constrained with --json-schema so the CLI returns validated JSON
 *      directly (no markdown-fence stripping needed on the happy path).
 *   4. Merge translations back, preserving existing keys that are already
 *      translated. Write the result.
 *
 * Usage:
 *   node scripts/fill-locales.mjs                # All locales, all namespaces
 *   node scripts/fill-locales.mjs --locale=ja    # Only ja
 *   node scripts/fill-locales.mjs --locale=ja,fr # Multiple
 *   node scripts/fill-locales.mjs --dry-run      # Report work without calling the CLI
 *   node scripts/fill-locales.mjs --verbose      # Log CLI invocations/responses
 *   node scripts/fill-locales.mjs --force        # Also retranslate keys that equal en (stubs)
 *   node scripts/fill-locales.mjs --model=opus   # Model alias (default: opus)
 *   node scripts/fill-locales.mjs --max-budget-usd=1.00  # Per-batch spend cap (default: 1.00)
 *
 * Auth:
 *   Uses the `claude` CLI in non-interactive mode (`claude -p`), which
 *   authenticates via whatever the local `claude` login state is — the
 *   user's Claude subscription, not a separate ANTHROPIC_API_KEY. Requires
 *   the `claude` binary on PATH (override with CLAUDE_BIN=/path/to/claude)
 *   and an already-authenticated session (run `claude` once interactively
 *   to log in if needed). Each translated batch is a normal, separately
 *   billed subscription usage — same as any other Claude Code session, just
 *   invoked headlessly. --max-budget-usd caps spend per batch as a safety
 *   backstop (`claude -p`'s own flag, not something this script enforces
 *   after the fact).
 *
 * Exit codes:
 *   0  success (or nothing to do)
 *   1  one or more locales failed to translate
 *   2  invalid invocation
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, "..", "packages", "core", "src", "locales");
const REFERENCE_LOCALE = "en";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const DEFAULT_MODEL = "opus"; // alias — resolves to the latest Opus, not a pinned model id
const DEFAULT_MAX_BUDGET_USD = "1.00";
const SUBPROCESS_TIMEOUT_MS = 300_000;
// `claude -p --json-schema` runs an agentic structured-output loop (observed
// num_turns > 1 even for trivial batches) whose cost scales with schema size
// — a single 326-key namespace reliably timed out at 180s even with a
// generous per-call timeout, while ~60-key batches consistently completed in
// well under a minute. Splitting large namespaces into chunks keeps each
// call's schema small and keeps per-chunk failures cheap to retry, rather
// than losing an entire large namespace's translations to one slow/failed
// call. Found via live end-to-end testing, not documented CLI behavior.
const MAX_BATCH_KEYS = 60;

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
  const out = {
    locales: null,
    dryRun: false,
    verbose: false,
    force: false,
    model: DEFAULT_MODEL,
    maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--verbose") out.verbose = true;
    else if (arg === "--force") out.force = true;
    else if (arg.startsWith("--locale=")) {
      out.locales = arg.slice("--locale=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith("--model=")) {
      out.model = arg.slice("--model=".length);
    } else if (arg.startsWith("--max-budget-usd=")) {
      out.maxBudgetUsd = arg.slice("--max-budget-usd=".length);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: fill-locales.mjs [--locale=xx[,yy]] [--dry-run] [--verbose] [--force]\n" +
          "                         [--model=opus] [--max-budget-usd=1.00]\n" +
          "\nFills missing translation keys in every non-en locale using `claude -p`" +
          " (the Claude Code CLI in headless mode).\n" +
          "Requires the `claude` binary on PATH and an already-authenticated session" +
          " (uses your Claude subscription, not ANTHROPIC_API_KEY).",
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

/** Split a Map into an array of Maps, each with at most `size` entries. */
function chunkMap(map, size) {
  const chunks = [];
  let current = new Map();
  for (const [k, v] of map.entries()) {
    current.set(k, v);
    if (current.size >= size) {
      chunks.push(current);
      current = new Map();
    }
  }
  if (current.size > 0) chunks.push(current);
  return chunks;
}

// ── Translation prompt ──────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a professional software localizer translating short UI strings for Claude Stats, a VS Code extension + CLI that visualizes Claude Code (an AI coding assistant CLI by Anthropic) usage statistics.

Non-negotiable rules:

1. Preserve every {{placeholder}} identifier EXACTLY — do not translate, rename, add spaces, or remove. Interpolations like {{tokens}} and {{cost}} are code; if the English has {{count}}, the output must have {{count}}.

2. Preserve every $(codicon) token EXACTLY — these are VS Code icon references like $(graph), $(cloud), $(sync~spin). Never translate or modify.

3. Preserve every backtick-quoted \`code\` fragment VERBATIM — file paths (~/.claude/projects/), commands (claude), config keys (mcpServers), CLI flags (--since, --until), and filenames are code identifiers.

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
 * (handles accidental code fences or leading/trailing prose). Used as a
 * fallback when --json-schema-constrained structured output isn't available
 * (e.g. an older `claude` CLI without --json-schema support).
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
 * Build a JSON Schema for --json-schema from a batch of missing entries.
 * String-valued keys get `{type: "string"}`; array-valued keys (step lists)
 * get a looser `{type: "array"}` — we don't know each array's exact object
 * shape here, so structural conformance (right length, right sub-keys) is
 * still checked afterward by validateBatch(), same as before this only
 * narrows the top-level type so the model can't return e.g. a number.
 */
function buildJsonSchema(missingEntries) {
  const properties = {};
  const required = [];
  for (const [k, v] of missingEntries.entries()) {
    properties[k] = Array.isArray(v) ? { type: "array" } : { type: "string" };
    required.push(k);
  }
  return { type: "object", properties, required, additionalProperties: false };
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

// ── Model invocation (claude -p, headless CLI — uses the user's Claude
// subscription via the CLI's own auth state, not a separate API key) ────────

/**
 * Run `claude` with the given args and return its stdout.
 *
 * Uses spawn() with stdin explicitly set to "ignore" (not the default
 * "pipe"). `execFile`'s default stdio leaves the child's stdin as an open,
 * unwritten, unclosed pipe — for large prompts `claude -p` was observed to
 * wait ~3s ("no stdin data received"), then error out entirely rather than
 * the "proceeding without it" its own warning claims, breaking any batch
 * above a few dozen keys. Explicitly ignoring stdin (no pipe at all, same
 * as redirecting from /dev/null) avoids that path completely. Found via
 * live end-to-end testing of this script, not from documentation — the
 * warning text alone reads as non-fatal, but the process reliably failed
 * for wide batches (326 keys) and reliably succeeded for narrow ones (59
 * keys) until this fix.
 *
 * Uses an argv array (never a shell string) so arbitrary characters in the
 * source strings — backticks, quotes, etc., several of which this file's own
 * SYSTEM_PROMPT explicitly calls out as content to preserve verbatim — are
 * never interpreted as shell syntax.
 */
function runClaude(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`\`${CLAUDE_BIN} -p\` timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => stdoutChunks.push(d));
    child.stderr.on("data", (d) => stderrChunks.push(d));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn \`${CLAUDE_BIN}\` (is it on PATH?): ${err.message}`, { cause: err }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (code !== 0) {
        const detail = stderr ? `: ${stderr.slice(0, 500)}` : "";
        reject(new Error(`\`${CLAUDE_BIN} -p\` exited with code ${code} (is the CLI logged in?)${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Translate one (locale, namespace) batch by shelling out to `claude -p`.
 * Uses --json-schema to constrain output to valid JSON matching the batch's
 * keys/types directly (structured_output in the response envelope), falling
 * back to extractJson() on the free-text `result` field if structured_output
 * is absent for any reason (e.g. an older CLI).
 */
async function translateBatch(localeName, localeCode, missingEntries, opts) {
  const schema = buildJsonSchema(missingEntries);
  const args = [
    "--output-format", "json",
    "--model", opts.model,
    "--system-prompt", SYSTEM_PROMPT,
    "--json-schema", JSON.stringify(schema),
    "--tools", "",
    "--strict-mcp-config",
    "--max-budget-usd", opts.maxBudgetUsd,
    "-p", userPrompt(localeName, localeCode, missingEntries),
  ];

  if (opts.verbose) {
    console.log(`  [${localeCode}] invoking: ${CLAUDE_BIN} --model ${opts.model} -p <${missingEntries.size} keys>`);
  }

  const stdout = await runClaude(args, SUBPROCESS_TIMEOUT_MS);

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`\`${CLAUDE_BIN} -p --output-format json\` returned non-JSON output: ${stdout.slice(0, 400)}`, { cause: err });
  }

  if (envelope.is_error) {
    throw new Error(`claude -p reported an error: ${envelope.result ?? envelope.subtype ?? "unknown"}`);
  }

  if (opts.verbose) {
    console.log(`  [${localeCode}] cost: $${envelope.total_cost_usd ?? "?"}, stop_reason: ${envelope.stop_reason}`);
  }

  if (envelope.structured_output && typeof envelope.structured_output === "object") {
    return envelope.structured_output;
  }
  // Fallback: parse the free-text result if the CLI didn't return
  // structured_output for some reason (e.g. --json-schema unsupported).
  if (typeof envelope.result === "string") {
    return extractJson(envelope.result);
  }
  throw new Error(`claude -p returned neither structured_output nor a text result (stop_reason=${envelope.stop_reason})`);
}

// ── Main per-locale worker ──────────────────────────────────────────────────

async function fillLocale(locale, opts) {
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

    // Chunk large namespaces so no single `claude -p` call has to get a huge
    // schema exactly right in one shot, and so a failure partway through a
    // namespace doesn't lose already-translated chunks — each chunk is
    // written to disk immediately, making a re-run resumable (diffKeys will
    // no longer see already-written keys as missing).
    const chunks = chunkMap(missing, MAX_BATCH_KEYS);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (opts.verbose && chunks.length > 1) {
        console.log(`  [${locale}/${ns}] chunk ${i + 1}/${chunks.length} (${chunk.size} keys)`);
      }

      const translated = await translateBatch(localeName, locale, chunk, opts);

      const errors = validateBatch(chunk, translated);
      if (errors.length > 0) {
        throw new Error(`[${locale}/${ns}] chunk ${i + 1}/${chunks.length} shape validation failed:\n  ${errors.join("\n  ")}`);
      }

      // Merge this chunk's translations into target, by path, and persist
      // immediately (see chunking comment above).
      for (const [keyPath, value] of Object.entries(translated)) {
        setByPath(target, keyPath, value);
      }
      writeJson(targetPath, target);

      summary.namespaces[ns].filled += Object.keys(translated).length;
      summary.filled += Object.keys(translated).length;
    }

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
      const summary = await fillLocale(locale, opts);
      grandTotalMissing += summary.totalMissing;
      grandTotalFilled += summary.filled;

      if (summary.totalMissing === 0) {
        console.log(`  up-to-date (no missing keys)`);
      } else if (opts.dryRun) {
        console.log(`  ${summary.totalMissing} keys would be filled (dry-run; no CLI calls made)`);
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
export { diffKeys, flatten, setByPath, extractJson, validateBatch, buildJsonSchema, chunkMap, fillLocale };
