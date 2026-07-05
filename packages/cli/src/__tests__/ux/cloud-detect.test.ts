/**
 * Phase E — consumer-cloud auto-detect. Filesystem is fully injected so this
 * never touches the real home directory or `process.platform`.
 */
import { describe, expect, it } from "vitest";
import { detectCloudRoots, providerLabelKey } from "../../ux/cloud-detect.js";

const HOME = "/home/example";

function join(...parts: string[]): string {
  return parts.join("/");
}

describe("detectCloudRoots", () => {
  it("returns nothing when no known root exists", () => {
    const result = detectCloudRoots({
      platform: "darwin",
      homeDir: HOME,
      existsSync: () => false,
      readdirSync: () => [],
      join,
    });
    expect(result).toEqual([]);
  });

  it("detects an exact-path root that exists (darwin Dropbox)", () => {
    const result = detectCloudRoots({
      platform: "darwin",
      homeDir: HOME,
      existsSync: (p) => p === `${HOME}/Dropbox`,
      readdirSync: () => [],
      join,
    });
    expect(result).toEqual([{ provider: "dropbox", path: `${HOME}/Dropbox` }]);
  });

  it("detects both the legacy and CloudStorage Dropbox paths independently", () => {
    const exists = new Set([`${HOME}/Dropbox`, `${HOME}/Library/CloudStorage/Dropbox`]);
    const result = detectCloudRoots({
      platform: "darwin",
      homeDir: HOME,
      existsSync: (p) => exists.has(p),
      readdirSync: () => [],
      join,
    });
    expect(result.map((r) => r.path)).toEqual([
      `${HOME}/Dropbox`,
      `${HOME}/Library/CloudStorage/Dropbox`,
    ]);
  });

  it("detects icloud on darwin", () => {
    const result = detectCloudRoots({
      platform: "darwin",
      homeDir: HOME,
      existsSync: (p) => p === `${HOME}/Library/Mobile Documents/com~apple~CloudDocs`,
      readdirSync: () => [],
      join,
    });
    expect(result).toEqual([
      { provider: "icloud", path: `${HOME}/Library/Mobile Documents/com~apple~CloudDocs` },
    ]);
  });

  it("scans the account-suffixed GoogleDrive-*/OneDrive-* folders under CloudStorage on darwin", () => {
    const scanDir = `${HOME}/Library/CloudStorage`;
    const result = detectCloudRoots({
      platform: "darwin",
      homeDir: HOME,
      existsSync: (p) =>
        p === `${scanDir}/GoogleDrive-user@example.com` || p === `${scanDir}/OneDrive-Personal`,
      readdirSync: (p) =>
        p === scanDir ? ["GoogleDrive-user@example.com", "OneDrive-Personal", "SomethingElse"] : [],
      join,
    });
    expect(result).toContainEqual({
      provider: "googleDrive",
      path: `${scanDir}/GoogleDrive-user@example.com`,
    });
    expect(result).toContainEqual({ provider: "oneDrive", path: `${scanDir}/OneDrive-Personal` });
    expect(result.some((r) => r.path.endsWith("SomethingElse"))).toBe(false);
  });

  it("never throws when the scan directory does not exist (readdirSync rejects)", () => {
    const result = detectCloudRoots({
      platform: "darwin",
      homeDir: HOME,
      existsSync: () => false,
      readdirSync: () => {
        throw new Error("ENOENT");
      },
      join,
    });
    expect(result).toEqual([]);
  });

  it("falls back to the linux root table (no CloudStorage scan) on linux", () => {
    const result = detectCloudRoots({
      platform: "linux",
      homeDir: HOME,
      existsSync: (p) => p === `${HOME}/Dropbox`,
      readdirSync: () => {
        throw new Error("should not be called on linux — no scan specs");
      },
      join,
    });
    expect(result).toEqual([{ provider: "dropbox", path: `${HOME}/Dropbox` }]);
  });

  it("uses the win32 root table for an unrecognized platform bucket (aix -> linux bucket)", () => {
    // Any platform outside darwin/win32 buckets to "linux" — assert it does not crash
    // and still finds a Dropbox-style root.
    const result = detectCloudRoots({
      platform: "aix" as NodeJS.Platform,
      homeDir: HOME,
      existsSync: (p) => p === `${HOME}/Dropbox`,
      readdirSync: () => [],
      join,
    });
    expect(result).toEqual([{ provider: "dropbox", path: `${HOME}/Dropbox` }]);
  });

  it("real node:fs/os defaults do not throw (smoke test)", () => {
    // No injected fakes — exercises the real existsSync/readdirSync/homedir/join
    // defaults. Assert only that it returns an array without throwing; the
    // actual contents depend on the machine running the test.
    expect(() => detectCloudRoots()).not.toThrow();
    expect(Array.isArray(detectCloudRoots())).toBe(true);
  });
});

describe("providerLabelKey", () => {
  it("maps every provider to its backup.target* i18n key", () => {
    expect(providerLabelKey("dropbox")).toBe("targetDropbox");
    expect(providerLabelKey("icloud")).toBe("targetICloud");
    expect(providerLabelKey("googleDrive")).toBe("targetGoogle");
    expect(providerLabelKey("oneDrive")).toBe("targetOnedrive");
  });
});
