# Parallel Implementation Checklist

This checklist is designed for multiple agents (or developers) working simultaneously. Work is split into **independent workstreams** that touch non-overlapping files, with a dependency graph showing what must complete before what.

## Dependency graph

```
                    ┌──────────────────┐
                    │  W1: Foundation  │
                    │  (packages/core) │
                    └────────┬─────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
            ▼                ▼                ▼
   ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐
   │  W2: CLI    │  │  W3: Ext.    │  │  W4: Frontend    │
   │  strings +  │  │  strings +   │  │  strings +       │
   │  wiring     │  │  wiring      │  │  wiring          │
   └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘
          │                │                    │
          │         ┌──────┴───────┐            │
          │         │  W3b: Ext.   │            │
          │         │  manifest    │            │
          │         │  (NLS files) │            │
          │         └──────┬───────┘            │
          │                │                    │
          ▼                ▼                    ▼
   ┌─────────────────────────────────────────────────┐
   │              W5: German translations            │
   │  (all de/*.json files — can be split further)   │
   └─────────────────────┬───────────────────────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │  W6: CI + polish    │
              └─────────────────────┘
```

**Key constraint:** W1 (Foundation) must complete first because all other workstreams import from `packages/core/src/i18n.ts` and `packages/core/locales/en/common.json`. After W1 merges, W2/W3/W4 can run fully in parallel — they touch completely different files.

---

## W1: Foundation (blocking — do first)

**Owner:** 1 agent
**Scope:** `packages/core/` only
**Files created:**

| File | Purpose |
|------|---------|
| `packages/core/locales/en/common.json` | Shared strings: model names, plan names, period labels, metric labels |
| `packages/core/locales/de/common.json` | Stub copy (English values, translated later in W5) |
| `packages/core/src/i18n.ts` | `initI18n()` helper, re-exports `i18next.t` |
| `packages/core/src/i18n-types.d.ts` | TypeScript module augmentation for type-safe `t()` |

**Tasks:**

- [ ] `npm install i18next` in `packages/core`
- [ ] `npm install react-i18next i18next-browser-languagedetector` in `packages/frontend`
- [ ] Create `packages/core/locales/en/common.json` — extract shared strings:
  - Model display names: `"opus4"`, `"sonnet4"`, `"haiku4"`
  - Plan names: `"pro"`, `"max5x"`, `"max20x"`, `"teamStandard"`, `"teamPremium"`
  - Period labels: `"day"`, `"week"`, `"month"`, `"all"`
  - Metric labels: `"sessions"`, `"prompts"`, `"inputTokens"`, `"outputTokens"`, `"cacheEfficiency"`, `"estCost"`, `"planValue"`, `"activeHours"`, `"costPerPrompt"`, `"tokPerMin"`, `"throttleEvents"`
  - Verdict labels: `"goodValue"`, `"underusing"`, `"noPlanDetected"`
- [ ] Create `packages/core/locales/de/common.json` — copy of English (placeholder)
- [ ] Create `packages/core/src/i18n.ts` — `initI18n()` function per architecture doc
- [ ] Create `packages/core/src/i18n-types.d.ts` — type augmentation
- [ ] Export `i18n.ts` from `packages/core` package entry point
- [ ] Verify: `npm run build` succeeds in `packages/core`

**Definition of done:** Other packages can `import { initI18n } from '@claude-stats/core/i18n'` and call `t('common:metrics.sessions')`.

---

## W2: CLI (parallel with W3, W4 — after W1)

**Owner:** 1 agent
**Scope:** `packages/cli/src/cli/`, `packages/cli/src/reporter/`, `packages/core/locales/en/cli.json`
**Files modified:** 2 (`cli/index.ts`, `reporter/index.ts`)
**Files created:** 2 (`en/cli.json`, `de/cli.json` stub)

**Tasks:**

### String extraction
- [ ] Read `packages/cli/src/cli/index.ts` — extract all user-facing strings
- [ ] Read `packages/cli/src/reporter/index.ts` — extract all user-facing strings
- [ ] Create `packages/core/locales/en/cli.json` with keys organized by feature:
  - `commands.program.description`, `commands.collect.*`, `commands.report.*`, `commands.status.*`, `commands.export.*`, `commands.diagnose.*`, `commands.search.*`, `commands.config.*`
  - `collection.collecting`, `collection.done`, `collection.parseErrors`, `collection.schemaChanges`, `collection.costAlert`
  - `report.title`, `report.tableHeader`, `report.noSessions`, `report.noSessionsFiltered`, `report.trend.*`, `report.total`
  - `status.dbSize`, `status.tables`, `status.lastCollection`
  - `config.noConfig`, `config.usage.*`, `config.unknownKey`, `config.invalidValue`, `config.set`, `config.unset`
  - `errors.htmlWithTrend`, `errors.trendWithDetail`, `errors.wrote`
