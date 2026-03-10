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

- [ ] **A1** Add `service_tier?: string` and `inference_geo?: string` to `MessageRecord` in [src/types.ts](src/types.ts)
- [ ] **A2** Add `ephemeral5mCacheTokens: number` and `ephemeral1hCacheTokens: number` to `MessageRecord`
- [ ] **A3** Add `throttleEvents: number`, `activeDurationMs: number | null`, `medianResponseTimeMs: number | null` to `SessionRecord`
- [ ] **A4** Add new `UsageWindow` interface to types.ts:
  ```typescript
  export interface UsageWindow {
    windowStart: number;   // epoch-ms
    windowEnd: number;     // epoch-ms (windowStart + 5 hours)
    accountUuid: string | null;
    totalCostEquivalent: number;
    promptCount: number;
    tokensByModel: Record<string, number>;
    throttled: boolean;
  }
  ```
- [ ] **A5** Add `PlanConfig` interface:
  ```typescript
  export type PlanType = "pro" | "max" | "team" | "custom";
  export interface PlanConfig {
    type: PlanType;
    monthlyFee: number;   // auto-set by type or user-overridden
  }
  ```
- [ ] **A6** Extend `DashboardData.summary` type to include new ROI + velocity + window fields (see section 2.3 of session-analysis.md)
- [ ] **A7** Add `byWindow` and `byConversationCost` arrays to `DashboardData` type
- [ ] **A8** Bump DB schema version from 6 → 7 in [src/store/index.ts](src/store/index.ts)
- [ ] **A9** Write migration v6→v7: add 4 columns to `messages` table
  ```sql
  ALTER TABLE messages ADD COLUMN service_tier TEXT;
  ALTER TABLE messages ADD COLUMN inference_geo TEXT;
  ALTER TABLE messages ADD COLUMN ephemeral_5m_cache_tokens INTEGER DEFAULT 0;
  ALTER TABLE messages ADD COLUMN ephemeral_1h_cache_tokens INTEGER DEFAULT 0;
  ```
- [ ] **A10** Write migration v6→v7: add 3 columns to `sessions` table
  ```sql
  ALTER TABLE sessions ADD COLUMN throttle_events INTEGER DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN active_duration_ms INTEGER;
  ALTER TABLE sessions ADD COLUMN median_response_time_ms INTEGER;
  ```
- [ ] **A11** Write migration v6→v7: create `usage_windows` table
  ```sql
  CREATE TABLE IF NOT EXISTS usage_windows (
    window_start INTEGER NOT NULL,
    window_end   INTEGER NOT NULL,
    account_uuid TEXT,
    total_cost_equivalent REAL DEFAULT 0,
    prompt_count INTEGER DEFAULT 0,
    tokens_by_model TEXT DEFAULT '{}',
    throttled INTEGER DEFAULT 0,
    PRIMARY KEY (window_start, account_uuid)
  );
  ```
- [ ] **A12** Verify existing migration chain still runs cleanly (v0→v7)

---

## Phase 2 — Core Layer (run Tracks B, C, D in parallel)

### Track B: Parser — New Fields + Throttle Detection

**Files:** [src/parser/session.ts](src/parser/session.ts)
**Depends on:** Track A complete

- [ ] **B1** Parse `service_tier` from `message.usage.service_tier` and assign to `MessageRecord`
- [ ] **B2** Parse `inference_geo` from `message.usage.inference_geo` and assign to `MessageRecord`
- [ ] **B3** Parse `ephemeral_5m_input_tokens` from `message.usage.cache_creation.ephemeral_5m_input_tokens`
- [ ] **B4** Parse `ephemeral_1h_input_tokens` from `message.usage.cache_creation.ephemeral_1h_input_tokens`
- [ ] **B5** Implement throttle detection heuristic:
  - Count messages where `stop_reason === "max_tokens"` AND `output_tokens < 200`
  - Add result as `throttleEvents` on `SessionRecord`
