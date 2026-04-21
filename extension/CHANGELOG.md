# Changelog

All notable changes to the Claude Stats VS Code extension are documented here.

## 0.2.2 — 2026-04-21

### Security hardening

- **Local dashboard now binds to `127.0.0.1` only** (previously bound to `0.0.0.0`/all interfaces due to a silently-failing double-`listen` call). The dashboard is no longer reachable from the LAN, and a `Host` header allowlist rejects requests that don't claim `localhost` / `127.0.0.1` / `[::1]` — blocking DNS-rebinding attacks from webpages.
- **`POST /api/config` now requires a bearer token.** A fresh token is generated each time the server starts and delivered to the same-origin dashboard SPA via a `SameSite=Strict` cookie. Any webpage attempting to CSRF the local config endpoint is rejected with 401. The token is compared with `crypto.timingSafeEqual`. Read-only `/api/dashboard` / `/api/status` endpoints remain unauthenticated for backward compatibility.
- **MCP tools (`search_history`, `get_session_detail`) now wrap stored prompt text in explicit untrusted-content markers** and updated tool descriptions tell the caller agent to treat the returned text as data, not instructions. Prevents second-order prompt injection where an adversarial string pasted into Claude Code once could later be surfaced to a future agent as a tool result that reinterpreted it as system-level instructions.
- **Prompt sanitization is now escape-based, deny-by-default.** The previous allow-list-based `extractPromptText` has been replaced with a sanitizer that strips known system-injected tag blocks for display cleanliness but then escapes *all* remaining `<` / `>` / `&`. This neutralizes Claude's own function-call vocabulary (`<function_calls>`, `<invoke>`, `<parameter>`), text-completions control tokens (`<|im_start|>`, `[INST]`, etc.), and any invented XML-ish tags — without needing an exhaustive block-list. Sanitization happens BEFORE the 2000-char truncation so a malicious tag cannot survive by splitting its close-tag past the cap.
- **Dashboard HTML template now escapes every user-controlled interpolation** (project paths, prompt previews, model names, MCP server/tool names, account display names, energy regions). A separate fix escapes `<` inside the inline JSON bootstrap block so a value containing literal `</script>` cannot break out of the script tag. This closes an XSS vector that would have fired in both the browser dashboard and the VS Code webview panel.
- **Scanner no longer follows symbolic links** inside `~/.claude/projects/`. Uses `fs.lstatSync` + `isFile()` checks so symlinks and other non-regular entries are skipped.
- Added an invariant comment on the `-e` inline script in `mcp-register.ts` documenting that only `__dirname`-derived paths may be interpolated there — guarding against future code-execution regressions.

### Internal

- New shared sanitizer at `packages/core/src/sanitize.ts`, exported as `@claude-stats/core/sanitize`.
- 44 new security-focused test cases across `parser.test.ts`, `history.test.ts`, `mcp.test.ts`, `template.test.ts`, `scanner.test.ts`, and `server.test.ts`.
- VSIX no longer accidentally bundles `.claude-flow/data/` (added to `.vscodeignore`).

## 0.2.1 — 2026-04-21

- Prompt to reload the window after extension upgrades, so already-open dashboards reconnect to the new extension host. Without reloading, the Refresh button and Period dropdown in an open dashboard silently stop working — VS Code keeps the old extension host attached to existing webviews after an in-place update. The prompt appears once on the activation after any version bump; "Later" dismisses it without reloading.

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