- [ ] Create `packages/core/locales/de/cli.json` — copy with English values (placeholder)

### Wiring
- [ ] Add `--locale <lang>` global option to commander program in `cli/index.ts`
- [ ] Implement `getCliLocale()` in `cli/index.ts` (flag -> `LC_ALL` -> `LC_MESSAGES` -> `LANG` -> `'en'`)
- [ ] Call `await initI18n(...)` at top of CLI entry before command registration
- [ ] Replace all hardcoded strings in `cli/index.ts` with `t('cli:...')` calls
- [ ] Replace all hardcoded strings in `reporter/index.ts` with `t('cli:...')` calls
- [ ] Add string-width-aware padding utility for table alignment (German strings may be wider)

### Verification
- [ ] `npm run build` succeeds
- [ ] `claude-stats report` output unchanged (English default)
- [ ] `claude-stats --locale de report` runs without errors (shows English placeholders from stub)

---

## W3: VS Code Extension (parallel with W2, W4 — after W1)

**Owner:** 1 agent
**Scope:** `packages/cli/src/extension/`, `extension/package.json`, `packages/core/locales/en/extension.json`, `packages/core/locales/en/dashboard.json`
**Files modified:** 6 (`extension.ts`, `statusBar.ts`, `sidebar.ts`, `panel.ts`, `sync-integration.ts`, `extension/package.json`)
**Files created:** 6 (`en/extension.json`, `en/dashboard.json`, `de/extension.json` stub, `de/dashboard.json` stub, `package.nls.json`, `package.nls.de.json`)

This is the largest workstream. Can be split into W3a + W3b if needed.

### W3a: Extension runtime strings

**String extraction**
- [ ] Read `statusBar.ts` — extract 3 strings (idle, withStats, tooltip)
- [ ] Read `sidebar.ts` — extract ~80 strings (TAB_HELP: 8 tabs x ~4-7 sections each with heading + body)
- [ ] Read `panel.ts` — extract 3 strings (title, config error messages)
- [ ] Read `sync-integration.ts` — extract ~20 strings (status text, tooltips, dialogs, progress messages, error messages)
- [ ] Read `extension.ts` — extract 2 strings (sqlite error, generic error)
- [ ] Read `server/template.ts` — extract ~80 strings (tab names, chart titles, summary cards, period options, plan labels, settings labels)
- [ ] Create `packages/core/locales/en/extension.json` with keys:
  - `statusBar.*`, `sidebar.*`, `panel.*`, `sync.*`, `errors.*`
  - `tabHelp.overview.*`, `tabHelp.models.*`, `tabHelp.projects.*`, `tabHelp.sessions.*`, `tabHelp.plan.*`, `tabHelp.context.*`, `tabHelp.efficiency.*`, `tabHelp.settings.*`
- [ ] Create `packages/core/locales/en/dashboard.json` with keys:
  - `tabs.*` (overview, models, projects, sessions, plan, context, efficiency, settings)
  - `charts.*` (hourlyTokenUsage, dailyTokenUsage, tokenBreakdown, cacheUsage, cumulativeValue, tokensByModel, stopReasons, topProjects, sessionsByEntrypoint, usageWindows, topConversations)
  - `summary.*` (sessions, prompts, inputTokens, outputTokens, cacheEfficiency, estCost, planValue, activeHours, costPerPrompt, tokPerMin, throttleEvents)
  - `toolbar.*` (period, refresh, autoOff)
  - `plan.*` (account, currentPlan, weeklyActivity, windowLimitUsage, windowsPerWeek)
  - `settings.*` (pricingInfo, model, input, output, cacheRead, cacheWrite)
- [ ] Create `packages/core/locales/de/extension.json` — English stub
- [ ] Create `packages/core/locales/de/dashboard.json` — English stub

**Wiring**
- [ ] Call `initI18n({ lng: vscode.env.language, ... })` in `activate()` in `extension.ts`
- [ ] Replace hardcoded strings in `statusBar.ts` with `t()` calls
- [ ] Refactor `TAB_HELP` in `sidebar.ts` to use `t('extension:tabHelp.{tab}.sections', { returnObjects: true })`
- [ ] Replace hardcoded strings in `panel.ts` with `t()` calls
- [ ] Replace hardcoded strings in `sync-integration.ts` with `t()` calls
- [ ] Replace hardcoded strings in `extension.ts` with `t()` calls
- [ ] Update `renderDashboard()` in `server/template.ts` to accept `TFunction` parameter
- [ ] Replace hardcoded strings in `server/template.ts` with `t()` calls

