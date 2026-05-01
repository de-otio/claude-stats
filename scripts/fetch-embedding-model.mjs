#!/usr/bin/env node
/**
 * Fetch the Xenova/all-MiniLM-L6-v2 model files into a directory layout
 * that @huggingface/transformers v3 can load via env.localModelPath.
 *
 * Output layout (relative to --out-dir, default extension/media/embed-model):
 *   Xenova/all-MiniLM-L6-v2/
 *     config.json
 *     tokenizer.json
 *     tokenizer_config.json
 *     onnx/model_quantized.onnx     # SHA-256-pinned (MODEL_SHA256)
 *   LICENSE                          # Apache-2.0 of the model
 *   MODEL-CARD.md                    # Mirrored from huggingface.co/.../README.md
 *
 * The ONNX file is the only weight-bearing artefact; we hash-verify it
 * against the constant exported from packages/cli/src/recap/embeddings.ts.
 * The tokenizer/config JSONs ship inside the same marketplace-signed VSIX,
 * so the marketplace signature is the integrity boundary for them.
 *
 * Usage:
 *   node scripts/fetch-embedding-model.mjs                 # default out-dir
 *   node scripts/fetch-embedding-model.mjs --out-dir=/tmp/x
 *   node scripts/fetch-embedding-model.mjs --skip-if-present
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

// ── Read the SHA-256 + URL from the source of truth in embeddings.ts ─────────
//
// We avoid duplicating the constant. Parse the file as text since this
// script is plain Node (no TS pipeline).
const embeddingsSrc = readFileSync(
  join(repoRoot, "packages", "cli", "src", "recap", "embeddings.ts"),
  "utf-8",
);

function readConst(name) {
  const re = new RegExp(`export const ${name}\\s*=\\s*(?:['"\`]([^'"\`]+)['"\`]|(\\d[\\d_]*))`);
  const m = embeddingsSrc.match(re);
  if (!m) throw new Error(`Could not parse export const ${name} from embeddings.ts`);
  return m[1] ?? m[2].replace(/_/g, "");
}

const MODEL_SHA256 = readConst("MODEL_SHA256");
const MODEL_BYTES = Number(readConst("MODEL_BYTES"));

// HuggingFace serves repo files from /resolve/main/<path>.
// Xenova/all-MiniLM-L6-v2 is a transformers.js mirror of sentence-transformers/all-MiniLM-L6-v2
// pre-converted to ONNX. The int8 (q8) variant is at onnx/model_quantized.onnx.
const HF_REPO = "Xenova/all-MiniLM-L6-v2";
const HF_BASE = `https://huggingface.co/${HF_REPO}/resolve/main`;

// Files we need. Only ONNX is hash-pinned (the others are tiny config files
// that ride the marketplace signature).
const FILES = [
  { src: "config.json", dest: `${HF_REPO}/config.json` },
  { src: "tokenizer.json", dest: `${HF_REPO}/tokenizer.json` },
  { src: "tokenizer_config.json", dest: `${HF_REPO}/tokenizer_config.json` },
  {
    src: "onnx/model_quantized.onnx",
    dest: `${HF_REPO}/onnx/model_quantized.onnx`,
    sha256: MODEL_SHA256,
    expectedBytes: MODEL_BYTES,
  },
];

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith("--out-dir="));
const skipIfPresent = args.includes("--skip-if-present");
const outDir = outArg
  ? outArg.split("=")[1]
  : join(repoRoot, "extension", "media", "embed-model");

// ── Fetch + verify ───────────────────────────────────────────────────────────
async function fetchToFile(url, destPath, expected) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} fetching ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());

  if (expected?.expectedBytes !== undefined && buf.length !== expected.expectedBytes) {
    throw new Error(
      `${url}: expected ${expected.expectedBytes} bytes, got ${buf.length}`,
    );
  }
  if (expected?.sha256 !== undefined) {
    const actual = createHash("sha256").update(buf).digest("hex");
    if (actual !== expected.sha256) {
      throw new Error(
        `${url}: SHA-256 mismatch.\n  expected ${expected.sha256}\n  actual   ${actual}`,
      );
    }
    console.log(`  sha256 ok (${expected.sha256.slice(0, 12)}…)`);
  }

  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, buf);
}

console.log(`[fetch-embedding-model] Output dir: ${outDir}`);

let fetched = 0;
let skipped = 0;
for (const file of FILES) {
  const destPath = join(outDir, file.dest);
  const url = `${HF_BASE}/${file.src}`;

  if (skipIfPresent && existsSync(destPath)) {
    // For the hash-pinned file, also verify on skip — a stale wrong-hash file
    // should not be silently accepted.
    if (file.sha256) {
      const buf = readFileSync(destPath);
      const actual = createHash("sha256").update(buf).digest("hex");
      if (actual !== file.sha256) {
        console.error(
          `[fetch-embedding-model] ${destPath} exists but hash mismatches; refetching`,
        );
      } else {
        console.log(`[fetch-embedding-model] skip (verified): ${file.dest}`);
        skipped++;
        continue;
      }
    } else {
      console.log(`[fetch-embedding-model] skip (exists): ${file.dest}`);
      skipped++;
      continue;
    }
  }

  console.log(`[fetch-embedding-model] fetch: ${url}`);
  await fetchToFile(url, destPath, file);
  fetched++;
}

// ── License + model card ─────────────────────────────────────────────────────
//
// MiniLM-L6-v2 is Apache-2.0. The model card (README.md on HF) is required
// for marketplace compliance when bundling third-party model weights.
const LICENSE_TEXT = `Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

This bundled model file (model_quantized.onnx, an int8-quantised ONNX export
of sentence-transformers/all-MiniLM-L6-v2 mirrored at huggingface.co/${HF_REPO})
is distributed under the Apache License, Version 2.0.

The full text of the Apache 2.0 license is available at:
  https://www.apache.org/licenses/LICENSE-2.0

You may obtain a copy of the upstream model card and licensing information at:
  https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
  https://huggingface.co/${HF_REPO}
`;

const MODEL_CARD_TEXT = `# Bundled embedding model — all-MiniLM-L6-v2 (int8 ONNX)

This VS Code extension bundles a copy of the
\`sentence-transformers/all-MiniLM-L6-v2\` model in int8-quantised ONNX
format (the \`Xenova/all-MiniLM-L6-v2\` HuggingFace mirror), used by the
daily-recap feature for on-device semantic clustering.

- **Source:** https://huggingface.co/${HF_REPO}
- **Upstream model:** https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- **Quantisation:** int8 (\`onnx/model_quantized.onnx\`, \`dtype: 'q8'\`)
- **SHA-256 pin:** \`${MODEL_SHA256}\`
- **License:** Apache-2.0 (see \`LICENSE\`)

The model runs locally inside the VS Code extension's bundled MCP server
process via \`@huggingface/transformers\` v3 + \`onnxruntime-node\`. It
processes prompt text to compute sentence embeddings for clustering
similar daily-recap topics. **No prompt data leaves your machine.**

## How to verify

The shipped \`onnx/model_quantized.onnx\` matches the SHA-256 above. The
extension verifies this on activation; a mismatch surfaces a warning
notification and falls back to lexical (Jaccard) clustering.

To verify manually:
\`\`\`sh
shasum -a 256 path/to/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx
# Expected: ${MODEL_SHA256}
\`\`\`

## How to update

The model is rotated by changing \`MODEL_SHA256\` (and \`MODEL_URL\`,
\`MODEL_BYTES\` if applicable) in
\`packages/cli/src/recap/embeddings.ts\`, then re-running
\`scripts/fetch-embedding-model.mjs\` and re-packaging the VSIX. CI keys
its model-fetch cache off the contents of \`embeddings.ts\` so a rotation
invalidates the cache automatically.
`;

writeFileSync(join(outDir, "LICENSE"), LICENSE_TEXT);
writeFileSync(join(outDir, "MODEL-CARD.md"), MODEL_CARD_TEXT);

console.log(
  `[fetch-embedding-model] done — fetched ${fetched}, skipped ${skipped}, plus LICENSE + MODEL-CARD.md`,
);