- [ ] **B6** Compute `activeDurationMs` on `SessionRecord`:
  - Collect all timestamps during parsing
  - Filter out gaps > 30 minutes between consecutive messages (idle time)
  - Sum remaining intervals as active duration
- [ ] **B7** Compute `medianResponseTimeMs` on `SessionRecord`:
  - For each assistant message, find the preceding user message timestamp
  - Compute `assistantTs - userTs` for each pair
  - Store median value (sort + middle index)
- [ ] **B8** Ensure all new fields default gracefully to 0/null when usage data is absent (defensive parsing)

---

### Track C: Store — New Columns + Queries

**Files:** [src/store/index.ts](src/store/index.ts)
**Depends on:** Track A complete

- [ ] **C1** Update `upsertMessages()` to include the 4 new columns (`service_tier`, `inference_geo`, `ephemeral_5m_cache_tokens`, `ephemeral_1h_cache_tokens`) in INSERT and UPDATE clauses
- [ ] **C2** Update `upsertSessions()` to include `throttle_events`, `active_duration_ms`, `median_response_time_ms`
  - Use `MAX()` coalesce for `throttle_events` (not additive when re-processing)
- [ ] **C3** Add `upsertUsageWindow(window: UsageWindow): void` method
- [ ] **C4** Add `getUsageWindows(filters: { since?: number; until?: number; accountUuid?: string }): UsageWindow[]` query
- [ ] **C5** Add `getCurrentWindow(accountUuid?: string): UsageWindow | null` — returns the most recent window
- [ ] **C6** Add `getSessionsByConversationCost(filters: SessionFilters, limit?: number): SessionRecord[]` — sorts by estimated cost descending
  - Cost computed in SQL: `(input_tokens * inputPricePerM + output_tokens * outputPricePerM) / 1e6`
  - Note: pricing constants need to be passed in or computed in TypeScript after fetching
- [ ] **C7** Add `getVelocityMetrics(filters: SessionFilters): { tokensPerMinute: number; promptsPerHour: number; outputTokensPerPrompt: number }` — aggregates across filtered sessions using `active_duration_ms`
- [ ] **C8** Add `getTotalActiveHours(filters: SessionFilters): number` — sum of `active_duration_ms` / 3_600_000
- [ ] **C9** Update `getSessions()` row mapper to include the 3 new session columns

---

### Track D: Config — Plan Pricing

**Files:** [src/config.ts](src/config.ts)
**Depends on:** Track A complete

- [ ] **D1** Read existing config.ts to understand current TOML structure and config interface
- [ ] **D2** Add `[plan]` section parsing to config loader:
  ```toml
  [plan]
  type = "pro"          # "pro" | "max" | "team" | "custom"
  monthly_fee = 20.00   # optional override
  ```
- [ ] **D3** Auto-derive `monthlyFee` from `type` if not overridden:
  - `pro` → $20, `max` → $100, `team` → $200, `custom` → 0 (require explicit fee)
- [ ] **D4** Auto-detect plan from `subscriptionType` telemetry field when config is absent:
  - Map known `subscriptionType` string values to `PlanType`
  - Fall back to `pro` if unknown
- [ ] **D5** Export `getPlanConfig(): PlanConfig` utility function
- [ ] **D6** Add `plan` field to config schema validation / defaults

---

## Phase 3 — Business Logic (run Tracks E, F in parallel)

### Track E: Aggregator — Window Computation + Session Metrics

**Files:** [src/aggregator/index.ts](src/aggregator/index.ts)
**Depends on:** Track B + Track C complete

- [ ] **E1** After processing each session file, compute 5-hour usage windows:
  - Query all messages for the account in the relevant time range (ordered by timestamp)
  - Slide window: for each message, assign it to the window that started ≤ 5h before its timestamp
  - If message falls outside all existing windows, start a new window at its timestamp
  - Accumulate `totalCostEquivalent`, `promptCount`, `tokensByModel` per window
- [ ] **E2** Detect throttled windows:
  - Mark window as `throttled = true` if it contains any session with `throttle_events > 0`
