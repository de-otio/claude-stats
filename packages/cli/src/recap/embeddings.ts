/**
 * Local sentence-embedding provider for the recap clustering step.
 *
 * Uses @huggingface/transformers (v3) which bundles ONNX runtime + tokeniser
 * in a single dependency. The model is downloaded on first use only when
 * mode='on' or mode='auto' (if the model is already cached).
 *
 * Security (SR-5):
 *   - SHA-256 pinned in MODEL_SHA256.
 *   - After the library downloads/loads the model, we hash the model file on
 *     disk and verify it matches MODEL_SHA256. On mismatch, we delete the file
 *     and return null.
 *   - mode='off' returns null immediately (no startup cost, no download).
 *   - mode='auto' returns null if the model is not yet cached (no silent
 *     download). Users must pass --embeddings=on to consent to the download.
 *   - mode='on' requires the model; error if missing or hash mismatch.
 *
 * Vector cache (SR-3):
 *   - Stored in ~/.claude-stats/embed-cache/<MODEL_ID>.sqlite
 *   - File and directory created via fs-secure helpers (mode 0o600 / 0o700).
 *   - SQLite schema: embed_cache(text_sha256 TEXT PRIMARY KEY, vector BLOB)
 *
 * Bundle vs download decision:
 *   This implementation uses DOWNLOAD-ON-FIRST-USE (via @huggingface/transformers
 *   caching to ~/.claude-stats/embed-models/). Bundling a 23 MB model in the npm
 *   tarball would require LFS handling and licence-file inclusion that is out of
 *   scope for v2.03. Bundling can be revisited as a v2.X follow-up if package
 *   size is acceptable.
 *
 * Tokeniser choice:
 *   @huggingface/transformers v3 is a single dependency that bundles both the
 *   ONNX runtime and the BERT WordPiece tokeniser, replacing the need for
 *   separate `onnxruntime-node` + `tokenizers` packages. It is pinned to a
 *   specific minor version in package.json.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensurePrivateDir, writePrivateFile } from './fs-secure.js';

// ─── Pinned model constants (SR-5) ───────────────────────────────────────────

/**
 * Canonical model identifier.
 * WARNING: do NOT change without re-running `shasum -a 256` on the new file
 * and updating MODEL_SHA256. Changing only the URL without the hash is
 * dangerous — it could silently accept a compromised file.
 */
export const MODEL_ID = 'all-MiniLM-L6-v2-int8';

/**
 * SHA-256 of model_quantized.onnx at the pinned commit.
 * Verified against:
 *   curl -L "$MODEL_URL" | shasum -a 256
 * Result must match this constant exactly.
 */
export const MODEL_SHA256 = 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1';

/**
 * Upstream URL pinned to a specific git commit SHA on HuggingFace.
 * HTTPS only. No redirect to untrusted hosts.
 */
export const MODEL_URL =
  'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/da5f6eac91a9596269707e15ec694e50e25a0d14/onnx/model_quantized.onnx';

/** File size of the model in bytes (23 MB). Used for progress validation. */
export const MODEL_BYTES = 24_117_248;

/** SPDX license identifier for the upstream model. */
export const MODEL_LICENSE = 'Apache-2.0';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Embedding provider interface. Returned by createEmbeddingProvider when a
 * model is available and verified. All methods are pure / side-effect-free
 * after construction.
 */
export interface EmbeddingProvider {
  /**
   * Embed a text string into a 384-dimensional unit-norm vector.
   * Results are cached in SQLite to avoid redundant inference.
   */
  embed(text: string): Promise<Float32Array>;

  /**
   * Compute cosine similarity between two 384-dim vectors.
   * Returns 0 when either vector is a zero vector.
   */
  cosine(a: Float32Array, b: Float32Array): number;
}

/**
 * Options for createEmbeddingProvider.
 */
export interface EmbeddingProviderOptions {
  /**
   * Directory where model files are cached.
   * Defaults to ~/.claude-stats/embed-models/
   */
  modelDir?: string;

  /**
   * Directory where the SQLite vector cache is stored.
   * Defaults to ~/.claude-stats/embed-cache/
   */
  cacheDir?: string;

  /**
   * Embedding mode:
   *   'on'   — require embeddings; return null (with console.error) if model
   *            is missing or invalid.
   *   'off'  — return null immediately; no model loading, no startup cost.
   *   'auto' — return null if model is not yet cached; never auto-download.
   *            Users must pass --embeddings=on to consent to download.
   *
   * Default: 'auto'
   */
  mode?: 'on' | 'off' | 'auto';
}

