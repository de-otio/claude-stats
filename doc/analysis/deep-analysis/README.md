# Deep Analysis — claude-stats as a "Wise Mentor"

This directory explores how claude-stats can move beyond *accounting* (tokens,
cost, sessions) toward *coaching*: observing how you actually work with Claude
and offering grounded, evidence-linked feedback across many dimensions — not
just AI usage.

The existing [`../04-insights.md`](../04-insights.md) and
[`../sessions/session-analysis.md`](../sessions/session-analysis.md) answer
*"what did I spend?"*. This catalog answers a different question:

> **"How should I work differently?"**

It is an **idea catalog**, not a build spec. Each insight is described with a
concrete signal (how it's computed), the data it needs, and a feasibility /
privacy tag. The goal is breadth — a map of everything worth measuring — so a
later spec can pick the highest-value slice to implement.

## The framing: a mentor, not a dashboard

A dashboard reports numbers and leaves interpretation to you. A mentor:

1. **Observes** behaviour over time, not just totals.
2. **Notices** patterns — including ones you can't see from inside a session.
3. **Compares** against a baseline (your past self, your stated principles, or
   external norms).
4. **Advises** with specific, falsifiable suggestions tied to evidence.
5. **Follows up** — did the advice land? Did the metric move?

The mentor's distinguishing move is **point 3 against *your own stated
principles***. This repo's owner keeps an explicit set of software-design
defaults in `~/.claude/CLAUDE.md` (spec-first, run-before-claiming, small
verifiable PRs, typed languages, no verification theatre). A mentor that knows
your declared values can flag *drift from your own standards* — far more
persuasive than generic best-practice nagging. See
[`08-mentor-engine.md`](08-mentor-engine.md).

## How to read this catalog

| # | File | Theme | Priority |
|---|------|-------|----------|
| 01 | [01-tiered-data-model.md](01-tiered-data-model.md) | The depth/privacy tiers every insight is tagged against | foundation |
| 02 | [02-usage-patterns.md](02-usage-patterns.md) | Behavioural patterns — how you work, when, with what | core |
| 03 | [03-risk-and-dangerous-use.md](03-risk-and-dangerous-use.md) | Dangerous AI habits — over-reliance, unverified change | **weighted** |
| 04 | [04-productivity-coaching.md](04-productivity-coaching.md) | Getting more done, faster — bottlenecks & rework | **weighted** |
| 05 | [05-metacognition.md](05-metacognition.md) | Thought process — framing, decomposition, reasoning | core |
| 06 | [06-technology-analysis.md](06-technology-analysis.md) | Per-stack feedback — where which tech costs you | core |
| 07 | [07-trend-benchmarking.md](07-trend-benchmarking.md) | How you compare to the field and your past self | exploratory |
| 08 | [08-mentor-engine.md](08-mentor-engine.md) | Delivery — cadence, tone, surfacing, the feedback loop | foundation |
| 09 | [09-metric-reference.md](09-metric-reference.md) | Consolidated metric table with all tags | appendix |

Priority reflects a request to weight **risk** and **productivity** highest;
everything else is covered but lighter.

## Tag legend (used throughout)

Every proposed insight carries three tags so feasibility and privacy are
explicit at a glance:

**Data tier** — how deep into your sessions the insight must read:

- `T0` — **Metadata / aggregate.** Token counts, timings, model, tool *names*,
  `stop_reason`, `permissionMode`, git branch, file paths. No reading of prompt
  or response *meaning*. Most of this is already parsed today.
- `T1` — **Local content analysis.** Reads prompt/response text, tool inputs
  (the actual `Bash` command, the `Edit` diff), thinking-block presence —
  but processed **strictly on-device** (regex, heuristics, or an optional local
  model). Nothing leaves the machine.
- `T2` — **Opt-in egress.** Sends excerpts to Claude (via MCP/API) or pulls
  external benchmark data. Highest quality semantic judgement, but transcripts
  or queries leave the machine. Always opt-in, always logged.

**Effort** — implementation cost given today's parser:

- `ready` — data is already collected or trivially derivable; deterministic.
- `moderate` — needs new parsing/storage or a non-trivial heuristic.
- `hard` — needs semantic scoring, a model pass, or external data.

**Privacy** — `local` (never leaves device) or `opt-in egress`.

> Example entry format:
>
> **Unread-diff acceptance** — fraction of large edits accepted with no review
> pause. **Signal:** `Edit`/`Write` `tool_use` with `permissionMode` in
> `{acceptEdits, bypassPermissions}` *and* < Ns to the next turn. **Data:**
> tool blocks + timestamps + permissionMode. **Tags:** `T0` · `ready` ·
> `local`. **Mentor:** *"You accepted 80% of edits this week without a review
> pause; on `main` directly, twice."*

## Design principles for the catalog itself

- **Grounded in real fields.** Every signal references a field that exists in
  [`../07-schema-reference.md`](../07-schema-reference.md). No magic data.
- **Honest about limits.** Many high-value insights are proxies (e.g. "review
  latency" infers, but cannot prove, that a diff went unread). Proxies are
  labelled as such. See also [`../06-limitations.md`](../06-limitations.md).
- **Privacy is a feature, not an afterthought.** The local-first design is the
  product's promise. T2 insights are clearly fenced and never default-on.
- **No verification theatre.** A mentor that emits uncalibrated scores or
  diff-paraphrasing "insights" is worse than silence. Every insight must be
  *actionable* and *falsifiable*, or it doesn't ship. (This mirrors the owner's
  own design default #16.)
- **The baseline is usually you.** External benchmarks are scarce and noisy;
  your own trailing 30-day behaviour is always available and more relevant.