- [ ] **E3** Upsert each computed window via `store.upsertUsageWindow()`
- [ ] **E4** Ensure window computation is idempotent — re-running on the same data should produce the same windows
- [ ] **E5** Handle cross-session windows: a window may span multiple sessions within the same 5-hour block

---

### Track F: Reporter — CLI Plan ROI Output

**Files:** [src/reporter/index.ts](src/reporter/index.ts)
**Depends on:** Track C + Track D complete

- [ ] **F1** Add plan ROI section to `printSummary()`:
  - Show `planFee`, `apiEquivalentCost`, `planMultiplier` ("8.3x your money")
  - Show `costPerPrompt` and `costPerActiveHour`
  - Only show if `planFee > 0`
- [ ] **F2** Add velocity row to `printSummary()`: tokens/min, prompts/hour, output tokens/prompt
- [ ] **F3** Add `activeDuration` to session list in `printSessionList()` (alongside existing duration)
- [ ] **F4** Add per-conversation cost column to `printSessionList()` (estimated API cost + % of plan fee)
- [ ] **F5** Add current window status to `printSummary()`: "Current 5h window: X prompts, ~$Y API value"
- [ ] **F6** Update `printTrend()` to include a daily plan-value column: "$X.XX/day API value equivalent"
- [ ] **F7** Format `planMultiplier` as e.g. "8.3×" with × symbol for readability

---

## Phase 4 — Presentation (run Tracks G, H in parallel)

### Track G: Dashboard Data Builder

**Files:** [src/dashboard/index.ts](src/dashboard/index.ts)
**Depends on:** Track C + Track E complete

- [ ] **G1** Call `getPlanConfig()` in dashboard builder and include `planFee` in summary
- [ ] **G2** Compute `planMultiplier = estimatedCost / planFee` (0 if planFee is 0)
- [ ] **G3** Compute `costPerPrompt = estimatedCost / totalPrompts`
- [ ] **G4** Compute `costPerActiveHour` using `getTotalActiveHours()`
- [ ] **G5** Compute `dailyValueRate = estimatedCost / daysInPeriod`
- [ ] **G6** Call `getVelocityMetrics()` and include `tokensPerMinute`, `promptsPerHour`, `outputTokensPerPrompt` in summary
- [ ] **G7** Compute `totalActiveHours` and `avgSessionDurationMinutes` from session data
- [ ] **G8** Build `byWindow` array from `getUsageWindows()` for the selected period
- [ ] **G9** Build `byConversationCost` array: top 20 sessions by cost, with `percentOfPlanFee`
- [ ] **G10** Add `throttleEvents` total (sum across sessions) to summary
- [ ] **G11** Add `currentWindowStart`, `currentWindowTokens`, `estimatedWindowPercent` from `getCurrentWindow()`
- [ ] **G12** Update `sessionsToday` count in summary

---

### Track H: Template — New Charts + Cards

**Files:** [src/server/template.ts](src/server/template.ts)
**Depends on:** Track G complete (but HTML/CSS scaffolding can start in Phase 3)

#### Cards (add to existing summary row)

- [ ] **H1** Add **Plan Value** card: `"$X.XX API value — Nx your $Y/mo plan"` (hide if planFee = 0)
- [ ] **H2** Add **Active Hours** card: total active hours for the period
- [ ] **H3** Add **Cost/Prompt** card: `"$X.XX per prompt"`
- [ ] **H4** Add **Window Status** card: gauge-style display of current 5-hour window utilization %

#### New Charts (add after existing 7 charts)

- [ ] **H5** **Cumulative Usage Curve** (line chart):
  - X-axis: days in period
  - Y-axis: cumulative API-equivalent cost ($)
  - Reference line: `planFee / 30 * daysInPeriod` (daily linear spend of plan fee)
  - Second reference line: flat `planFee` (break-even line for monthly period)
  - Data source: `byDay` accumulated
