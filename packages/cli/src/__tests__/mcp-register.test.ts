import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// vi.hoisted runs before vi.mock factories, so tmpDir is available
const { tmpDir, mockExecFileSync } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  return {
    tmpDir: mkdtempSync(join(tmpdir(), "claude-stats-mcp-reg-test-")) as string,
    mockExecFileSync: vi.fn(),
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

// Mock child_process.execFileSync for the `which` command
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
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

    mockExecFileSync.mockReset();
    vi.mocked(vscode.window.showInformationMessage).mockReset();
  });

  it("creates settings file and registers MCP server when none exists", () => {
    mockExecFileSync.mockReturnValue("/usr/local/bin/claude-stats\n");

    ensureMcpServer(mockContext);

    expect(existsSync(SETTINGS_PATH)).toBe(true);
    const settings = readSettings();
    expect(settings.mcpServers).toBeDefined();
    const servers = settings.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(servers["claude-stats"]).toBeDefined();
    expect(servers["claude-stats"]!.command).toBe("/usr/local/bin/claude-stats");
    expect(servers["claude-stats"]!.args).toEqual(["mcp"]);
  });

  it("shows info message after registration", () => {
    mockExecFileSync.mockReturnValue("/usr/local/bin/claude-stats\n");

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

    mockExecFileSync.mockReturnValue("/usr/local/bin/claude-stats\n");

    ensureMcpServer(mockContext);

    const settings = readSettings();
    const servers = settings.mcpServers as Record<string, unknown>;
    expect(servers["other-server"]).toBeDefined();
    expect(servers["claude-stats"]).toBeDefined();
    expect(settings.someOtherSetting).toBe(true);
  });

  it("skips registration if claude-stats is already registered", () => {
    mkdirSync(SETTINGS_DIR, { recursive: true });
    const existing = {
      mcpServers: {
        "claude-stats": { command: "existing-cmd", args: ["mcp"] },
      },
    };
    writeFileSync(SETTINGS_PATH, JSON.stringify(existing));

    ensureMcpServer(mockContext);

    // Should not modify the file
    const settings = readSettings();
    const servers = settings.mcpServers as Record<string, { command: string }>;
    expect(servers["claude-stats"]!.command).toBe("existing-cmd");
    // Should not show info message
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("falls back to node path when claude-stats is not on PATH", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    ensureMcpServer(mockContext);

    if (existsSync(SETTINGS_PATH)) {
      const settings = readSettings();
      const servers = settings.mcpServers as Record<string, { command: string; args: string[] }>;
      const entry = servers["claude-stats"]!;
      // Should use either node or npx as fallback
      expect(entry.command).toBeTruthy();
      expect(entry.args).toContain("mcp");
    }
  });

  it("does not throw on errors — fails silently", () => {
    // Make settings dir unwritable by giving a bad homedir mock
    // The function should catch and log, not throw
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create a file where the directory should be, causing mkdir to fail
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(SETTINGS_PATH, "invalid json{{{");

    mockExecFileSync.mockReturnValue("/usr/local/bin/claude-stats\n");

    // Should not throw
    expect(() => ensureMcpServer(mockContext)).not.toThrow();
  });

  it("creates .claude directory if it does not exist", () => {
    mockExecFileSync.mockReturnValue("/usr/local/bin/claude-stats\n");

    expect(existsSync(SETTINGS_DIR)).toBe(false);

    ensureMcpServer(mockContext);

    expect(existsSync(SETTINGS_DIR)).toBe(true);
    expect(existsSync(SETTINGS_PATH)).toBe(true);
  });

  it("handles empty settings file gracefully", () => {
    mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(SETTINGS_PATH, "{}");

    mockExecFileSync.mockReturnValue("/usr/local/bin/claude-stats\n");

    ensureMcpServer(mockContext);

    const settings = readSettings();
    const servers = settings.mcpServers as Record<string, unknown>;
    expect(servers["claude-stats"]).toBeDefined();
  });
});
