# 03 - Gaps and Opportunities

## Ecosystem-Wide Gaps

These are problems that NO tool currently solves well.

### 1. Sub-Agent Token Tracking

Most JSONL-based tools miss tokens consumed by Claude Code's parallel sub-agents because they don't scan the `subagents/` subdirectory. Users of those tools report seeing only ~10% of actual usage when sub-agents are heavily used.

**claude-stats solves this.** The scanner explicitly discovers JSONL files in `subagents/` directories, parses them as independent sessions, and links them to their parent session via the `parentUuid` field in the JSONL data. Sub-agent tokens are included in all aggregate totals (daily, project, window), and the parent-child relationship is stored in the database for per-session drill-down.

### 2. No Combined Claude Web + Claude Code Tracking

Pro/Max subscribers share rate limits across claude.ai and Claude Code, but no tool aggregates usage across both. Users get rate-limited unexpectedly because they can't see their combined consumption.

**Potential approach:** Use the undocumented claude.ai usage API (see [04-claudemeter-api.md](04-claudemeter-api.md)) for real-time combined utilization. Risky due to API instability.

### 3. Log Rotation Destroys History

Claude Code's default 7-day log rotation means all JSONL-based tools lose historical data unless users manually archive. Most tools don't warn about this.

**claude-stats advantage:** Already solved. The SQLite database preserves all collected data indefinitely, independent of log rotation. Incremental collection means data is captured before rotation deletes it.

### 4. No Multi-Device Aggregation

All tools read local files only. Developers using Claude Code across multiple machines have no unified view.

**Potential approaches:**
- SQLite database export/import/merge
- Optional sync to a shared location (S3, NAS, git)
- Accept this as out of scope (complexity vs. demand)

### 5. Per-Project Budgeting

No tool offers project-level budget limits with alerts. Users can set global thresholds but can't say "alert me if Project X exceeds $50/week."

**claude-stats advantage:** Already has per-project filtering in reports and the tag system. Adding per-project thresholds would be incremental.

### 6. Rate Limit Prediction

Only Clauder (paid SaaS) attempts ML-based rate limit prediction. All other tools are purely retrospective.

**Potential approach:** Trend-based projection using recent window consumption rates -- simpler than ML, still useful.

---

## claude-stats Unique Strengths

Features that no competitor currently offers in combination:

### Already Shipped

| Feature | Closest Competitor | Advantage |
|---------|-------------------|-----------|
| Incremental SQLite collection with crash recovery | ccboard (SQLite cache) | claude-stats also has rewrite detection, error quarantine, and schema fingerprinting |
| Model efficiency scoring + complexity classification | None | Unique -- scores tasks 0-100 and recommends appropriate model tier |
| Context/compaction analysis | None | Unique -- detects compaction events, tracks context growth curves, flags sessions needing better management |
| Plan ROI with per-account breakdown | None | Unique -- calculates plan multiplier, cost per prompt, recommends plan changes |
| Unified CLI + web dashboard + VS Code extension | None | ccusage has CLI only, ccboard has CLI+TUI+web, but none combine all three with a VS Code extension |
| Session tagging | None | ccboard has search but no user-defined tags |
| Self-contained VS Code extension | None | All dependencies bundled, no separate install required |
| Velocity metrics (tokens/min, prompts/hour) | None | Unique |
| Throttle detection and per-window tracking | Partial in ccburn | claude-stats links throttles to specific windows and accounts |
| Sub-agent token collection + parent-child linking | cccost (via fetch hook) | claude-stats scans subagents/ dirs and links child sessions to parents via parentUuid -- no wrapper needed |

### Potential Differentiators to Build

| Opportunity | Difficulty | Impact | Notes |
|-------------|-----------|--------|-------|
| Real-time rate limit display via claude.ai API | Medium | High | See [04-claudemeter-api.md](04-claudemeter-api.md). Risky (undocumented API) but high-value. Could show utilization % and reset countdown in status bar |
| ~~Sub-agent token reconciliation~~ | ~~Done~~ | ~~High~~ | Shipped: scans subagents/ dirs and links parent-child sessions |
| Per-project budget alerts | Easy | Medium | Extend existing config/alert system with project-scoped thresholds |
| Rate limit projection | Medium | Medium | Extrapolate current window burn rate to estimate time-to-limit |
| npx/zero-install support | Easy | Medium | Would lower adoption barrier significantly (ccusage's biggest UX win) |
| MCP server mode | Medium | Medium | Expose stats as MCP tools so Claude Code itself can query usage |
| Team dashboard (multi-user) | Hard | Low | Small market, enterprise users already have Anthropic Console |

---

## Competitive Positioning Summary

### vs. ccusage (the incumbent)

ccusage wins on: zero-install (`npx`), community size, MCP integration, broad ecosystem support (Codex, Amp, OpenCode).

claude-stats wins on: incremental collection (no re-parsing), web dashboard, VS Code extension, model efficiency analysis, context analysis, plan ROI, session tagging, historical data preservation past log rotation, crash safety.

**Strategy:** Don't compete on quick CLI usage reports (ccusage owns that). Compete on depth of analysis, visualization, and integrated experience.

### vs. ccboard (the feature-rich)

ccboard wins on: TUI quality, security auditing (credential detection), live process monitoring, FTS5 search quality, Rust performance.

claude-stats wins on: VS Code integration, plan ROI, model efficiency scoring, context analysis, Node.js accessibility (no Rust toolchain needed), web dashboard accessibility.

**Strategy:** Complementary more than competitive. Different audiences -- ccboard appeals to terminal-native users, claude-stats to VS Code users who want a dashboard.

### vs. VS Code extensions

Claudemeter/Usage Tracker win on: real-time rate limit data, reset countdowns.

claude-stats wins on: depth of analysis (efficiency, context, ROI), full dashboard with charts, historical data, CLI for scripting.

**Strategy:** Consider adding real-time rate limit display (the one thing users clearly want that claude-stats lacks). The undocumented API is risky but could be offered as an opt-in feature.
