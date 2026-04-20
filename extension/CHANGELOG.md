# Changelog

All notable changes to the Claude Stats VS Code extension are documented here.

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
