/**
 * Platform-aware path resolution for Claude Code data files.
 * See doc/analysis/01-data-sources.md — Platform Paths.
 */
import os from "os";
import path from "path";

const home = os.homedir();

export const paths = {
  /** ~/.claude/ — primary data directory (same on all platforms) */
  claudeDir: path.join(home, ".claude"),

  /** ~/.claude/projects/ — session JSONL files per project */
  projectsDir: path.join(home, ".claude", "projects"),

  /** ~/.claude/history.jsonl — lightweight prompt index */
  historyFile: path.join(home, ".claude", "history.jsonl"),

  /** ~/.claude/cache/changelog.md — used to detect Claude Code version updates */
  changelogFile: path.join(home, ".claude", "cache", "changelog.md"),

  /** ~/.claude-stats/ — tool's own storage, separate from Claude Code's directory */
  statsDir: path.join(home, ".claude-stats"),

  /** ~/.claude-stats/stats.db */
  statsDb: path.join(home, ".claude-stats", "stats.db"),

  /** ~/.claude-stats/quarantine/ */
  quarantineDir: path.join(home, ".claude-stats", "quarantine"),

  /** ~/.claude-stats/config.toml */
  configFile: path.join(home, ".claude-stats", "config.toml"),

  /** ~/.claude.json — Claude Code's main config (account info, OAuth) */
  claudeConfigFile: path.join(home, ".claude.json"),
} as const;

/** Decode a Claude Code project directory name back to a filesystem path.
 *  Claude encodes project paths by replacing '/' with '-'.
 *  The encoded name starts with '-' because the leading '/' becomes '-'. */
export function decodeProjectPath(encodedName: string): string {
  // Replace leading and internal '-' with '/' to recover the original path.
  // Only the first character and path separators were encoded.
  return encodedName.replace(/-/g, "/");
}

/** Encode a filesystem path into Claude's project directory name format. */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}
