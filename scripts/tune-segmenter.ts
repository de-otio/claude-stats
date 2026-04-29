#!/usr/bin/env tsx
/**
 * tune-segmenter.ts — Offline LLM-as-Judge weight tuning for the topic segmenter.
 *
 * PRIVACY NOTICE (SR-7)
 * ─────────────────────
 * This script sends adjacent message pairs from your local Claude history to
 * the Anthropic API (claude-haiku-4-5) for labelling. Each pair includes the
 * raw prompt_text of two consecutive messages from your coding sessions.
 *
 * Anthropic's data retention policy: https://docs.anthropic.com/en/docs/legal-aspects/data-usage
 * Summary: API inputs/outputs may be retained for up to 30 days for trust &
 * safety purposes unless you opt in to zero-retention (requires Enterprise
 * agreement). Review that policy before running this script.
 *
 * MANDATORY OPT-IN
 * ─────────────────
 * By default this script runs in --dry-run mode: it samples pairs and prints
 * them to stdout, but makes NO API calls. To proceed you must:
 *   1. Pass --i-have-reviewed-the-data
 *   2. Confirm "yes" at the interactive prompt after reviewing 5 sample pairs
 *
 * NO AUTOMATIC INVOCATION — this script is never run automatically. It is a
 * developer/maintainer tool intended for manual invocation only.
 *
 * SESSION TAGGING (DEFENSIVE)
 * ───────────────────────────
 * Sessions tagged "sensitive" are excluded from sampling. The tagging feature
 * (Plan 10) is not yet fully built, but the session_tags table exists in the
 * schema (v5+), and sessions with tag="sensitive" are excluded here. If the
 * table does not exist (older DB), the check is a no-op and sampling proceeds.
 *
 * USAGE
 * ─────
 * npx tsx scripts/tune-segmenter.ts --help
 * npx tsx scripts/tune-segmenter.ts --dry-run              # default: show sample, no API
 * npx tsx scripts/tune-segmenter.ts --i-have-reviewed-the-data  # prompts for "yes"
 *
 * API KEY
 * ───────
 * Set ANTHROPIC_API_KEY in your environment. The key is never logged.
 * It is read once and passed to the Anthropic SDK. The Authorization
 * header is redacted from any error output before printing.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Store } from "../packages/cli/src/store/index.js";
import type { ShiftWeights } from "../packages/cli/src/recap/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MessagePair {
  sessionId: string;
  prevUuid: string;
  currUuid: string;
  prevPrompt: string | null;
  currPrompt: string | null;
  gapMinutes: number;
  prevPaths: string[];
  currPaths: string[];
}

interface LabelledPair {
  pair: MessagePair;
  label: "same" | "different";
  reason: string;
}

interface WeightCandidate {
  gap: number;
  path: number;
  vocab: number;
  marker: number;
  commit: number;
  threshold: number;
}

interface TuningResult {
  version: number;
  model: string;
  sampledAt: string;
  sampleSize: number;
  trainSize: number;
  testSize: number;
  testF1: number;
  weights: {
    gap: number;
    path: number;
    vocab: number;
    marker: number;
    commit: number;
    threshold: number;
  };
}

interface Args {
  dryRun: boolean;
  iHaveReviewedTheData: boolean;
  sampleSize: number;
  output: string;
  holdOut: number;
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: true,
    iHaveReviewedTheData: false,
    sampleSize: 500,
    output: join(
      dirname(fileURLToPath(import.meta.url)),
      "../packages/cli/src/recap/segment-weights.json"
    ),
    holdOut: 0.2,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run" || arg === "--dry-run=true") {
      args.dryRun = true;
    } else if (arg === "--dry-run=false") {
      args.dryRun = false;
    } else if (arg === "--i-have-reviewed-the-data") {
      args.iHaveReviewedTheData = true;
      args.dryRun = false;
    } else if (arg === "--sample-size" && argv[i + 1]) {
      args.sampleSize = parseInt(argv[++i]!, 10);
    } else if (arg?.startsWith("--sample-size=")) {
      args.sampleSize = parseInt(arg.slice("--sample-size=".length), 10);
    } else if (arg === "--output" && argv[i + 1]) {
      args.output = argv[++i]!;
    } else if (arg?.startsWith("--output=")) {
      args.output = arg.slice("--output=".length);
    } else if (arg === "--hold-out" && argv[i + 1]) {
      args.holdOut = parseFloat(argv[++i]!);
    } else if (arg?.startsWith("--hold-out=")) {
      args.holdOut = parseFloat(arg.slice("--hold-out=".length));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
tune-segmenter.ts — Offline LLM-as-Judge weight tuner for the topic segmenter

PRIVACY NOTICE:
  This script sends message pairs from your local Claude history to the
  Anthropic API. Review Anthropic's data retention policy before proceeding:
  https://docs.anthropic.com/en/docs/legal-aspects/data-usage

  By default, the script runs in --dry-run mode and makes NO API calls.
  To proceed you must pass --i-have-reviewed-the-data and type "yes" at
  the confirmation prompt.

USAGE:
  npx tsx scripts/tune-segmenter.ts [options]

OPTIONS:
  --dry-run                   Print sample pairs only; no API calls (default: true)
  --dry-run=false             Disable dry-run (still requires --i-have-reviewed-the-data)
  --i-have-reviewed-the-data  Enable live labelling; implies --dry-run=false
  --sample-size=N             Number of adjacent pairs to sample (default: 500)
  --output=PATH               Output JSON file path
                              (default: packages/cli/src/recap/segment-weights.json)
  --hold-out=FRACTION         Fraction held out as test set (default: 0.2)
  --help                      Show this message

ENVIRONMENT:
  ANTHROPIC_API_KEY           Required for live labelling (never logged)

NO AUTOMATIC INVOCATION:
  This script is a developer/maintainer tool. It must never be wired into
  any install hook, daemon, cron job, or CI pipeline.
`);
}

// ─── Signal helpers (mirroring segment.ts logic) ──────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of",
  "is", "was", "in", "on", "for", "with", "this",
  "that", "my", "your", "please", "can", "could", "will",
]);

function tokenise(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

function jaccardDistance(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return 1 - intersection / union;
}

const SHIFT_MARKER_RE =
  /^\s*(okay|ok|now|next|let'?s|switch to|moving on|different (?:topic|thing)|new (?:task|topic))\b/i;

function computeScore(pair: MessagePair, w: WeightCandidate): number {
  const gapSignal = pair.gapMinutes > 20 ? 1 : 0;

  const pathsBefore = new Set(pair.prevPaths);
  const pathsAfter = new Set(pair.currPaths);
  const pathSignal = jaccardDistance(pathsBefore, pathsAfter);

  let vocabSignal = 0;
  if (pair.prevPrompt !== null && pair.currPrompt !== null) {
    vocabSignal = jaccardDistance(tokenise(pair.prevPrompt), tokenise(pair.currPrompt));
  }

  const markerSignal =
    pair.currPrompt !== null && SHIFT_MARKER_RE.test(pair.currPrompt) ? 1 : 0;

  // Note: commit signal not available in offline pairs without commit data; treated as 0.
  const commitSignal = 0;

  return (
    w.gap * gapSignal +
    w.path * pathSignal +
    w.vocab * vocabSignal +
    w.marker * markerSignal +
    w.commit * commitSignal
  );
}

// ─── Store interface ──────────────────────────────────────────────────────────

/** Minimal store interface needed by the tuning script (for test injection). */
export interface TunerStore {
  getSessions(opts: { includeCI?: boolean; includeDeleted?: boolean }): Array<{ session_id: string }>;
  getSessionMessages(sessionId: string): Array<{
    uuid: string;
    session_id: string;
    timestamp: number | null;
    prompt_text: string | null;
    file_paths: string;
    tools: string;
  }>;
  getSessionIdsByTag(tag: string): string[];
  close(): void;
}

