# 10 — Team Features

Fun, engaging, privacy-respecting team functionality.

## Team Creation & Management

### Create

Any authenticated user can create a team (becomes admin):

```
POST createTeam({ teamName: "Backend Crew" })
→ { teamId, teamSlug: "backend-crew", inviteCode: "bk-7x9m2q4p8r1z" }
```

Invite code is a 12-character alphanumeric string (72 bits of entropy), optionally prefixed with a short team identifier for readability (e.g., `bk-` above). The prefix is cosmetic — the 12 random characters provide the entropy. Codes expire after 30 days and are regeneratable by team admins.

### Join

```
POST joinTeam({ inviteCode: "bk-7x9m2q4p8r1z" })
→ { team: { teamName: "Backend Crew", memberCount: 4 } }
```

**Brute-force protection:**
- WAF rate limit: 10 `joinTeam` requests per IP per 5 minutes
- 12-char alphanumeric = 36^12 = ~4.7 x 10^18 combinations
- At 10 attempts per 5 min, brute-forcing takes ~7.5 x 10^11 years
- Expired codes are rejected immediately (no team name leaked)
- Invalid codes return generic "Invalid or expired invite code" (no existence check)

**Team size limit:** 50 members per team. Sufficient for department-level teams. Enforced in `joinTeam` resolver. If larger teams are needed later, raise the limit in team settings (admin-configurable, hard cap 200).

On join, user is prompted to configure:
1. Display name for this team
2. Share level (full/summary/minimal)
3. Which accounts to include (work, personal, or both)

### Team Identity

Teams can customize their identity:
- **Team name** — set on creation, updatable by admin
- **Team logo** — uploaded by admin via presigned S3 URL (max 256 KB, PNG/SVG/JPEG). Displayed in team headers, comparison pages, and inter-team challenge scoreboards. Logo stored in a dedicated S3 bucket (`{prefix}-team-logos`) with CloudFront caching.

Logo upload flow:
1. Admin calls `requestTeamLogoUpload(teamId)` → receives presigned S3 PUT URL (5 min expiry)
2. Client uploads image directly to S3 via PUT
3. S3 event notification triggers a small Lambda that validates image (size, type, dimensions ≤ 512x512) and updates `Teams.logoUrl`
4. If validation fails, the object is deleted and `logoUrl` is not updated

### Team Settings (Admin)

- Enable/disable leaderboards
- Choose active leaderboard categories
- Enable/disable challenges
- Set minimum members for aggregates (default 3)
- Regenerate invite code (invalidates previous)
- Remove members
- **Cross-team visibility** — `private` (default), `public_stats`, or `public_dashboard`
- **Dashboard readers** — grant/revoke read access to specific teams (only when visibility = `public_dashboard`)

## Gamification

### Streaks

Computed server-side from synced sessions:

```
Current streak: 12 days 🔥
Longest streak: 23 days
Weekend grace: enabled
Freeze tokens: 1 remaining (earned at 30-day milestone)
```

Streak milestones: 7, 14, 30, 60, 90, 180, 365.
Each milestone unlocks a badge and (at 30-day intervals) a streak freeze token.
Freeze tokens: max 3 held at once. Using a freeze token preserves the streak for one missed day. Tokens never expire. Earned at day 30, 60, 90 (and every 30 days thereafter, capped at 3).

### Achievements

Achievement categories:
- **Productivity** — prompt counts, session lengths, daily activity
- **Efficiency** — model selection, cache rates, cost optimization
- **Team** — collaboration, sync, challenges
- **Milestones** — cumulative totals over time
- **Fun/Secret** — hidden achievements for unusual patterns

Achievements are **computed locally** during `collect` and synced to the cloud. Users choose which achievements are visible to teammates (`shared: boolean` per achievement).

### Leaderboards

Weekly reset (Monday). Categories configurable per team.

| Category | Metric | Award |
|----------|--------|-------|
| Most Productive | Total prompts | "The Machine" |
| Fastest | Velocity (tokens/min) | "Speed Demon" |
| Most Efficient | Lowest cost/prompt | "The Optimizer" |
| Longest Streak | Consecutive days | "Iron Will" |
| Best Cache Rate | Cache hit % | "Cache Money" |
| Model Diversity | Distinct models used | "The Polyglot" |
| Subagent Master | Highest subagent ratio | "The Delegator" |

**Anti-toxicity:**
- Only top 3 shown (no last-place callout)
- Different categories reward different styles
- Can show rank without raw numbers
- Team admin can disable specific categories

### Challenges

Time-boxed team competitions:

```
┌─ Active Challenge: Haiku Week ───────────────┐
│ Goal: Highest Haiku usage %                   │
│ Ends: Friday 6pm                              │
│                                               │
│ 1. Charlie  94% ████████████████████░  │
│ 2. Alice    87% ██████████████████░░░  │
│ 3. Bob      71% ███████████████░░░░░░  │
└───────────────────────────────────────────────┘
```

Built-in challenge types:
- **Haiku Week** — max Haiku usage %
- **Context Diet** — fewest compaction events
- **Sprint** — most prompts in 24h
- **Slow & Steady** — longest average session
- **Cache Attack** — highest cache hit rate
- **Budget Battle** — most prompts under $X

Custom challenges: admin picks metric + duration + start time. Minimum duration: 1 day. Maximum: 30 days.

