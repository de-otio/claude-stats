# Session & Usage Analysis: Reducing Claude Plan Intransparency

## Problem Statement

Claude Plan users see only an opaque "percent used" indicator. There is no breakdown of what drives usage, how it maps to the monthly fee, or how to optimize behavior. claude-stats already collects rich token-level data — the gap is in **derived metrics, time-window awareness, and plan-level context**.

---

## 1. What We Already Track (Current State)

| Layer | Metrics |
|-------|---------|
| **Per-message** | input/output/cache-read/cache-creation tokens, model, stop reason, tools, thinking blocks |
| **Per-session** | prompt count, assistant message count, duration (first–last timestamp), models, tools, entrypoint, git branch, project |
| **Aggregated** | daily/hourly token totals, by-project, by-model, by-entrypoint, cache efficiency %, estimated API-equivalent cost |
| **Context** | account UUID, organization UUID, subscription type (from telemetry enrichment) |

### What's Missing

1. **No usage-window awareness** — Claude Pro/Max enforce rolling 5-hour usage windows; we don't track or visualize these.
2. **No plan-cost comparison** — We estimate API-equivalent cost but never compare it to the flat monthly fee ($20 Pro / $100 Max / $200 Team).
3. **No rate/velocity metrics** — Tokens per minute, cost per hour, sessions per day — none computed.
4. **No limit/throttle detection** — When a user hits the usage cap, there's no event captured.
5. **No per-conversation "weight"** — No sense of which conversations are "expensive" relative to the plan.
6. **No cumulative usage tracking** — No running total within a billing period.
7. **No idle-time or gap analysis** — Time between prompts within a session, or gaps between sessions.

---

## 2. Proposed Improvements

### 2.1 Data Collection

#### A. Capture `service_tier` and rate-limit signals

`UsageData.service_tier` is already in the type definition but **not stored** in SessionRecord or MessageRecord. This field distinguishes priority tiers and can signal throttling.

**Action:** Add `service_tier` column to the `messages` table and parse it from usage data.

#### B. Detect throttle/limit events

When Claude returns shorter responses or the user sees "usage limit reached", the session JSONL may contain:
- `stop_reason: "max_tokens"` at suspiciously low output counts
- System messages with rate-limit content
- Gaps in timestamps (user forced to wait)

**Action:** Add a heuristic throttle detector:
- Flag messages where `stop_reason === "max_tokens"` AND `output_tokens < 200`
- Flag inter-prompt gaps > 10 minutes within a session (potential cooldown)
- Store a `throttle_events` counter on SessionRecord

#### C. Track `inference_geo` for latency context

Already in UsageData but not stored. Could explain performance variations.

**Action:** Store on MessageRecord (low priority).

#### D. Capture ephemeral cache breakdown

`cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` are defined but not stored separately. These affect cache efficiency differently.

**Action:** Add columns for ephemeral cache subtypes to MessageRecord.

---

### 2.2 Derived Metrics & Analysis

#### A. Usage Windows (5-Hour Rolling)

Claude Pro/Max plans enforce usage limits within rolling 5-hour windows. This is the most impactful missing analysis.

**Proposed metric: "Window Utilization"**

```
For each 5-hour window starting from first prompt of the day:
  - Total tokens consumed (weighted by model cost)
  - Number of prompts
  - Estimated "usage percent" consumed
  - Time remaining in window
```

**Implementation:**
1. Query messages ordered by timestamp
2. Slide a 5-hour window, computing cumulative weighted token cost
3. Identify window boundaries (when usage resets)
4. Store window summaries: `{ windowStart, windowEnd, totalCostEquivalent, promptCount, peakModel }`

#### B. Plan ROI Metrics

Compare actual usage value to plan price.

| Metric | Formula |
|--------|---------|
| **API-equivalent value** | Already computed (estimatedCost) |
| **Plan multiplier** | `apiEquivalentCost / monthlyPlanFee` — "you got Nx your money's worth" |
| **Cost per prompt** | `monthlyPlanFee / totalPrompts` |
| **Cost per session** | `monthlyPlanFee / totalSessions` |
| **Cost per active hour** | `monthlyPlanFee / totalActiveHours` |
| **Daily value rate** | `apiEquivalentCost / daysInPeriod` — "today you used $X of API value" |

