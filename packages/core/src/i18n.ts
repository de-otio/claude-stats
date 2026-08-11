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
/**
 * The most recently initialized instance's translator.
 *
 * Exists for one narrow case: a shared builder that runs under BOTH the CLI
 * and the VS Code extension host, and so cannot import either surface's own
 * i18n singleton — the CLI's `t` throws inside the extension, and the
 * extension never sets it. `buildDashboard` is the one such builder, and
 * threading a translator through its nine call sites (several of which never
 * touch a localized string) would be a large change for a small gain.
 *
 * Deliberately not a general-purpose escape hatch: everything that CAN take a
 * translator as a parameter still does, so it stays testable with an identity
 * translator and the locale can never leak between two surfaces in one
 * process. Null until some surface has initialized — callers must have a
 * defined answer for that state rather than assuming English.
 */
let _current: TFunction | null = null;

export function currentT(): TFunction | null {
  return _current;
}

/** Test seam: drop the singleton so a suite can exercise the not-yet-ready
 *  branch its production callers must handle. */
export function resetCurrentT(): void {
  _current = null;
}

export async function initI18n(options: I18nOptions): Promise<I18nInstance> {
  const instance = i18next.createInstance();
  await instance.init({
    // i18next 25 prints a Locize promo banner via console.info on init, and
    // console.info writes to STDOUT — a protocol channel here: `dashboard` and
    // `export` emit JSON/CSV there, and `mcp` speaks JSON-RPC over it. The
    // banner made `claude-stats dashboard` unparseable.
    //
    // i18next 26.3.6 dropped the banner and this option along with it, so
    // bumping core past that version turns this line into a type error. That
    // is the intended signal: delete it then, don't cast around it. The
    // frontend is already on 26 and needs no equivalent.
    showSupportNotice: false,
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
  _current = instance.t.bind(instance) as TFunction;
  return instance;
}

/**
 * Every locale with a bundled translation, in the exact casing the resource
 * keys use. `en` is both the default and the fallback.
 */
export const SUPPORTED_LOCALES = [
  "en",
  "de",
  "es",
  "fr",
  "ja",
  "pl",
  "pt-BR",
  "ru",
  "uk",
  "zh-CN",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** The bundles whose code carries a region, keyed by lowercased tag. */
const REGIONAL_BY_TAG = new Map<string, SupportedLocale>(
  SUPPORTED_LOCALES.filter((l) => l.includes("-")).map((l) => [l.toLowerCase(), l]),
);

/**
 * Normalize a raw locale tag to a bundled locale code.
 *
 * Accepts both the POSIX environment form (`pt_BR.UTF-8`) and the BCP 47 form
 * VS Code reports (`pt-br`), in any casing. Resolution order:
 *
 *   1. Exact regional match — `pt_BR` / `pt-br` → `pt-BR`.
 *   2. Primary subtag — `de_DE.UTF-8` → `de`.
 *   3. Sole regional variant of that primary subtag — `zh`, `zh_TW` → `zh-CN`,
 *      because Simplified Chinese is the only Chinese bundle that exists.
 *      Serving a near-miss beats serving English to a reader who told us their
 *      language; if a second variant is ever added this step stops applying to
 *      that language and an exact match becomes required.
 *   4. Anything else (including `C`, `POSIX`, and the empty string) → `en`.
 *
 * Step 1 is the load-bearing one: without it a regional tag fell through to its
 * primary subtag, and `pt`/`zh` are not themselves bundle codes, so Brazilian
 * Portuguese and Simplified Chinese users silently got English.
 */
export function normalizeLocale(raw: string): SupportedLocale {
  // Strip the POSIX charset/modifier suffix (`.UTF-8`, `@euro`) and unify the
  // separator so both `pt_BR` and `pt-br` reduce to the same tag.
  const tag = raw.split(/[.@]/)[0]!.replace(/_/g, "-").toLowerCase();
  if (tag === "") return "en";

  const regional = REGIONAL_BY_TAG.get(tag);
  if (regional) return regional;

  const primary = tag.split("-")[0]!;
  const exact = SUPPORTED_LOCALES.find((l) => l === primary);
  if (exact) return exact;

  const variants = SUPPORTED_LOCALES.filter(
    (l) => l.toLowerCase().split("-")[0] === primary,
  );
  return variants.length === 1 ? variants[0]! : "en";
}

/**
 * Detect locale from environment variables (for CLI / Node.js contexts).
 * Checks LC_ALL -> LC_MESSAGES -> LANG, then normalizes; falls back to "en".
 */
export function detectLocaleFromEnv(): SupportedLocale {
  return normalizeLocale(
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "",
  );
}
