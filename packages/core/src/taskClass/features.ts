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

/**
 * Tools whose contribution to `messages.file_paths` is a genuine FILE path.
 *
 * `file_paths` is not a list of files. `packages/core/src/parser/session.ts`
 * fills that one column from three different shapes: the `file_path` argument
 * of the tools below, the Bash tool's `input.cwd` (a DIRECTORY), and
 * `dirname(pattern)` for Glob (a directory, or a literal wildcard like `src/**`
 * when the pattern nests). Counting all three as edited files lets a session
 * cross `REFACTOR_MIN_FILES` on directories it never changed.
 *
 * `NotebookEdit` is listed even though the parser contributes no path for it
 * today: including a tool that contributes nothing changes no current output,
 * and it means a later parser change that DOES record `notebook_path` is
 * honoured rather than silently discarded.
 */
const FILE_PATH_TOOLS: ReadonlySet<string> = new Set([
  "Read", "Edit", "Write", "MultiEdit", "NotebookEdit",
]);

/** Tools whose contribution to `file_paths` is a directory or a glob pattern. */
const DIR_PATH_TOOLS: ReadonlySet<string> = new Set(["Glob", "Bash"]);

/** Glob metacharacters. A path carrying one of these is a pattern, not a file. */
const GLOB_METACHARS: ReadonlySet<string> = new Set(["*", "?", "[", "]", "{", "}"]);

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

/**
 * Path segments that mark infrastructure regardless of the file's extension.
 *
 * **Dot-prefixed only, deliberately.** Stored paths are absolute, so a segment
 * scan sees the entire home and repository prefix, not just the part inside the
 * project. `.github` / `.circleci` / `.gitlab` / `.vscode` are tool-reserved
 * names that mean the same thing wherever they appear, so scanning for them
 * anywhere is safe.
 *
 * The bare generic names an earlier draft also scanned for — `k8s`, `helm`,
 * `charts`, `terraform`, `deploy` — are only meaningful RELATIVE TO THE PROJECT
 * ROOT, which this module does not receive. Scanned absolutely they matched any
 * ancestor directory: `/home/u/repos/deploy/src/order.ts` was config, so an
 * ordinary TypeScript rename sweep inside a repository (or a monorepo package)
 * named `deploy`, `charts`, `k8s`, `helm` or `terraform` was reported as
 * `config-chore` — at HIGH confidence, since `configShare` was then 1.
 *
 * Threading a project root would move that boundary rather than remove it: a
 * monorepo package named `deploy` is still misread unless the generic segments
 * are additionally restricted to the first root-relative segment, at which
 * point they catch almost nothing the extension rule missed — real files under
 * `terraform/`, `k8s/`, `helm/` and `charts/` already match on `.tf`, `.tfvars`,
 * `.hcl`, `.yaml`, `.yml` or `.json`. The residual recall loss is a file with a
 * non-config extension inside such a directory (`deploy/rollout.sh`); the
 * residual false positive it removes is unbounded. Precision over recall: where
 * the rule cannot be made precise, it abstains.
 */
const CONFIG_SEGMENTS: ReadonlySet<string> = new Set([
  ".github", ".circleci", ".gitlab", ".vscode",
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
 * True when a path is structurally a FILE rather than a directory or a pattern.
 *
 * Used only to disambiguate a message that mixes a file-taking tool with a
 * directory-contributing one, where the stored data cannot say which path came
 * from which tool. A glob metacharacter is decisive; otherwise a file is taken
 * to have an extension, or a known extension-less config basename
 * (`Dockerfile`, `Makefile`, …). Conservative by design — an extension-less
 * `LICENSE` edited in the same message as a Bash call is dropped, which costs a
 * file from a count rather than adding one that was never edited.
 *
 * No regular expression, per this module's ReDoS guard.
 */
function looksLikeFile(p: string): boolean {
  for (const ch of p) if (GLOB_METACHARS.has(ch)) return false;
  const { base, ext } = splitPath(p);
  return ext !== "" || CONFIG_BASENAMES.has(base);
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
 * **Not every `file_paths` entry is a file.** The parser fills that column from
 * three shapes: a real `file_path` argument, the Bash tool's `input.cwd`, and
 * `dirname(pattern)` for Glob. The last two are directories or literal
 * wildcards. Tool names and paths are stored per message but not paired, so the
 * per-message tool set is what decides:
 *
 *  - no file-taking tool in the message → every path in it came from Bash or
 *    Glob and is dropped outright (fully decidable);
 *  - file-taking tools and no Bash/Glob → every path is a real file, kept as
 *    stored, even an unusual extension-less one (fully decidable);
 *  - both → the paths are a mixture and `looksLikeFile` filters it, which drops
 *    a directory and a glob pattern and keeps anything with an extension.
 *
 * **Edited vs touched.** Within a kept set, a message containing at least one
 * mutating tool has its paths attributed to the change — the same approximation
 * `cost-per-task/evidence/gather.ts` already makes when it builds edit events.
 * It over-counts when one message mixes a Read and an Edit, and that is the
 * honest ceiling of the stored data.
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
    let fileToolHere = false;
    let dirToolHere = false;
    for (const tool of m.tools ?? []) {
      toolCalls++;
      if (EDIT_TOOLS.has(tool)) { editCalls++; mutatingHere = true; }
      else if (WRITE_TOOLS.has(tool)) { writeCalls++; mutatingHere = true; }
      else if (tool === "Read") readCalls++;
      else if (SEARCH_TOOLS.has(tool)) searchCalls++;
      else if (tool === "Bash") bashCalls++;
      if (FILE_PATH_TOOLS.has(tool)) fileToolHere = true;
      if (DIR_PATH_TOOLS.has(tool)) dirToolHere = true;
    }
    // A message with no file-taking tool contributed only a Bash cwd or a Glob
    // dirname; neither is a file, so neither may reach a file count.
    if (fileToolHere) {
      for (const p of m.filePaths ?? []) {
        if (typeof p !== "string" || p.length === 0) continue;
        if (dirToolHere && !looksLikeFile(p)) continue;
        files.add(p);
        if (mutatingHere) edited.add(p);
      }
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