**Requires:** User-configurable plan fee (or auto-detect from `subscriptionType`). Default fees by plan type: Pro=$20, Max 5x=$100, Max 20x=$200, Team Standard=$25, Team Premium=$125.

#### C. Token Velocity Metrics

| Metric | Formula | Purpose |
|--------|---------|---------|
| **Tokens/minute** | `totalTokens / activeDurationMinutes` | Throughput indicator |
| **Output tokens/prompt** | `outputTokens / promptCount` | Response richness |
| **Input tokens/prompt** | `inputTokens / promptCount` | Context size trend |
| **Cache hit rate trend** | `cacheRead / (input + cacheRead)` per day | Efficiency over time |
| **Prompts/hour** | `promptCount / activeHours` | Interaction intensity |
| **Tokens between throttles** | Tokens consumed before each detected throttle | Usage budget estimator |

#### D. Session Duration Analysis

| Metric | Formula |
|--------|---------|
| **Active duration** | `lastTimestamp - firstTimestamp` |
| **Inter-prompt gaps** | Time between consecutive user messages |
| **Median response time** | Median of (assistant timestamp - preceding user timestamp) |
| **Sessions per day** | Count of distinct sessions per calendar day |
| **Avg session length** | Mean active duration across sessions |
| **Long session detection** | Sessions approaching or exceeding 5-hour window |

#### E. "Usage Budget" Estimator

Based on historical data, estimate:
- "At your current rate, you'll hit the usage limit in X minutes"
- "You've used approximately Y% of a typical 5-hour window budget"
- "Your heaviest model (Opus) consumed Z% of your budget"

This requires reverse-engineering or calibrating the usage formula. Approach:
1. Track the relationship between token consumption (weighted by model) and observed throttle events
2. Over time, build a regression model: `usagePercent ≈ f(opusTokens, sonnetTokens, haikuTokens, cacheTokens)`
3. Use throttle events as calibration points (throttle = ~100% usage)

---

### 2.3 Aggregation Improvements

#### A. New Dashboard Data Fields

Extend `DashboardData.summary`:

```typescript
summary: {
  // existing fields...

  // NEW: Plan ROI
  planFee: number;                    // monthly plan cost
  planMultiplier: number;             // apiCost / planFee
  costPerPrompt: number;
  costPerActiveHour: number;
  dailyValueRate: number;

  // NEW: Velocity
  tokensPerMinute: number;
  outputTokensPerPrompt: number;
  promptsPerHour: number;

  // NEW: Session patterns
  avgSessionDurationMinutes: number;
  totalActiveHours: number;
  sessionsToday: number;

  // NEW: Usage window
  currentWindowStart: string | null;
  currentWindowTokens: number;
  estimatedWindowPercent: number;
  throttleEvents: number;
}
```

#### B. New Time-Series: `byWindow`

```typescript
byWindow: Array<{
  windowStart: string;   // ISO timestamp
  windowEnd: string;
  totalCostEquivalent: number;
  promptCount: number;
  tokensByModel: Record<string, number>;
  throttled: boolean;
}>
```

#### C. New Breakdown: `byConversationCost`

Rank sessions by API-equivalent cost to identify "expensive" conversations:

```typescript
byConversationCost: Array<{
  sessionId: string;
  projectPath: string;
  duration: number;
  estimatedCost: number;
  percentOfPlanFee: number;  // "this conversation cost X% of your monthly fee"
  dominantModel: string;
}>
```

---

### 2.4 Visualization Improvements

#### A. New Dashboard Cards

| Card | Content |
|------|---------|
| **Plan Value** | "You've received $X.XX of API value this month — **Nx** your $Y/mo plan" |
| **Usage Window** | Gauge showing estimated % of current 5-hour window used |
| **Budget Forecast** | "At current rate, ~Z minutes until usage limit" |
| **Cost/Prompt** | "$X.XX per prompt this period" |
| **Active Hours** | Total active hours this period |

#### B. New Charts

1. **Usage Window Timeline** — Horizontal bar chart showing 5-hour windows across the day, colored by utilization intensity. Throttle events marked with red indicators.

2. **Cumulative Usage Curve** — Line chart showing cumulative API-equivalent cost over the billing month, with the plan fee as a horizontal reference line. Shows when you "break even."

