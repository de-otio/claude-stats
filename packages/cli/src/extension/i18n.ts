/**
 * Module-level i18n accessor for the VS Code extension.
 *
 * The `t` function is initialised as a passthrough (returns the key)
 * until `setT()` is called from `activate()` after i18next boots.
 */
import type { TFunction } from "@claude-stats/core/i18n";

let _t: TFunction = (key: string) => key;

export function setT(t: TFunction): void {
  _t = t;
}

export function t(...args: Parameters<TFunction>): string {
  return _t(...args) as string;
}