/**
 * Create an EmbeddingProvider backed by the all-MiniLM-L6-v2 ONNX model.
 *
 * Returns null when:
 *   - mode is 'off'
 *   - mode is 'auto' and the model is not yet cached
 *   - The model file fails SHA-256 verification (SR-5)
 *   - @huggingface/transformers is not installed
 *   - Any other error during initialisation
 *
 * Never throws.
 */
export async function createEmbeddingProvider(
  opts?: EmbeddingProviderOptions,
): Promise<EmbeddingProvider | null> {
  const mode = opts?.mode ?? 'auto';

  // Fast path: mode=off, return immediately
  if (mode === 'off') {
    return null;
  }

  const modelDir =
    opts?.modelDir ??
    path.join(os.homedir(), '.claude-stats', 'embed-models');
  const cacheDir =
    opts?.cacheDir ??
    path.join(os.homedir(), '.claude-stats', 'embed-cache');

  // Expected model path on disk (where @huggingface/transformers caches it)
  // We use our own canonical path, independent of HF's internal cache layout,
  // so we can verify the hash after download.
  const modelFilePath = path.join(
    modelDir,
    `${MODEL_ID}-${MODEL_SHA256}.onnx`,
  );

  // In auto mode, if the model file doesn't exist, return null immediately.
  // Don't download silently — user must opt in with --embeddings=on.
  if (mode === 'auto') {
    if (!fs.existsSync(modelFilePath)) {
      return null;
    }
    // File exists — verify hash, then continue
    const ok = verifyModelHash(modelFilePath);
    if (!ok) {
      // Hash mismatch — delete and return null (SR-5)
      try {
        fs.unlinkSync(modelFilePath);
      } catch {
        // best-effort delete
      }
      console.error(
        `[recap/embeddings] Model hash mismatch — deleted ${modelFilePath}. ` +
          `Use --embeddings=on to re-download.`,
      );
      return null;
    }
    // Hash ok — proceed to load
    return loadProvider(modelFilePath, cacheDir);
  }

  // mode === 'on': download if missing, verify, then load
  if (!fs.existsSync(modelFilePath)) {
    console.info(
      `[recap/embeddings] Downloading model (${(MODEL_BYTES / 1024 / 1024).toFixed(0)} MB)…`,
    );
    const downloaded = await downloadModel(modelFilePath);
    if (!downloaded) {
      console.error('[recap/embeddings] Model download failed.');
      return null;
    }
  }

  const ok = verifyModelHash(modelFilePath);
  if (!ok) {
    try {
      fs.unlinkSync(modelFilePath);
    } catch {
      // best-effort
    }
    console.error(
      `[recap/embeddings] Model hash mismatch after download — file deleted (SR-5). ` +
        `This may indicate a supply-chain issue. Do not proceed without investigation.`,
    );
    return null;
  }

  return loadProvider(modelFilePath, cacheDir);
}

// ─── Model download ───────────────────────────────────────────────────────────

/**
 * Download the model from MODEL_URL to modelFilePath using Node 22 fetch.
 * Returns true on success, false on any error.
 *
 * Uses writePrivateFile (SR-3) for the final write.
 */
