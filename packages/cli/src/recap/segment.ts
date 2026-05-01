/**
 * segment.ts — Deterministic topic-segmentation within sessions.
 *
 * Splits a session's messages into topic Segments using a weighted
 * shift-score across five signals: gap, path, vocab, marker, commit.
 *
 * Pure function — no I/O, no async, no globals. Same input always
 * produces byte-identical output.
 *
 * Weights are tunable; see ShiftWeights / DEFAULT_SHIFT_WEIGHTS so that
 * the v3 offline-judge task (C1) can rewrite them without touching
 * this file's logic.
 *
 * Weights are loaded at module initialisation from segment-weights.json
 * in this directory (produced by scripts/tune-segmenter.ts). If the file
 * is absent or malformed, DEFAULT_SHIFT_WEIGHTS from types.ts is used.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MessageRow } from "../store/index.js";
import {
  type Segment,
  type SegmentId,
  type ShiftWeights,
  DEFAULT_SHIFT_WEIGHTS,
} from "./types.js";

// ─── Weight loader ────────────────────────────────────────────────────────────

/**
 * Load shift weights from segment-weights.json at module initialisation.
 *
 * Validates that the parsed object has a `weights` key containing all six
 * numeric fields (gap, path, vocab, marker, commit, threshold). On any
 * error — file missing, JSON parse failure, wrong shape — falls back to
 * DEFAULT_SHIFT_WEIGHTS from types.ts so the segmenter always has a
 * working default.
 */
function loadWeights(): ShiftWeights {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const jsonPath = join(dir, "segment-weights.json");
    const raw = readFileSync(jsonPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "weights" in parsed &&
      parsed.weights !== null &&
      typeof parsed.weights === "object"
    ) {
      const w = parsed.weights as Record<string, unknown>;
      if (
        typeof w["gap"] === "number" &&
        typeof w["path"] === "number" &&
        typeof w["vocab"] === "number" &&
        typeof w["marker"] === "number" &&
        typeof w["commit"] === "number" &&
        typeof w["threshold"] === "number"
      ) {
        return {
          gap: w["gap"],
          path: w["path"],
          vocab: w["vocab"],
          marker: w["marker"],
          commit: w["commit"],
          threshold: w["threshold"],
        };
      }
    }
    return { ...DEFAULT_SHIFT_WEIGHTS };
  } catch {
    return { ...DEFAULT_SHIFT_WEIGHTS };
  }
}

/** Module-level weights: loaded once from segment-weights.json, else defaults. */
const FILE_WEIGHTS: ShiftWeights = loadWeights();

// ─── Constants ────────────────────────────────────────────────────────────────

/** Gap threshold in minutes above which the gap signal fires. */
const GAP_THRESHOLD_MINUTES = 20;

/** Number of messages on each side of a boundary used for path comparison. */
const PATH_WINDOW = 3;

/**
 * Anchored imperative-shift marker regex (case-insensitive).
 * Fires when a user prompt starts with one of these phrases.
 */
