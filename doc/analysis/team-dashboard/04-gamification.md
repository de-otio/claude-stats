# 04 — Gamification

Fun, motivating, and occasionally ridiculous ways to make team stats engaging.

---

## Streaks

**Daily coding streak** — consecutive days with at least 1 Claude Code session.

```
Alice 🔥 12 days
Bob   🔥 5 days
Charlie 💀 streak broken yesterday
```

### Streak Mechanics
- Day boundary: midnight in user's configured timezone
- Minimum activity: 1 session with at least 1 prompt (no accidental opens)
- Grace period: weekends don't break streaks by default (configurable)
- Streak milestones: 7, 14, 30, 60, 90, 180, 365 days

### Streak Freeze
Users get **1 freeze per 30-day streak** — protects against sick days, vacations.

```bash
claude-stats streak freeze  # Uses one freeze token
```

---

## Achievements / Badges

Unlocked locally, shared in team manifests. Visual badges shown in VS Code sidebar and team dashboard.

### Productivity Achievements

| Badge | Condition | Flavor Text |
|-------|-----------|-------------|
| **First Prompt** | Complete first session | "Hello, World... but fancier" |
| **Centurion** | 100 prompts in one day | "Are you okay? Drink water." |
| **Marathon** | Single session > 200 prompts | "You and Claude are basically roommates now" |
| **Speed Demon** | Velocity > 2,000 tokens/min sustained | "The tokens flow like water" |
| **Minimalist** | Complete a session with < 5 prompts | "Less is more" |
| **Night Owl** | 10+ sessions starting after midnight | "Sleep is for the weak... or is it?" |
| **Early Bird** | 10+ sessions starting before 7 AM | "The early dev catches the bug" |

### Efficiency Achievements

| Badge | Condition | Flavor Text |
|-------|-----------|-------------|
| **Model Miser** | 90%+ Haiku usage in a week | "Why use a cannon when a slingshot works?" |
| **Big Spender** | $100+ estimated cost in one day | "Somebody call accounting" |
| **Cache Master** | 80%+ cache hit rate over 50+ prompts | "Your context game is immaculate" |
| **Token Diet** | 20%+ reduction in avg input tokens week-over-week | "Trimming the fat" |
| **Context Ninja** | No compaction events in 50+ prompt session | "Master of the context window" |
| **Opus Whisperer** | 50+ Opus sessions with efficiency score > 80 | "Using the big model wisely" |

### Team Achievements

| Badge | Condition | Flavor Text |
|-------|-----------|-------------|
| **Team Player** | Join first team | "There is no I in AI... wait" |
| **Full House** | All team members synced in the same day | "The gang's all here" |
| **Synchronized** | All members within 10% of each other on weekly prompts | "Perfectly balanced, as all things should be" |
| **Diversity** | Team uses 3+ distinct models in one week | "The right model for the right job" |
| **Relay Race** | Team members active across all 24 hours in a day | "The sun never sets on this team" |
| **Streak Squad** | All members have 7+ day streaks simultaneously | "Unstoppable" |

### Milestone Achievements

| Badge | Condition | Flavor Text |
|-------|-----------|-------------|
| **10K Club** | 10,000 total prompts | "You've talked to Claude more than most humans talk to humans" |
| **Millionaire** | 1,000,000 total tokens | "Token millionaire (the good kind)" |
| **Billionaire** | 1,000,000,000 total tokens | "Is this even possible? Apparently yes" |
| **Veteran** | Using Claude Code for 6+ months | "You've seen things" |
| **Archivist** | 1,000+ sessions in database | "A library of conversations" |

---

## Leaderboards

### Weekly Leaderboard

Resets every Monday. Categories:

| Category | Metric | Award Name |
|----------|--------|------------|
| **Most Productive** | Total prompts | "The Machine" |
| **Fastest** | Highest velocity (tokens/min) | "Speed Demon" |
| **Most Efficient** | Lowest cost per prompt | "The Optimizer" |
| **Longest Streak** | Consecutive days | "Iron Will" |
| **Best Cache Rate** | Cache hit percentage | "Cache Money" |
| **Most Diverse** | Distinct models used | "The Polyglot" |

