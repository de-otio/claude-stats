#!/usr/bin/env node
/**
 * Smoke-check a packaged VSIX before publish:
 *   - The bundled ONNX model is present and matches MODEL_SHA256.
 *   - dist/mcp.js exists and references @huggingface/transformers
 *     (esbuild leaves the package name in comments / require calls).
 *   - For per-target builds, exactly one onnxruntime_binding.node is present
 *     and matches the target's expected platform/arch.
 *
 * Usage:
 *   node scripts/verify-vsix.mjs                   # check default unpacked layout
 *   node scripts/verify-vsix.mjs --target=darwin-arm64
 *
 * The script verifies the *unpacked* extension/ tree (which is what
 * vsce package zipped). For checking an existing .vsix file, unzip it
 * first and pass --extension-dir=<unzipped path>.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const args = process.argv.slice(2);
const targetArg = args.find((a) => a.startsWith("--target="));
const extDirArg = args.find((a) => a.startsWith("--extension-dir="));
const target = targetArg ? targetArg.split("=")[1] : null;
const extensionDir = extDirArg
  ? extDirArg.split("=")[1]
  : join(repoRoot, "extension");

// Read MODEL_SHA256 from the source of truth.
const embeddingsSrc = readFileSync(
  join(repoRoot, "packages", "cli", "src", "recap", "embeddings.ts"),
  "utf-8",
);
const sha256Match = embeddingsSrc.match(
  /export const MODEL_SHA256\s*=\s*['"`]([0-9a-f]{64})['"`]/,
);
if (!sha256Match) {
  console.error("Could not parse MODEL_SHA256 from embeddings.ts");
  process.exit(1);
}
const MODEL_SHA256 = sha256Match[1];

const failures = [];
const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  failures.push(msg);
};

console.log(`[verify-vsix] checking ${extensionDir}`);

// ── 1. Bundled model present + hash matches ──────────────────────────────────
const modelPath = join(
  extensionDir,
  "media",
  "embed-model",
  "Xenova",
  "all-MiniLM-L6-v2",
  "onnx",
  "model_quantized.onnx",
);
if (!existsSync(modelPath)) {
  fail(`bundled model missing at ${modelPath}`);
} else {
  const buf = readFileSync(modelPath);
  const actual = createHash("sha256").update(buf).digest("hex");
  if (actual === MODEL_SHA256) {
    ok(`bundled model present and matches MODEL_SHA256`);
  } else {
    fail(
      `bundled model SHA-256 mismatch:\n    expected ${MODEL_SHA256}\n    actual   ${actual}`,
    );
  }
}

// LICENSE + MODEL-CARD.md
const licensePath = join(extensionDir, "media", "embed-model", "LICENSE");
const cardPath = join(extensionDir, "media", "embed-model", "MODEL-CARD.md");
if (!existsSync(licensePath)) fail(`LICENSE missing at ${licensePath}`);
else if (!readFileSync(licensePath, "utf-8").includes("Apache License"))
  fail(`LICENSE does not contain "Apache License"`);
else ok("LICENSE present and Apache-2.0");

if (!existsSync(cardPath)) fail(`MODEL-CARD.md missing at ${cardPath}`);
else ok("MODEL-CARD.md present");

// ── 2. dist/mcp.js exists and references the runtime ─────────────────────────
const mcpPath = join(extensionDir, "dist", "mcp.js");
if (!existsSync(mcpPath)) {
  fail(`dist/mcp.js missing at ${mcpPath}`);
} else {
  const text = readFileSync(mcpPath, "utf-8");
  if (!text.includes("@huggingface/transformers")) {
    fail("dist/mcp.js does not reference @huggingface/transformers");
  } else {
    ok("dist/mcp.js references @huggingface/transformers");
  }
}

// ── 3. Per-target ONNX binary check ──────────────────────────────────────────
if (target !== null) {
  const [tPlatform, tArch] = target.split("-");
  const onnxBinRoot = join(
    extensionDir,
    "node_modules",
    "onnxruntime-node",
    "bin",
  );

  if (!existsSync(onnxBinRoot)) {
    fail(`onnxruntime-node binaries directory missing at ${onnxBinRoot}`);
  } else {
    let foundCount = 0;
    let unexpectedCount = 0;
    for (const napiDir of readdirSync(onnxBinRoot)) {
      if (!napiDir.startsWith("napi-v")) continue;
      const napiPath = join(onnxBinRoot, napiDir);
      if (!statSync(napiPath).isDirectory()) continue;

      for (const platform of readdirSync(napiPath)) {
        const platformDir = join(napiPath, platform);
        if (!statSync(platformDir).isDirectory()) continue;
        for (const arch of readdirSync(platformDir)) {
          const archDir = join(platformDir, arch);
          if (!statSync(archDir).isDirectory()) continue;

          if (platform === tPlatform && arch === tArch) {
            foundCount++;
          } else {
            unexpectedCount++;
            fail(
              `unexpected ONNX binary for ${platform}/${arch} in a ${target} VSIX`,
            );
          }
        }
      }
    }
    if (foundCount === 0) {
      fail(`no ONNX binary found for ${tPlatform}/${tArch}`);
    } else {
      ok(`exactly ${foundCount} ONNX binary leg(s) for ${target}, no others`);
      if (unexpectedCount > 0) {
        // already reported via fail() above
      }
    }
  }
}

if (failures.length > 0) {
  console.error(
    `\n[verify-vsix] FAILED: ${failures.length} issue(s) — see lines above`,
  );
  process.exit(1);
}
console.log("\n[verify-vsix] OK");
