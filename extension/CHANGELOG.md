# Changelog

All notable changes to the Claude Stats VS Code extension are documented here.

## 0.2.0 — 2026-04-21

### Added

- **Seven new languages.** Japanese (`ja`), Simplified Chinese (`zh-CN`), French (`fr`), Spanish (`es`), Brazilian Portuguese (`pt-BR`), Polish (`pl`), and Ukrainian (`uk`) — all VS Code surfaces (status bar, welcome state, sidebar help, dashboard, tab descriptions, MCP toasts) follow your VS Code display language. Technical terms (token, cache, MCP, API, Claude Code, Opus/Sonnet/Haiku) are kept in English where native-speaker developers use the English term; UI chrome matches VS Code's own localized terminology per locale.
- **Welcome state** shown when no Claude Code sessions have been collected yet — clear step-by-step instructions instead of an empty dashboard full of zeroed-out charts. Distinguishes the "Claude Code not installed" case from "no sessions recorded yet" and offers different instructions for each.
- **MCP-registration failures are now surfaced as warning toasts** with actionable guidance — no more silent `console.warn` when the extension can't install its MCP server. Distinguishes "no Node.js on PATH" (install Node 22.5+) from write failures (check `~/.claude.json` permissions) from generic errors, so you know what to fix. The dashboard and collector keep working; only the MCP integration is disabled until resolved.
- **Status bar tooltip** is now empty-state-aware, pointing first-time users to setup instructions instead of showing "0 tokens · ~$0.00".

### Internal

- Locale parity CI script (`npm run locales:check`) enforces structural key parity across all locales — missing/extra keys, mismatched `{{placeholders}}`, and mismatched `$(codicons)` all fail the build.
- Opus-driven auto-translation (`npm run locales:fill`) fills missing translation keys in every non-en locale using `claude-opus-4-7`, and a `.github/workflows/locales-fill.yml` workflow runs it automatically on PRs that touch English strings.

## 0.1.4 — 2026-04-20

- Fix stale MCP server path in `~/.claude.json` after extension upgrades (previously caused `MCP error -32000: Connection closed` until the Claude Stats sidebar was manually opened)
- Activate on VS Code startup (`onStartupFinished`) so the MCP registration is refreshed without waiting for the sidebar to be opened
- Notify on every MCP path update — not just first install — so users know to restart Claude Code after upgrading the extension

## 0.1.2 — 2026-04-20

- Fix broken dashboard screenshot on marketplace listing (GitHub org URL was `deotio`, correct is `de-otio`)
- Correct repository, bugs, and homepage URLs in `package.json`

## 0.1.1 — 2026-04-20

- Marketplace metadata: icon, README, CHANGELOG, keywords, bugs URL
- Publisher set to `de-otio`; display name changed to "Claude Stats by de-otio" to resolve marketplace name collision
- No runtime code changes

## 0.1.0 — 2026-04-16

Initial release.

- Dashboard webview with tokens, cost, sessions, cache efficiency, and streaks
- Per-project breakdown and top-conversations chart
- Spending view with model, session, tool, and MCP-server attribution
- Environmental context panel (energy, CO₂, and comparable everyday figures)
- Work profile chart showing the nature of work distribution by project
- Auto-registration of a bundled local MCP server in `~/.claude.json`
- Configurable dashboard auto-refresh interval
