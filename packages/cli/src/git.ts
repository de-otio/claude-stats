/**
 * Git utilities — reads metadata from .git/ directly without spawning a process.
 */
import fs from "fs";
import path from "path";

/**
 * Return the URL of the "origin" remote for the git repo at projectPath,
 * or null if the directory is not a git repo or has no origin remote.
 *
 * Reads .git/config directly; no shell execution.
 */
export function getGitRemoteUrl(projectPath: string): string | null {
  try {
    const configPath = path.join(projectPath, ".git", "config");
    const config = fs.readFileSync(configPath, "utf8");
    // Match the [remote "origin"] section, then capture the url line.
    // The section ends at the next [ or end-of-file.
    const sectionMatch = config.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\[|$)/);
    if (!sectionMatch) return null;
    const urlMatch = sectionMatch[1]!.match(/^\s*url\s*=\s*(.+)$/m);
    return urlMatch ? urlMatch[1]!.trim() : null;
  } catch {
    return null;
  }
}
