/**
 * Auto-collector — watches ~/.claude/projects/ for changes and runs
 * incremental collection with debouncing.
 *
 * Multiple VS Code instances can safely run collectors concurrently:
 * - SQLite WAL mode allows concurrent readers
 * - busy_timeout (5 s) lets concurrent writers wait rather than fail
 * - collect() upserts are idempotent — duplicate work is harmless
 * - Debouncing reduces (but doesn't need to prevent) concurrent runs
 */
import fs from "node:fs";
import type * as vscode from "vscode";
import { paths } from "@claude-stats/core/paths";
import { Store } from "../store/index.js";
import { collect } from "../aggregator/index.js";

const DEBOUNCE_MS = 5_000;

export class AutoCollector implements vscode.Disposable {
  private watcher: fs.FSWatcher | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private collecting = false;
  private pendingRerun = false;
  private readonly onCollectedCallbacks: Array<() => void> = [];

  /**
   * Register a callback invoked after each successful collection.
   * Returns a disposable that removes the callback.
   */
  onDidCollect(cb: () => void): vscode.Disposable {
    this.onCollectedCallbacks.push(cb);
    return { dispose: () => {
      const idx = this.onCollectedCallbacks.indexOf(cb);
      if (idx >= 0) this.onCollectedCallbacks.splice(idx, 1);
    }};
  }

  /**
   * Start watching ~/.claude/projects/ and run an initial collection.
   */
  start(): void {
    // Run initial collection immediately
    void this.runCollect();

    // Watch for file changes
    const projectsDir = paths.projectsDir;
    if (!fs.existsSync(projectsDir)) return;

    try {
      this.watcher = fs.watch(
        projectsDir,
        { recursive: true },
        (_event, _filename) => this.scheduleCollect(),
      );
    } catch {
      // fs.watch can fail on some platforms/permissions — fall back to polling
      this.watcher = undefined;
      this.debounceTimer = setInterval(
        () => void this.runCollect(),
        30_000,
      ) as unknown as ReturnType<typeof setTimeout>;
    }
  }

  /**
   * Run collection immediately (e.g. from a manual refresh command).
   */
  async collectNow(): Promise<void> {
    await this.runCollect();
  }

  private scheduleCollect(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.runCollect(), DEBOUNCE_MS);
  }

  private async runCollect(): Promise<void> {
    // If already collecting, mark that we need another run after this one
    if (this.collecting) {
      this.pendingRerun = true;
      return;
    }

    this.collecting = true;
    try {
      const store = new Store();
      try {
        await collect(store, {});
      } finally {
        store.close();
      }
      for (const cb of this.onCollectedCallbacks) {
        try { cb(); } catch { /* callback errors must not break collector */ }
      }
    } catch {
      // Collection failures are non-fatal — will retry on next trigger
    } finally {
      this.collecting = false;
      // If a file change arrived while we were collecting, run again
      if (this.pendingRerun) {
        this.pendingRerun = false;
        this.scheduleCollect();
      }
    }
  }

  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }
}
