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
}

/** Discover all session JSONL files under ~/.claude/projects/.
 *  Includes subagent JSONL files in subagents/ subdirectories. */
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
    collectJsonlFiles(projectDirPath, projectPath, projectDir, false, result);

    // Subagent files
    const subagentsDir = path.join(projectDirPath, "subagents");
    let subagentsStat: fs.Stats | null = null;
    try {
      subagentsStat = fs.lstatSync(subagentsDir);
    } catch {
      subagentsStat = null;
    }
    if (
      subagentsStat &&
      !subagentsStat.isSymbolicLink() &&
      subagentsStat.isDirectory()
    ) {
      collectJsonlFiles(subagentsDir, projectPath, projectDir, true, result);
    }
  }

  return result;
}

function collectJsonlFiles(
  dir: string,
  projectPath: string,
  projectDir: string,
  isSubagent: boolean,
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
