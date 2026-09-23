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

export interface SessionFile {
  filePath: string;
  projectPath: string; // decoded project path
  projectDir: string; // raw encoded directory name
  isSubagent: boolean;
  /**
   * The parent session's id, when the layout itself names it: set for
   * subagent files under `<project>/<sessionId>/subagents/`, null otherwise.
   * Entries in those files carry the PARENT's `sessionId`, so the aggregator
   * uses this to give the subagent its own session row instead of merging it
   * into the parent's.
   */
  parentSessionId: string | null;
}

/** Discover all session JSONL files under ~/.claude/projects/.
 *  Includes subagent JSONL files in both layouts Claude Code has used:
 *  `<project>/subagents/*.jsonl` (older) and
 *  `<project>/<sessionId>/subagents/*.jsonl` (current). */
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
      collectJsonlFiles(subagentsDir, projectPath, projectDir, true, null, result);
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
      collectJsonlFiles(nestedSubagentsDir, projectPath, projectDir, true, entry, result);
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

function collectJsonlFiles(
  dir: string,
  projectPath: string,
  projectDir: string,
  isSubagent: boolean,
  parentSessionId: string | null,
  result: SessionFile[]
): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
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
