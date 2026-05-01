# Internationalization (i18n): Implementation Plan

claude-stats has ~200+ user-facing strings spread across four surfaces: the VS Code extension (status bar, sidebar help, sync dialogs), the CLI (commander descriptions, reporter output), the HTML dashboard template, and the React frontend. All strings are currently hardcoded in English with no localization infrastructure.

This plan covers adding full i18n support for English (en) and German (de), with an architecture that makes adding further languages straightforward.

## Surfaces & string counts

| Surface | Key files | Approx. strings | Interpolation style |
|---------|-----------|-----------------|---------------------|
| VS Code extension | statusBar.ts, sidebar.ts, panel.ts, sync-integration.ts, extension.ts | ~110 | Template literals |
| CLI | cli/index.ts, reporter/index.ts | ~90 | Template literals, console.log |
| HTML dashboard template | server/template.ts | ~80 | Embedded in generated HTML |
| React frontend | pages/*.tsx, components/*.tsx | ~50 | JSX |
| Extension manifest | extension/package.json | ~8 | VS Code NLS |

## Approach

| | Option A: i18next everywhere | Option B: VS Code NLS + i18next | Option C: Manual key-value maps |
|---|---|---|---|
| **Consistency** | Single API across all surfaces | Two APIs (vscode-nls + i18next) | Single API, no deps |
| **React integration** | First-class (react-i18next) | Needs i18next for React anyway | Manual wiring |
| **VS Code idiom** | Non-standard for extensions | Follows VS Code conventions | Non-standard |
| **Bundle size** | ~40 kB (i18next core) | ~8 kB (vscode-nls) + ~40 kB | 0 |
| **Plural/date support** | Built-in | Partial (NLS) + built-in | DIY |
| **New language effort** | Add JSON file | Add JSON file(s) | Add JSON file |

**Recommendation: Option A (i18next everywhere).** One API, one set of JSON locale files, consistent interpolation syntax. The VS Code extension is not published to the marketplace, so conforming to vscode-nls is unnecessary. i18next is the de-facto standard with proven TypeScript support, ICU message format, and namespace splitting.

## Documents

1. [Architecture & library choices](./01-architecture.md) -- i18next setup, namespace design, locale file structure
2. [String extraction & key naming](./02-string-extraction.md) -- How to extract strings, naming conventions, interpolation patterns
3. [Per-surface implementation](./03-per-surface.md) -- Extension, CLI, HTML template, React frontend
4. [Language detection & switching](./04-language-detection.md) -- How each surface detects the user's language
5. [Translation workflow](./05-translation-workflow.md) -- Adding new languages, keeping translations in sync
6. [Migration checklist](./06-migration-checklist.md) -- Phased rollout steps
7. [Parallel implementation](./07-parallel-implementation.md) -- Multi-agent workstreams, dependency graph, merge strategy