// ─── Stratified sampling ──────────────────────────────────────────────────────

/**
 * Sample N adjacent message pairs from the store.
 *
 * Stratification: we bucket by gap (0-5 min, 5-20 min, 20+ min) and by
 * whether there is any file-path overlap between the two messages. We then
 * sample proportionally within each bucket so the training set covers the
 * signal space.
 *
 * Sensitive sessions (tagged "sensitive") are excluded. If the session_tags
 * table does not exist yet (pre-v5 schema), this check is a no-op.
 *
 * @param store  The open Store instance.
 * @param n      Maximum number of pairs to return.
 * @returns      Array of MessagePair objects, at most n entries.
 */
function samplePairs(store: TunerStore, n: number): MessagePair[] {
  // Discover sensitive session IDs (defensive: if the table / column does not
  // exist the query throws; we catch it and treat the excluded set as empty).
  const sensitiveIds = new Set<string>();
  try {
    const ids = store.getSessionIdsByTag("sensitive");
    for (const id of ids) sensitiveIds.add(id);
  } catch {
    // session_tags table may not exist in older stores — no-op.
  }

  // Fetch all interactive, non-deleted sessions.
  const sessions = store.getSessions({ includeCI: false, includeDeleted: false });

  const allPairs: MessagePair[] = [];

  for (const session of sessions) {
    if (sensitiveIds.has(session.session_id)) continue;

    const messages = store.getSessionMessages(session.session_id);
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1]!;
      const curr = messages[i]!;

      // Skip pairs where both messages lack prompt text (nothing to label).
      if (prev.prompt_text === null && curr.prompt_text === null) continue;

      const tPrev = prev.timestamp ?? 0;
      const tCurr = curr.timestamp ?? 0;
      const gapMinutes = (tCurr - tPrev) / 60_000;

      let prevPaths: string[] = [];
      let currPaths: string[] = [];
      try { prevPaths = JSON.parse(prev.file_paths) as string[]; } catch { /* empty */ }
      try { currPaths = JSON.parse(curr.file_paths) as string[]; } catch { /* empty */ }

      allPairs.push({
        sessionId: session.session_id,
        prevUuid: prev.uuid,
        currUuid: curr.uuid,
        prevPrompt: prev.prompt_text,
        currPrompt: curr.prompt_text,
        gapMinutes,
        prevPaths,
        currPaths,
      });
    }
  }

  if (allPairs.length === 0) return [];

  // Stratify into 6 buckets: 3 gap buckets × 2 path-overlap buckets.
  const buckets: MessagePair[][] = [[], [], [], [], [], []];
  for (const pair of allPairs) {
    const prevSet = new Set(pair.prevPaths);
    const hasOverlap = pair.currPaths.some((p) => prevSet.has(p));
    const gapBucket = pair.gapMinutes <= 5 ? 0 : pair.gapMinutes <= 20 ? 1 : 2;
    const overlapBucket = hasOverlap ? 0 : 1;
    buckets[gapBucket * 2 + overlapBucket]!.push(pair);
  }

  // Shuffle each bucket independently using Fisher-Yates.
  const rng = seededRandom(Date.now());
  for (const bucket of buckets) {
    for (let i = bucket.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [bucket[i], bucket[j]] = [bucket[j]!, bucket[i]!];
    }
  }

  // Take proportional share from each bucket.
  const totalInBuckets = buckets.reduce((s, b) => s + b.length, 0);
  const result: MessagePair[] = [];
  for (const bucket of buckets) {
    const take = Math.round((bucket.length / totalInBuckets) * n);
    result.push(...bucket.slice(0, take));
  }

  // Trim to exactly n (or less).
  return result.slice(0, n);
}

