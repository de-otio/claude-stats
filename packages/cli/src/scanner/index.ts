/**
 * Scans ~/.claude/projects/ to discover session JSONL files.
 *
 * Builds a dynamic inventory — does not hardcode subdirectory names since
 * Claude Code has reorganised its directory structure in the past.
 * See doc/analysis/08-resilience.md — Filesystem Monitoring.
 */
import fs from "fs";
import path from "path";
import { paths, decodeProjectPath } from "@claude-stats/core/paths";
import { SUBAGENT_TRANSCRIPT_RE } from "../aggregator/subagentMetaFile.js";

/**
 * How many directory levels below a `subagents/` directory are searched. The
 * real tree needs two (`workflows/<wf_id>/`); the cap only keeps a pathological
 * tree from making the scan unbounded.
 */
const MAX_SUBAGENT_DEPTH = 4;

export interface SessionFile {
  filePath: string;
  projectPath: string; // decoded project path
  projectDir: string; // raw encoded directory name
  isSubagent: boolean;
  /**
   * The parent session's id, when the layout itself names it: set for
   * subagent files anywhere under `<project>/<sessionId>/subagents/` (including
   * `workflows/<wf_id>/`), null otherwise. Entries in those files carry the
   * PARENT's `sessionId`, so the aggregator uses this to give the subagent its
   * own session row instead of merging it into the parent's.
   */
  parentSessionId: string | null;
}

/** Discover all session JSONL files under ~/.claude/projects/.
 *  Includes subagent JSONL files in the layouts Claude Code has used:
 *  `<project>/subagents/*.jsonl` (older),
 *  `<project>/<sessionId>/subagents/*.jsonl` (current) and
 *  `<project>/<sessionId>/subagents/workflows/<wf_id>/agent-*.jsonl`
 *  (Workflow-tool agents). */
export function discoverSessionFiles(): SessionFile[] {
  const result: SessionFile[] = [];

  if (!fs.existsSync(paths.projectsDir)) return result;

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(paths.projectsDir);
  } catch {
    return result;
  }

  for (const projectDir of projectDirs) {
    const projectDirPath = path.join(paths.projectsDir, projectDir);
    let stat: fs.Stats;
    try {
      // lstatSync (not statSync) so we see symlinks themselves, not their
      // targets. Defence-in-depth: refuse to traverse into symlinked
      // directories so a symlink planted under ~/.claude/projects/ can't
      // redirect the scan anywhere on disk.
      stat = fs.lstatSync(projectDirPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory()) continue;

    const projectPath = decodeProjectPath(projectDir);

    // Top-level session files
    collectJsonlFiles(projectDirPath, projectPath, projectDir, false, null, result);

    // Subagent files, older layout: <project>/subagents/
    const subagentsDir = path.join(projectDirPath, "subagents");
    if (isRealDirectory(subagentsDir)) {
      collectSubagentFiles(subagentsDir, projectPath, projectDir, null, result, 0);
    }

    // Subagent files, current layout: <project>/<sessionId>/subagents/.
    // Collected after the top-level files so a parent session is stored
    // before its children within one collect run.
    let entries: string[];
    try {
      entries = fs.readdirSync(projectDirPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "subagents") continue;
      const sessionDirPath = path.join(projectDirPath, entry);
      if (!isRealDirectory(sessionDirPath)) continue;
      const nestedSubagentsDir = path.join(sessionDirPath, "subagents");
      if (!isRealDirectory(nestedSubagentsDir)) continue;
      collectSubagentFiles(nestedSubagentsDir, projectPath, projectDir, entry, result, 0);
    }
  }

  return result;
}

/** True for a directory that is not a symlink. Same defence as above: never
 *  traverse a symlinked directory, at any level. */
function isRealDirectory(dirPath: string): boolean {
  try {
    const stat = fs.lstatSync(dirPath);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Collect the transcripts under a `subagents/` directory, descending into real
 * subdirectories (Workflow-tool agents live in `workflows/<wf_id>/`).
 *
 * The directory itself keeps its historical rule — any `*.jsonl`. Below it only
 * `agent-<id>.jsonl` is taken: the aggregator keys a subagent's session id on
 * the file basename, so a stray sidecar such as the workflow `journal.jsonl`
 * would otherwise become one colliding session named `journal`.
 */
function collectSubagentFiles(
  dir: string,
  projectPath: string,
  projectDir: string,
  parentSessionId: string | null,
  result: SessionFile[],
  depth: number
): void {
  collectJsonlFiles(
    dir,
    projectPath,
    projectDir,
    true,
    parentSessionId,
    result,
    depth === 0 ? undefined : (name) => SUBAGENT_TRANSCRIPT_RE.test(name)
  );
  if (depth >= MAX_SUBAGENT_DEPTH) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const childPath = path.join(dir, entry);
    if (!isRealDirectory(childPath)) continue;
    collectSubagentFiles(childPath, projectPath, projectDir, parentSessionId, result, depth + 1);
  }
}

function collectJsonlFiles(
  dir: string,
  projectPath: string,
  projectDir: string,
  isSubagent: boolean,
  parentSessionId: string | null,
  result: SessionFile[],
  acceptName?: (name: string) => boolean
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    if (acceptName && !acceptName(entry)) continue;
    const entryPath = path.join(dir, entry);
    // Skip symlinks: only include regular .jsonl files that live directly
    // under ~/.claude/projects/. A symlink could point anywhere on disk
    // and cause us to read (and later surface in the dashboard) arbitrary
    // files the user didn't intend to share. Defence-in-depth.
    try {
      const entryStat = fs.lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) continue;
      if (!entryStat.isFile()) continue;
    } catch {
      continue;
    }
    result.push({
      filePath: entryPath,
      projectPath,
      projectDir,
      isSubagent,
      parentSessionId,
    });
  }
}

/** Get current mtime and size of a file. Returns null if file is gone. */
export function getFileStats(
  filePath: string
): { mtime: number; size: number } | null {
  try {
    const stat = fs.statSync(filePath);
    return { mtime: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}
