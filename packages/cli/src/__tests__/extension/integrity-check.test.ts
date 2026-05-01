/**
 * Tests for extension/integrity-check.ts — the activation-time SHA-256
 * verifier for the bundled embedding model.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { verifyBundledModel } from "../../extension/integrity-check.js";
import { MODEL_SHA256 } from "../../recap/embeddings.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "integrity-check-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function bundledPath(extensionPath: string): string {
  return path.join(
    extensionPath,
    "media",
    "embed-model",
    "Xenova",
    "all-MiniLM-L6-v2",
    "onnx",
    "model_quantized.onnx",
  );
}

describe("verifyBundledModel", () => {
  it("returns missing when the bundled model file is absent", async () => {
    const result = await verifyBundledModel(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing");
      expect(result.modelPath).toContain("model_quantized.onnx");
    }
  });

  it("returns hash-mismatch when bundled file exists but SHA-256 differs", async () => {
    const target = bundledPath(tmpDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "not the real model bytes");

    const result = await verifyBundledModel(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "hash-mismatch") {
      expect(result.actual).toMatch(/^[0-9a-f]{64}$/);
      // Ensure the file was NOT deleted (read-only VSIX semantics)
      expect(fs.existsSync(target)).toBe(true);
    } else {
      throw new Error("expected hash-mismatch result");
    }
  });

  it.skipIf(!process.env["VITEST_REAL_MODEL"])(
    "returns ok when bundled file matches the pinned hash (real model fixture)",
    async () => {
      // This case requires the real ~23 MB model file. Skipped in CI by
      // default; run with VITEST_REAL_MODEL=1 if `extension/media/embed-model/`
      // is populated.
      const realRoot = path.resolve(__dirname, "..", "..", "..", "..", "..", "extension");
      const realFile = bundledPath(realRoot);
      if (!fs.existsSync(realFile)) {
        return; // nothing to test
      }
      const result = await verifyBundledModel(realRoot);
      expect(result.ok).toBe(true);
    },
  );

  it("MODEL_SHA256 is a 64-char hex string (sanity)", () => {
    expect(MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