/** Simple seeded LCG PRNG — good enough for shuffling. */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ─── LLM labelling ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a labeller. Given two adjacent messages from a coding session, " +
  "output JSON: {\"label\": \"same\" | \"different\", \"reason\": \"<one short sentence>\"}. " +
  "Use \"same\" if both messages relate to the same engineering task; " +
  "\"different\" if they relate to distinct tasks.";

function serialisePair(pair: MessagePair): string {
  return JSON.stringify(
    {
      gap_minutes: Math.round(pair.gapMinutes),
      prev_files: pair.prevPaths.slice(0, 5),
      curr_files: pair.currPaths.slice(0, 5),
      prev_prompt: pair.prevPrompt?.slice(0, 300) ?? "(no prompt)",
      curr_prompt: pair.currPrompt?.slice(0, 300) ?? "(no prompt)",
    },
    null,
    2
  );
}

/** Redact the Authorization header value from an error message string. */
export function redactAuthHeader(text: string): string {
  // Replace "Authorization: Bearer sk-ant-..." or "authorization: ..." patterns.
  // Matches the header name, colon, and the rest of the header value (to end of
  // line), since header values may include multiple tokens ("Bearer <token>").
  return text
    .replace(/authorization[^:]*:[^\n]*/gi, "Authorization: [REDACTED]")
    .replace(/sk-ant-[a-zA-Z0-9\-_]+/g, "[REDACTED]")
    .replace(/x-api-key[^:]*:[^\n]*/gi, "x-api-key: [REDACTED]");
}

