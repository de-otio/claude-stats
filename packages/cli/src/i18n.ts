/**
 * CLI i18n singleton — initialized once by buildCli(), then importable
 * everywhere via `import { t } from "../i18n.js"`.
 */
import { initI18n, detectLocaleFromEnv } from "@claude-stats/core/i18n";
import type { TFunction, I18nInstance } from "@claude-stats/core/i18n";
import { createRequire } from "node:module";

// Build a require() that works in both ESM (import.meta.url) and CJS (esbuild
// bundles where import.meta is empty). Falls back to __filename for CJS.
const _url = typeof import.meta?.url === "string"
  ? import.meta.url
  : typeof __filename === "string"
    ? "file://" + __filename
    : "file:///placeholder.js";
const _require = createRequire(_url);
const enCli = _require("@claude-stats/core/locales/en/cli.json") as Record<string, unknown>;
const deCli = _require("@claude-stats/core/locales/de/cli.json") as Record<string, unknown>;
const jaCli = _require("@claude-stats/core/locales/ja/cli.json") as Record<string, unknown>;
const zhCnCli = _require("@claude-stats/core/locales/zh-CN/cli.json") as Record<string, unknown>;
const frCli = _require("@claude-stats/core/locales/fr/cli.json") as Record<string, unknown>;
const esCli = _require("@claude-stats/core/locales/es/cli.json") as Record<string, unknown>;
const ptBrCli = _require("@claude-stats/core/locales/pt-BR/cli.json") as Record<string, unknown>;

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
      ja: { cli: jaCli as unknown as object },
      "zh-CN": { cli: zhCnCli as unknown as object },
      fr: { cli: frCli as unknown as object },
      es: { cli: esCli as unknown as object },
      "pt-BR": { cli: ptBrCli as unknown as object },
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
  return _t(key, options as never) as unknown as string;
}

export type { TFunction };