### W3b: Extension manifest (NLS)

Can run in parallel with W3a — different files.

- [ ] Create `extension/package.nls.json` (English defaults for display name, description, command titles, setting descriptions)
- [ ] Create `extension/package.nls.de.json` (German translations)
- [ ] Update `extension/package.json`: replace literal strings with `%key%` references

### Verification
- [ ] Extension builds without errors (`npm run build:extension`)
- [ ] Dashboard renders correctly with English strings
- [ ] Sidebar help displays for each tab

---

## W4: React Frontend (parallel with W2, W3 — after W1)

**Owner:** 1 agent
**Scope:** `packages/frontend/src/`
**Files modified:** ~12 pages + ~4 components + `main.tsx`
**Files created:** 3 (`en/frontend.json`, `de/frontend.json` stub, `LanguageSwitcher.tsx`)

### String extraction
- [ ] Read all 27 page files in `packages/frontend/src/pages/` — extract user-facing strings
- [ ] Read all 7 component files in `packages/frontend/src/components/` — extract user-facing strings
- [ ] Create `packages/core/locales/en/frontend.json` with keys organized by page:
  - `login.*` (emailLabel, sendLink, checkEmail.heading, checkEmail.body, checkEmail.expiry, differentEmail, subtitle, error)
  - `dashboard.*` (welcome, subtitle, streak, usageTrend, modelMix)
  - `achievements.*` (heading, description, earned, cacheMaster.*, speedDemon.*, tenKClub.*, nightOwl.*, streakChampion.*, streakLegend.*, connected.*, teamPlayer.*, pennyPincher.*)
  - `sessions.*`, `projects.*`, `teams.*`, `compare.*`, `profile.*`, `accounts.*`
  - `admin.*`, `challenges.*`, `leaderboard.*`
  - `auth.*` (verify page strings)
  - `components.*` (KPI card labels, team card labels, member card labels, error boundary text, loading text)
  - `nav.*` (navigation labels, if any)
- [ ] Create `packages/core/locales/de/frontend.json` — English stub

### Wiring
- [ ] Set up i18next in `main.tsx` with `react-i18next` + `LanguageDetector`
- [ ] Create `packages/frontend/src/components/LanguageSwitcher.tsx`
- [ ] Add `LanguageSwitcher` to app layout/header
- [ ] Replace hardcoded strings in `Login.tsx` with `useTranslation()` + `t()` calls
- [ ] Replace hardcoded strings in `Dashboard.tsx`
- [ ] Replace hardcoded strings in `Achievements.tsx`
- [ ] Replace hardcoded strings in `Profile.tsx`
- [ ] Replace hardcoded strings in `Accounts.tsx`
- [ ] Replace hardcoded strings in `SessionsPage.tsx` + `SessionDetailPage.tsx`
- [ ] Replace hardcoded strings in `ProjectsPage.tsx`
- [ ] Replace hardcoded strings in `Teams.tsx` + `TeamDashboard.tsx` + `TeamSettingsPage.tsx`
- [ ] Replace hardcoded strings in `TeamMembersPage.tsx` + `TeamLeaderboardPage.tsx`
- [ ] Replace hardcoded strings in `TeamProjectsPage.tsx`
- [ ] Replace hardcoded strings in `TeamChallengesPage.tsx` + `ChallengePage.tsx`
- [ ] Replace hardcoded strings in `InterChallengesPage.tsx` + `InterChallengeDetailPage.tsx`
- [ ] Replace hardcoded strings in `Compare.tsx` + `CompareTeamPage.tsx`
- [ ] Replace hardcoded strings in `JoinTeamPage.tsx` + `CreateTeamPage.tsx`
- [ ] Replace hardcoded strings in `AdminPage.tsx` + `AdminDomainsPage.tsx` + `AdminTeamsPage.tsx`
- [ ] Replace hardcoded strings in `AuthVerify.tsx`
- [ ] Replace hardcoded strings in shared components: `KPICard.tsx`, `TeamCard.tsx`, `MemberCard.tsx`, `LeaderboardTable.tsx`, `ErrorBoundary.tsx`, `LoadingSkeleton.tsx`

### Verification
- [ ] `npm run build` succeeds in `packages/frontend`
- [ ] All pages render correctly with English strings
- [ ] Language switcher toggles between `en` and `de` (de shows English placeholders from stub)

---

## W5: German Translations (after W2, W3, W4)

**Owner:** 1-3 agents (can be split by namespace)
**Scope:** `packages/core/locales/de/` only (no code changes)

