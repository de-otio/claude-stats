# Prompt Cross-Analysis: Insights from Combining Prompt Data with Other Stats

Design constraint: **every visualization must deliver its insight instantly**.
If the user has to interpret axes, decode color mappings, or read a paragraph
of explanation, the chart has failed. The title should state the finding, and
the visual should confirm it at a glance.

## Data Available Per Prompt

Each assistant message can carry:
- `prompt_text` — the user's input that triggered this response
- `model` — which model handled it
- `output_tokens` / `input_tokens` — response size and context size
- `thinking_blocks` — extended reasoning used
- `tools` — JSON array of tools invoked in the response
- `stop_reason` — end_turn, tool_use, or max_tokens
- `timestamp` — when it happened
- `session_id` → joins to project_path, git_branch, entrypoint, etc.

---

## 1. Your Sessions Get Expensive After Prompt N

**Data:** cost per prompt (from model + tokens) at each prompt position (1st,
2nd, 3rd, ...), averaged across all sessions.

**Visualization:** Single line chart. X-axis is prompt number (1-40). Y-axis is
average cost per prompt. The line starts flat and curves up.

**Title on chart:** "Your prompts cost 3x more after prompt 18"
(computed dynamically — find where cost doubles vs the first 5 prompts).

**Why it's instantly obvious:** One line going up. No legend, no comparison
needed. The user sees the inflection point and knows when to start fresh.

**Actionable callout below the chart:**
"Starting a new session after ~N prompts saves you approximately $X/week."
(Compute by comparing actual cost of late prompts vs what they'd cost at
early-session rates.)

---

## 2. Where Your Money Goes (Treemap)

**Data:** estimatedCost per project, broken into work categories from workProfile.

**Visualization:** Treemap. Outer rectangles = projects (sized by cost). Inner
rectangles = work categories (Exploring, Editing, Running, Researching,
Planning), each a distinct color.

**Why it's instantly obvious:** Bigger rectangle = more money. Color tells you
what kind of work. No axes to read. The user's eye goes straight to the
largest block: "claude-stats / Editing is my biggest spend."

**Alternative (simpler):** If treemap is unavailable in Chart.js, use a single
stacked horizontal bar chart where each project row shows absolute cost
(not percentages) split by work category. Bar length = dollars. Longest bar =
most expensive project. Color within the bar = what the money bought.

---

## 3. How Long Your Sessions Last (Distribution)

**Data:** prompt_count per session, bucketed.

**Visualization:** Histogram with labeled buckets: "1-3 prompts", "4-10",
"11-20", "21-40", "40+". Each bar shows session count.

**Title on chart:** "Most of your sessions are N prompts"
(highlight the dominant bucket).

**Why it's instantly obvious:** Tallest bar = your typical session. A long tail
to the right means you occasionally go deep. This answers "how do I typically
use Claude?" without any interpretation.

**Enhancement:** Color each bar by average cost-per-prompt for that bucket.
Short sessions (green/cheap), long sessions (red/expensive). The color shift
makes the cost story immediate.

---

## 4. Sessions That Ran Hot

**Data:** Per session — total cost, prompt count, project, dominant model, and
a "heat score" = cost / median session cost for that project.

**Visualization:** Table sorted by heat score descending, with a visual
intensity bar (red gradient). Columns: Project, Prompts, Cost, Heat (the
bar). Top 10 only.

**Title:** "Your most expensive sessions relative to normal"

**Why it's instantly obvious:** It's a ranked list. #1 is the hottest session.
The red bar makes outliers visually scream. The user doesn't need to understand
statistics — "this session cost 8x what my sessions in that project normally
cost."

**Callout:** For the top session, show the dominant model and whether it had
truncated outputs or throttle events — these are likely explanations.

---

## 5. Your Hardest Projects (Ranked)

**Data:** Per project — avg complexity score (from classifier), avg thinking
blocks per prompt, avg output tokens per prompt.

**Visualization:** Horizontal bar chart ranked by a composite "difficulty"
score. Each project gets one bar. Longest bar = hardest project.

**Title:** "Projects ranked by how hard Claude has to think"

**Why it's instantly obvious:** Sorted list. Top = hardest. The user
immediately sees "auth-service makes Claude think twice as hard as web-client."

**What makes this different from thinking intensity:** Thinking intensity only
uses thinking_blocks. This combines complexity score (which includes prompt
length, tool usage, output volume, and keywords) with thinking blocks for a
fuller picture.