**Challenge scoring:** The `challenge-scoring` Lambda runs on an EventBridge schedule (hourly during active challenges). It reads TeamStats for the challenge period, computes each participant's score based on the challenge metric, ranks by score descending, and updates the Challenges table. Ties are broken by earliest join time. Challenges auto-complete when `endTime` is reached (EventBridge rule triggers `completeChallenge`).

### Personality Types

Computed from usage patterns, displayed on profile card:

| Pattern | Type | Icon |
|---------|------|------|
| High Opus, long sessions | The Architect | 🏗️ |
| High Haiku, many short sessions | The Sprinter | 🏃 |
| High Sonnet, moderate sessions | The Balanced | ⚖️ |
| High cache rate | The Repeater | 🔄 |
| Many subagents | The Delegator | 👔 |
| Late night sessions | The Vampire | 🧛 |
| Early morning sessions | The Rooster | 🐓 |
| Weekend activity | The Devotee | 💪 |

### Team Chemistry Score

Fun composite metric (0-100):

```
Diversity bonus:   +15  (team uses all model tiers)
Coverage bonus:    +12  (active across 18/24 hours)
Sync bonus:        +8   (all members synced today)
Streak bonus:      +10  (all streaks > 7 days)
Challenge bonus:   +5   (active challenge participation)
Balance penalty:   -2   (one member's cost is 3x average)
```

### Superlatives (Weekly)

Auto-generated fun stats:

```
This Week's Superlatives:
  Longest conversation:   Alice — 4h 12m, 287 prompts
  Most expensive turn:    Bob — $0.82 single prompt
  Fastest session:        Charlie — 12 prompts in 3 min
  Biggest cache save:     Bob — 91% hits, saved ~$4.20
  Most tools in one go:   Alice — 8 different tools
```

## Cross-Team Comparison

Teams can opt in to being visible on a cross-team comparison page:

| Visibility | What's Shared | Who Can See |
|-----------|---------------|-------------|
| `private` (default) | Nothing | Only team members |
| `public_stats` | Aggregate-only: total prompts, total cost, member count, avg velocity | All authenticated users |
| `public_dashboard` | Full dashboard (same view as team members see) | Teams listed in `dashboardReaders` |

**Cross-team comparison page** shows all `public_stats` and `public_dashboard` teams ranked by configurable metrics (prompts, cost, velocity, member count). Individual member data is never exposed — only team-level aggregates.

**Dashboard read access** allows team admins to grant specific other teams read-only access to their full dashboard. This enables friendly rivalry and knowledge sharing between related teams. The reader team sees the same dashboard view as members but cannot modify settings, view invite codes, or access raw session data.

## Inter-Team Challenges

Cross-team competitions for friendly rivalry between teams:

```
┌─ Inter-Team Challenge: March Madness ────────────────┐
│ Metric: Most prompts per member (normalized)         │
│ Runs: 2026-03-10 → 2026-03-20                       │
│                                                      │
│ 1. [logo] Backend Crew     142.3 prompts/member     │
│ 2. [logo] Platform Team    128.7 prompts/member     │
│ 3. [logo] Frontend Guild    98.2 prompts/member     │
└──────────────────────────────────────────────────────┘
```

### How Inter-Team Challenges Work

1. **Creation:** A team admin creates an inter-team challenge with a name, metric, and time window
2. **Invitation:** The system generates an invite code. The creating admin shares it with other team admins (Slack, email, etc.)
3. **Joining:** Other team admins use the invite code to enroll their team. Min 2 teams, max 10 teams per challenge.
4. **Scoring:** The `inter-team-scoring` Lambda runs hourly (EventBridge). It reads each participating team's TeamStats for the challenge period, computes the team-level metric (normalized per member where applicable), and updates rankings.
5. **Completion:** Auto-completes at `endTime`. Winners get a team-level achievement badge displayed on their team dashboard.

### Inter-Team Challenge Metrics

All metrics are **normalized per member** to prevent larger teams from having an unfair advantage:

| Metric | Formula | Award |
|--------|---------|-------|
| `prompts_per_member` | Total prompts / active members | "Prompt Champions" |
| `cost_efficiency` | Prompts per $ spent | "Efficiency Kings" |
| `cache_rate` | Avg cache hit % across members | "Cache Masters" |
| `streak_strength` | Avg streak days across members | "Streak Warriors" |
| `model_diversity` | Distinct models used / member count | "Model Explorers" |

### Privacy in Inter-Team Challenges

- Only team-level aggregates are shared between teams (no individual member stats)
- Participating teams must have `crossTeamVisibility` set to at least `public_stats`
- Teams can leave a challenge at any time (their scores are removed)

## Privacy in Team Features

All team data flows through the sharing controls defined in [11-account-separation.md](11-account-separation.md):

1. User selects which accounts to share per team
2. User selects share level per team
3. Only stats from selected accounts at the selected level appear in team views
4. Achievements can be individually hidden
5. Aggregate views require 3+ active members
6. Prompt text is optionally shared when the user explicitly opts in (`sharePrompts: true` on the account) and at `full` share level, after client-side secret scanning (see [06-sync-strategy.md § Prompt Text Sync](06-sync-strategy.md)). Assistant responses, local file paths, and code snippets are never shared. GitHub repo identifiers (`owner/repo`) are shared in project breakdowns at `full` and `summary` share levels — these are organizational metadata, not private paths. Users at `minimal` share level see no project data.
7. Team admins cannot see members' `accountUuid`, linked account details, or raw session data — only pre-aggregated `TeamStats` with share-level filtering applied
