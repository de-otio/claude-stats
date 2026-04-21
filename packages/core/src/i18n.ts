/**
 * Shared i18n initialization for all claude-stats surfaces.
 * Each surface (CLI, extension, frontend) calls initI18n() with its
 * own namespace resources; common.json is always loaded automatically.
 */
import i18next, { type TFunction, type i18n as I18nInstance } from "i18next";
import { createRequire } from "node:module";

// Build a require() that works in both ESM (import.meta.url) and CJS (esbuild
// bundles where import.meta is empty). Falls back to __filename for CJS.
const _url = typeof import.meta?.url === "string"
  ? import.meta.url
  : typeof __filename === "string"
    ? "file://" + __filename
    : "file:///placeholder.js";
const _require = createRequire(_url);
const enCommon = _require("./locales/en/common.json") as Record<string, unknown>;
const deCommon = _require("./locales/de/common.json") as Record<string, unknown>;
const jaCommon = _require("./locales/ja/common.json") as Record<string, unknown>;
const zhCnCommon = _require("./locales/zh-CN/common.json") as Record<string, unknown>;
const frCommon = _require("./locales/fr/common.json") as Record<string, unknown>;
const esCommon = _require("./locales/es/common.json") as Record<string, unknown>;
const ptBrCommon = _require("./locales/pt-BR/common.json") as Record<string, unknown>;
const plCommon = _require("./locales/pl/common.json") as Record<string, unknown>;
const ukCommon = _require("./locales/uk/common.json") as Record<string, unknown>;
const ruCommon = _require("./locales/ru/common.json") as Record<string, unknown>;

export type { TFunction, I18nInstance };

export interface I18nOptions {
  /** Language code, e.g. "en" or "de". Defaults to "en". */
  lng?: string;
  /** Namespaces to load (first is the default). */
  ns: string[];
  /** Per-language, per-namespace resource bundles (merged with common). */
  resources?: Record<string, Record<string, object>>;
}

/**
 * Initialize i18next with the given options. Returns the i18next instance.
 * Safe to call multiple times — subsequent calls re-initialize.
 */
export async function initI18n(options: I18nOptions): Promise<I18nInstance> {
  const instance = i18next.createInstance();
  await instance.init({
    lng: options.lng ?? "en",
    fallbackLng: "en",
    ns: [...options.ns, "common"],
    defaultNS: options.ns[0],
    resources: {
      en: { common: enCommon, ...options.resources?.en },
      de: { common: deCommon, ...options.resources?.de },
      ja: { common: jaCommon, ...options.resources?.ja },
      "zh-CN": { common: zhCnCommon, ...options.resources?.["zh-CN"] },
      fr: { common: frCommon, ...options.resources?.fr },
      es: { common: esCommon, ...options.resources?.es },
      "pt-BR": { common: ptBrCommon, ...options.resources?.["pt-BR"] },
      pl: { common: plCommon, ...options.resources?.pl },
      uk: { common: ukCommon, ...options.resources?.uk },
      ru: { common: ruCommon, ...options.resources?.ru },
    },
    interpolation: {
      escapeValue: false,
    },
  });
  return instance;
}

/**
 * Detect locale from environment variables (for CLI / Node.js contexts).
 * Checks LC_ALL -> LC_MESSAGES -> LANG -> fallback "en".
 */
export function detectLocaleFromEnv(): string {
  const envLang =
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  const match = envLang.match(/^([a-z]{2})/i);
  if (match) return match[1]!.toLowerCase();
  return "en";
}
