import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensurePrivateDir,
  writePrivateFile,
  readIfReadable,
} from '../../recap/fs-secure.js';

// ── Test isolation ────────────────────────────────────────────────────────────

// Each test gets a fresh temp directory created by mkdtempSync.
let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fs-secure-test-'));
}

afterEach(() => {
  // Clean up — best effort; ignore errors on already-removed dirs.
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ── ensurePrivateDir ──────────────────────────────────────────────────────────

describe('ensurePrivateDir', () => {
  it('creates a new directory with mode 0o700', () => {
    tmpDir = createTmpDir();
    const newDir = path.join(tmpDir, 'private-dir');

    ensurePrivateDir(newDir);

    expect(fs.existsSync(newDir)).toBe(true);
    const mode = fs.statSync(newDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('chmod-es a pre-existing 0o755 directory down to 0o700', () => {
    tmpDir = createTmpDir();
    const existingDir = path.join(tmpDir, 'loose-dir');

    // Create the directory with loose permissions first.
    fs.mkdirSync(existingDir, { mode: 0o755 });
    const beforeMode = fs.statSync(existingDir).mode & 0o777;
    expect(beforeMode).toBe(0o755);

    ensurePrivateDir(existingDir);

    const afterMode = fs.statSync(existingDir).mode & 0o777;
    expect(afterMode).toBe(0o700);
  });

  it('creates nested directories and sets mode on the leaf', () => {
    tmpDir = createTmpDir();
    const nested = path.join(tmpDir, 'a', 'b', 'c');

    ensurePrivateDir(nested);

    expect(fs.existsSync(nested)).toBe(true);
    const mode = fs.statSync(nested).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('is idempotent — calling twice does not throw', () => {
    tmpDir = createTmpDir();
    const dir = path.join(tmpDir, 'idempotent');

    ensurePrivateDir(dir);
    expect(() => ensurePrivateDir(dir)).not.toThrow();

    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

// ── writePrivateFile ──────────────────────────────────────────────────────────

describe('writePrivateFile', () => {
  it('creates a new file with mode 0o600', () => {
    tmpDir = createTmpDir();
    const filePath = path.join(tmpDir, 'secret.json');

    writePrivateFile(filePath, '{"hello":"world"}');

    expect(fs.existsSync(filePath)).toBe(true);
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"hello":"world"}');
  });

  it('chmod-es a pre-existing 0o644 file down to 0o600', () => {
    tmpDir = createTmpDir();
    const filePath = path.join(tmpDir, 'existing.json');

    // Create the file with loose permissions first.
    fs.writeFileSync(filePath, 'old content', { mode: 0o644 });
    const beforeMode = fs.statSync(filePath).mode & 0o777;
    expect(beforeMode).toBe(0o644);

    writePrivateFile(filePath, 'new content');

    const afterMode = fs.statSync(filePath).mode & 0o777;
    expect(afterMode).toBe(0o600);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('accepts a Buffer as data', () => {
    tmpDir = createTmpDir();
    const filePath = path.join(tmpDir, 'buf.bin');

    writePrivateFile(filePath, Buffer.from('binary'));

    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(fs.readFileSync(filePath)).toEqual(Buffer.from('binary'));
  });
});

// ── readIfReadable ────────────────────────────────────────────────────────────

describe('readIfReadable', () => {
  it('returns null for a missing file (ENOENT)', () => {
    tmpDir = createTmpDir();
    const missing = path.join(tmpDir, 'does-not-exist.json');

    const result = readIfReadable(missing);

    expect(result).toBeNull();
  });

  it('returns the file content as a string for an existing file', () => {
    tmpDir = createTmpDir();
    const filePath = path.join(tmpDir, 'data.json');
    fs.writeFileSync(filePath, '{"key":"value"}', 'utf-8');

    const result = readIfReadable(filePath);

    expect(result).toBe('{"key":"value"}');
  });

  it('re-throws errors other than ENOENT', () => {
    tmpDir = createTmpDir();
    // Passing a directory path to readFileSync throws EISDIR, not ENOENT.
    expect(() => readIfReadable(tmpDir)).toThrow();
  });
});
