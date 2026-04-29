# Changelog

All notable changes to the Claude Stats VS Code extension are documented here.

## 0.3.0 — 2026-04-29

### Added — Daily-recap feature

- **`claude-stats recap [--date | --tz | --json | --all]` CLI command** and a **`summarize_day` MCP tool** that return a structured digest of the user's day — clusters of topic segments across sessions joined to author-scoped git activity, ranked by outcome impact, with first prompts quoted verbatim. The pipeline is fully deterministic at the service layer (segment → cluster → git enrichment → cache); LLM synthesis is optional and lives in the calling agent.
- **Confidence scores per item** (`high`/`medium`/`low`) drive default rendering: high+medium shown by default, low items collapsed into "+N brief items (use --all to show)". Computed deterministically — no LLM.
- **Phrase-template bank** at `recap/templates.ts` selects rendering by confidence. Untrusted slots are mandatorily backtick-delimited; backticks in source values are escaped.
- **Self-consistency guard** (`recap/guard.ts`) catches LLM hallucinations against the source digest — flags missing entities, count mismatches, unknown file paths, verb/confidence mismatches.
- **Background pre-computation** via `claude-stats recap precompute --lookback-days N`; `--install-cron` prints a crontab snippet (does NOT modify crontab).
- **User-correctable digests** via `claude-stats recap correct {merge,split,rename,hide,list,remove}`. Persists in `~/.claude-stats/recap-corrections.db` (mode `0o600`) keyed by signature so the same correction applies to recurring tasks across days.
- **Optional local sentence embeddings** for semantic clustering. Pinned `Xenova/all-MiniLM-L6-v2` (int8, 23MB, Apache-2.0); SHA-256 verified before first use; mismatched models deleted, fallback to Jaccard. Opt-in via `--embeddings=on|off|auto`.
- **Incremental digest patcher** (feature flag `--patch-cache`, default off) that splices new messages/commits into the prior digest. Determinism verified — byte-identical to full rebuild.
- **MCP tool description guidance** for calling agents: prompt-caching pattern (`cache_control: ephemeral`), tier-routing (Haiku for classifiers, Sonnet for prose), `max_tokens` caps, and entity-presence post-check.
- **Offline LLM-as-judge tuning script** (`packages/cli/src/recap/tune-segmenter.ts`, maintainer tool). Strict opt-in: `--dry-run` default, sample preview, typed `yes` confirmation, no automatic invocation, redacted auth headers.
- **Parser enrichment** captures `tool_use.input.file_path` (`Edit`/`Write`/`Read`/`MultiEdit`), dirname of `Glob.pattern`, and `Bash.cwd` into the new `messages.file_paths` column. Schema migration v9 → v10, additive and idempotent.

### Security

23+ dedicated negative tests verify every recap-feature gate:

- **Subprocess argument injection (SR-1):** `execFile` with `--` separators and validated email regex; malicious `user.email` (`--output=…`, newlines, leading `-`) cannot inject arguments.
- **Untrusted-slot rendering (SR-2):** every templating path wraps in single backticks and escapes embedded backticks. Markdown injection (`# OWNED`) and envelope-escape attempts blocked.
- **File permissions (SR-3):** all writes under `~/.claude-stats/` go through a shared `fs-secure` helper (`0o700` dirs, `0o600` files, `chmod`-after-write). Pre-existing loose perms tightened.
- **Cache-key correctness (SR-4):** snapshot hash includes sorted project paths and `Intl`-derived TZ. New-project-on-empty-day invalidates correctly.
- **Embedding model integrity (SR-5):** SHA-256 pinned in source; tampered files deleted; no user-supplied model paths.
- **Corrections SQL injection (SR-6):** parameterised queries exclusively; SQL-injection labels stored verbatim, control characters rejected, 200-char cap.
- **LLM-as-judge privacy (SR-7):** tuning script makes 0 API calls without explicit consent; `Authorization` header redacted from error output.
- **Wrap-untrusted preservation (SR-8):** envelope preserved through builder, MCP, JSON CLI, cache, and patcher.

### Internal

- 14 new files under `packages/cli/src/recap/`, 9 new test files. **1,111 project-wide tests passing** (+194 from prior baseline).
- Three-release implementation plan documented under `plans/daily-recap/` (gitignored); full design + security review under `doc/analysis/daily-recap/`.
- New optional dependency: `@huggingface/transformers@^3.0.0` — only loaded when embeddings are enabled and a hash-verified model is on disk.

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
