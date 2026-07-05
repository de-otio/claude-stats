/**
 * Remove the claude-stats MCP server registration from Claude Code's
 * ~/.claude.json. The inverse of `extension/mcp-register.ts`'s `ensureMcpServer`
 * — but with NO vscode dependency, so it is callable from the CLI/MCP purge
 * path as well as the extension. The Wire/UX phases wire this into the MCP
 * `unregisterMcpServer()` handler and the "Delete All Stored Data" command.
 *
 * Idempotent: absent file, unparseable file, or missing key are all clean
 * no-ops. Only the `claude-stats` key is touched — every other MCP server and
 * every unrelated key in ~/.claude.json is preserved byte-for-byte in shape.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The registration key `ensureMcpServer` writes. Keep in sync. */
export const MCP_KEY = "claude-stats";

interface ClaudeJson {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Delete the `claude-stats` entry from `mcpServers` in ~/.claude.json.
 * Returns true when an entry was present and removed, false when there was
 * nothing to do.
 *
 * @param claudeJsonPath override for tests; defaults to ~/.claude.json.
 */
export function unregisterMcpServerFromClaudeJson(
  claudeJsonPath: string = path.join(os.homedir(), ".claude.json"),
): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(claudeJsonPath, "utf-8");
  } catch {
    return false; // no config file → nothing registered
  }

  let json: ClaudeJson;
  try {
    json = JSON.parse(raw) as ClaudeJson;
  } catch {
    return false; // unparseable → do not risk clobbering a file we can't read
  }

  if (!json.mcpServers || !(MCP_KEY in json.mcpServers)) return false;

  delete json.mcpServers[MCP_KEY];
  fs.writeFileSync(claudeJsonPath, JSON.stringify(json, null, 2) + "\n");
  return true;
}
