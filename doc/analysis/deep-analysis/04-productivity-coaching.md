# 04 — Productivity Coaching  *(priority)*

"What should I change to get more done, more quickly?" The honest answer is
rarely *"use more tokens"* — it's usually *"stop the rework loop"*, *"scope
before you build"*, or *"the model you picked was wrong for the task"*. This
section catalogues the signals that reveal where effort leaks, and what the
mentor can suggest.

The organising idea: **wasted effort is observable as rework, thrash, and
abandonment.** Effective effort produces changes that *survive*. Most metrics
here are ratios of *surviving output* to *total effort*.

## 4.1 Rework & thrash (the biggest lever)

**File-thrash detection** — the same file edited many times within a session,
especially with reverts. **Signal:** file-history version count per file per
session; a file at v8 in one session is being thrashed. **Data:**
`file-history/<session>/` version numbers. **Tags:** `T0` · `moderate` ·
`local`. **Mentor:** *"`auth.ts` reached 9 revisions in one session before it
settled — usually a sign the goal wasn't pinned before editing."*

**Edit-survival rate** — fraction of edited lines that survive to session end /
commit vs. get rewritten or reverted. **Signal:** diff successive file-history
snapshots; churn that cancels itself out is wasted. **Data:** file-history
diffs. **Tags:** `T1` · `hard` · `local`. **Mentor:** *"Roughly 40% of the
lines you generated this session were later rewritten — scoping the change
first would cut that."*

**Repeated-failure loops** — the same test/command failing repeatedly before it
passes. **Signal:** identical or near-identical `Bash` command runs with error
results N times in a row. **Data:** Bash commands + `tool_result` error state.
**Tags:** `T1` · `moderate` · `local`. **Mentor:** *"`npm test` failed 6 times
in a row before passing — the loop ate ~20 minutes. A failing test reproduced
in isolation first usually converges faster."*

**Clarification thrash** — bursts of short corrective prompts ("no, I meant…",
"that's wrong", "undo that"). **Signal:** sequences of short prompts with
negation/correction markers following a large action. **Data:** prompt text +
length. **Tags:** `T1` · `moderate` · `local`. **Mentor:** *"After big edits
you average 3 corrective prompts. A more specific opening prompt typically
removes most of them."* (Ties to prompt quality, [05](05-metacognition.md).)

**Session abandonment** — sessions that produce edits but no commit and aren't
resumed; effort that led nowhere. **Signal:** edits present, no commit, session
not continued, topic doesn't recur productively. **Data:** tool sequence +
follow-on sessions. **Tags:** `T1` · `hard` · `local`.

## 4.2 Effort distribution & bottlenecks

**Time-to-first-edit** — how long (and how many tokens) spent exploring before
the first change. **Signal:** tokens/turns from session start to first
`Edit`/`Write`. High can mean poor codebase familiarity or unclear goal; near-
zero can mean editing before understanding. **Data:** tool sequence + timing.
**Tags:** `T0` · `ready` · `local`. **Mentor:** *"You average 18 exploration
turns before the first edit in this repo — a project map or notes file might
cut the ramp."*

**Exploration↔implementation balance** — per session and trend. **Signal:**
ratio of read-type to write-type tool calls. **Data:** tool names. **Tags:**
`T0` · `ready` · `local`. **Mentor:** *"Sessions with <10% exploration have 2×
the rework — you may be coding before reading."*

**Bottleneck attribution** — where wall-clock actually goes: waiting on long
Bash runs, re-reading the same files, repeated searches. **Signal:** time
attributed per tool category; repeated Reads of the same path. **Data:**
timestamps + tool inputs. **Tags:** `T1` · `moderate` · `local`. **Mentor:**
*"You re-Read `config.ts` 5 times across the session — keeping it in context or
noting the key values would save the round-trips."*