All English locale files are finalized at this point. This workstream replaces the English stubs in `de/` with actual German translations.

Can be parallelized by namespace — each file is independent:

### W5a: common.json + cli.json (1 agent)
- [ ] Translate `packages/core/locales/de/common.json` (~30 keys)
- [ ] Translate `packages/core/locales/de/cli.json` (~90 keys)

### W5b: extension.json + dashboard.json (1 agent)
- [ ] Translate `packages/core/locales/de/extension.json` (~110 keys, including verbose sidebar help)
- [ ] Translate `packages/core/locales/de/dashboard.json` (~80 keys)

### W5c: frontend.json (1 agent)
- [ ] Translate `packages/core/locales/de/frontend.json` (~50+ keys)

### Translation guidelines (all sub-agents)
- Use formal "Sie" form throughout
- Keep English for: Cache, Token, Dashboard, Session, API, CLI
- Prefer compound nouns: "Nutzungsfenster", "Kostenwarnung"
- Do not translate interpolation placeholders: `{{count}}`, `{{cost}}`
- Do not translate codicon prefixes: `$(graph)`, `$(cloud)`
- Keep translations concise — chart labels and table headers have limited space

---

## W6: CI, Testing & Polish (after W5)

**Owner:** 1 agent
**Scope:** Cross-cutting — scripts, CI, docs, integration testing

- [ ] Create `scripts/check-translations.ts` — compares key sets between `en/` and all other locale directories, flags missing keys and `[TODO]` prefixed values
- [ ] Add `check-translations` to `npm run lint` or as a standalone script
- [ ] Add CI job in `.github/workflows/ci.yml` to run translation check
- [ ] Test full app in German:
  - [ ] CLI: `LANG=de claude-stats collect && claude-stats report` — all output in German
  - [ ] CLI: `claude-stats --locale de report --html out.html` — HTML report in German
  - [ ] Extension: launch VS Code with `--locale de` — status bar, sidebar, dashboard all in German
  - [ ] Frontend: set browser to German — all pages render in German, language switcher works
- [ ] Test fallback: `--locale fr` falls back to English gracefully (no crashes, no missing key errors)
- [ ] Test mixed scenario: CLI in German + extension in English (independent i18n instances)
- [ ] Visual review: check for truncation, overflow, or layout issues with German strings (typically 20-30% longer)
- [ ] Update `README.md` — document `--locale` flag and supported languages
- [ ] Update `CONTRIBUTING.md` — document translation workflow for contributors

---

## Parallel execution summary

```
Time ──►

Agent 1:  ██ W1 ██ ─── ██████ W2: CLI ██████ ─── ██ W5a: translate common+cli ██
Agent 2:             ─── ██████ W3: Extension █████████████ ─── ██ W5b: translate ext+dash ██
Agent 3:             ─── ██████ W4: Frontend ██████ ─── ██ W5c: translate frontend ██
Agent 4:                                                                              ─── ██ W6 ██
```

| Phase | Agents active | Wall-clock | Blocking? |
|-------|--------------|------------|-----------|
| W1: Foundation | 1 | Short | Yes — all others depend on it |
| W2 + W3 + W4 | 3 (parallel) | Medium | No — independent file sets |
| W5a + W5b + W5c | 3 (parallel) | Medium | No — independent JSON files |
| W6: CI + Polish | 1 | Short | Yes — needs everything merged |

**Total agents:** 4 (3 concurrent max)
**Critical path:** W1 -> W3 (largest) -> W5b -> W6

## Merge strategy

Each workstream operates on a separate branch:

| Branch | Base | Files touched |
|--------|------|---------------|
| `i18n/foundation` | `master` | `packages/core/` |
| `i18n/cli` | `i18n/foundation` | `packages/cli/src/cli/`, `packages/cli/src/reporter/`, `packages/core/locales/en/cli.json` |
| `i18n/extension` | `i18n/foundation` | `packages/cli/src/extension/`, `packages/cli/src/server/`, `extension/`, `packages/core/locales/en/{extension,dashboard}.json` |
| `i18n/frontend` | `i18n/foundation` | `packages/frontend/src/`, `packages/core/locales/en/frontend.json` |
| `i18n/translations-de` | merge of cli+ext+frontend | `packages/core/locales/de/` |
| `i18n/ci-polish` | `i18n/translations-de` | `scripts/`, `.github/`, `README.md` |

Merge order: foundation -> (cli + extension + frontend in any order) -> translations-de -> ci-polish -> master

No merge conflicts expected between W2/W3/W4 since they modify disjoint file sets. The only shared touchpoint is `packages/core/locales/en/`, where each workstream creates a *new* file (no overlapping edits).
