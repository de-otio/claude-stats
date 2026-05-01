# 01 - Competitive Landscape

## Native Claude Code Features

Claude Code ships four built-in slash commands for usage monitoring:

| Command | Purpose | Availability |
|---------|---------|-------------|
| `/cost` | Session API cost and token counts | API users (shows $0.00 for Pro/Max) |
| `/stats` | Usage graph, streak, favorite model (7d/30d/all) | All users |
| `/usage` | Plan limits, rate limit status, remaining capacity, reset timing | Pro/Max subscribers |
| `/context` | Token breakdown for current context window | All users |

**Strengths:** Zero setup, always available, real-time.
**Gaps:** No historical analysis, no cross-session aggregation, no visualization, no export, no cost estimation for subscription users.

## Anthropic Console

The console at console.anthropic.com provides:

- Usage page with per-model and per-key breakdowns
- Billing history and spend tracking
- Workspace-level spend limits
- Usage & Cost API (`/v1/organizations/cost_report`) for programmatic access
- Team/Enterprise: lines accepted, accept rate, daily active users, per-member CSV export

**Gaps:** No individual session-level analysis, no local data visualization, no subscription-plan ROI analysis.

## CLI Tools

### ccusage -- The Dominant Player

- **Stars:** ~11,500 | **Language:** TypeScript | **Install:** `npx ccusage@latest`
- Daily/monthly/session/5-hour-block reports with per-model costs
- Cache token separation, date filtering, JSON export, MCP server
- Companion packages for Codex, OpenCode, Amp

**Key limitations:**
- No web dashboard or TUI -- terminal tables only
- No incremental collection -- reparses all JSONL files every run
- Misses sub-agent/sub-task tokens entirely (users report ~10% of actual usage displayed)
- 30GB memory usage reported with large datasets
- RangeError on files >700MB
- No search, tagging, or session management
- No VS Code extension (third-party wrapper exists)
- Claude's 7-day log rotation limits historical analysis

### ccboard -- Most Feature-Rich Alternative

- **Language:** Rust | **Binary:** 5.8MB | **Install:** Homebrew, cargo, or prebuilt
- 11-tab TUI + web dashboard with SSE live updates
- FTS5 full-text search, CSV/JSON export
- Credential leak detection, destructive command alerts
- Live process monitoring (CPU/RAM), 4-column config diff
- SQLite cache: 89x faster repeat startup (20s → 224ms)

**Key limitations:**
- `cargo install` omits web UI (needs WASM build)
- Windows experimental, small community (16 stars)
- No VS Code extension
- No plan ROI or efficiency analysis

### claudelytics -- Speed-Focused

- **Language:** Rust | **Install:** cargo
- Parallel JSONL processing via rayon (handles 10k+ files)
- Enhanced TUI with 9 tabs, real-time watch mode
- Interactive fuzzy-searchable session browser
- Multiple output formats, shell aliases

**Key limitations:**
- Beta software
- No web dashboard, no VS Code extension
- No search/tagging beyond interactive browser

### cccost -- Most Accurate Tracking

- **Language:** Node.js | **Install:** `npm install -g @mariozechner/cccost`
- Hooks Node.js `fetch()` to intercept actual API requests
- Captures requests invisible to JSONL logs (most accurate cost data)
- Tracks resumed sessions correctly (unlike `/cost` which resets)

**Key limitations:**
- Requires using `cccost` wrapper instead of `claude` command
- No visualization, dashboard, or aggregation -- JSON files only
- Could break with Claude Code updates
- Injects code into Claude Code's Node process

### ccburn -- Budget Pacing

- **Language:** Python | **Install:** pip, npm, or WinGet
- ASCII burn-up charts, pace indicators, time-to-limit predictions
- Compact mode for status bars, JSON output, SQLite persistence

**Key limitations:**
- No per-project tracking, no cache breakdown
- No VS Code extension, no search/tagging

## VS Code Extensions

| Extension | Installs | Approach | Key Feature |
|-----------|----------|----------|-------------|
| Claude Code Usage Tracker | ~1,250 | Local JSONL | 5-hour window countdown, burn rate predictions |
| Claudemeter | ~675 | claude.ai API | Direct utilization %, reset timers, service status |
| Claude Token Monitor | ~500 | Wraps ccusage | 11 languages, auto plan detection |
| Claude Meter (DataWrights) | ~80 | Local JSONL | ASCII sparklines, 30-day history |
| Clauder | SaaS | Anthropic API | ML predictions, Slack/Discord alerts ($1.99/mo pro) |

**Common gaps:** No model efficiency analysis, no context management insights, no plan ROI, limited historical depth.

## macOS Apps

- **ClaudeMeter** (github.com/eddmann/ClaudeMeter) -- SwiftUI menu bar app using undocumented claude.ai API for real-time utilization percentages and reset countdowns (see [04-claudemeter-api.md](04-claudemeter-api.md))
- **ClaudeUsageTracker** (github.com/masorange/ClaudeUsageTracker) -- SwiftUI menu bar showing monthly cost breakdowns

## Other

- **claude-code-otel** -- Enterprise-grade: OpenTelemetry + Prometheus + Grafana stack for team monitoring
- **claude-code-log** -- Converts JSONL transcripts to readable HTML
- **claude-code-leaderboard** -- Posts token stats to a team leaderboard after each session
