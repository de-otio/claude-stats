/**
 * Phase D — ambient sync wiring off the {@link AutoCollector} (imperative shell).
 *
 * Sync should be effortless: the moment a collect finishes (new local sessions
 * landed), we also pull + merge everyone else's shards. This attaches a sync run
 * to the collector's `onDidCollect` signal with the same discipline the collector
 * itself uses — debounce bursts, single-flight so two runs never overlap, and
 * swallow errors so a transient transport hiccup never breaks collection.
 *
 * The collector lives in the extension (it imports `vscode` types), so this
 * module depends only on a MINIMAL structural signal — anything exposing
 * `onDidCollect(cb) => { dispose }` — keeping the sync engine free of a VS Code
 * dependency and trivially testable with a fake emitter.
 */

import type { SyncStatus } from "./sync.js";

/** The slice of {@link AutoCollector} ambient sync needs. */
export interface CollectSignal {
  onDidCollect(cb: () => void): { dispose(): void };
}

export interface AmbientSyncOptions {
  /** Debounce window (ms) collapsing a burst of collects into one sync. */
  readonly debounceMs?: number;
  /** Observe each completed sync (status surface / logging). */
  readonly onStatus?: (status: SyncStatus) => void;
  /** Injected timer factory (tests pass fakes). Defaults to global setTimeout. */
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_DEBOUNCE_MS = 5_000;

/** Handle for an attached ambient-sync loop: last status + teardown. */
export interface AmbientSyncHandle {
  /** Most recent completed sync status, or `undefined` before the first run. */
  lastStatus(): SyncStatus | undefined;
  /** Force a sync now (bypasses the debounce); resolves when it settles. */
  syncNow(): Promise<void>;
  dispose(): void;
}

/**
 * Attach ambient sync to a collect signal. `runSync` performs one full cycle
 * (typically {@link syncOnce} bound to its deps). Returns a handle exposing the
 * latest status for a glanceable surface and a disposer that unsubscribes and
 * cancels any pending run.
 */
export function attachAmbientSync(
  signal: CollectSignal,
  runSync: () => Promise<SyncStatus>,
  options: AmbientSyncOptions = {},
): AmbientSyncHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let syncing = false;
  let pendingRerun = false;
  let disposed = false;
  let last: SyncStatus | undefined;

  async function run(): Promise<void> {
    if (disposed) return;
    if (syncing) {
      pendingRerun = true;
      return;
    }
    syncing = true;
    try {
      const status = await runSync();
      last = status;
      options.onStatus?.(status);
    } catch {
      // Ambient sync is best-effort; a failure must not break the collector.
    } finally {
      syncing = false;
      if (pendingRerun && !disposed) {
        pendingRerun = false;
        schedule();
      }
    }
  }

  function schedule(): void {
    if (disposed) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = undefined;
      void run();
    }, debounceMs);
  }

  const subscription = signal.onDidCollect(() => schedule());

  return {
    lastStatus: () => last,
    syncNow: () => run(),
    dispose: () => {
      disposed = true;
      if (timer) {
        clearTimer(timer);
        timer = undefined;
      }
      subscription.dispose();
    },
  };
}
