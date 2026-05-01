/**
 * Resolve the running MCP server's version by walking up from this file
 * until we find a package.json belonging to a known claude-stats package.
 *
 * Three contexts to support:
 *   - bundled extension (esbuild CJS):   extension/dist/mcp.js → extension/package.json
 *   - tsc-built standalone CLI (ESM):    packages/cli/dist/mcp/index.js → packages/cli/package.json
 *   - vitest source tests (ESM):         packages/cli/src/mcp/index.ts → packages/cli/package.json
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KNOWN_PACKAGES = new Set(["claude-stats-vscode", "@claude-stats/cli"]);

function thisDir(): string {
  // Mirrors the pattern in packages/cli/src/i18n.ts: import.meta.url in ESM,
  // __filename in CJS (esbuild bundle), placeholder as last resort.
  const url = typeof import.meta?.url === "string"
    ? import.meta.url
    : typeof __filename === "string"
      ? "file://" + __filename
      : null;
  if (!url) return process.cwd();
  try {
    return dirname(fileURLToPath(url));
  } catch {
    return process.cwd();
  }
}

function readVersion(): string {
  let dir = thisDir();
  // Walk at most 6 levels up — enough for any of the three contexts above.
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name && KNOWN_PACKAGES.has(pkg.name) && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // No readable package.json at this level; keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}

export const MCP_VERSION = readVersion();
