/**
 * Regression guard for the global test setup's locale loading (G0/G3).
 *
 * `setup.ts` seeds the extension i18n instance (`../extension/i18n.js`'s
 * `t()`, bound via `setT()`) once for every cli test. It must load
 * `extension.json` / `dashboard.json` from SOURCE — a bare
 * `@claude-stats/core/locales/...` specifier resolves through
 * `createRequire`'s plain Node module resolution, which `vitest.config.ts`'s
 * `@claude-stats/core/*` source aliases never intercept (aliases only apply
 * to the `import` graph vite transforms, not to `require()` calls). In a git
 * worktree that resolution can walk out of the worktree entirely and land on
 * a DIFFERENT checkout's built `dist/` — so a key added or removed in this
 * worktree's source would silently not show up in what `t()` actually
 * serves, and every locale-dependent assertion in the suite would test
 * against the wrong tree without any indication.
 *
 * This test doesn't hardcode a translated string (that would only pin
 * today's copy, not the "loads from source" invariant). Instead it reads the
 * same source file directly — the same relative path nav.test.ts and
 * template.test.ts already use for the same reason — and asserts the running
 * `t()` instance agrees with it. If setup.ts ever regresses to a bare
 * specifier, this fails independently of whether any particular string
 * happens to be in sync at the time.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { t } from "../extension/i18n.js";
import { NAV_TAB_IDS } from "../server/nav.js";

const require = createRequire(import.meta.url);
const enExtension = require("../../../core/src/locales/en/extension.json") as {
  tabHelp?: Record<string, { title?: string }>;
};

describe("global test setup — extension i18n loads from source", () => {
  it("t('extension:tabHelp.<id>.title') matches the source JSON for every nav tab", () => {
    const help = enExtension.tabHelp ?? {};
    expect(Object.keys(help).length).toBeGreaterThan(0);
    for (const id of NAV_TAB_IDS) {
      const expected = help[id]?.title;
      expect(expected).toBeDefined();
      expect(t(`extension:tabHelp.${id}.title`)).toBe(expected);
    }
  });
});
