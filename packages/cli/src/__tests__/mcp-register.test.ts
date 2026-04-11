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

const SETTINGS_DIR = join(tmpDir, ".claude");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Record<string, unknown>;
}

describe("ensureMcpServer", () => {
  const mockContext = {} as vscode.ExtensionContext;

  beforeEach(() => {
    // Ensure clean state
    try {
      rmSync(SETTINGS_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }

    vi.mocked(vscode.window.showInformationMessage).mockReset();
  });

  it("creates settings file and registers MCP server when none exists", () => {
    ensureMcpServer(mockContext);

    expect(existsSync(SETTINGS_PATH)).toBe(true);
    const settings = readSettings();
    expect(settings.mcpServers).toBeDefined();
    const servers = settings.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(servers["claude-stats"]).toBeDefined();
    // Should use current node executable
    expect(servers["claude-stats"]!.command).toBe(process.execPath);
    // Should pass --experimental-sqlite and point to mcp.js
    expect(servers["claude-stats"]!.args[0]).toBe("--experimental-sqlite");
    expect(servers["claude-stats"]!.args[1]).toMatch(/mcp\.js$/);
  });

  it("shows info message after first registration", () => {
    ensureMcpServer(mockContext);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("MCP server registered"),
    );
  });

  it("preserves existing settings when adding MCP server", () => {
    mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      mcpServers: {
        "other-server": { command: "other", args: [] },
      },
      someOtherSetting: true,
    }));

    ensureMcpServer(mockContext);

    const settings = readSettings();
    const servers = settings.mcpServers as Record<string, unknown>;
    expect(servers["other-server"]).toBeDefined();
    expect(servers["claude-stats"]).toBeDefined();
    expect(settings.someOtherSetting).toBe(true);
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
    mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      mcpServers: {
        "claude-stats": { command: "npx", args: ["claude-stats", "mcp"] },
      },
    }));

    ensureMcpServer(mockContext);

    const settings = readSettings();
    const servers = settings.mcpServers as Record<string, { command: string; args: string[] }>;
    // Should have been updated to use node + mcp.js
    expect(servers["claude-stats"]!.command).toBe(process.execPath);
    expect(servers["claude-stats"]!.args[0]).toBe("--experimental-sqlite");
    // Should NOT show notification (was already registered, just updated silently)
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("does not throw on errors — fails silently", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create a file where the directory should be, causing mkdir to fail
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(SETTINGS_PATH, "invalid json{{{");

    // Should not throw (invalid JSON is caught and treated as empty settings)
    expect(() => ensureMcpServer(mockContext)).not.toThrow();
  });

  it("creates .claude directory if it does not exist", () => {
    expect(existsSync(SETTINGS_DIR)).toBe(false);

    ensureMcpServer(mockContext);

    expect(existsSync(SETTINGS_DIR)).toBe(true);
    expect(existsSync(SETTINGS_PATH)).toBe(true);
  });

  it("handles empty settings file gracefully", () => {
    mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, "{}");

    ensureMcpServer(mockContext);

    const settings = readSettings();
    const servers = settings.mcpServers as Record<string, unknown>;
    expect(servers["claude-stats"]).toBeDefined();
  });
});
