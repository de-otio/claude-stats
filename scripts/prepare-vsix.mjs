#!/usr/bin/env node
/**
 * Prepare extension/ for VSIX packaging.
 *
 * Steps:
 *   1. Install runtime deps declared in extension/package.json
 *      (@huggingface/transformers + onnxruntime-node) into
 *      extension/node_modules/. The bundled dist/mcp.js declares both as
 *      external (see scripts/build-extension.mjs) so they must exist as
 *      real packages at runtime for embeddings to load.
 *   2. (Optional, --target=<triple>) Prune onnxruntime-node binaries to
 *      only the target platform/arch. Reduces VSIX size from ~210 MB to
 *      ~6–10 MB of native binary per platform. Used by per-target VSIX
 *      builds (plans/vscode-embedding-distribution/07).
 *   3. (Optional) Verify the bundled model file is present and matches
 *      the pinned SHA-256. Run scripts/fetch-embedding-model.mjs first
 *      if missing.
 *
 * Usage:
 *   node scripts/prepare-vsix.mjs                 # all-platforms install
 *   node scripts/prepare-vsix.mjs --target=darwin-arm64
 *
 * Targets: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const extensionDir = join(repoRoot, "extension");

const args = process.argv.slice(2);
const targetArg = args.find((a) => a.startsWith("--target="));
const target = targetArg ? targetArg.split("=")[1] : null;

// Note: onnxruntime-node 1.21.0 ships prebuilds for darwin-arm64,
// linux-{x64,arm64}, win32-{x64,arm64}. There is NO darwin-x64 prebuilt,
// so Intel Macs are not in this matrix — they'd need the WASM fallback
// (analysis recommendation #6).
const VALID_TARGETS = new Set([
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
]);

if (target !== null && !VALID_TARGETS.has(target)) {
  console.error(
    `Invalid --target=${target}. Valid: ${[...VALID_TARGETS].join(", ")}`,
  );
  process.exit(1);
}

// ── Step 1: install runtime deps in extension/ ───────────────────────────────
console.log("[prepare-vsix] Installing runtime deps in extension/");
execSync(
  "npm install --omit=dev --omit=peer --no-package-lock --no-audit --no-fund",
  {
    cwd: extensionDir,
    stdio: "inherit",
    env: { ...process.env, npm_config_progress: "false" },
  },
);

// ── Step 1b: ensure the embedding model is fetched ───────────────────────────
//
// The fetch script verifies the SHA-256 of model_quantized.onnx against the
// constant in embeddings.ts on every run; --skip-if-present avoids re-downloading
// when the file is already present and the hash matches.
const modelDir = join(extensionDir, "media", "embed-model");
const onnxPath = join(
  modelDir,
  "Xenova",
  "all-MiniLM-L6-v2",
  "onnx",
  "model_quantized.onnx",
);
if (!existsSync(onnxPath)) {
  console.log("[prepare-vsix] Bundled model not found — fetching");
  execSync(`node ${join(repoRoot, "scripts", "fetch-embedding-model.mjs")}`, {
    cwd: repoRoot,
    stdio: "inherit",
  });
} else {
  console.log("[prepare-vsix] Bundled model present (skipping fetch)");
}

// ── Step 2: prune onnxruntime-node binaries to the target platform ───────────
//
// onnxruntime-node ships prebuilt binaries under
//   bin/napi-v<N>/<platform>/<arch>/{onnxruntime_binding.node, libonnxruntime.<ver>.dylib, ...}
// for whichever napi version the installed release bundles (currently
// napi-v6 in 1.21). We iterate over every napi-v* directory so the prune
// keeps working across upgrades.
const onnxBinRoot = join(extensionDir, "node_modules", "onnxruntime-node", "bin");

if (target !== null && existsSync(onnxBinRoot)) {
  const [targetPlatform, targetArch] = target.split("-");
  console.log(
    `[prepare-vsix] Pruning onnxruntime-node binaries to ${targetPlatform}/${targetArch}`,
  );

  for (const napiDir of readdirSync(onnxBinRoot)) {
    if (!napiDir.startsWith("napi-v")) continue;
    const napiPath = join(onnxBinRoot, napiDir);
    if (!statSync(napiPath).isDirectory()) continue;

    for (const platform of readdirSync(napiPath)) {
      const platformDir = join(napiPath, platform);
      if (!statSync(platformDir).isDirectory()) continue;

      if (platform !== targetPlatform) {
        rmSync(platformDir, { recursive: true, force: true });
        continue;
      }
      for (const arch of readdirSync(platformDir)) {
        const archDir = join(platformDir, arch);
        if (!statSync(archDir).isDirectory()) continue;
        if (arch !== targetArch) {
          rmSync(archDir, { recursive: true, force: true });
        }
      }
    }
  }
}

// ── Step 3: drop GPU/accelerator execution providers ─────────────────────────
//
// onnxruntime-node ships GPU provider libraries on some platforms — these
// are *only* loaded when the caller explicitly opts into a GPU execution
// provider via session options. transformers.js's Node backend runs the
// default CPU provider, so these never load at runtime, but they bloat
// the VSIX significantly:
//
//   linux-x64:  libonnxruntime_providers_cuda.so      (~343 MB) — CUDA
//               libonnxruntime_providers_tensorrt.so  (<1 MB)   — TensorRT
//   win32-*:    DirectML.dll                          (~18 MB)  — DirectML
//
// libonnxruntime_providers_shared.so is *not* a GPU provider — it's the
// shared infrastructure that the CPU provider depends on. Keep it.
const GPU_PROVIDER_FILES = [
  "libonnxruntime_providers_cuda.so",
  "libonnxruntime_providers_tensorrt.so",
  "DirectML.dll",
];

if (existsSync(onnxBinRoot)) {
  let droppedBytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else if (st.isFile() && GPU_PROVIDER_FILES.includes(entry)) {
        droppedBytes += st.size;
        rmSync(p, { force: true });
        console.log(
          `[prepare-vsix] Dropped GPU provider: ${p} (${(st.size / 1024 / 1024).toFixed(1)} MB)`,
        );
      }
    }
  };
  walk(onnxBinRoot);
  if (droppedBytes > 0) {
    console.log(
      `[prepare-vsix] Total GPU-provider bytes dropped: ${(droppedBytes / 1024 / 1024).toFixed(1)} MB`,
    );
  }
}

console.log("[prepare-vsix] Done");
