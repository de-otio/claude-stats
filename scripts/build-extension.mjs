#!/usr/bin/env node
/**
 * Bundle the VS Code extension into a single file with esbuild.
 *
 * - Entry: packages/cli/src/extension/extension.ts
 * - Output: extension/dist/extension.js
 * - Externals: vscode (provided by VS Code runtime)
 * - All node: builtins are external (they ship with Node)
 * - All npm dependencies (zod, etc.) are bundled in
 * - Format: CommonJS (required by VS Code extension host)
 */
import * as esbuild from "esbuild";
import { copyFileSync } from "fs";

// Copy Chart.js UMD build to extension/media/ so it can be served as a local
// webview resource (webviews cannot reliably load external CDN scripts).
copyFileSync(
  "node_modules/chart.js/dist/chart.umd.min.js",
  "extension/media/chart.min.js",
);

const watch = process.argv.includes("--watch");

/**
 * Plugin to intercept createRequire() calls for JSON locale files and replace
 * them with static requires that esbuild can resolve and inline.
 *
 * The i18n modules use createRequire(import.meta.url) which is opaque to
 * esbuild in CJS mode. This plugin rewrites those imports at the source level.
 * @type {import("esbuild").Plugin}
 */
const inlineLocalesPlugin = {
  name: "inline-locales",
  setup(build) {
    // Intercept files that use createRequire for JSON locale loading and
    // strip the createRequire wrapper so esbuild can resolve requires natively.
    build.onLoad({ filter: /\.(ts|js)$/ }, async (args) => {
      const fs = await import("fs");
      let contents = fs.readFileSync(args.path, "utf-8");

      // Skip files that don't use createRequire
      if (!contents.includes("createRequire")) return undefined;

      // Remove `import { createRequire } from "node:module"`
      contents = contents.replace(
        /import\s*\{\s*createRequire\s*\}\s*from\s*["']node:module["'];?\s*/g,
        "",
      );
      // Remove ES compiled form: `const { createRequire } = require("node:module")`
      contents = contents.replace(
        /(?:const|var)\s*\{\s*createRequire\s*\}\s*=\s*require\(["']node:module["']\);?\s*/g,
        "",
      );
      // Remove the _url + _require block (multi-line)
      contents = contents.replace(
        /(?:\/\/.*?\n)*(?:const|var)\s+_url\s*=[\s\S]*?(?:const|var)\s+_require\s*=\s*createRequire\([^)]+\);?\s*/g,
        "",
      );
      // Remove old-style: const require = createRequire(import.meta.url);
      contents = contents.replace(
        /(?:const|var)\s+require\s*=\s*createRequire\([^)]+\);?\s*/g,
        "",
      );
      // Replace _require("...") with require("...") so esbuild can resolve them
      contents = contents.replace(/_require\(/g, "require(");

      const loader = args.path.endsWith(".ts") ? "ts" : "js";
      return { contents, loader };
    });
  },
};

/** @type {import("esbuild").BuildOptions} */
const extensionOptions = {
  entryPoints: ["packages/cli/src/extension/extension.ts"],
  bundle: true,
  outfile: "extension/dist/extension.js",
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external: ["vscode"],
  plugins: [inlineLocalesPlugin],
  minify: false,
  logLevel: "info",
};

// Standalone MCP server bundle — runs as a child process over stdio.
// No vscode dependency; self-contained so it works from the installed VSIX path.
/** @type {import("esbuild").BuildOptions} */
const mcpOptions = {
  entryPoints: ["packages/cli/src/mcp/index.ts"],
  bundle: true,
  outfile: "extension/dist/mcp.js",
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external: ["vscode"],
  plugins: [inlineLocalesPlugin],
  minify: false,
  logLevel: "info",
};

if (watch) {
  const [extCtx, mcpCtx] = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(mcpOptions),
  ]);
  await Promise.all([extCtx.watch(), mcpCtx.watch()]);
  console.log("Watching for changes...");
} else {
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(mcpOptions),
  ]);
}
