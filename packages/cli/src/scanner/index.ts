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
      stat = fs.statSync(projectDirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const projectPath = decodeProjectPath(projectDir);

    // Top-level session files
    collectJsonlFiles(projectDirPath, projectPath, projectDir, false, result);

    // Subagent files
    const subagentsDir = path.join(projectDirPath, "subagents");
    if (fs.existsSync(subagentsDir)) {
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
    result.push({
      filePath: path.join(dir, entry),
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
