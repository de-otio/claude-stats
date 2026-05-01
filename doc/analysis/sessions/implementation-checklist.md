# Implementation Checklist — Multi-Agent Parallel Execution

## Dependency Graph

```
Phase 1: Foundation
  └─ Track A: Types + Schema (BLOCKS everything)

Phase 2: Core Layer (all parallel after Phase 1)
  ├─ Track B: Parser — new fields + throttle detection
  ├─ Track C: Store — new columns, queries, migrations
  └─ Track D: Config — plan pricing

Phase 3: Business Logic (after B + C)
  ├─ Track E: Aggregator — window computation, session metrics
  └─ Track F: Reporter — CLI plan ROI output

Phase 4: Presentation (after C + E)
  ├─ Track G: Dashboard data builder — new summary/series fields
  └─ Track H: Template — new charts + cards (HTML scaffolding can start in Phase 3)

Phase 5: Validation
  └─ Track I: Tests (unit + integration, per-track)
```

---

## Phase 1 — Foundation

### Track A: Types & Schema Migration

**Files:** [src/types.ts](src/types.ts), [src/store/index.ts](src/store/index.ts)

**Blocks all other tracks. Complete this first.**

- [x] **A1** Add `service_tier?: string` and `inference_geo?: string` to `MessageRecord` in [src/types.ts](src/types.ts)
- [x] **A2** Add `ephemeral5mCacheTokens: number` and `ephemeral1hCacheTokens: number` to `MessageRecord`
- [x] **A3** Add `throttleEvents: number`, `activeDurationMs: number | null`, `medianResponseTimeMs: number | null` to `SessionRecord`
- [x] **A4** Add new `UsageWindow` interface to types.ts
- [x] **A5** Add `PlanConfig` interface (actual types: `"pro" | "max_5x" | "max_20x" | "team_standard" | "team_premium" | "custom"`)
- [x] **A6** Extend `DashboardData.summary` type to include new ROI + velocity + window fields
- [x] **A7** Add `byWindow` and `byConversationCost` arrays to `DashboardData` type
- [x] **A8** DB schema version is now at **v8** (v7 added these columns; v8 added `prompt_text` to messages)
- [x] **A9** Migration v6→v7: added 4 columns to `messages` table
- [x] **A10** Migration v6→v7: added 3 columns to `sessions` table
- [x] **A11** Migration v6→v7: created `usage_windows` table
- [x] **A12** Migration chain runs cleanly (v0→v8)

---

## Phase 2 — Core Layer (run Tracks B, C, D in parallel)

### Track B: Parser — New Fields + Throttle Detection

**Files:** [src/parser/session.ts](src/parser/session.ts)
**Depends on:** Track A complete

- [x] **B1** Parse `service_tier` from `message.usage.service_tier` and assign to `MessageRecord`
- [x] **B2** Parse `inference_geo` from `message.usage.inference_geo` and assign to `MessageRecord`
- [x] **B3** Parse `ephemeral_5m_input_tokens` from `message.usage.cache_creation.ephemeral_5m_input_tokens`
- [x] **B4** Parse `ephemeral_1h_input_tokens` from `message.usage.cache_creation.ephemeral_1h_input_tokens`
- [x] **B5** Implement throttle detection heuristic:
  - Count messages where `stop_reason === "max_tokens"` AND `output_tokens < 200`
  - Add result as `throttleEvents` on `SessionRecord`
- [x] **B6** Compute `activeDurationMs` on `SessionRecord`:
  - Collect all timestamps during parsing
  - Filter out gaps > 30 minutes between consecutive messages (idle time)
  - Sum remaining intervals as active duration
- [x] **B7** Compute `medianResponseTimeMs` on `SessionRecord`:
  - For each assistant message, find the preceding user message timestamp
  - Compute `assistantTs - userTs` for each pair
  - Store median value (sort + middle index)
- [x] **B8** Ensure all new fields default gracefully to 0/null when usage data is absent (defensive parsing)

---

### Track C: Store — New Columns + Queries

**Files:** [src/store/index.ts](src/store/index.ts)
**Depends on:** Track A complete

- [x] **C1** Update `upsertMessages()` to include the 4 new columns (`service_tier`, `inference_geo`, `ephemeral_5m_cache_tokens`, `ephemeral_1h_cache_tokens`) in INSERT and UPDATE clauses
- [x] **C2** Update `upsertSessions()` to include `throttle_events`, `active_duration_ms`, `median_response_time_ms`
  - Use `MAX()` coalesce for `throttle_events` (not additive when re-processing)
