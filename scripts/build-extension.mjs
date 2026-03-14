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

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["packages/cli/src/extension/extension.ts"],
  bundle: true,
  outfile: "extension/dist/extension.js",
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external: ["vscode"],
  // Keep the output readable for debugging
  minify: false,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(options);
}
