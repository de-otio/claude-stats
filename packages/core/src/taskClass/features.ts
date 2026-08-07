/**
 * Feature derivation for the task-class classifier (spec §5.3, §5.6).
 *
 * Pure and order-independent: every feature is a sum or a set cardinality over
 * a session's messages, so the class cannot depend on the order SQLite happened
 * to return rows in. No clock, no RNG, no I/O.
 *
 * SECURITY: file paths are matched with `Set.has` and index lookups ONLY — no
 * regular expression is ever applied to a path or a tool name. Paths are read
 * here and immediately reduced to counts; nothing downstream sees them.
 */
import type { TaskClassFeatures } from "./types.js";

/** Tools that create or modify workspace files. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "NotebookEdit"]);
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write"]);
const SEARCH_TOOLS: ReadonlySet<string> = new Set(["Grep", "Glob"]);

/** Config/infra file extensions (spec §5.6). Compared lowercased, with the dot. */
const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set([
  ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".properties", ".lock", ".tf", ".tfvars", ".hcl", ".gradle", ".bzl", ".plist",
]);

/** Config/infra basenames — files with no extension, or dotfiles. */
const CONFIG_BASENAMES: ReadonlySet<string> = new Set([
  "dockerfile", "makefile", "procfile", ".gitignore", ".dockerignore",
  ".npmrc", ".nvmrc", ".editorconfig", ".eslintrc", ".prettierrc",
  ".babelrc", ".gitattributes",
]);

/** Path segments that mark infrastructure regardless of the file's extension. */
const CONFIG_SEGMENTS: ReadonlySet<string> = new Set([
  ".github", ".circleci", ".gitlab", ".vscode", "k8s", "helm", "charts",
  "terraform", "deploy",
]);

/** Documentation / prose extensions (spec §5.6). */
const PROSE_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

/**
 * Split a path into its lowercased basename and extension without a regex.
 * Handles both separators; a leading-dot basename (`.npmrc`) has NO extension,
 * which is why the dot is only treated as an extension marker past index 0.
 */
function splitPath(p: string): { base: string; ext: string; segments: string[] } {
  const lower = p.toLowerCase();
  const segments = lower.split("/").flatMap((s) => s.split("\\")).filter((s) => s.length > 0);
  const base = segments.length > 0 ? segments[segments.length - 1]! : lower;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  return { base, ext, segments };
}

/** True when a path is configuration or infrastructure (spec §5.6). */
export function isConfigPath(p: string): boolean {
  const { base, ext, segments } = splitPath(p);
  if (CONFIG_BASENAMES.has(base)) return true;
  if (ext !== "" && CONFIG_EXTENSIONS.has(ext)) return true;
  // The basename is excluded from the segment scan so a file literally named
  // `deploy` is not infra by accident; only DIRECTORIES mark infra.
  for (let i = 0; i < segments.length - 1; i++) {
    if (CONFIG_SEGMENTS.has(segments[i]!)) return true;
  }
  return false;
}

/** True when a path is documentation/prose (spec §5.6). */
export function isProsePath(p: string): boolean {
  const { ext } = splitPath(p);
  return ext !== "" && PROSE_EXTENSIONS.has(ext);
}

/**
 * The narrow per-message projection the classifier needs. Deliberately a
 * structural type rather than `MessageRecord`, so `packages/core` does not have
 * to know how the store shapes a row and tests can build inputs by hand.
 */
export interface TaskClassMessage {
  readonly tools?: readonly string[] | null;
  readonly filePaths?: readonly string[] | null;
  readonly toolErrorCount?: number | null;
  readonly isTurnStart?: boolean | null;
}

/**
 * Reduce a session's messages to the feature vector.
 *
 * Tolerant of missing fields by design: `file_paths` arrived in V10,
 * `tool_error_count` in V11 and `is_turn_start` in V18, so historical rows are
 * genuinely absent rather than zero. Absence carries forward as a count of
 * zero, and the rules that read a file count all require a POSITIVE one — so a
 * pre-V10 session is never read as "changed no files", it simply fails to reach
 * the rules that need that evidence and abstains.
 *
 * **Edited vs touched.** `file_paths` records the path argument of any
 * file-taking tool, reads included, so it cannot alone say what was changed.
 * A message containing at least one mutating tool has its paths attributed to
 * the change — the same approximation `cost-per-task/evidence/gather.ts`
 * already makes when it builds edit events. It over-counts when one message
 * mixes a Read and an Edit, and that is the honest ceiling of the stored data:
 * tool names and path arguments are recorded per message, not paired.
 *
 * `turns` falls back to the message count when no row carries `is_turn_start`,
 * because a zero there would be a pre-V18 artefact rather than a session with
 * no prompts.
 */
export function deriveFeatures(messages: readonly TaskClassMessage[]): TaskClassFeatures {
  let toolCalls = 0;
  let editCalls = 0;
  let writeCalls = 0;
  let readCalls = 0;
  let searchCalls = 0;
  let bashCalls = 0;
  let toolErrors = 0;
  let turnStarts = 0;
  const files = new Set<string>();
  const edited = new Set<string>();

  for (const m of messages) {
    let mutatingHere = false;
    for (const tool of m.tools ?? []) {
      toolCalls++;
      if (EDIT_TOOLS.has(tool)) { editCalls++; mutatingHere = true; }
      else if (WRITE_TOOLS.has(tool)) { writeCalls++; mutatingHere = true; }
      else if (tool === "Read") readCalls++;
      else if (SEARCH_TOOLS.has(tool)) searchCalls++;
      else if (tool === "Bash") bashCalls++;
    }
    for (const p of m.filePaths ?? []) {
      if (typeof p !== "string" || p.length === 0) continue;
      files.add(p);
      if (mutatingHere) edited.add(p);
    }
    const errs = m.toolErrorCount ?? 0;
    if (Number.isFinite(errs) && errs > 0) toolErrors += errs;
    if (m.isTurnStart) turnStarts++;
  }

  let configFiles = 0;
  let proseFiles = 0;
  for (const p of edited) {
    if (isConfigPath(p)) configFiles++;
    else if (isProsePath(p)) proseFiles++;
  }

  return {
    toolCalls,
    editCalls,
    writeCalls,
    readCalls,
    searchCalls,
    bashCalls,
    filesTouched: files.size,
    editedFiles: edited.size,
    configFiles,
    proseFiles,
    toolErrors,
    turns: turnStarts > 0 ? turnStarts : messages.length,
  };
}