- [x] **C3** Add `upsertUsageWindow(window: UsageWindow): void` method
- [x] **C4** Add `getUsageWindows(filters: { since?: number; until?: number; accountUuid?: string }): UsageWindow[]` query
- [x] **C5** Add `getCurrentWindow(accountUuid?: string): UsageWindow | null` — returns the most recent window
- [x] **C6** Add `getSessionsByConversationCost(filters: SessionFilters, limit?: number): SessionRecord[]` — sorts by estimated cost descending
- [x] **C7** Add `getVelocityMetrics(filters: SessionFilters): { tokensPerMinute: number; promptsPerHour: number; outputTokensPerPrompt: number }` — aggregates across filtered sessions using `active_duration_ms`
- [x] **C8** Add `getTotalActiveHours(filters: SessionFilters): number` — sum of `active_duration_ms` / 3_600_000
- [x] **C9** Update `getSessions()` row mapper to include the 3 new session columns

---

### Track D: Config — Plan Pricing

**Files:** [src/config.ts](src/config.ts)
**Depends on:** Track A complete

- [x] **D1** Config uses JSON format (`~/.claude-stats/config.json`), not TOML
- [x] **D2** Add `plan` section to config:
  ```json
  { "plan": { "type": "max_5x", "monthly_fee": 100.00 } }
  ```
- [x] **D3** Auto-derive `monthlyFee` from `type` if not overridden:
  - `pro` → $20, `max_5x` → $100, `max_20x` → $200, `team_standard` → $25, `team_premium` → $125, `custom` → 0
- [x] **D4** Auto-detect plan from `subscriptionType` telemetry field when config is absent:
  - Map known `subscriptionType` string values to `PlanType`
  - Fall back to null if unknown (returns null PlanConfig, not a default)
- [x] **D5** Export `getPlanConfig(config, subscriptionType?)` utility function
- [x] **D6** Add `plan` field to config interface

---

## Phase 3 — Business Logic (run Tracks E, F in parallel)

### Track E: Aggregator — Window Computation + Session Metrics

**Files:** [src/aggregator/index.ts](src/aggregator/index.ts)
**Depends on:** Track B + Track C complete

- [x] **E1** After processing each session file, compute 5-hour usage windows
- [x] **E2** Detect throttled windows
- [x] **E3** Upsert each computed window via `store.upsertUsageWindow()`
- [x] **E4** Ensure window computation is idempotent
- [x] **E5** Handle cross-session windows

---

### Track F: Reporter — CLI Plan ROI Output

**Files:** [src/reporter/index.ts](src/reporter/index.ts)
**Depends on:** Track C + Track D complete

- [x] **F1** Add plan ROI section to `printSummary()`
- [x] **F2** Add velocity row to `printSummary()`
- [x] **F3** Add `activeDuration` to session list in `printSessionList()`
- [x] **F4** Add per-conversation cost column to `printSessionList()`
- [x] **F5** Add current window status to `printSummary()`
- [x] **F6** Update `printTrend()` to include a daily plan-value column
- [x] **F7** Format `planMultiplier` as e.g. "8.3×" with × symbol for readability

---

## Phase 4 — Presentation (run Tracks G, H in parallel)

### Track G: Dashboard Data Builder

**Files:** [src/dashboard/index.ts](src/dashboard/index.ts)
**Depends on:** Track C + Track E complete

- [x] **G1** Call `getPlanConfig()` in dashboard builder and include `planFee` in summary
- [x] **G2** Compute `planMultiplier = estimatedCost / planFee` (0 if planFee is 0)
- [x] **G3** Compute `costPerPrompt = estimatedCost / totalPrompts`
- [x] **G4** Compute `costPerActiveHour` using `getTotalActiveHours()`
- [x] **G5** Compute `dailyValueRate = estimatedCost / daysInPeriod`
- [x] **G6** Call `getVelocityMetrics()` and include `tokensPerMinute`, `promptsPerHour`, `outputTokensPerPrompt` in summary
- [x] **G7** Compute `totalActiveHours` and `avgSessionDurationMinutes` from session data
- [x] **G8** Build `byWindow` array from `getUsageWindows()` for the selected period
- [x] **G9** Build `byConversationCost` array: top 20 sessions by cost, with `percentOfPlanFee`
- [x] **G10** Add `throttleEvents` total (sum across sessions) to summary
- [x] **G11** Add `currentWindowStart`, `currentWindowTokens`, `estimatedWindowPercent` from `getCurrentWindow()`
- [x] **G12** Update `sessionsToday` count in summary

---

### Track H: Template — New Charts + Cards

**Files:** [src/server/template.ts](src/server/template.ts)
**Depends on:** Track G complete (but HTML/CSS scaffolding can start in Phase 3)

#### Cards (add to existing summary row)

- [x] **H1** Add **Plan Value** card: `"$X.XX API value — Nx your $Y/mo plan"` (hide if planFee = 0)
- [x] **H2** Add **Active Hours** card: total active hours for the period
- [x] **H3** Add **Cost/Prompt** card: `"$X.XX per prompt"`
- [x] **H4** Add **Window Status** card: gauge-style display of current 5-hour window utilization %

#### New Charts (add after existing 7 charts)

- [x] **H5** **Cumulative Usage Curve** (line chart)
- [x] **H6** **Usage Window Timeline** (horizontal bar or scatter)
- [x] **H7** **Token Velocity** (line chart)
- [x] **H8** **Session Cost Distribution** (bar chart / histogram)
- [x] **H9** **Top Expensive Conversations** (horizontal bar)

