#!/usr/bin/env node
/**
 * Build, prepare, and package a VSIX. Optionally target a specific
 * (platform, arch) tuple — the marketplace serves the right build to
 * each user based on their OS.
 *
 * Steps:
 *   1. Run scripts/build-extension.mjs (esbuild bundles dist/{extension,mcp}.js).
 *   2. Run scripts/prepare-vsix.mjs (npm install runtime deps in extension/,
 *      fetch the embedding model if absent, prune ONNX binaries to the
 *      target if given).
 *   3. Run `vsce package --no-dependencies` (with --target if applicable).
 *
 * Usage:
 *   node scripts/package-vsix.mjs                          # all platforms
 *   node scripts/package-vsix.mjs --target=darwin-arm64    # per-target
 *   VSCE_TARGET=linux-x64 node scripts/package-vsix.mjs    # via env
 */
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const extensionDir = join(repoRoot, "extension");

const args = process.argv.slice(2);
const targetArg = args.find((a) => a.startsWith("--target="));
const target = targetArg ? targetArg.split("=")[1] : process.env["VSCE_TARGET"] ?? null;

function run(cmd, cwd = repoRoot) {
  console.log(`\n$ ${cmd}\n`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// ── 1. esbuild ───────────────────────────────────────────────────────────────
run("node scripts/build-extension.mjs");

// ── 2. prepare ───────────────────────────────────────────────────────────────
const prepareCmd = target
  ? `node scripts/prepare-vsix.mjs --target=${target}`
  : "node scripts/prepare-vsix.mjs";
run(prepareCmd);

// ── 3. vsce package ──────────────────────────────────────────────────────────
//
// We do NOT pass --no-dependencies. vsce's --no-dependencies excludes
// node_modules/ from the VSIX entirely, which we cannot allow because the
// MCP runtime requires @huggingface/transformers + onnxruntime-node at
// runtime. Without --no-dependencies, vsce uses the existing node_modules/
// (which prepare-vsix.mjs already populated and pruned to the target).
const vsceCmd = target
  ? `npx @vscode/vsce package --target ${target}`
  : "npx @vscode/vsce package";
run(vsceCmd, extensionDir);

console.log("\n[package-vsix] done");