async function labelPair(
  client: Pick<Anthropic, "messages">,
  pair: MessagePair
): Promise<LabelledPair | null> {
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: serialisePair(pair) }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;

    // Extract JSON from the response (may be wrapped in markdown code fences).
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !("label" in parsed) ||
      (parsed.label !== "same" && parsed.label !== "different")
    ) {
      return null;
    }

    const reason =
      "reason" in parsed && typeof parsed.reason === "string"
        ? parsed.reason
        : "";

    return { pair, label: parsed.label as "same" | "different", reason };
  } catch (err: unknown) {
    const errStr = err instanceof Error ? err.message : String(err);
    const redacted = redactAuthHeader(errStr);
    console.error(`[label error] ${redacted}`);
    return null;
  }
}

// ─── Grid search ─────────────────────────────────────────────────────────────

const WEIGHT_GRID = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5] as const;
const THRESHOLD_GRID = [0.3, 0.4, 0.5, 0.6, 0.7] as const;

interface F1Stats {
  precision: number;
  recall: number;
  f1: number;
}

function evaluateWeights(
  labelled: LabelledPair[],
  candidate: WeightCandidate
): F1Stats {
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const { pair, label } of labelled) {
    const score = computeScore(pair, candidate);
    const predicted = score >= candidate.threshold ? "different" : "same";
    if (label === "different" && predicted === "different") tp++;
    else if (label === "same" && predicted === "different") fp++;
    else if (label === "different" && predicted === "same") fn++;
  }

  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1 };
}

function gridSearch(trainSet: LabelledPair[]): WeightCandidate {
  let bestCandidate: WeightCandidate = {
    gap: 0.4, path: 0.25, vocab: 0.15, marker: 0.15, commit: 0.30, threshold: 0.5,
  };
  let bestF1 = -1;

  for (const gap of WEIGHT_GRID) {
    for (const path of WEIGHT_GRID) {
      for (const vocab of WEIGHT_GRID) {
        for (const marker of WEIGHT_GRID) {
          for (const commit of WEIGHT_GRID) {
            for (const threshold of THRESHOLD_GRID) {
              const candidate: WeightCandidate = { gap, path, vocab, marker, commit, threshold };
              const { f1 } = evaluateWeights(trainSet, candidate);
              if (f1 > bestF1) {
                bestF1 = f1;
                bestCandidate = { ...candidate };
              }
            }
          }
        }
      }
    }
  }

  return bestCandidate;
}

// ─── Confirmation prompt ──────────────────────────────────────────────────────

