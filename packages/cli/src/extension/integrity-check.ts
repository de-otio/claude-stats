/**
 * Activation-time integrity check for the bundled embedding model.
 *
 * The MCP runtime in createEmbeddingProvider() already fails closed (returns
 * null → Jaccard) on a SHA-256 mismatch, but it does so silently from the
 * VS Code extension's perspective — the extension never sees MCP responses.
 * This module runs in the extension process at activation, hashes the
 * bundled ONNX file, and surfaces a vscode.window.showWarningMessage if the
 * pin doesn't match.
 *
 * Background:
 * doc/analysis/daily-recap/06-vscode-embedding-distribution-gap/08-privacy-security.md
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MODEL_SHA256, bundledOnnxPath } from '../recap/embeddings.js';

export type IntegrityResult =
  | { ok: true }
  | { ok: false; reason: 'missing'; modelPath: string }
  | { ok: false; reason: 'hash-mismatch'; modelPath: string; actual: string };

/**
 * Verify the bundled embedding model file under
 * `<extensionPath>/media/embed-model/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx`
 * against the pinned MODEL_SHA256.
 *
 * Streams the file (~23 MB) rather than loading it whole so activation stays
 * fast on first launch. Never throws — returns a structured result.
 */
export async function verifyBundledModel(
  extensionPath: string,
): Promise<IntegrityResult> {
  const modelDir = path.join(extensionPath, 'media', 'embed-model');
  const modelPath = bundledOnnxPath(modelDir);

  if (!fs.existsSync(modelPath)) {
    return { ok: false, reason: 'missing', modelPath };
  }

  return new Promise<IntegrityResult>((resolve) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(modelPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      const actual = hash.digest('hex');
      if (actual === MODEL_SHA256) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, reason: 'hash-mismatch', modelPath, actual });
      }
    });
    stream.on('error', () => {
      // Treat unreadable file as missing for end-user purposes.
      resolve({ ok: false, reason: 'missing', modelPath });
    });
  });
}