**Verification cost share** — how much effort goes into *checking* vs
*producing* (the owner's verification-as-bottleneck thesis, made measurable).
**Signal:** tokens/turns in test/run/review activity vs generation. **Data:**
tool sequence. **Tags:** `T1` · `moderate` · `local`. **Mentor:** *"Verification
is 8% of your effort on this project; the rework rate suggests it's
under-invested — cheaper to verify earlier than to thrash."*

## 4.3 Cost & model efficiency (do more per token)

**Model-fit savings** — estimated tokens/cost wasted running a heavier model on
work a lighter one handles. **Signal:** Opus sessions classified as mechanical/
single-file → counterfactual Sonnet cost. **Data:** model + archetype + tokens.
**Tags:** `T0` · `moderate` · `local`. **Mentor:** *"~35% of Opus spend went to
mechanical edits; routing those to Sonnet saves an estimated X without quality
loss."*

**Cache-efficiency coaching** — low cache-read ratio means context churn.
**Signal:** existing cache metric + correlation with restarts/`/clear`. **Data:**
usage fields. **Tags:** `T0` · `ready` · `local`. **Mentor:** *"Your cache hit
rate is 41% vs your 70% baseline — frequent restarts are re-paying context
cost. Fewer, longer-scoped sessions cache better."*

**Context-bloat tax** — performance/cost degradation as sessions balloon past
compaction. **Signal:** rising cache-creation + compaction events + rework
climbing late in long sessions. **Data:** usage + telemetry + rework trend.
**Tags:** `T0` · `moderate` · `local`. **Mentor:** *"Past ~150K context tokens
your edit-survival rate drops. Splitting the task would keep each session
sharp."*

**Token-per-outcome** — tokens spent per surviving change / per closed task.
**Signal:** session tokens ÷ surviving edits (or ÷ commits). **Data:** tokens +
file-history + commits. **Tags:** `T1` · `moderate` · `local`. The closest
thing to a "productivity ROI" number; trend it.

## 4.4 Leverage you're not using

**Underused parallelism** — serial work that could fan out (subagents, parallel
tool calls, the deep-research/explore patterns). **Signal:** wide sequential
file sweeps, many serial Reads, no Agent use. **Data:** tool sequence. **Tags:**
`T0` · `moderate` · `local`. **Mentor:** *"Three sessions did 20+ serial Reads
to map a subsystem — an Explore subagent returns just the conclusion."*

**Missing automation** — repeated manual sequences that should be codified.
**Signal:** recurring prompt clusters ([02](02-usage-patterns.md)) + repeated
identical Bash pipelines. **Data:** prompts + Bash strings. **Tags:** `T1b` ·
`moderate` · `local`. **Mentor:** *"You've run the same 4-step release pipeline
by hand 7 times — wrap it in a script and allowlist it."* (Also reduces
permission-prompt fatigue, per the owner's CLAUDE.md.) — But "automation" isn't
one thing; §4.4.1 routes each recurring pattern to the *right* artifact.

**Skill/tool blind spots** — capabilities available but never used (e.g. plan
mode, specific MCP tools, project skills). **Signal:** registered tools/skills
vs observed usage. **Data:** tool names vs config (read `~/.claude/skills/` and
project `.claude/skills/`). **Tags:** `T0` · `moderate` · `local`. **Mentor:**
*"You have a `plan-the-day` skill and a deep-research harness you've never
invoked; both fit your morning sessions."* — The inverse of §4.4.1: a skill
exists but isn't pulling its weight, so either adopt it or retire it.

### 4.4.1 Codification opportunities — *when to create a skill* (and when not)

This is the leverage insight the user explicitly asked for: spotting the moment
a recurring way-of-working should become a reusable artifact. The trap is
treating every repetition the same — a repeated one-liner wants an alias, a
deterministic shell sequence wants a script, but a *recurring multi-step
procedure that carries judgement and context* is what a **Claude skill** is for.
The mentor's job is to detect the pattern *and* route it to the correct artifact.

**The routing rubric** — given a detected recurring pattern, classify it:

| You repeatedly… | Best artifact | Why |
|---|---|---|
| run the same single command with small arg changes | shell alias / function | no procedure, no judgement |
| run the same fixed multi-command shell pipeline | **script** (+ allowlist) | deterministic, no decisions, no per-run context |
| re-type the same multi-step *instructions* to Claude — explain a procedure, paste the same context/conventions, make the same judgement calls | **Claude skill** | procedure + knowledge + decisions; exactly what skills package |
| fan the same work out across many files/targets independently | **subagent / workflow** | parallel, not a linear procedure |
| correct Claude toward the same standing convention every time | **CLAUDE.md rule / memory** | a always-on constraint, not an invoked task |

**Skill-creation opportunity** — recurring *procedural* prompts that a skill
would capture. **Signal (the conjunction matters):**

1. **Recurrence** — a cluster of ≥N semantically near-duplicate prompts across
   sessions ([02](02-usage-patterns.md) recurring-prompt detection), *and*
2. **Procedure** — those sessions share a recurring multi-step *tool sequence*
   (a stable archetype fingerprint: e.g. read X → edit Y → run test → commit),
   not a single command, *and*
3. **Re-explanation** — you repeatedly paste or retype the same instructions/
   context (detectable via `pastedContents` and long, near-identical prompt
   prefixes in `history.jsonl`), *and*
4. **Not already covered** — no existing skill in `~/.claude/skills/` or the
   project `.claude/skills/` matches the cluster's topic.

**Data:** prompt text + `pastedContents` + per-session tool-sequence fingerprint
+ installed-skills inventory. **Tags:** `T1b` · `moderate` · `local` (semantic
dedup + clustering on-device). **Mentor:** *"You've walked Claude through the
same 'cut a release' procedure 6 times across 3 weeks — same steps, same
re-pasted checklist, no matching skill. This is a strong skill candidate; the
`skill-builder` skill can scaffold it."*

**Skill-vs-script disambiguation** — don't recommend a skill for something a
script handles better (and vice-versa). **Signal:** within a recurring cluster,
measure the *decision/judgement content* — does the assistant branch on context,
read and reason, and produce varying output (→ skill), or just execute a fixed
command list (→ script)? Proxy: variance in the tool sequence and presence of
reasoning/Read steps between the fixed commands. **Data:** tool-sequence
variance + thinking/Read presence. **Tags:** `T1` · `moderate` · `local`.
**Mentor:** *"Your deploy steps are identical every time with no decisions —
that's a script, not a skill. But your 'review a PR' flow varies and re-explains
conventions each time — that's the skill."*

**Skill-decay / over-fragmentation** — the maintenance side. **Signal:** skills
that exist but are never invoked (retire), or many narrow near-duplicate skills
that could merge; also prompts that *reinvent* an existing skill's procedure
without invoking it (discoverability gap). **Data:** skills inventory × invocation
counts × prompt clusters. **Tags:** `T0`/`T1b` · `moderate` · `local`. **Mentor:**
*"You hand-rolled the 'where was I' recap 4 times this month — you already have
a `where-was-I` skill that does exactly that. Discoverability problem, not a
missing skill."* — Catches the failure mode where the right artifact exists but
isn't reached for.

> **Why this is high-value coaching.** Skill creation is pure compounding
> leverage: a procedure codified once is cheaper, more consistent, and more
> verifiable on every future run (it turns an ad-hoc reasoning task into a
> repeatable one — directly serving the owner's verification-as-bottleneck
> thesis). But the cost of getting the *artifact type* wrong is real friction
> (a skill where a script belongs is over-engineering; a script where a skill
> belongs loses the judgement). Detecting the pattern is the easy half; routing
> it correctly is the coaching.

**Prompt-leverage gap** — short under-specified prompts that predictably cause
rework, vs specified prompts that land first try. **Signal:** correlate prompt
specificity score with downstream rework. **Data:** prompt text + rework.
**Tags:** `T1b` · `moderate` · `local`. **Mentor:** *"Prompts under 15 words
preceded 70% of your correction loops. A one-line acceptance criterion up front
pays for itself."* (Deep link to [05](05-metacognition.md).)

## 4.5 Effective vs wasteful sessions (the synthesis)

A useful mentor output is a **session-quality score** combining the above into
one comparable number, then showing what separated your best sessions from your
worst:

- **Inputs:** edit-survival rate, rework/thrash, token-per-outcome, corrective-
  prompt count, verification presence, abandonment.
- **Output:** a 0–100 per-session score + a "what made the difference" line.
- **Mentor:** *"Your top-decile sessions share three traits: a scoping prompt
  with acceptance criteria, exploration before editing, and a test run before
  the 'done' claim. Your bottom-decile sessions skip all three."*

This is the productivity insight with the highest coaching value because it's
*self-derived* — it tells you what *your own* good days look like, which is
more credible and more actionable than any external rule. It needs T1 to
compute survival/rework well, but a coarse T0 version (tokens-per-commit,
corrective-prompt proxy via prompt length) ships first.

## 4.6 Honest caveats

- **Surviving ≠ good.** Code that survives a session can still be wrong; these
  are *effort-efficiency* proxies, not *correctness* measures. The mentor should
  say "efficient", never "correct".
- **Rework is sometimes learning.** Exploratory thrash on a genuinely hard
  problem is healthy. Flag *patterns* and *trends*, not single sessions.
- **Don't optimise the metric.** A mentor that rewards "fewer corrective
  prompts" could push you to accept bad output silently — exactly the risk
  [03](03-risk-and-dangerous-use.md) warns about. The two layers must be read
  together; speed without verification is not productivity.
