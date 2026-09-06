/**
 * Module-level i18n accessor for the VS Code extension.
 *
 * The `t` function is initialised as a passthrough (returns the key)
 * until `setT()` is called from `activate()` after i18next boots.
 *
 * `initI18n()` is async, but `activate()` constructs the status-bar owners
 * synchronously — so anything that renders UI in its constructor renders the
 * raw key. `onI18nReady()` exists for exactly that case: register a relabel
 * callback and the UI is repainted once real translations land. Components
 * that repaint on their own schedule (the dashboard panel, notifications)
 * don't need it; ones that paint once and then sit there do.
 */
import type { TFunction } from "@claude-stats/core/i18n";

type ReadyListener = () => void;

const passthrough = ((key: string) => key) as unknown as TFunction;

let _t: TFunction = passthrough;
let _ready = false;
const readyListeners = new Set<ReadyListener>();

export function setT(t: TFunction): void {
  _t = t;
  _ready = true;
  // Copy first: a listener may unsubscribe itself while we iterate.
  for (const listener of [...readyListeners]) {
    try {
      listener();
    } catch {
      // A failing relabel must never break activation.
    }
  }
  readyListeners.clear();
}

/**
 * Run `cb` once translations are available — immediately if they already are.
 * Returns an unsubscribe function, safe to call after `cb` has run.
 */
export function onI18nReady(cb: ReadyListener): () => void {
  if (_ready) {
    cb();
    return () => {};
  }
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

export function t(...args: Parameters<TFunction>): string {
  return _t(...args) as string;
}

/** Test-only: restore the pre-`setT()` passthrough state. */
export function __resetI18nForTests(): void {
  _t = passthrough;
  _ready = false;
  readyListeners.clear();
}
