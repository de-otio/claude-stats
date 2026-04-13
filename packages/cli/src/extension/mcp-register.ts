/**
 * Auto-register the claude-stats MCP server in Claude Code's global config
 * (~/.claude.json) on extension activation.
 *
 * The MCP server runs as a child process using the `mcp.js` bundle that ships
 * alongside this extension (extension/dist/mcp.js). Using an absolute path to
 * the bundled file means the server works regardless of whether `claude-stats`
 * is installed globally — and survives extension updates by always pointing to
 * the currently installed version.
 *
 * The registration is re-written on every activation so stale entries (e.g.
 * from a previous install) are corrected.
 *
 * WHY ~/.claude.json and not ~/.claude/settings.json:
 *   Claude Code CLI reads MCP servers from ~/.claude.json (the "user" scope).
 *   ~/.claude/settings.json is read by the CLI for other settings (permissions,
 *   model) but its mcpServers key is silently ignored for server registration.
 *
 * WHY -e "require(...).startMcpServer()":
 *   mcp.js exports startMcpServer() but does not call it when run as a plain
 *   script. Running `node mcp.js` directly does nothing — the server never
 *   starts. The -e flag invokes the entry point explicitly.
 *
 * WHY we find system Node instead of using process.execPath:
 *   Inside VS Code, process.execPath points to the Electron binary ("Code
 *   Helper (Plugin)"), not a plain Node.js binary. Passing it to Claude Code
 *   as the MCP command causes the server to crash immediately on startup.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import * as vscode from "vscode";

const CLAUDE_JSON_PATH = path.join(os.homedir(), ".claude.json");
const MCP_KEY = "claude-stats";

interface McpEntry {
  type: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface ClaudeJson {
  mcpServers?: Record<string, McpEntry>;
  [key: string]: unknown;
}

/**
 * Find a plain Node.js binary (not VS Code's Electron host).
 *
 * process.execPath inside VS Code is the Electron binary and cannot be used
 * to run standalone Node scripts. We search well-known locations first, then
 * fall back to `which node` / `where node`.
 */
function findNodeBinary(): string {
  // If not running inside Electron we can trust process.execPath directly.
  if (!process.versions.electron) return process.execPath;

  const candidates =
    process.platform === "win32"
      ? [] // handled by `where node` below
      : [
          "/opt/homebrew/bin/node",
          "/usr/local/bin/node",
          "/usr/bin/node",
        ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Shell fallback
  const whichCmd = process.platform === "win32" ? "where node" : "which node";
  try {
    const result = execSync(whichCmd, { encoding: "utf-8", env: process.env }).trim();
    const first = result.split("\n")[0]?.trim();
    if (first) return first;
  } catch {
    // ignore
  }

  throw new Error(
    "claude-stats: could not find a system Node.js binary. " +
      "Install Node.js 22.5+ and ensure it is on your PATH.",
  );
}

/**
 * Build the MCP entry for ~/.claude.json.
 *
 * The -e flag is required because mcp.js exports startMcpServer() but does
 * not invoke it when executed as a plain script.
 */
function buildMcpEntry(): McpEntry {
  const mcpJs = path.join(__dirname, "mcp.js");
  const node = findNodeBinary();
  const inline = `require(${JSON.stringify(mcpJs)}).startMcpServer().catch(e=>{console.error(e);process.exit(1)})`;
  return {
    type: "stdio",
    command: node,
    args: ["--experimental-sqlite", "-e", inline],
    env: {},
  };
}

export function ensureMcpServer(_context: vscode.ExtensionContext): void {
  try {
    const entry = buildMcpEntry();

    // Read existing ~/.claude.json
    let json: ClaudeJson = {};
    if (fs.existsSync(CLAUDE_JSON_PATH)) {
      try {
        json = JSON.parse(fs.readFileSync(CLAUDE_JSON_PATH, "utf-8")) as ClaudeJson;
      } catch {
        json = {};
      }
    }

    // Check if the entry is already up-to-date.
    const existing = json.mcpServers?.[MCP_KEY];
    const upToDate =
      existing &&
      existing.command === entry.command &&
      JSON.stringify(existing.args) === JSON.stringify(entry.args);

    if (upToDate) return;

    if (!json.mcpServers) json.mcpServers = {};
    json.mcpServers[MCP_KEY] = entry;

    fs.writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(json, null, 2) + "\n");

    if (!existing) {
      void vscode.window.showInformationMessage(
        "Claude Stats MCP server registered in ~/.claude.json. Restart Claude Code for it to take effect.",
      );
    }
  } catch (err) {
    // Non-fatal — don't block extension activation
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`claude-stats: failed to register MCP server: ${msg}`);
  }
}