3. **Token Velocity Over Time** — Line chart of tokens/minute across sessions, revealing throughput patterns and potential throttling.

4. **Session Cost Distribution** — Histogram of session costs, highlighting outliers.

5. **Model Cost Contribution** — Stacked area chart showing which model drives cost over time (critical since Opus is ~5x Sonnet and ~19x Haiku).

6. **Inter-Prompt Gap Distribution** — Histogram revealing usage patterns (rapid-fire vs. contemplative) and potential forced cooldowns.

#### C. Enhanced Existing Charts

- **Daily token chart**: Add a reference line for "daily plan budget" (monthlyFee / 30 in API-equivalent terms)
- **By-model chart**: Add cost column alongside token counts
- **Summary cards**: Show plan ROI alongside raw numbers

---

## 3. Store Schema Changes

### New columns on `messages`:

```sql
ALTER TABLE messages ADD COLUMN service_tier TEXT;
ALTER TABLE messages ADD COLUMN inference_geo TEXT;
ALTER TABLE messages ADD COLUMN ephemeral_5m_cache_tokens INTEGER DEFAULT 0;
ALTER TABLE messages ADD COLUMN ephemeral_1h_cache_tokens INTEGER DEFAULT 0;
```

### New columns on `sessions`:

```sql
ALTER TABLE sessions ADD COLUMN throttle_events INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN active_duration_ms INTEGER;  -- excluding long gaps
ALTER TABLE sessions ADD COLUMN median_response_time_ms INTEGER;
```

### New table: `usage_windows`

```sql
CREATE TABLE usage_windows (
  window_start INTEGER NOT NULL,  -- epoch-ms
  window_end   INTEGER NOT NULL,
  account_uuid TEXT,
  total_cost_equivalent REAL,
  prompt_count INTEGER,
  tokens_by_model TEXT,           -- JSON
  throttled INTEGER DEFAULT 0,
  PRIMARY KEY (window_start, account_uuid)
);
```

### Config: plan pricing

Plan pricing is stored in `~/.claude-stats/config.json`:

```json
{
  "plan": {
    "type": "max_5x",
    "monthly_fee": 100.00
  }
}
```

Valid plan types: `pro`, `max_5x`, `max_20x`, `team_standard`, `team_premium`, `custom`. If `monthly_fee` is omitted, it is auto-derived from the plan type. The plan type can also be auto-detected from the `subscriptionType` telemetry field.

---

## 4. Implementation Priority

| Priority | Improvement | Effort | Impact |
|----------|------------|--------|--------|
| **P0** | Plan ROI metrics (multiplier, cost/prompt) | Low | High — directly answers "what am I getting?" |
| **P0** | Store `service_tier` from messages | Low | High — enables throttle detection |
| **P1** | 5-hour usage window tracking | Medium | High — core to understanding limits |
| **P1** | Cumulative usage curve visualization | Medium | High — "break-even" is very motivating |
| **P1** | Session duration & velocity metrics | Low | Medium — enriches existing data |
| **P2** | Throttle event detection heuristic | Medium | Medium — calibrates usage model |
| **P2** | Per-conversation cost ranking | Low | Medium — identifies expensive patterns |
| **P2** | Budget forecast estimator | High | High — but depends on throttle calibration |
| **P3** | Ephemeral cache breakdown | Low | Low — niche optimization |
| **P3** | Inference geo tracking | Low | Low — informational only |

---

## 5. Open Questions

1. **Can we observe usage resets?** If Claude Code logs any signal when the 5-hour window resets, this would greatly simplify window tracking.
2. **Is `subscriptionType` reliably populated?** If so, we can auto-detect plan fee without user config.
3. **What is the actual usage formula?** Anthropic hasn't published it. We may need to crowdsource calibration data from users who hit limits.
4. **Should we track billing periods?** Monthly reset dates vary by account; we'd need either user config or detection from usage patterns.

---

## 6. Summary

The biggest wins come from **plan-level context** (ROI metrics, plan fee comparison) and **usage-window awareness** (5-hour rolling windows, throttle detection). These directly address the core complaint: "I don't know what I'm getting for my money."

The data infrastructure is already strong — most improvements are about **deriving new metrics from existing data** plus storing a few additional fields (`service_tier`, `throttle_events`, `active_duration`). The visualization layer needs new chart types but the Chart.js foundation supports all of them.
