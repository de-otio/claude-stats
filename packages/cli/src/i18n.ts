/**
 * CLI i18n singleton — initialized once by buildCli(), then importable
 * everywhere via `import { t } from "../i18n.js"`.
 */
import { initI18n, detectLocaleFromEnv, normalizeLocale } from "@claude-stats/core/i18n";
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
const plCli = _require("@claude-stats/core/locales/pl/cli.json") as Record<string, unknown>;
const ukCli = _require("@claude-stats/core/locales/uk/cli.json") as Record<string, unknown>;
const ruCli = _require("@claude-stats/core/locales/ru/cli.json") as Record<string, unknown>;

// Dashboard namespace — used by the standalone `serve` HTTP server's HTML
// template. Previously only loaded by the VS Code extension, which left
// every label on the CLI dashboard rendering as a raw "dashboard:..." key.
const enDash = _require("@claude-stats/core/locales/en/dashboard.json") as Record<string, unknown>;
const deDash = _require("@claude-stats/core/locales/de/dashboard.json") as Record<string, unknown>;
const jaDash = _require("@claude-stats/core/locales/ja/dashboard.json") as Record<string, unknown>;
const zhCnDash = _require("@claude-stats/core/locales/zh-CN/dashboard.json") as Record<string, unknown>;
const frDash = _require("@claude-stats/core/locales/fr/dashboard.json") as Record<string, unknown>;
const esDash = _require("@claude-stats/core/locales/es/dashboard.json") as Record<string, unknown>;
const ptBrDash = _require("@claude-stats/core/locales/pt-BR/dashboard.json") as Record<string, unknown>;
const plDash = _require("@claude-stats/core/locales/pl/dashboard.json") as Record<string, unknown>;
const ukDash = _require("@claude-stats/core/locales/uk/dashboard.json") as Record<string, unknown>;
const ruDash = _require("@claude-stats/core/locales/ru/dashboard.json") as Record<string, unknown>;

let _t: TFunction;
let _instance: I18nInstance;

/**
 * Initialize i18n for the CLI surface. Must be called (and awaited) before
 * any code calls `t()`.
 */
export async function initCliI18n(locale?: string): Promise<void> {
  // An explicit `--locale` goes through the same normalizer as the environment,
  // so `--locale pt_BR`, `--locale pt-br` and `--locale pt-BR` all land on the
  // same bundle instead of only the exactly-cased form working.
  const lng = locale !== undefined ? normalizeLocale(locale) : detectLocaleFromEnv();
  _instance = await initI18n({
    lng,
    ns: ["cli", "dashboard"],
    resources: {
      en: { cli: enCli as unknown as object, dashboard: enDash as unknown as object },
      de: { cli: deCli as unknown as object, dashboard: deDash as unknown as object },
      ja: { cli: jaCli as unknown as object, dashboard: jaDash as unknown as object },
      "zh-CN": { cli: zhCnCli as unknown as object, dashboard: zhCnDash as unknown as object },
      fr: { cli: frCli as unknown as object, dashboard: frDash as unknown as object },
      es: { cli: esCli as unknown as object, dashboard: esDash as unknown as object },
      "pt-BR": { cli: ptBrCli as unknown as object, dashboard: ptBrDash as unknown as object },
      pl: { cli: plCli as unknown as object, dashboard: plDash as unknown as object },
      uk: { cli: ukCli as unknown as object, dashboard: ukDash as unknown as object },
      ru: { cli: ruCli as unknown as object, dashboard: ruDash as unknown as object },
    },
  });
  _t = _instance.t.bind(_instance);
}

/**
 * Whether `initCliI18n()` has already run in this process.
 *
 * Exists so a SECOND entry point can initialize i18n without clobbering an
 * initialization that already happened. `startMcpServer()` is reached two
 * ways: straight from the bin (`claude-stats mcp` — `src/index.ts`
 * short-circuits on `argv[2] === "mcp"` before `buildCli()` ever runs, so
 * nothing has initialized) and through Commander's `mcp` subcommand
 * (`claude-stats --locale de mcp`, where `buildCli()` already initialized with
 * the user's `--locale`). Re-initializing unconditionally would silently reset
 * that second case to the environment locale.
 *
 * Deliberately a boolean predicate rather than an exported `_t`: callers get
 * the one fact they need in order to decide, and the translator stays private
 * so nothing can route around the `t()` guard below.
 */
export function isCliI18nInitialized(): boolean {
  return _t !== undefined;
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
