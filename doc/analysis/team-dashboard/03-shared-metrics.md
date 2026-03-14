# 03 — Shared Metrics

What gets shared with the team, what stays local, and how aggregates work.

---

## What Gets Shared

Only **pre-aggregated summaries** leave the machine. Never raw sessions, prompts, file paths, or code.

### Per-Period Manifest (weekly by default)

| Field | Type | Privacy | Notes |
|-------|------|---------|-------|
| sessions | number | Low risk | Count of sessions in period |
| prompts | number | Low risk | Total prompt count |
| inputTokens | number | Low risk | Aggregate input tokens |
| outputTokens | number | Low risk | Aggregate output tokens |
| estimatedCost | number | Medium risk | Dollar estimate (opt-in) |
| activeMinutes | number | Medium risk | Time with active sessions |
| modelsUsed | map | Low risk | Token count per model |
| topTools | string[] | Low risk | Top 5 tool names (Edit, Read, etc.) |
| projectCount | number | Low risk | Number of distinct projects |
| streakDays | number | Low risk | Current consecutive-day streak |
| achievements | string[] | Low risk | Unlocked achievement IDs |
| velocityTokensPerMin | number | Low risk | Average tokens/minute |
| velocityPromptsPerHour | number | Low risk | Average prompts/hour |
| longestSession | object | Low risk | Duration + prompt count (no content) |
| subagentRatio | number | Low risk | % of sessions that spawned subagents |

### What Is Never Shared

| Data | Reason |
|------|--------|
| Prompt text | Contains user intent, possibly proprietary code context |
| File paths / project paths | Reveals repo structure and project names |
| Git branch names | Reveals feature work in progress |
| Account UUID / email | PII — only anonymous team-scoped hash is shared |
| Session IDs | Internal identifiers, no value to team |
| Error quarantine content | May contain sensitive JSONL fragments |
| Organization UUID | Could be used to correlate across teams |

---

## Aggregation Rules

### Individual View (Team Dashboard)

Each team member sees a card per teammate:

```
┌─────────────────────────────────────────┐
│  Alice                    Streak: 5 days │
│  This week: 312 prompts · $18.42        │
│  Models: Sonnet 88% · Opus 10% · Haiku 2% │
│  Velocity: 1,428 tok/min                │
│  Achievements: [Early Bird] [10K Club]   │
└─────────────────────────────────────────┘
```

### Team Aggregate View (3+ members required)

| Metric | Aggregation |
|--------|-------------|
| Total prompts | SUM across members |
| Total cost | SUM across members |
| Average velocity | MEAN of individual velocities |
| Model distribution | Weighted average by token count |
| Active days | COUNT of days where any member was active |
| Team streak | MIN of individual streaks (weakest link) |
| Most used tools | UNION of top tools, ranked by frequency |

### Leaderboards

Leaderboards show **relative position**, not raw numbers, to avoid pressure:

```
This Week's Leaderboard
  Prompts:    1. Bob  2. Alice  3. Charlie
  Velocity:   1. Alice  2. Charlie  3. Bob
  Streak:     1. Bob (12d)  2. Alice (5d)  3. Charlie (3d)
```

Option: anonymize positions beyond top 3 for larger teams.

---

## Period Granularity

| Period | Use Case |
|--------|----------|
| Daily | Sprint dashboards, daily standups |
| Weekly | Default. Maps to typical sprint cadence |
| Monthly | Trend analysis, retrospectives |

Stats are always computed locally from the SQLite database and summarized per period before sync. The shared manifest contains one period's data at a time.

---

## Conflict Resolution

Since each user only writes their own manifest (keyed by `userId + period`), there are no write conflicts in the normal case.

Edge cases:
- **Same user, two machines:** Last push wins (timestamp comparison). Manifests include `syncedAt` — readers use the latest.
- **Clock skew:** Periods are week-aligned (ISO week), so minor clock differences don't create duplicate periods.
- **Stale data:** Manifests older than 30 days are ignored in aggregate views. Members inactive > 30 days are shown as "inactive" in the member list.
