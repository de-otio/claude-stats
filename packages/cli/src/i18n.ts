/**
 * CLI i18n singleton — initialized once by buildCli(), then importable
 * everywhere via `import { t } from "../i18n.js"`.
 */
import { initI18n, detectLocaleFromEnv } from "@claude-stats/core/i18n";
import type { TFunction, I18nInstance } from "@claude-stats/core/i18n";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const enCli = require("@claude-stats/core/locales/en/cli.json") as Record<string, unknown>;
const deCli = require("@claude-stats/core/locales/de/cli.json") as Record<string, unknown>;

let _t: TFunction;
let _instance: I18nInstance;

/**
 * Initialize i18n for the CLI surface. Must be called (and awaited) before
 * any code calls `t()`.
 */
export async function initCliI18n(locale?: string): Promise<void> {
  const lng = locale ?? detectLocaleFromEnv();
  _instance = await initI18n({
    lng,
    ns: ["cli"],
    resources: {
      en: { cli: enCli as unknown as object },
      de: { cli: deCli as unknown as object },
    },
  });
  _t = _instance.t.bind(_instance);
}

/**
 * Translation function — delegates to the i18next instance created by
 * `initCliI18n()`. Throws if called before initialization.
 */
export function t(key: string, options?: Record<string, unknown>): string {
  if (!_t) throw new Error("i18n not initialized — call initCliI18n() first");
  return _t(key, options as never);
}

export type { TFunction };
