# 02 — Usage Patterns

*How* you work — rhythm, shape, and the implicit habits visible in the stream
of sessions. These are mostly `T0`, so they're the cheapest insights to ship
and the foundation everything else builds on. Pattern detection is descriptive;
the value-judgement layers ([03](03-risk-and-dangerous-use.md),
[04](04-productivity-coaching.md)) reuse these primitives.

## 2.1 Temporal rhythm

**Peak-performance hours** — when are your sessions most *effective*, not just
most frequent? **Signal:** bucket sessions by hour-of-day; cross with an
effectiveness proxy (edits-that-survived per token, low rework). **Data:**
timestamps + file-history churn. **Tags:** `T0` · `moderate` · `local`.
**Mentor:** *"Your highest-yield sessions cluster 08:00–11:00; post-16:00
sessions have 2× the rework rate. Consider front-loading hard work."*

**Cadence & overload** — sessions per day, prompts per session, day-streaks,
and the gaps. **Signal:** session/prompt counts per calendar bucket; detect
binge days and long idle stretches. **Data:** timestamps. **Tags:** `T0` ·
`ready` · `local`. **Mentor:** *"4 days this week exceeded 6 hours of active
session time — your error/rework rate climbs sharply past hour 4."*

**Interruption & fragmentation** — many short sessions vs few deep ones.
**Signal:** distribution of session active-span and inter-prompt gaps; a
session fragmented into many >10-min gaps suggests context-switching cost.
**Data:** timestamps, `queue-operation`. **Tags:** `T0` · `moderate` · `local`.

**Time-of-week / project drift** — which projects you touch when. **Signal:**
project × day-of-week heatmap. **Data:** `cwd`/project + timestamp. **Tags:**
`T0` · `ready` · `local`.

## 2.2 Session shape & typing

**Session archetype classification** — label each session by its tool
fingerprint: *exploration* (Read/Grep/Glob-heavy), *implementation*
(Edit/Write-heavy), *debugging* (Bash+Read loops), *research* (WebSearch/
WebFetch), *orchestration* (Agent-heavy). **Signal:** normalised tool-mix
vector → nearest archetype (k-means or rules). **Data:** `tool_use.name`
counts. **Tags:** `T0` · `moderate` · `local`. **Mentor:** *"62% of your
sessions are implementation, 9% exploration — you may be coding before fully
scoping."* (Feeds metacognition, [05](05-metacognition.md).)

**Tool-mix profile** — your personal tool histogram vs your own trailing
baseline; detect drift (e.g. Agent usage rising, Grep falling). **Signal:**
tool frequency over rolling windows. **Data:** tool names. **Tags:** `T0` ·
`ready` · `local`.

**Parallelism use** — do you batch independent tool calls / use subagents, or
serialise everything? **Signal:** count of multi-`tool_use` assistant turns;
`isSidechain` / `subagents/` presence. **Data:** message structure + subagent
files. **Tags:** `T0` · `moderate` · `local`. **Mentor:** *"You rarely use
subagents; three sessions last week did wide file sweeps that a parallel
explore could have shortened."*

**Thinking engagement** — how often extended thinking is invoked. **Signal:**
count of `thinking` content blocks (content is redacted, presence isn't).
**Data:** content block types. **Tags:** `T0` · `ready` · `local`.

## 2.3 Model & context behaviour

**Model-mix appropriateness** — Opus on trivial edits (waste) vs Haiku/Sonnet
on hard reasoning (thrash). **Signal:** model × session-archetype × outcome.
**Data:** model id + archetype + rework. **Tags:** `T0` · `moderate` · `local`.
**Mentor:** *"40% of Opus sessions were single-file mechanical edits — Sonnet
would likely match at lower cost."* (See also [04](04-productivity-coaching.md).)

**Context-pressure pattern** — how often sessions hit compaction / grow huge.
**Signal:** `tengu_compact` / `tengu_context_size` telemetry (incomplete, see
limits) + proxy: very long sessions with rising cache-creation. **Data:**
telemetry + token trend. **Tags:** `T0` · `moderate` · `local`. **Mentor:**
*"Your long sessions compact 2–3 times; performance degrades after compaction.
Consider `/clear` and a fresh scoped session sooner."*

**Cache-efficiency habits** — cache read ÷ total input over time; low cache use
often means context-thrashing or frequent restarts. **Signal:** existing cache
metric, trended and correlated with session shape. **Data:** usage fields.
**Tags:** `T0` · `ready` · `local`.

## 2.4 Topic & intent patterns (content)

**Topic clustering** — what you actually work on, over time. **Signal:** embed
`history.jsonl` prompts (local embedding model), cluster, label. **Data:**
prompt text. **Tags:** `T1b` · `moderate` · `local`. **Mentor:** *"Auth and CI
config have consumed 30% of prompts this month across four projects — a shared
helper might pay off."*

**Intent mix** — ratio of *commands* ("do X") to *questions* ("how does X
work?") to *specifications* ("build X given constraints A,B"). **Signal:**
classify each prompt. **Data:** prompt text. **Tags:** `T1` · `moderate` ·
`local`. **Mentor:** *"95% of your prompts are imperative commands, 2% are
questions — you may be under-using Claude as a thinking partner."* (Bridges to
[05](05-metacognition.md).)

**Recurring-prompt detection** — near-duplicate prompts across sessions signal
a missing snippet, alias, skill, or doc. **Signal:** semantic dedup of prompts.
**Data:** prompt text. **Tags:** `T1b` · `moderate` · `local`. **Mentor:**
*"You've re-typed variations of the same release-checklist prompt 7 times —
worth a slash-command or skill."*

## 2.5 What patterns alone *can't* tell you

Patterns describe; they don't judge. "You code more than you explore" is only a
problem if it *causes* rework — which needs the productivity layer. "You
auto-accept edits" is only dangerous in context — which needs the risk layer.
Keep pattern detection value-neutral and let 03/04/05 attach meaning, so the
same primitive serves multiple mentors without baking in a bias.