---

## 6. When You Work With Claude (Heatmap)

**Data:** Prompt count bucketed by day-of-week × hour-of-day. From message
timestamps, derive (Monday 9am, Monday 10am, ..., Sunday 11pm).

**Visualization:** 7×24 grid heatmap. Rows = days (Mon-Sun). Columns = hours
(0-23). Cell color intensity = prompt count.

**Title:** "Your Claude usage by day and hour"

**Why it's instantly obvious:** Dark cells = heavy usage. Light cells = quiet.
The user sees their pattern in one glance: "I use Claude most on weekday
mornings and barely on weekends."

**Enhancement:** Clicking/hovering a cell could show the dominant work category
for that timeslot (from tool usage).

---

## 7. Cache Saves You $X Per Week

**Data:** cache_read_tokens per period, priced at the delta between full input
rate and cache read rate.

**Visualization:** Single large number (KPI card) with a supporting sparkline
of daily savings.

**Title:** "Cache saved you $12.40 this week"

**Why it's instantly obvious:** It's a number. Big number = good. The sparkline
gives trend context without requiring interpretation.

**Enhancement:** Below the KPI, a single sentence: "That's N% of what you
would have spent without caching." This is already partially shown on the
overview tab — but framing it as a weekly savings number makes it tangible.

---

## 8. Projects Where Claude Explores vs. Builds

**Data:** Per project, ratio of Read+Grep+Glob (exploring) to Edit+Write
(editing) tool invocations.

**Visualization:** Diverging horizontal bar chart. Center line = 50/50.
Bars extending left = exploration-heavy. Bars extending right = editing-heavy.
One bar per project.

**Title:** "Exploration vs. building by project"

**Why it's instantly obvious:** Left = Claude is mostly reading your code.
Right = Claude is mostly writing code. Projects that are all-left might be
new or unfamiliar codebases. Projects that are all-right are active development.

**No percentages needed.** The visual position (left vs right) is the insight.

---

## 9. Your Most Expensive Prompts

**Data:** Top 10 prompts by estimated cost, with prompt_text preview, model,
project, and cost.

**Visualization:** Numbered list with cost prominently displayed, prompt text
truncated to ~80 chars, and project/model as metadata.

**Title:** "Your 10 costliest individual prompts"

**Why it's instantly obvious:** Ranked list. #1 is the most expensive. The
prompt preview tells the user exactly what they asked. "Oh, that refactor
prompt cost $0.47 by itself."

**Exists partially** in the Spending tab as "expensive prompts" — but surfacing
it with the actual prompt text (truncated) makes it much more relatable.

---

## 10. How Your Usage Has Changed (Trend)

**Data:** byWeek data — sessions, prompts, cost, activeHours.

**Visualization:** Small multiples — four tiny line charts stacked vertically,
all sharing the same x-axis (weeks). Each shows one metric: Sessions/week,
Prompts/week, Cost/week, Active hours/week.

**Title:** "Your Claude usage over time"

**Why it's instantly obvious:** Lines going up = using more. Lines going down =
using less. Four charts show whether all metrics move together or diverge.
If cost rises but prompts stay flat, you're doing harder work per prompt.

---

## Implementation Priority

Ranked by "insight clarity" — how immediately obvious the takeaway is.

| # | Insight | Effort | Self-Evident? | Data Ready? |
|---|---------|--------|---------------|-------------|
| 1 | Sessions get expensive after prompt N | Medium | Very — one line, one number | Yes |
| 7 | Cache saves you $X/week | Low | Very — single KPI | Yes |
| 3 | Session length distribution | Low | Very — histogram | Yes |
| 9 | Most expensive prompts | Low | Very — ranked list | Partial (need prompt_text) |
| 4 | Sessions that ran hot | Low | Very — ranked table | Yes |
| 6 | When you work (heatmap) | Medium | Very — pattern jumps out | Needs week×hour aggregation |
| 5 | Hardest projects | Low | Very — sorted bars | Yes (classifier exists) |
| 2 | Where money goes (treemap) | High | Very — size = cost | Yes |
| 8 | Explore vs build | Low | Clear — left/right diverging | Yes (workProfile exists) |
| 10 | Usage trend | Medium | Clear — lines up/down | Yes (byWeek exists) |