### Display Options

```
┌─ WEEKLY LEADERBOARD ─ Backend Crew ─ W11 2026 ──────┐
│                                                       │
│  🏆 The Machine:    Bob (428 prompts)                 │
│  ⚡ Speed Demon:    Alice (2,341 tok/min)             │
│  💰 The Optimizer:  Charlie ($0.04/prompt)            │
│  🔥 Iron Will:      Bob (12 day streak)               │
│  💵 Cache Money:    Alice (89% cache hits)            │
│                                                       │
│  "Alice takes velocity crown from Bob this week!"     │
└───────────────────────────────────────────────────────┘
```

### Anti-Toxicity Rules

- Leaderboards are **opt-in per team** (disabled by default)
- No "worst performer" callouts — only top positions shown
- Categories reward different styles (speed, efficiency, consistency) so different people win different things
- Can show rankings without absolute numbers to reduce pressure
- Teams can pick which categories are active

---

## Challenges

Time-boxed competitions within a team.

### Built-In Challenges

| Challenge | Duration | Goal | Description |
|-----------|----------|------|-------------|
| **Haiku Week** | 1 week | Max Haiku usage % | Who can get the most done with the smallest model? |
| **Context Diet** | 1 week | Fewest compaction events | Master your context window management |
| **Sprint** | 1 day | Most prompts | Classic productivity race |
| **Slow & Steady** | 1 week | Longest avg session | Deep work, not scattered prompts |
| **Cache Attack** | 1 week | Highest cache hit rate | Optimize those repeated contexts |
| **Budget Battle** | 1 week | Most prompts under $X total | Efficiency under constraint |

### Custom Challenges

```bash
claude-stats team challenge create \
  --name "Friday Blitz" \
  --metric prompts \
  --duration 1d \
  --starts "2026-03-13T09:00:00"
```

Challenge results are computed locally from each member's manifest for the challenge period.

---

## Fun Stats & Trivia

Generated locally, optionally shared in team view.

### Session Superlatives

```
This Week's Superlatives:
  Longest conversation:  Alice — 4h 12m, 287 prompts ("The Odyssey")
  Most expensive turn:   Bob — $0.82 single prompt (Opus, 48K context)
  Fastest session:       Charlie — 12 prompts in 3 minutes
  Most tools in one session: Alice — 8 different tools
  Biggest cache save:    Bob — 91% cache hit, saved ~$4.20
```

### Personality Types (based on usage patterns)

| Pattern | Type | Description |
|---------|------|-------------|
| High Opus, long sessions | **The Architect** | Plans big, thinks deep |
| High Haiku, many short sessions | **The Sprinter** | Quick questions, fast iterations |
| High Sonnet, moderate sessions | **The Balanced** | Goldilocks model selection |
| High cache rate | **The Repeater** | Knows their codebase, iterates on themes |
| Many subagents | **The Delegator** | Trusts the process, parallelizes everything |
| Late night sessions | **The Vampire** | Best code happens after dark |
| Early morning sessions | **The Rooster** | Productive before coffee |
| Weekend warrior | **The Devotee** | Can't stop, won't stop |

### Team Chemistry Score

A fun composite metric based on how well the team's usage patterns complement each other:

```
Team Chemistry: 78/100
  Diversity bonus:  +15  (team uses all 3 model tiers effectively)
  Coverage bonus:   +12  (active across 18 of 24 hours)
  Sync bonus:       +8   (all members synced within 24h)
  Streak penalty:   -5   (Charlie broke their streak)
  Balance penalty:  -2   (Bob's cost is 3x team average)
```

Not scientifically meaningful. Entirely for fun.

---

## VS Code Integration

### Status Bar

```
$(team) Backend Crew: 🔥12d streak · #2 velocity · 3 new badges
```

### Sidebar Panel

- Team member cards with current stats
- Weekly leaderboard
- Active challenges with progress bars
- Recent achievements (toast notifications when unlocked)
- "Challenge a teammate" button

### Achievement Toast

When a badge is unlocked:

```
🏆 Achievement Unlocked: Cache Master
   "Your context game is immaculate"
   80%+ cache hit rate over 50+ prompts
```
