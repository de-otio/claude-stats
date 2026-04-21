/**
 * Vitest setup file — initializes i18n so tests that call t() work correctly.
 *
 * Initializes BOTH the CLI i18n singleton and the extension's module-level
 * `t` accessor. Without the extension init, tests that exercise extension
 * code paths would see raw translation keys (e.g. "extension:mcp.registered")
 * instead of the real English strings — and assertions like
 * `stringContaining("MCP server registered")` would fail.
 */
import { initCliI18n } from "../i18n.js";
import { initI18n } from "@claude-stats/core/i18n";
import { setT } from "../extension/i18n.js";
import { createRequire } from "node:module";

await initCliI18n("en");

const _req = createRequire(import.meta.url);
const enExt = _req("@claude-stats/core/locales/en/extension.json") as Record<string, unknown>;
const enDash = _req("@claude-stats/core/locales/en/dashboard.json") as Record<string, unknown>;
const extInstance = await initI18n({
  lng: "en",
  ns: ["extension", "dashboard"],
  resources: {
    en: { extension: enExt, dashboard: enDash },
  },
});
setT(extInstance.t.bind(extInstance));