- [ ] **H6** **Usage Window Timeline** (horizontal bar or scatter):
  - Each row = one 5-hour window
  - Bar width = window duration (always 5h)
  - Color intensity = `totalCostEquivalent` (lighter = low, darker = high)
  - Red marker = throttled windows
  - Data source: `byWindow`
- [ ] **H7** **Token Velocity** (line chart):
  - X-axis: sessions ordered by time
  - Y-axis: tokens per minute
  - Highlight sessions above 2× average (potential throttle risk)
  - Data source: `byConversationCost` enriched with velocity
- [ ] **H8** **Session Cost Distribution** (bar chart / histogram):
  - X-axis: cost buckets ($0–$0.10, $0.10–$0.50, $0.50–$1, $1–$5, $5+)
  - Y-axis: session count
  - Data source: `byConversationCost`
- [ ] **H9** **Top Expensive Conversations** (horizontal bar):
  - Top 10 sessions by estimated cost
  - Show cost and `% of plan fee`
  - Data source: `byConversationCost` (top 10)

#### Enhance Existing Charts

- [ ] **H10** Add horizontal reference line to daily token chart: "daily plan budget" = `planFee / 30` converted to API-equivalent token count using avg model pricing
- [ ] **H11** Add cost column to by-model chart: show estimated cost per model alongside tokens
- [ ] **H12** Update summary section to show plan multiplier prominently ("8.3× value")

---

## Phase 5 — Validation

### Track I: Tests

**Files:** [src/__tests__/](src/__tests__/)
**Depends on:** All tracks complete (or write alongside each track)

#### Parser Tests

- [ ] **I1** Test `service_tier` is parsed from usage data and stored on MessageRecord
- [ ] **I2** Test ephemeral cache fields parse correctly from nested `cache_creation` object
- [ ] **I3** Test `throttleEvents` counter: messages with `stop_reason=max_tokens` + `output_tokens<200`
- [ ] **I4** Test `throttleEvents` is 0 when no heuristic matches
- [ ] **I5** Test `activeDurationMs` excludes gaps > 30 minutes
- [ ] **I6** Test `medianResponseTimeMs` with even and odd prompt counts
- [ ] **I7** Test all new fields default to 0/null when usage data is missing

#### Store Tests

- [ ] **I8** Test migration v6→v7 runs without error on fresh DB
- [ ] **I9** Test migration v6→v7 runs without error on populated v6 DB (existing rows get defaults)
- [ ] **I10** Test `upsertUsageWindow()` is idempotent (insert same window twice = no duplicate)
- [ ] **I11** Test `getUsageWindows()` filters by time range
- [ ] **I12** Test `getCurrentWindow()` returns the most recent window
- [ ] **I13** Test `getVelocityMetrics()` returns 0 values when no active_duration_ms data

#### Aggregator Tests

- [ ] **I14** Test window assignment: 3 sessions within 5 hours → 1 window
- [ ] **I15** Test window boundary: 2 sessions 6 hours apart → 2 windows
- [ ] **I16** Test throttled window detection propagates from session `throttle_events`
- [ ] **I17** Test re-running aggregation is idempotent (same windows, no duplicates)

#### Config Tests

- [ ] **I18** Test `getPlanConfig()` returns correct defaults per plan type
- [ ] **I19** Test `monthly_fee` override in TOML takes precedence over type default
- [ ] **I20** Test auto-detection from `subscriptionType` telemetry field

#### Dashboard Tests

- [ ] **I21** Test `planMultiplier` is 0 when `planFee` is 0 (no divide-by-zero)
- [ ] **I22** Test `byWindow` is populated from store query
- [ ] **I23** Test `byConversationCost` is sorted descending by cost

#### Template Tests

- [ ] **I24** Test Plan Value card renders when `planFee > 0`
- [ ] **I25** Test Plan Value card is hidden when `planFee = 0`
- [ ] **I26** Test Cumulative Usage Curve chart data is correctly accumulated
- [ ] **I27** Test no JS errors thrown when `byWindow` is empty array

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
