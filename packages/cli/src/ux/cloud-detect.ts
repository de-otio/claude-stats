/**
 * Phase E — consumer-cloud auto-detect (functional core).
 *
 * "Don't ask the user to configure storage. Detect it." ([02 §1]
 * (../../../../doc/analysis/data-planes/02-user-experience.md)). Most
 * developers already run a consumer cloud client that syncs a local folder;
 * we probe the well-known per-platform roots for each provider and offer the
 * ones that actually exist as one-click choices. Detection is RUNTIME
 * filesystem existence, not a hard-coded assumption (plan assumption 6) —
 * some roots are exact paths, others are glob-style (`GoogleDrive-*`,
 * `OneDrive-*`) because consumer cloud clients suffix them with an account
 * identifier.
 *
 * Pure function: every side-effecting primitive (`existsSync`, `readdirSync`,
 * `homedir`, `platform`) is injected with real `node:fs`/`node:os` defaults,
 * so this is exercised directly in tests without touching the real
 * filesystem or `process.platform`.
 */

import { existsSync as fsExistsSync, readdirSync as fsReaddirSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

export type CloudProvider = "dropbox" | "icloud" | "googleDrive" | "oneDrive";

export interface CloudRootCandidate {
  readonly provider: CloudProvider;
  /** Absolute, verified-to-exist path. */
  readonly path: string;
}

/** One provider's candidate roots for one platform: exact paths, or a (dir, glob-suffix) pair to scan. */
interface ProviderRootSpec {
  readonly provider: CloudProvider;
  /** Exact candidate paths (relative to `$HOME`), checked with `existsSync`. */
  readonly exact: readonly string[];
  /**
   * A parent directory (relative to `$HOME`) to scan, plus a prefix each entry
   * must start with — for the `GoogleDrive-<account>` / `OneDrive-<account>`
   * style suffixed folders under `~/Library/CloudStorage/`.
   */
  readonly scan?: { readonly dir: string; readonly entryPrefix: string };
}

/**
 * Known roots per platform (plan §Phase E; doc 02 §1). Verified against the
 * documented per-platform locations of each consumer cloud client; darwin's
 * `~/Library/CloudStorage/` is the modern unified mount point Dropbox/Drive/
 * OneDrive use in addition to (or instead of) their legacy top-level folder.
 */
const ROOTS: Record<"darwin" | "win32" | "linux", readonly ProviderRootSpec[]> = {
  darwin: [
    { provider: "dropbox", exact: ["Dropbox", "Library/CloudStorage/Dropbox"] },
    { provider: "icloud", exact: ["Library/Mobile Documents/com~apple~CloudDocs"] },
    {
      provider: "googleDrive",
      exact: ["Google Drive"],
      scan: { dir: "Library/CloudStorage", entryPrefix: "GoogleDrive-" },
    },
    {
      provider: "oneDrive",
      exact: ["OneDrive"],
      scan: { dir: "Library/CloudStorage", entryPrefix: "OneDrive-" },
    },
  ],
  win32: [
    { provider: "dropbox", exact: ["Dropbox"] },
    { provider: "icloud", exact: ["iCloudDrive"] },
    { provider: "googleDrive", exact: ["Google Drive"] },
    { provider: "oneDrive", exact: ["OneDrive"] },
  ],
  linux: [
    { provider: "dropbox", exact: ["Dropbox"] },
    // No first-party iCloud/Google Drive/OneDrive Linux clients; some users
    // mount one via rclone under a conventional name, worth a cheap check.
    { provider: "googleDrive", exact: ["GoogleDrive", "Google Drive"] },
    { provider: "oneDrive", exact: ["OneDrive"] },
  ],
};

export interface DetectCloudRootsOptions {
  /** Defaults to `process.platform`, normalized to one of the three buckets below. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `os.homedir()`. */
  readonly homeDir?: string;
  /** Defaults to `fs.existsSync`. Injected for tests. */
  readonly existsSync?: (path: string) => boolean;
  /** Defaults to `fs.readdirSync`. Injected for tests; must not throw on a missing dir. */
  readonly readdirSync?: (path: string) => string[];
  /** Defaults to `node:path.join`. Injected only for tests that need a foreign separator. */
  readonly join?: (...parts: string[]) => string;
}

/** Bucket an arbitrary `NodeJS.Platform` into the three root tables above. */
function platformBucket(platform: NodeJS.Platform): "darwin" | "win32" | "linux" {
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "win32";
  return "linux";
}

/**
 * Probe every known consumer-cloud root for the current (or given) platform
 * and return only the ones that actually exist on disk right now. Order is
 * stable (declaration order above) so the UI can present a deterministic list.
 */
export function detectCloudRoots(options: DetectCloudRootsOptions = {}): CloudRootCandidate[] {
  const {
    platform = process.platform,
    homeDir,
    existsSync,
    readdirSync,
    join,
  } = options;

  const home = homeDir ?? homedir();
  const exists = existsSync ?? fsExistsSync;
  const readdir = readdirSync ?? ((p: string) => {
    try {
      return fsReaddirSync(p);
    } catch {
      return [];
    }
  });
  const joinPath = join ?? pathJoin;

  const specs = ROOTS[platformBucket(platform)];
  const out: CloudRootCandidate[] = [];

  for (const spec of specs) {
    for (const rel of spec.exact) {
      const abs = joinPath(home, ...rel.split("/"));
      if (exists(abs)) out.push({ provider: spec.provider, path: abs });
    }
    if (spec.scan) {
      const scanDir = joinPath(home, ...spec.scan.dir.split("/"));
      let entries: string[];
      try {
        entries = readdir(scanDir);
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (entry.startsWith(spec.scan.entryPrefix)) {
          const abs = joinPath(scanDir, entry);
          if (exists(abs)) out.push({ provider: spec.provider, path: abs });
        }
      }
    }
  }
  return out;
}

/** i18n key suffix (`backup:target<Suffix>`) for a detected provider's label. */
export function providerLabelKey(provider: CloudProvider): string {
  switch (provider) {
    case "dropbox":
      return "targetDropbox";
    case "icloud":
      return "targetICloud";
    case "googleDrive":
      return "targetGoogle";
    case "oneDrive":
      return "targetOnedrive";
  }
}
