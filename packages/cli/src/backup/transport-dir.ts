/**
 * Directory-backed {@link StorageTransport} (imperative shell).
 *
 * The dumb-folder personal-plane sink: a plain filesystem directory (a consumer
 * cloud folder such as Dropbox/iCloud/Drive, a local dir, or a mounted remote).
 * It moves OPAQUE bytes — encryption happens ABOVE this seam, never here — so a
 * blind zero-knowledge service later can drop in behind the same interface.
 *
 * Logical keys are `/`-separated, bundle-relative. Every component is validated
 * with the shared path-safety guard BEFORE being joined, and the resolved path
 * is contained under the root, so a hostile key (`../`, absolute, NUL) can never
 * escape the bundle directory (F5, same guard the archive uses).
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { StorageTransport } from "@claude-stats/core/crypto/types";
import { assertPathSafeComponent } from "@claude-stats/core/types/shard";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class DirectoryStorageTransport implements StorageTransport {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Resolve a bundle-relative logical key to an absolute path under the root,
   * validating every component. Throws on any traversal attempt.
   */
  private resolveKey(key: string): string {
    if (key.length === 0) throw new Error("transport: empty key");
    const components = key.split("/").filter((c) => c.length > 0);
    if (components.length === 0) throw new Error("transport: key has no components");
    for (const component of components) assertPathSafeComponent(component, "bundle path component");
    const full = join(this.root, ...components);
    const rel = full.startsWith(this.root + sep) || full === this.root;
    if (!rel) throw new Error("transport: key escapes the bundle root");
    return full;
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.resolveKey(key));
      return new Uint8Array(buf);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const full = this.resolveKey(key);
    await mkdir(dirname(full), { recursive: true, mode: DIR_MODE });
    await writeFile(full, data, { mode: FILE_MODE });
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolveKey(key), { force: true });
  }

  async list(prefix?: string): Promise<readonly string[]> {
    const base = prefix && prefix.length > 0 ? this.resolveKey(prefix) : this.root;
    const out: string[] = [];
    await this.walk(base, out);
    // Return bundle-relative, `/`-separated logical keys, sorted for determinism.
    return out
      .map((abs) => abs.slice(this.root.length + 1).split(sep).join("/"))
      .sort();
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const abs = join(dir, String(entry.name));
      if (entry.isDirectory()) {
        await this.walk(abs, out);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }

  /** True when the given logical key exists as a file. */
  async has(key: string): Promise<boolean> {
    try {
      await stat(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }
}

/** Convenience factory. */
export function createDirectoryTransport(root: string): DirectoryStorageTransport {
  return new DirectoryStorageTransport(root);
}
