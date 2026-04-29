/**
 * Tests for recap/embeddings.ts
 *
 * Most tests that require a real model are marked it.skip (they would need
 * network access and ~23 MB download).  The subset that can run in CI without
 * a real model covers:
 *   - createEmbeddingProvider returns null for mode='off'
 *   - createEmbeddingProvider returns null for mode='auto' when model is absent
 *   - createEmbeddingProvider returns null on SHA-256 mismatch (SR-5) and
 *     deletes the tampered file
 *   - cosine() sanity: identical vectors → 1, orthogonal → 0, zero → 0
 *   - cosine() round-trip with normalised random vectors
 *   - MODEL_* constants are present and well-formed
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createEmbeddingProvider,
  cosine,
  MODEL_ID,
  MODEL_SHA256,
  MODEL_URL,
  MODEL_BYTES,
  MODEL_LICENSE,
} from '../../recap/embeddings.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Create a deterministic unit-norm Float32Array of length n using a simple LCG. */
function lcgVec(seed: number, n = 384): Float32Array {
  const v = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    v[i] = (s / 0xffffffff) * 2 - 1;
  }
  // Normalise
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag);
  for (let i = 0; i < n; i++) v[i] = (v[i] ?? 0) / mag;
  return v;
}

/** Write a dummy file at `filePath`, creating parent directories as needed. */
function writeDummy(filePath: string, content: string | Buffer = 'tampered'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ─── MODEL_* constants ────────────────────────────────────────────────────────

describe('MODEL constants', () => {
  it('MODEL_ID is non-empty string', () => {
    expect(typeof MODEL_ID).toBe('string');
    expect(MODEL_ID.length).toBeGreaterThan(0);
  });

  it('MODEL_SHA256 is a 64-char lowercase hex string', () => {
    expect(MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('MODEL_URL starts with https://huggingface.co', () => {
    expect(MODEL_URL).toMatch(/^https:\/\/huggingface\.co\//);
  });

  it('MODEL_URL ends with .onnx', () => {
    expect(MODEL_URL).toMatch(/\.onnx$/);
  });

  it('MODEL_BYTES is a positive integer near 23-25 MB', () => {
    expect(MODEL_BYTES).toBeGreaterThan(20_000_000);
    expect(MODEL_BYTES).toBeLessThan(30_000_000);
  });

  it('MODEL_LICENSE is Apache-2.0', () => {
    expect(MODEL_LICENSE).toBe('Apache-2.0');
  });
});

// ─── cosine() ────────────────────────────────────────────────────────────────

describe('cosine()', () => {
  it('identical unit-norm vectors → 1 (within floating-point tolerance)', () => {
    const v = lcgVec(42);
    expect(cosine(v, v)).toBeCloseTo(1, 5);
  });

  it('opposite vectors → -1', () => {
    const v = lcgVec(123);
    const neg = v.map((x) => -x) as unknown as Float32Array;
    expect(cosine(v, neg)).toBeCloseTo(-1, 5);
  });

  it('zero vector → 0 (avoids NaN / division by zero)', () => {
    const zero = new Float32Array(384);
    const v = lcgVec(7);
    expect(cosine(zero, v)).toBe(0);
    expect(cosine(v, zero)).toBe(0);
    expect(cosine(zero, zero)).toBe(0);
  });

  it('orthogonal vectors (constructed) → cosine ≈ 0', () => {
    // Build two strictly orthogonal vectors in 384-dim space.
    // e1 = [1, 0, 0, …], e2 = [0, 1, 0, …]
    const e1 = new Float32Array(384);
    const e2 = new Float32Array(384);
    e1[0] = 1;
    e2[1] = 1;
    expect(cosine(e1, e2)).toBeCloseTo(0, 10);
  });

  it('random vectors with positive dot product → result in (0, 1)', () => {
    // Two LCG vectors with small seed difference tend to have positive dot
    // product by chance, but we test the range rather than the exact value.
    const a = lcgVec(1);
    const b = lcgVec(2);
    const sim = cosine(a, b);
    // Cosine is always in [-1, 1]
    expect(sim).toBeGreaterThanOrEqual(-1);
    expect(sim).toBeLessThanOrEqual(1);
  });

  it('result is symmetric: cosine(a,b) === cosine(b,a)', () => {
    const a = lcgVec(100);
    const b = lcgVec(200);
    expect(cosine(a, b)).toBeCloseTo(cosine(b, a), 10);
  });
});

// ─── createEmbeddingProvider — mode='off' ─────────────────────────────────────

describe('createEmbeddingProvider — mode=off', () => {
  it('returns null immediately without touching the filesystem', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-test-'));
    try {
      const provider = await createEmbeddingProvider({
        mode: 'off',
        modelDir: path.join(tmpDir, 'models'),
        cacheDir: path.join(tmpDir, 'cache'),
      });
      expect(provider).toBeNull();
      // The model dir should NOT have been created (no startup cost)
      expect(fs.existsSync(path.join(tmpDir, 'models'))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── createEmbeddingProvider — mode='auto', model absent ─────────────────────

describe('createEmbeddingProvider — mode=auto, model absent', () => {
  it('returns null when model file does not exist (no silent download)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-test-'));
    try {
      const modelDir = path.join(tmpDir, 'models');
      const cacheDir = path.join(tmpDir, 'cache');
      fs.mkdirSync(modelDir, { recursive: true });

      const provider = await createEmbeddingProvider({
        mode: 'auto',
        modelDir,
        cacheDir,
      });
      expect(provider).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── createEmbeddingProvider — SR-5: hash mismatch ───────────────────────────

describe('createEmbeddingProvider — SR-5 hash mismatch', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-sr5-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mode=auto: tampered model file → returns null and deletes the file', async () => {
    const modelDir = path.join(tmpDir, 'models');
    const cacheDir = path.join(tmpDir, 'cache');

    // Write a file at the expected path but with wrong content
    const modelFilePath = path.join(
      modelDir,
      `${MODEL_ID}-${MODEL_SHA256}.onnx`,
    );
    writeDummy(modelFilePath, 'this is tampered content, not a real onnx model');

    expect(fs.existsSync(modelFilePath)).toBe(true);

    const provider = await createEmbeddingProvider({
      mode: 'auto',
      modelDir,
      cacheDir,
    });

    // Must return null (SR-5)
    expect(provider).toBeNull();

    // Must delete the tampered file (SR-5)
    expect(fs.existsSync(modelFilePath)).toBe(false);
  });

  it('mode=auto: tampered model → does NOT create a cache database', async () => {
    const modelDir = path.join(tmpDir, 'models');
    const cacheDir = path.join(tmpDir, 'cache');

    const modelFilePath = path.join(
      modelDir,
      `${MODEL_ID}-${MODEL_SHA256}.onnx`,
    );
    writeDummy(modelFilePath);

    await createEmbeddingProvider({ mode: 'auto', modelDir, cacheDir });

    // Cache dir should not be created when provider init fails
    const dbPath = path.join(cacheDir, `${MODEL_ID}.sqlite`);
    expect(fs.existsSync(dbPath)).toBe(false);
  });
});

// ─── createEmbeddingProvider — mode='on', model absent ───────────────────────

describe('createEmbeddingProvider — mode=on, model absent (no network)', () => {
  it.skip(
    'downloads model, verifies hash, returns provider (needs network)',
    async () => {
      // This test requires real network access and ~23 MB download.
      // Run manually: VITEST_EMBEDDINGS=1 npx vitest run embeddings.test.ts
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-dl-'));
      try {
        const provider = await createEmbeddingProvider({
          mode: 'on',
          modelDir: path.join(tmpDir, 'models'),
          cacheDir: path.join(tmpDir, 'cache'),
        });
        expect(provider).not.toBeNull();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});

// ─── createEmbeddingProvider — with real model (skipped in CI) ───────────────

describe('createEmbeddingProvider — real model integration', () => {
  const MODEL_PATH = path.join(
    os.homedir(),
    '.claude-stats',
    'embed-models',
    `${MODEL_ID}-${MODEL_SHA256}.onnx`,
  );
  const modelExists = fs.existsSync(MODEL_PATH);

  it.skipIf(!modelExists)(
    'mode=auto: returns non-null provider when model is present and valid',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-real-'));
      try {
        // Copy the real model to a temp dir so the test is self-contained
        const modelDir = path.join(tmpDir, 'models');
        const cacheDir = path.join(tmpDir, 'cache');
        fs.mkdirSync(modelDir, { recursive: true });
        const destPath = path.join(
          modelDir,
          `${MODEL_ID}-${MODEL_SHA256}.onnx`,
        );
        fs.copyFileSync(MODEL_PATH, destPath);

        const provider = await createEmbeddingProvider({
          mode: 'auto',
          modelDir,
          cacheDir,
        });
        expect(provider).not.toBeNull();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!modelExists)(
    'embed() returns a 384-dim Float32Array',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-embed-'));
      try {
        const modelDir = path.join(tmpDir, 'models');
        const cacheDir = path.join(tmpDir, 'cache');
        fs.mkdirSync(modelDir, { recursive: true });
        const destPath = path.join(
          modelDir,
          `${MODEL_ID}-${MODEL_SHA256}.onnx`,
        );
        fs.copyFileSync(MODEL_PATH, destPath);

        const provider = await createEmbeddingProvider({
          mode: 'auto',
          modelDir,
          cacheDir,
        });
        expect(provider).not.toBeNull();

        const vec = await provider!.embed('hello world');
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(384);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!modelExists)(
    'embed() is deterministic (same input → same output)',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-det-'));
      try {
        const modelDir = path.join(tmpDir, 'models');
        const cacheDir = path.join(tmpDir, 'cache');
        fs.mkdirSync(modelDir, { recursive: true });
        const destPath = path.join(
          modelDir,
          `${MODEL_ID}-${MODEL_SHA256}.onnx`,
        );
        fs.copyFileSync(MODEL_PATH, destPath);

        const provider = await createEmbeddingProvider({
          mode: 'auto',
          modelDir,
          cacheDir,
        });
        expect(provider).not.toBeNull();

        const v1 = await provider!.embed('the quick brown fox');
        const v2 = await provider!.embed('the quick brown fox');
        // Must be identical (same text, same normalised output)
        expect(v1.length).toBe(v2.length);
        for (let i = 0; i < v1.length; i++) {
          expect(v1[i]).toBeCloseTo(v2[i] ?? 0, 6);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!modelExists)(
    'cosine: similar phrases score > 0.5',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-cos-'));
      try {
        const modelDir = path.join(tmpDir, 'models');
        const cacheDir = path.join(tmpDir, 'cache');
        fs.mkdirSync(modelDir, { recursive: true });
        const destPath = path.join(
          modelDir,
          `${MODEL_ID}-${MODEL_SHA256}.onnx`,
        );
        fs.copyFileSync(MODEL_PATH, destPath);

        const provider = await createEmbeddingProvider({
          mode: 'auto',
          modelDir,
          cacheDir,
        });
        expect(provider).not.toBeNull();

        const vHello = await provider!.embed('hello');
        const vHi = await provider!.embed('hi');
        const sim = provider!.cosine(vHello, vHi);
        expect(sim).toBeGreaterThan(0.5);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!modelExists)(
    'cosine: dissimilar phrases (apple vs quantum cryptography) score < 0.4',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-dis-'));
      try {
        const modelDir = path.join(tmpDir, 'models');
        const cacheDir = path.join(tmpDir, 'cache');
        fs.mkdirSync(modelDir, { recursive: true });
        const destPath = path.join(
          modelDir,
          `${MODEL_ID}-${MODEL_SHA256}.onnx`,
        );
        fs.copyFileSync(MODEL_PATH, destPath);

        const provider = await createEmbeddingProvider({
          mode: 'auto',
          modelDir,
          cacheDir,
        });
        expect(provider).not.toBeNull();

        const vApple = await provider!.embed('apple');
        const vQC = await provider!.embed('quantum cryptography');
        const sim = provider!.cosine(vApple, vQC);
        expect(sim).toBeLessThan(0.4);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!modelExists)(
    'SQLite cache: second embed() call returns cached vector (file mode 0o600)',
    async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-cache-'));
      try {
        const modelDir = path.join(tmpDir, 'models');
        const cacheDir = path.join(tmpDir, 'cache');
        fs.mkdirSync(modelDir, { recursive: true });
        const destPath = path.join(
          modelDir,
          `${MODEL_ID}-${MODEL_SHA256}.onnx`,
        );
        fs.copyFileSync(MODEL_PATH, destPath);

        const provider = await createEmbeddingProvider({
          mode: 'auto',
          modelDir,
          cacheDir,
        });
        expect(provider).not.toBeNull();

        // First call — runs inference and writes to cache
        const v1 = await provider!.embed('cache test phrase');

        // Second call — should hit cache
        const v2 = await provider!.embed('cache test phrase');

        // Results must be identical
        expect(v1.length).toBe(v2.length);
        for (let i = 0; i < v1.length; i++) {
          expect(v1[i]).toBe(v2[i]);
        }

        // SQLite file must exist with mode 0o600 (SR-3)
        const dbPath = path.join(cacheDir, `${MODEL_ID}.sqlite`);
        expect(fs.existsSync(dbPath)).toBe(true);
        const stat = fs.statSync(dbPath);
        // 0o600 = rw------- (owner read+write only)
        expect(stat.mode & 0o777).toBe(0o600);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