#### Enhance Existing Charts

- [x] **H10** Add horizontal reference line to daily token chart: "daily plan budget"
- [x] **H11** Add cost column to by-model chart
- [x] **H12** Update summary section to show plan multiplier prominently ("8.3× value")

---

## Phase 5 — Validation

### Track I: Tests

**Files:** [src/__tests__/](src/__tests__/)
**Depends on:** All tracks complete (or write alongside each track)

#### Parser Tests

- [x] **I1** Test `service_tier` is parsed from usage data and stored on MessageRecord
- [x] **I2** Test ephemeral cache fields parse correctly from nested `cache_creation` object
- [x] **I3** Test `throttleEvents` counter: messages with `stop_reason=max_tokens` + `output_tokens<200`
- [x] **I4** Test `throttleEvents` is 0 when no heuristic matches
- [x] **I5** Test `activeDurationMs` excludes gaps > 30 minutes
- [x] **I6** Test `medianResponseTimeMs` with even and odd prompt counts
- [x] **I7** Test all new fields default to 0/null when usage data is missing

#### Store Tests

- [x] **I8** Test migration v6→v7 runs without error on fresh DB
- [x] **I9** Test migration v6→v7 runs without error on populated v6 DB (existing rows get defaults)
- [x] **I10** Test `upsertUsageWindow()` is idempotent (insert same window twice = no duplicate)
- [x] **I11** Test `getUsageWindows()` filters by time range
- [x] **I12** Test `getCurrentWindow()` returns the most recent window
- [x] **I13** Test `getVelocityMetrics()` returns 0 values when no active_duration_ms data

#### Aggregator Tests

- [x] **I14** Test window assignment: 3 sessions within 5 hours → 1 window
- [x] **I15** Test window boundary: 2 sessions 6 hours apart → 2 windows
- [x] **I16** Test throttled window detection propagates from session `throttle_events`
- [x] **I17** Test re-running aggregation is idempotent (same windows, no duplicates)

#### Config Tests

- [x] **I18** Test `getPlanConfig()` returns correct defaults per plan type
- [x] **I19** Test `monthly_fee` override in JSON config takes precedence over type default
- [x] **I20** Test auto-detection from `subscriptionType` telemetry field

#### Dashboard Tests

- [x] **I21** Test `planMultiplier` is 0 when `planFee` is 0 (no divide-by-zero)
- [x] **I22** Test `byWindow` is populated from store query
- [x] **I23** Test `byConversationCost` is sorted descending by cost

#### Template Tests

- [x] **I24** Test Plan Value card renders when `planFee > 0`
- [x] **I25** Test Plan Value card is hidden when `planFee = 0`
- [x] **I26** Test Cumulative Usage Curve chart data is correctly accumulated
- [x] **I27** Test no JS errors thrown when `byWindow` is empty array

---

## Agent Assignment Guide

| Agent | Tracks | Can start when |
|-------|--------|---------------|
| Agent-1 | Track A (Types + Schema) | Immediately |
| Agent-2 | Track B (Parser) | After A complete |
| Agent-3 | Track C (Store) | After A complete |
| Agent-4 | Track D (Config) | After A complete |
| Agent-5 | Track E (Aggregator) | After B + C complete |
| Agent-6 | Track F (Reporter) | After C + D complete |
| Agent-7 | Track G (Dashboard builder) | After C + E complete |
| Agent-8 | Track H (Template — scaffolding) | Can start HTML structure in Phase 3; wire data in Phase 4 |
| Agent-9 | Track I (Tests) | Write alongside each track; integration tests after all complete |

## Key Files Cross-Reference

| File | Tracks that modify it |
|------|-----------------------|
| [src/types.ts](src/types.ts) | A |
| [src/store/index.ts](src/store/index.ts) | A, C |
| [src/parser/session.ts](src/parser/session.ts) | B |
| [src/config.ts](src/config.ts) | D |
| [src/aggregator/index.ts](src/aggregator/index.ts) | E |
| [src/reporter/index.ts](src/reporter/index.ts) | F |
| [src/dashboard/index.ts](src/dashboard/index.ts) | G |
| [src/server/template.ts](src/server/template.ts) | H |
| [src/__tests__/](src/__tests__/) | I |

## Notes for Agents

- **Read the file before editing.** Every track modifies existing files; understand current structure first.
- **Preserve defensive defaults.** All new fields must have safe zero/null defaults — session JSONL fields may be absent.
- **No breaking changes to existing queries.** New store methods are additive; existing `getSessions()`, `getMessageTotals()` signatures must not change.
- **Schema migrations are append-only.** Only ADD columns; never DROP or RENAME (older DBs must migrate forward cleanly).
- **Track A is the critical path.** No other work should begin until A1–A12 are verified passing.
- **Test idempotency.** Aggregation and window computation must produce identical results when run multiple times on the same data.