async function askForConsent(samples: MessagePair[]): Promise<boolean> {
  console.log("\n─── SAMPLE PAIRS (5 random) ───\n");

  // Print 5 random samples (or fewer if not enough pairs).
  const rng = seededRandom(Date.now() ^ 0xdeadbeef);
  const shuffled = [...samples].sort(() => rng() - 0.5);
  const preview = shuffled.slice(0, 5);

  for (let i = 0; i < preview.length; i++) {
    const pair = preview[i]!;
    console.log(`[Pair ${i + 1}]`);
    console.log(`  Session:    ${pair.sessionId}`);
    console.log(`  Gap:        ${Math.round(pair.gapMinutes)} min`);
    console.log(`  Prev files: ${pair.prevPaths.slice(0, 3).join(", ") || "(none)"}`);
    console.log(`  Curr files: ${pair.currPaths.slice(0, 3).join(", ") || "(none)"}`);
    console.log(`  Prev prompt: ${pair.prevPrompt?.slice(0, 200) ?? "(none)"}`);
    console.log(`  Curr prompt: ${pair.currPrompt?.slice(0, 200) ?? "(none)"}`);
    console.log();
  }

  console.log("PRIVACY NOTICE: The pairs above will be sent to the Anthropic API.");
  console.log("See: https://docs.anthropic.com/en/docs/legal-aspects/data-usage");
  console.log();
  console.log('Type "yes" (exactly) to proceed, or anything else to abort:');

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("> ", (answer) => {
      rl.close();
      resolve(answer.trim() === "yes");
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Main entry point.
 *
 * @param argv         Argument vector (default: process.argv.slice(2)).
 * @param apiClient    Optional injected Anthropic client for testing.
 *                     When omitted a real client is constructed from ANTHROPIC_API_KEY.
 * @param stdinLines   Optional array of pre-supplied stdin lines (for testing the
 *                     consent prompt without actually blocking on readline).
 * @param storeFactory Optional factory for the store (for testing; omit for real use).
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  apiClient?: Pick<Anthropic, "messages">,
  stdinLines?: string[],
  storeFactory?: () => TunerStore
): Promise<void> {
  const args = parseArgs(argv);

  // ── Step 1: Load store and sample pairs ─────────────────────────────────────
  let store: TunerStore;
  try {
    store = storeFactory ? storeFactory() : new Store();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to open store: ${redactAuthHeader(msg)}`);
    process.exit(1);
  }

  let pairs: MessagePair[];
  try {
    pairs = samplePairs(store, args.sampleSize);
  } finally {
    store.close();
  }

  if (pairs.length === 0) {
    console.error("ERROR: No message pairs found in the store. Ensure the store has been populated.");
    process.exit(1);
  }

  // ── Step 2: Dry-run or consent check ────────────────────────────────────────
  if (args.dryRun || !args.iHaveReviewedTheData) {
    // Print sample pairs.
    console.log("\n─── DRY-RUN: SAMPLE PAIRS (5 random) ───\n");
    const rng = seededRandom(Date.now() ^ 0xdeadbeef);
    const shuffled = [...pairs].sort(() => rng() - 0.5);
    const preview = shuffled.slice(0, 5);
    for (let i = 0; i < preview.length; i++) {
      const pair = preview[i]!;
      console.log(`[Pair ${i + 1}]`);
      console.log(`  Session:    ${pair.sessionId}`);
      console.log(`  Gap:        ${Math.round(pair.gapMinutes)} min`);
      console.log(`  Prev files: ${pair.prevPaths.slice(0, 3).join(", ") || "(none)"}`);
      console.log(`  Curr files: ${pair.currPaths.slice(0, 3).join(", ") || "(none)"}`);
      console.log(`  Prev prompt: ${pair.prevPrompt?.slice(0, 200) ?? "(none)"}`);
      console.log(`  Curr prompt: ${pair.currPrompt?.slice(0, 200) ?? "(none)"}`);
      console.log();
    }
    console.log(`Sampled ${pairs.length} pairs total.`);
    console.log("DRY-RUN mode: no API calls made.");
    console.log("Pass --i-have-reviewed-the-data to proceed with labelling.");
    return;
  }

  // ── Step 3: Interactive consent prompt ───────────────────────────────────────
  let consented: boolean;
  if (stdinLines !== undefined) {
    // Test injection path: no real readline.
    const line = stdinLines.shift() ?? "";
    console.log("\n─── SAMPLE PAIRS (5 random) ───\n");
    const rng = seededRandom(Date.now() ^ 0xdeadbeef);
    const shuffled = [...pairs].sort(() => rng() - 0.5);
    const preview = shuffled.slice(0, 5);
    for (let i = 0; i < preview.length; i++) {
      const pair = preview[i]!;
      console.log(`[Pair ${i + 1}] session=${pair.sessionId}`);
    }
    console.log();
    console.log("PRIVACY NOTICE: The pairs above will be sent to the Anthropic API.");
    console.log("See: https://docs.anthropic.com/en/docs/legal-aspects/data-usage");
    console.log();
    console.log('Type "yes" (exactly) to proceed, or anything else to abort:');
    console.log(`> ${line}`);
    consented = line.trim() === "yes";
  } else {
    consented = await askForConsent(pairs);
  }

  if (!consented) {
    console.log("Aborted — no API calls made.");
    return;
  }

  // ── Step 4: Build API client ─────────────────────────────────────────────────
  const client: Pick<Anthropic, "messages"> = apiClient ?? (() => {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      console.error("ERROR: ANTHROPIC_API_KEY is not set.");
      process.exit(1);
    }
    return new Anthropic({ apiKey });
  })();

  // ── Step 5: Label pairs ──────────────────────────────────────────────────────
  console.log(`\nLabelling ${pairs.length} pairs via claude-haiku-4-5 …`);
  const labelled: LabelledPair[] = [];

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    if ((i + 1) % 50 === 0) {
      console.log(`  ${i + 1}/${pairs.length} …`);
    }
    const result = await labelPair(client, pair);
    if (result !== null) {
      labelled.push(result);
    }
  }

  console.log(`Labelled ${labelled.length} / ${pairs.length} pairs (${pairs.length - labelled.length} skipped).`);

  if (labelled.length === 0) {
    console.error("ERROR: No pairs were successfully labelled. Cannot fit weights.");
    process.exit(1);
  }

  // ── Step 6: Train/test split ─────────────────────────────────────────────────
  // Shuffle deterministically (same seed for reproducibility given same data).
  const rng = seededRandom(0xbeefc0de);
  const shuffledLabelled = [...labelled].sort(() => rng() - 0.5);
  const testSize = Math.max(1, Math.round(shuffledLabelled.length * args.holdOut));
  const trainSize = shuffledLabelled.length - testSize;
  const trainSet = shuffledLabelled.slice(0, trainSize);
  const testSet = shuffledLabelled.slice(trainSize);

  // ── Step 7: Grid search on train set ────────────────────────────────────────
  console.log(`\nGrid searching over weights (train=${trainSize}, test=${testSize}) …`);
  const bestWeights = gridSearch(trainSet);

  // ── Step 8: Evaluate on test set ────────────────────────────────────────────
  const testStats = evaluateWeights(testSet, bestWeights);
  console.log(`\nTest set results:`);
  console.log(`  Precision: ${testStats.precision.toFixed(3)}`);
  console.log(`  Recall:    ${testStats.recall.toFixed(3)}`);
  console.log(`  F1:        ${testStats.f1.toFixed(3)}`);
  console.log(`\nBest weights:`);
  console.log(JSON.stringify(bestWeights, null, 2));

  // ── Step 9: Write output ─────────────────────────────────────────────────────
  const result: TuningResult = {
    version: 1,
    model: "claude-haiku-4-5",
    sampledAt: new Date().toISOString(),
    sampleSize: pairs.length,
    trainSize,
    testSize,
    testF1: Math.round(testStats.f1 * 10000) / 10000,
    weights: {
      gap: bestWeights.gap,
      path: bestWeights.path,
      vocab: bestWeights.vocab,
      marker: bestWeights.marker,
      commit: bestWeights.commit,
      threshold: bestWeights.threshold,
    },
  };

  // Print diff against previous weights.
  if (existsSync(args.output)) {
    try {
      const prev: TuningResult = JSON.parse(readFileSync(args.output, "utf8")) as TuningResult;
      const prevW = prev.weights;
      const newW = result.weights;
      console.log("\nDiff vs previous weights:");
      for (const key of Object.keys(newW) as Array<keyof typeof newW>) {
        const before = prevW[key] ?? "(missing)";
        const after = newW[key];
        if (before !== after) {
          console.log(`  ${key}: ${before} → ${after}`);
        } else {
          console.log(`  ${key}: ${after} (unchanged)`);
        }
      }
    } catch {
      console.log("(could not parse previous weights file for diff)");
    }
  }

  writeFileSync(args.output, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(`\nWeights written to: ${args.output}`);
  console.log("Review the diff above before committing.");
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// Only run main() when invoked directly (not when imported by tests).
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/^.*[\\/]/, ""))
) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: ${redactAuthHeader(msg)}`);
    process.exit(1);
  });
}
