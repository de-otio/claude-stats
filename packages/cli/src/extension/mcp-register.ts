/**
 * Auto-register the claude-stats MCP server in Claude Code's global settings
 * (~/.claude/settings.json) on extension activation.
 *
 * The MCP server runs as a child process using the `mcp.js` bundle that ships
 * alongside this extension (extension/dist/mcp.js). Using an absolute path to
 * the bundled file means the server works regardless of whether `claude-stats`
 * is installed globally — and survives extension updates by always pointing to
 * the currently installed version.
 *
 * The registration is re-written on every activation so stale entries (e.g.
 * from a previous install that used `npx claude-stats mcp`) are corrected.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const MCP_KEY = "claude-stats";

interface ClaudeSettings {
  mcpServers?: Record<string, { command: string; args: string[] }>;
  [key: string]: unknown;
}

/**
 * Resolve the absolute path to the bundled mcp.js.
 *
 * `__dirname` inside the CJS bundle is the directory containing extension.js,
 * i.e. `<install-path>/dist/`. The mcp.js bundle is built alongside it.
 */
function resolveMcpEntry(): { command: string; args: string[] } {
  const mcpJs = path.join(__dirname, "mcp.js");
  return {
    command: process.execPath,          // absolute path to the current Node binary
    args: ["--experimental-sqlite", mcpJs],
  };
}

export function ensureMcpServer(_context: vscode.ExtensionContext): void {
  try {
    const { command, args } = resolveMcpEntry();

    // Read existing settings
    let settings: ClaudeSettings = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      try {
        settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8")) as ClaudeSettings;
      } catch {
        settings = {};
      }
    }

    // Check if the entry already points to the correct mcp.js path.
    // Re-register when: entry is absent, command changed, or args changed
    // (catches stale "npx claude-stats mcp" entries from previous installs).
    const existing = settings.mcpServers?.[MCP_KEY];
    const argsMatch = existing &&
      existing.command === command &&
      JSON.stringify(existing.args) === JSON.stringify(args);

    if (argsMatch) return; // Already up-to-date

    // Register / update
    if (!settings.mcpServers) settings.mcpServers = {};
    settings.mcpServers[MCP_KEY] = { command, args };

    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");

    if (!existing) {
      void vscode.window.showInformationMessage(
        "Claude Stats MCP server registered. Your AI agent can now query your usage stats.",
      );
    }
  } catch (err) {
    // Non-fatal — don't block extension activation
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`claude-stats: failed to register MCP server: ${msg}`);
  }
}