const SHIFT_MARKER_RE =
  /^\s*(okay|ok|now|next|let'?s|switch to|moving on|different (?:topic|thing)|new (?:task|topic))\b/i;

/**
 * Stop-words excluded from vocab tokenisation.
 * Specified in the task plan; kept as a Set for O(1) lookup.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of",
  "is", "was", "in", "on", "for", "with", "this",
  "that", "my", "your", "please", "can", "could", "will",
]);

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Parse a message's dedicated `file_paths` JSON column (added in schema v10).
 *
 * The column is stored as a JSON array of strings produced at parse time
 * from tool_use block.input fields (file_path, cwd, Glob pattern dirname).
 * Any parse error returns [] so old / malformed rows degrade gracefully.
 */
function parseFilePaths(filePathsJson: string): readonly string[] {
  try {
    const parsed = JSON.parse(filePathsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

/**
 * Tokenise prompt text for vocabulary comparison.
 * Lowercase → strip punctuation → split on whitespace →
 * drop tokens shorter than 3 chars → drop stop-words.
 */
function tokenise(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

/**
 * Jaccard distance between two sets: `1 - |A ∩ B| / |A ∪ B|`.
 * Returns 0 when both sets are empty (no distance).
 */
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

/**
 * Compute a SHA-256 segmentId from session-stable inputs.
 * Hex-encoded, lowercase — deterministic across runs.
 */
function computeSegmentId(
  sessionId: string,
  index: number,
  openingMessageUuid: string,
): SegmentId {
  return createHash("sha256")
    .update(`${sessionId}:${index}:${openingMessageUuid}`)
    .digest("hex") as SegmentId;
}

/**
 * Collect file paths from a window of messages around a boundary.
 * Reads from the dedicated `file_paths` JSON column (schema v10+),
 * which is populated at parse time from tool_use block.input fields.
 * windowMessages is already the slice to inspect.
 */
function pathSetFromWindow(messages: readonly MessageRow[]): Set<string> {
  const paths: string[] = [];
  for (const msg of messages) {
    for (const p of parseFilePaths(msg.file_paths)) {
      paths.push(p);
    }
  }
  return new Set(paths);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Segment a session's messages into topic Segments.
 *
 * @param messages  All messages in the session, in chronological order.
 *                  The array must not be mutated after calling this function.
 * @param opts      Optional tuning: custom ShiftWeights and/or commit
 *                  timestamps (unix ms) to detect commit-boundary signals.
 * @returns         Immutable array of Segments, ordered by `index`.
 *
 * The algorithm evaluates a shift-score at each consecutive message
 * boundary using five weighted signals:
 *
 *   shift_score(i) =
 *     weights.gap     * (gap_minutes(i-1, i) > 20 ? 1 : 0)
 *   + weights.path    * jaccard_distance(filePathsBefore, filePathsAfter)
 *   + weights.vocab   * jaccard_distance(tokens(prev prompt), tokens(this prompt))
 *   + weights.marker  * (this prompt starts with imperative-shift marker ? 1 : 0)
 *   + weights.commit  * (a commit timestamp lies in (t[i-1], t[i]] ? 1 : 0)
 *
 * A new segment opens when shift_score >= weights.threshold.
 */
export function segmentSession(
  messages: readonly MessageRow[],
  opts?: {
    weights?: ShiftWeights;
    commitTimestamps?: readonly number[];
  },
): readonly Segment[] {
  if (messages.length === 0) return [];

  const weights: ShiftWeights = opts?.weights ?? FILE_WEIGHTS;
  const commitTs: readonly number[] = opts?.commitTimestamps ?? [];

  // Boundary indices: index of the first message in each segment.
  // We start with one segment covering everything, then split.
  const boundaryIndices: number[] = [0];

  for (let i = 1; i < messages.length; i++) {
    // Both indices are in-bounds by loop condition; non-null assertions are safe.
    const prev = messages[i - 1]!;
    const curr = messages[i]!;

    // ── Signal 1: gap ────────────────────────────────────────────────────────
    const tPrev = prev.timestamp ?? 0;
    const tCurr = curr.timestamp ?? 0;
    const gapMinutes = (tCurr - tPrev) / 60_000;
    const gapSignal = gapMinutes > GAP_THRESHOLD_MINUTES ? 1 : 0;

    // ── Signal 2: path ───────────────────────────────────────────────────────
    // Window: up to PATH_WINDOW messages on each side of the boundary.
    const beforeSlice = messages.slice(Math.max(0, i - PATH_WINDOW), i);
    const afterSlice = messages.slice(i, Math.min(messages.length, i + PATH_WINDOW));
    const pathsBefore = pathSetFromWindow(beforeSlice);
    const pathsAfter = pathSetFromWindow(afterSlice);
    const pathSignal = jaccardDistance(pathsBefore, pathsAfter);

    // ── Signal 3: vocab ──────────────────────────────────────────────────────
    // Only contributes when both sides have prompt text (spec §9).
    let vocabSignal = 0;
    if (prev.prompt_text !== null && curr.prompt_text !== null) {
      const tokensPrev = tokenise(prev.prompt_text);
      const tokensCurr = tokenise(curr.prompt_text);
      vocabSignal = jaccardDistance(tokensPrev, tokensCurr);
    }

    // ── Signal 4: marker ─────────────────────────────────────────────────────
    const markerSignal =
      curr.prompt_text !== null && SHIFT_MARKER_RE.test(curr.prompt_text) ? 1 : 0;

    // ── Signal 5: commit ─────────────────────────────────────────────────────
    // Fires when any commit timestamp falls in the half-open interval (tPrev, tCurr].
    const commitSignal = commitTs.some((ts) => ts > tPrev && ts <= tCurr) ? 1 : 0;

    // ── Shift score ──────────────────────────────────────────────────────────
    const score =
      weights.gap * gapSignal +
      weights.path * pathSignal +
      weights.vocab * vocabSignal +
      weights.marker * markerSignal +
      weights.commit * commitSignal;

    if (score >= weights.threshold) {
      boundaryIndices.push(i);
    }
  }

  // ── Build Segments ────────────────────────────────────────────────────────
  const segments: Segment[] = [];

  for (let segIdx = 0; segIdx < boundaryIndices.length; segIdx++) {
    // boundaryIndices[segIdx] is always defined (loop condition ensures it).
    // segMessages is non-empty because boundary indices point to valid message indices.
    const startMsgIdx = boundaryIndices[segIdx]!;
    const endMsgIdx =
      segIdx + 1 < boundaryIndices.length
        ? boundaryIndices[segIdx + 1]!
        : messages.length;

    const segMessages = messages.slice(startMsgIdx, endMsgIdx);
    // segMessages has at least one element by construction (each boundary index is a
    // valid message index, so startMsgIdx < endMsgIdx).
    const firstMsg = segMessages[0]!;
    const lastMsg = segMessages[segMessages.length - 1]!;

    const sessionId = firstMsg.session_id;
    const openingMessageUuid = firstMsg.uuid;

    // Tool histogram: count each tool name across all messages in segment.
    const toolHistogram: Record<string, number> = {};
    for (const msg of segMessages) {
      let tools: unknown;
      try {
        tools = JSON.parse(msg.tools);
      } catch {
        tools = [];
      }
      if (!Array.isArray(tools)) continue;
      for (const t of tools) {
        if (typeof t === "string") {
          toolHistogram[t] = (toolHistogram[t] ?? 0) + 1;
        } else if (
          typeof t === "object" &&
          t !== null &&
          typeof (t as Record<string, unknown>)["name"] === "string"
        ) {
          const name = (t as Record<string, unknown>)["name"] as string;
          toolHistogram[name] = (toolHistogram[name] ?? 0) + 1;
        }
      }
    }

    // File paths: union of all paths from the dedicated file_paths column across
    // all messages in segment. Column populated at parse time from tool_use input.
    const filePathSet = new Set<string>();
    for (const msg of segMessages) {
      for (const p of parseFilePaths(msg.file_paths)) {
        filePathSet.add(p);
      }
    }

    // Opening prompt: first message with non-null prompt_text.
    const openingMsg = segMessages.find((m) => m.prompt_text !== null);
    const openingPromptText = openingMsg?.prompt_text ?? null;

    segments.push({
      segmentId: computeSegmentId(sessionId, segIdx, openingMessageUuid),
      sessionId,
      index: segIdx,
      startTs: firstMsg.timestamp ?? 0,
      endTs: lastMsg.timestamp ?? 0,
      openingPromptText,
      messageUuids: segMessages.map((m) => m.uuid),
      toolHistogram: Object.freeze(toolHistogram),
      filePaths: Array.from(filePathSet).sort(),
    });
  }

  // Segments are already in index order by construction.
  return Object.freeze(segments);
}
