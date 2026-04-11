/**
 * Auto-register the claude-stats MCP server in Claude Code's global settings
 * (~/.claude/settings.json) if not already present.
 *
 * Runs once on extension activation. Idempotent — skips if the entry exists.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { execFileSync } from "node:child_process";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const MCP_KEY = "claude-stats";

interface ClaudeSettings {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function resolveClaudeStatsCommand(): { command: string; args: string[] } {
  // Try to find claude-stats on PATH
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const resolved = execFileSync(which, ["claude-stats"], {
      encoding: "utf-8",
      timeout: 3000,
    }).trim().split("\n")[0]!;
    if (resolved) {
      return { command: resolved, args: ["mcp"] };
    }
  } catch {
    // Not on PATH — fall through
  }

  // Fall back to node with the CLI entry point resolved from this extension's location
  const nodeExec = process.execPath;
  // Extension is at extension/dist/extension.js, CLI dist is at packages/cli/dist/index.js
  // Both relative to the repo root
  const extDir = path.dirname(__dirname); // extension/
  const repoRoot = path.dirname(extDir);
  const cliEntry = path.join(repoRoot, "packages", "cli", "dist", "index.js");

  if (fs.existsSync(cliEntry)) {
    return {
      command: nodeExec,
      args: ["--experimental-sqlite", cliEntry, "mcp"],
    };
  }

  // Last resort: assume npm global install
  return { command: "npx", args: ["claude-stats", "mcp"] };
}

export function ensureMcpServer(_context: vscode.ExtensionContext): void {
  try {
    // Read existing settings
    let settings: ClaudeSettings = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
      settings = JSON.parse(raw) as ClaudeSettings;
    }

    // Check if already registered
    if (settings.mcpServers && MCP_KEY in settings.mcpServers) {
      return; // Already registered
    }

    // Resolve the command
    const { command, args } = resolveClaudeStatsCommand();

    // Register
    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }
    settings.mcpServers[MCP_KEY] = { command, args };

    // Write back
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");

    void vscode.window.showInformationMessage(
      "Claude Stats MCP server registered. Your AI agent can now query your usage stats.",
    );
  } catch (err) {
    // Non-fatal — don't block extension activation
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`claude-stats: failed to register MCP server: ${msg}`);
  }
}