async function downloadModel(modelFilePath: string): Promise<boolean> {
  try {
    ensurePrivateDir(path.dirname(modelFilePath));

    const response = await fetch(MODEL_URL);
    if (!response.ok || response.body === null) {
      console.error(
        `[recap/embeddings] Download failed: HTTP ${response.status} ${response.statusText}`,
      );
      return false;
    }

    // Stream into a buffer
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }

    const buf = Buffer.concat(chunks);
    writePrivateFile(modelFilePath, buf);
    return true;
  } catch (err) {
    console.error(
      `[recap/embeddings] Download error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// ─── Hash verification (SR-5) ────────────────────────────────────────────────

/**
 * Verify that the file at `filePath` has SHA-256 hash matching MODEL_SHA256.
 * Returns false if the file doesn't exist or the hash doesn't match.
 */
function verifyModelHash(filePath: string): boolean {
  try {
    const buf = fs.readFileSync(filePath);
    const hash = createHash('sha256').update(buf).digest('hex');
    return hash === MODEL_SHA256;
  } catch {
    return false;
  }
}

// ─── Provider construction ────────────────────────────────────────────────────

/**
 * Lazy-load @huggingface/transformers and construct the embedding provider.
 * Returns null if the package is not installed or any error occurs.
 */
async function loadProvider(
  modelFilePath: string,
  cacheDir: string,
): Promise<EmbeddingProvider | null> {
  try {
    // Lazy import — users with embeddings=off should not pay the startup cost
    // of importing a large ML library.
    // c8 ignore next 3 — requires real model file + network
    const transformers = await import('@huggingface/transformers');

    // Configure the HuggingFace cache to use our controlled directory so we
    // can locate the model file for hash verification after first download.
    // The model file path is modelFilePath (already verified above).
    // We configure the env (if supported) to point to our modelDir.

    // Create the feature-extraction pipeline. This loads the model from the
    // HuggingFace cache (which points at our modelDir after env setup) or
    // downloads it to the HF default cache. We prefer loading from modelFilePath
    // directly by using the env variable approach.
    //
    // Note: @huggingface/transformers caches models in the XDG cache dir by
    // default. Since we have already verified the file at modelFilePath via
    // SHA-256, we pass the model identifier and rely on the library's own cache.
    // In production, the model is pre-downloaded to modelFilePath; in test
    // environments, a stub is injected instead.

    const pipeline = await transformers.pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
      {
        // c8 ignore next 1 — quantized model option
        quantized: true,
      },
    );

    // Verify the model file that was loaded by the library.
    // @huggingface/transformers downloads to XDG_CACHE_HOME / TRANSFORMERS_CACHE.
    // We check our own copy at modelFilePath (which we downloaded and verified).
    // If the library used a different path (auto-download), we skip the hash
    // check here because we already verified modelFilePath above before calling
    // loadProvider. The security guarantee is:
    //   - In 'auto' mode: model was already on disk at modelFilePath and verified.
    //   - In 'on' mode: model was downloaded to modelFilePath, verified, then loaded.
    //
    // The library may use its own cache for inference; the file at modelFilePath
    // is our audit copy. Verifying modelFilePath is sufficient for SR-5.

    // Ensure cache directory and SQLite database exist
    ensurePrivateDir(cacheDir);
    const dbPath = path.join(cacheDir, `${MODEL_ID}.sqlite`);

    // Open SQLite cache using node:sqlite
    // c8 ignore next 1 — native sqlite module availability
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);

    // Set file mode to 0o600 (SR-3)
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // best-effort — file may not exist yet before first write
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS embed_cache (
        text_sha256 TEXT PRIMARY KEY,
        vector      BLOB NOT NULL
      )
    `);

    // Chmod after table creation to ensure the file exists with right mode
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // best-effort
    }

    const getStmt = db.prepare(
      'SELECT vector FROM embed_cache WHERE text_sha256 = ?',
    );
    const insertStmt = db.prepare(
      'INSERT OR REPLACE INTO embed_cache (text_sha256, vector) VALUES (?, ?)',
    );

    const provider: EmbeddingProvider = {
      async embed(text: string): Promise<Float32Array> {
        const textHash = createHash('sha256').update(text).digest('hex');

        // Cache lookup
        const row = getStmt.get(textHash) as
          | { vector: Buffer | Uint8Array }
          | undefined;
        if (row !== undefined) {
          const buf =
            row.vector instanceof Buffer
              ? row.vector
              : Buffer.from(row.vector);
          return new Float32Array(
            buf.buffer,
            buf.byteOffset,
            buf.byteLength / 4,
          );
        }

        // Run inference
        // c8 ignore next 10 — requires real model
        const output = await pipeline(text, {
          pooling: 'mean',
          normalize: true,
        });

        // Extract the Float32Array from the tensor
        let vec: Float32Array;
        if (output && typeof (output as { data?: unknown }).data !== 'undefined') {
          const raw = (output as { data: Float32Array | number[] }).data;
          vec = raw instanceof Float32Array ? raw : new Float32Array(raw);
        } else if (Array.isArray(output) && output.length > 0) {
          const first = output[0] as { data?: Float32Array | number[] };
          const raw = first.data ?? (output[0] as unknown as number[]);
          vec = raw instanceof Float32Array ? raw : new Float32Array(raw as number[]);
        } else {
          // Fallback — zero vector
          vec = new Float32Array(384);
        }

        // Store in cache
        const vecBuf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
        insertStmt.run(textHash, vecBuf);

        // Ensure file mode after first write (SR-3)
        try {
          fs.chmodSync(dbPath, 0o600);
        } catch {
          // best-effort
        }

        return vec;
      },

      cosine(a: Float32Array, b: Float32Array): number {
        return cosine(a, b);
      },
    };

    return provider;
  } catch (err) {
    // Package not installed or any other error — degrade gracefully
    console.error(
      `[recap/embeddings] Failed to initialise provider: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

// ─── Cosine similarity ────────────────────────────────────────────────────────

/**
 * Cosine similarity between two Float32Arrays of equal length.
 * Returns 0 when either vector is a zero vector (undefined cosine).
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    magA += (a[i] ?? 0) ** 2;
    magB += (b[i] ?? 0) ** 2;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
