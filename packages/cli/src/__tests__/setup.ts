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
// Load from SOURCE, not the bare `@claude-stats/core/locales/...` specifier.
// That specifier resolves through the package's `exports` map to
// `packages/core/dist/locales/...` — the built output — via `createRequire`'s
// plain Node module resolution, which (unlike an `import`) is never
// intercepted by vitest.config.ts's `@claude-stats/core/*` source aliases.
// Every cli test uses this setup file, so a stale dist silently tests the
// last build instead of the tree under test (e.g. a tab id source no longer
// has, or one it just added) — a relative path here always reads the
// current source tree, matching template.test.ts's own locale loads.
const enExt = _req("../../../core/src/locales/en/extension.json") as Record<string, unknown>;
const enDash = _req("../../../core/src/locales/en/dashboard.json") as Record<string, unknown>;
const extInstance = await initI18n({
  lng: "en",
  ns: ["extension", "dashboard"],
  resources: {
    en: { extension: enExt, dashboard: enDash },
  },
});
setT(extInstance.t.bind(extInstance));
