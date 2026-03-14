# Migration Checklist

Phased rollout to minimize risk. Each phase is independently shippable -- the app works in English at every step, with German support growing incrementally.

## Phase 1: Foundation

- [ ] Install dependencies: `i18next`, `react-i18next`, `i18next-browser-languagedetector`
- [ ] Create `packages/core/locales/en/common.json` with shared strings (model names, plan names, period labels, metric labels)
- [ ] Create `packages/core/src/i18n.ts` with `initI18n()` helper
- [ ] Generate TypeScript type declarations for locale keys
- [ ] Create `packages/core/locales/de/common.json` (translated)
- [ ] Add `scripts/check-translations.ts` and wire into `npm run lint` / CI

## Phase 2: CLI

- [ ] Create `packages/core/locales/en/cli.json` -- extract all strings from `cli/index.ts` and `reporter/index.ts`
- [ ] Add `--locale` global option to commander program
- [ ] Implement `getCliLocale()` detection (flag -> env -> fallback)
- [ ] Call `initI18n()` at CLI entry point before command setup
- [ ] Replace hardcoded strings in `cli/index.ts` with `t()` calls
- [ ] Replace hardcoded strings in `reporter/index.ts` with `t()` calls
- [ ] Verify table alignment with German strings (padding utility)
- [ ] Create `packages/core/locales/de/cli.json` (translated)
- [ ] Test: `LANG=de claude-stats report` shows German output

## Phase 3: HTML Dashboard Template

- [ ] Create `packages/core/locales/en/dashboard.json` -- extract strings from `server/template.ts`
- [ ] Update `renderDashboard()` signature to accept `TFunction`
- [ ] Replace hardcoded strings in template with `t()` calls
- [ ] Verify Chart.js labels render correctly with translated strings
- [ ] Create `packages/core/locales/de/dashboard.json` (translated)
- [ ] Test: `claude-stats serve` with `LANG=de` shows German dashboard

## Phase 4: VS Code Extension

- [ ] Create `packages/core/locales/en/extension.json` -- extract strings from `statusBar.ts`, `sidebar.ts`, `panel.ts`, `sync-integration.ts`, `extension.ts`
- [ ] Call `initI18n({ lng: vscode.env.language })` in `activate()`
- [ ] Replace hardcoded strings in `statusBar.ts`
- [ ] Replace hardcoded strings in `sidebar.ts` (TAB_HELP refactor)
- [ ] Replace hardcoded strings in `panel.ts`
- [ ] Replace hardcoded strings in `sync-integration.ts`
- [ ] Replace hardcoded strings in `extension.ts`
- [ ] Create `extension/package.nls.json` (English) and `extension/package.nls.de.json` (German)
- [ ] Update `extension/package.json` to use `%key%` references
- [ ] Create `packages/core/locales/de/extension.json` (translated)
- [ ] Test: VS Code with `--locale de` shows German extension UI

## Phase 5: React Frontend

- [ ] Create `packages/core/locales/en/frontend.json` -- extract strings from all page and component files
- [ ] Set up i18next with `react-i18next` and `LanguageDetector` in `main.tsx`
- [ ] Replace hardcoded strings in `Login.tsx`
- [ ] Replace hardcoded strings in `Dashboard.tsx`
- [ ] Replace hardcoded strings in `Achievements.tsx`
- [ ] Replace hardcoded strings in remaining page components
- [ ] Add `LanguageSwitcher` component to app header
- [ ] Create `packages/core/locales/de/frontend.json` (translated)
- [ ] Test: browser with `navigator.language = 'de'` shows German frontend

## Phase 6: Polish & CI

- [ ] Run full app in German -- visual review of all surfaces for truncation, overflow, or layout issues
- [ ] Verify fallback behavior: unknown locale falls back to English gracefully
- [ ] Verify mixed-locale scenario: CLI in German, extension in English (independent)
- [ ] Add CI job: `check-translations.ts` fails on missing keys
- [ ] Document `--locale` flag in README
- [ ] Update CONTRIBUTING.md with translation instructions for new contributors

## Estimated scope

| Phase | Files modified | New files | Effort |
|-------|---------------|-----------|--------|
| 1. Foundation | 1-2 | 4 (2 JSON + init + types) | Small |
| 2. CLI | 2 | 2 (en/de cli.json) | Medium |
| 3. Dashboard | 1 | 2 (en/de dashboard.json) | Medium |
| 4. Extension | 5 | 4 (en/de extension.json + 2 nls) | Large (sidebar help is verbose) |
| 5. Frontend | 5-10 | 2 (en/de frontend.json) + 1 component | Medium |
| 6. Polish | 1-2 | 1 (CI script) | Small |

Total: ~15-20 source files modified, ~15 new files created.
