import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// vi.hoisted runs before vi.mock factories, so tmpDir is available
const { tmpDir } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  return {
    tmpDir: mkdtempSync(join(tmpdir(), "claude-stats-mcp-reg-test-")) as string,
  };
});

// Mock vscode before importing the module under test
vi.mock("vscode", () => ({
  window: {
    showInformationMessage: vi.fn(),
  },
}));

// Mock os.homedir() to use the temp directory
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpDir },
    homedir: () => tmpDir,
  };
});

import { ensureMcpServer } from "../extension/mcp-register.js";
import * as vscode from "vscode";

// Claude Code CLI reads MCP servers from ~/.claude.json, not ~/.claude/settings.json
const CLAUDE_JSON_PATH = join(tmpDir, ".claude.json");

function readClaudeJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(CLAUDE_JSON_PATH, "utf-8")) as Record<string, unknown>;
}

describe("ensureMcpServer", () => {
  const mockContext = {} as vscode.ExtensionContext;

  beforeEach(() => {
    try {
      rmSync(CLAUDE_JSON_PATH, { force: true });
    } catch { /* ignore */ }

    vi.mocked(vscode.window.showInformationMessage).mockReset();
  });

  it("creates ~/.claude.json and registers MCP server when none exists", () => {
    ensureMcpServer(mockContext);

    expect(existsSync(CLAUDE_JSON_PATH)).toBe(true);
    const json = readClaudeJson();
    expect(json.mcpServers).toBeDefined();
    const servers = json.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(servers["claude-stats"]).toBeDefined();
    // Command must be a plain Node binary (not the Electron host)
    expect(servers["claude-stats"]!.command).toBeTruthy();
    // Args: --experimental-sqlite, -e, <inline script containing mcp.js>
    expect(servers["claude-stats"]!.args[0]).toBe("--experimental-sqlite");
    expect(servers["claude-stats"]!.args[1]).toBe("-e");
    expect(servers["claude-stats"]!.args[2]).toMatch(/mcp\.js/);
    expect(servers["claude-stats"]!.args[2]).toMatch(/startMcpServer/);
  });

  it("shows info message after first registration", () => {
    ensureMcpServer(mockContext);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("MCP server registered"),
    );
  });

  it("preserves existing settings when adding MCP server", () => {
    writeFileSync(CLAUDE_JSON_PATH, JSON.stringify({
      mcpServers: {
        "other-server": { type: "stdio", command: "other", args: [], env: {} },
      },
      someOtherSetting: true,
    }));

    ensureMcpServer(mockContext);

    const json = readClaudeJson();
    const servers = json.mcpServers as Record<string, unknown>;
    expect(servers["other-server"]).toBeDefined();
    expect(servers["claude-stats"]).toBeDefined();
    expect(json.someOtherSetting).toBe(true);
  });

  it("skips notification if entry is already up-to-date (idempotent on second call)", () => {
    // First call registers and shows notification
    ensureMcpServer(mockContext);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);

    vi.mocked(vscode.window.showInformationMessage).mockReset();

    // Second call — entry already up-to-date, no notification
    ensureMcpServer(mockContext);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("updates stale entry (e.g. old npx command) to current mcp.js path", () => {
    writeFileSync(CLAUDE_JSON_PATH, JSON.stringify({
      mcpServers: {
        "claude-stats": { type: "stdio", command: "npx", args: ["claude-stats", "mcp"], env: {} },
      },
    }));

    ensureMcpServer(mockContext);

    const json = readClaudeJson();
    const servers = json.mcpServers as Record<string, { command: string; args: string[] }>;
    // Should have been updated to use node + -e invocation
    expect(servers["claude-stats"]!.args[0]).toBe("--experimental-sqlite");
    expect(servers["claude-stats"]!.args[1]).toBe("-e");
    expect(servers["claude-stats"]!.args[2]).toMatch(/startMcpServer/);
    // Should NOT show notification (was already registered, just updated silently)
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("does not throw on errors — fails silently", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Invalid JSON is caught and treated as empty settings
    writeFileSync(CLAUDE_JSON_PATH, "invalid json{{{");

    expect(() => ensureMcpServer(mockContext)).not.toThrow();
  });

  it("handles empty settings file gracefully", () => {
    writeFileSync(CLAUDE_JSON_PATH, "{}");

    ensureMcpServer(mockContext);

    const json = readClaudeJson();
    const servers = json.mcpServers as Record<string, unknown>;
    expect(servers["claude-stats"]).toBeDefined();
  });
});
