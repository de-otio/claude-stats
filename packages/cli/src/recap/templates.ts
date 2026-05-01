/**
 * Phrase-template bank for daily recap rendering (v3.04).
 *
 * Used by both the CLI reporter (printDailyRecap) and recommended for
 * agent-side rendering. Confidence drives template selection; backtick
 * escaping (SR-2) is enforced at this layer for every untrusted slot.
 *
 * NOTE: This module intentionally does NOT import from reporter/index.ts to
 * avoid a circular dependency (reporter imports templates, templates must not
 * import reporter). Duration formatting is implemented locally.
 */
import type { DailyDigestItem } from "./types.js";

// ─── Duration helper (local, avoids circular import with reporter) ────────────

/**
 * Format a duration in milliseconds as "1h 12m" / "38m" / "< 1m".
 * Mirrors reporter/index.ts formatDuration — kept in sync manually.
 */
function formatDurationMs(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "< 1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

// ─── Context ─────────────────────────────────────────────────────────────────

export interface TemplateContext {
  item: DailyDigestItem;
  projectBasename: string;
  durationHuman: string; // "1h 12m" / "38m"
  costHuman: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Escape backtick characters so the value cannot break out of a
 * single-backtick delimiter (SR-2).
 */
export function escapeBacktick(s: string): string {
  return s.replace(/`/g, "\\`");
}

/**
 * Strip the wrapUntrusted() envelope from a firstPrompt value.
 * Returns null if input is null.
 *
 * SR-2: The stripped value must still be escaped and re-wrapped in
 * backticks before printing.
 */
export function stripUntrustedEnvelope(s: string | null): string | null {
  if (s == null) return null;
  const m = s.match(/<untrusted-stored-content>([\s\S]*?)<\/untrusted-stored-content>/);
  return m ? m[1]! : s;
}

/**
 * Prepare the firstPrompt for safe inline rendering:
 * 1. Strip the untrusted envelope.
 * 2. Truncate at 80 code points.
 * 3. Escape backticks (SR-2).
 *
 * Returns `(no prompt)` when the inner text is null/empty.
 */
function preparePrompt(firstPrompt: string | null): string {
  const inner = stripUntrustedEnvelope(firstPrompt);
  if (inner === null || inner.trim() === "") return "(no prompt)";
  // Truncate at 80 code points before escaping (spec: "before escape")
  const codePoints = [...inner];
  const truncated =
    codePoints.length > 80
      ? codePoints.slice(0, 80).join("") + "…"
      : inner;
  return escapeBacktick(truncated);
}

// ─── Template definitions ─────────────────────────────────────────────────────

export interface Template {
  name: "shipped" | "merged-pr" | "drafted" | "worked-on" | "brief";
  applies: (ctx: TemplateContext) => boolean;
  render: (ctx: TemplateContext) => string;
}

export const TEMPLATES: readonly Template[] = [
  // high + commits pushed
  {
    name: "shipped",
    applies: ({ item }) =>
      item.confidence === "high" &&
      !!item.git?.pushed &&
      (item.git?.commitsToday ?? 0) > 0,
    render: ({ item, projectBasename, durationHuman }) => {
      const escapedPrompt = preparePrompt(item.firstPrompt);
      return (
        `Shipped \`${escapedPrompt}\` (${projectBasename}) — ` +
        `${item.git!.commitsToday} commits, ${item.git!.filesChanged} files, ~${durationHuman}`
      );
    },
  },
  // high + PR merged
  {
    name: "merged-pr",
    applies: ({ item }) =>
      item.confidence === "high" && (item.git?.prMerged ?? 0) > 0,
    render: ({ item, projectBasename, durationHuman }) => {
      const escapedPrompt = preparePrompt(item.firstPrompt);
      return (
        `Merged \`${escapedPrompt}\` (${projectBasename}) — ` +
        `${item.git!.filesChanged} files, ~${durationHuman}`
      );
    },
  },
  // medium + local commits
  {
    name: "drafted",
    applies: ({ item }) =>
      item.confidence === "medium" && (item.git?.commitsToday ?? 0) > 0,
    render: ({ item, projectBasename, durationHuman }) => {
      const escapedPrompt = preparePrompt(item.firstPrompt);
      return (
        `Drafted \`${escapedPrompt}\` (${projectBasename}) — ` +
        `${item.git!.commitsToday} local commits, ${item.git!.filesChanged} files, ~${durationHuman}`
      );
    },
  },
  // medium + edits, no commits (catch-all for medium)
  {
    name: "worked-on",
    applies: ({ item }) => item.confidence === "medium",
    render: ({ item, projectBasename, durationHuman }) => {
      const escapedPrompt = preparePrompt(item.firstPrompt);
      return (
        `Worked on \`${escapedPrompt}\` (${projectBasename}) — ` +
        `${item.filePathsTouched.length} files touched, no commits yet, ~${durationHuman}`
      );
    },
  },
  // low confidence (when shown via --all)
  {
    name: "brief",
    applies: ({ item }) => item.confidence === "low",
    render: ({ item, projectBasename, durationHuman }) => {
      const escapedPrompt = preparePrompt(item.firstPrompt);
      return `Brief: \`${escapedPrompt}\` (${projectBasename}, ~${durationHuman})`;
    },
  },
] as const;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Select the first template whose `applies` predicate matches the item.
 * Falls back to the `brief` template when no other template matches
 * (e.g. undefined/null confidence).
 */
export function pickTemplate(item: DailyDigestItem): Template {
  const ctx = buildContext(item);
  for (const tpl of TEMPLATES) {
    if (tpl.applies(ctx)) return tpl;
  }
  // Guaranteed fallback: brief is always last and covers everything
  return TEMPLATES[TEMPLATES.length - 1]!;
}

/**
 * Build a TemplateContext for the given item.
 * Exported for testing; callers can also use renderItem directly.
 */
export function buildContext(item: DailyDigestItem): TemplateContext {
  const projectBasename = item.project.split("/").pop() ?? item.project;
  const durationMs =
    item.duration.activeMs > 0 ? item.duration.activeMs : item.duration.wallMs;
  const durationHuman = formatDurationMs(durationMs);
  const costHuman = `$${item.estimatedCost.toFixed(2)}`;
  return { item, projectBasename, durationHuman, costHuman };
}

/**
 * Select the right template for `item` and render it to a string.
 *
 * SR-2: All untrusted slots (firstPrompt) are stripped of their
 * envelope, truncated, backtick-escaped, and re-wrapped in single
 * backticks inside this function.
 */
export function renderItem(item: DailyDigestItem): string {
  const ctx = buildContext(item);
  const tpl = pickTemplate(item);
  return tpl.render(ctx);
}
