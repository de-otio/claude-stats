# 05 — Metacognition & Thought Process

The most ambitious goal: not "use AI better" but "think better, visible through
how you use AI." Your prompts are a partial transcript of your reasoning — how
you frame problems, decompose them, and where your thinking stalls. This is the
most `T1`/`T2`-dependent section (it's about *meaning*), and the most
speculative, so it leans on offered-not-asserted phrasing and opt-in depth.

> **Caveat up front.** Prompts under-represent thought — you think far more than
> you type. These insights describe *expressed* reasoning patterns, not your
> mind. The mentor must frame them as observations about the trace, never
> verdicts about you.

## 5.1 Problem framing

**Goal-clarity in opening prompts** — does a session start with a stated goal +
constraints + acceptance criteria, or a bare imperative? **Signal:** classify
the first substantive prompt for presence of goal / constraints / success
criteria. **Data:** prompt text. **Tags:** `T1` · `moderate` · `local`.
**Mentor:** *"3 of 5 features this week opened with an imperative ('add X') and
no success criteria; those sessions had more correction loops."* — Reinforces
the owner's spec-first default #17.

**Constraint articulation** — do you supply the constraints (perf, compat,
style, deadline) that prevent wrong-but-plausible solutions? **Signal:**
constraint-marker detection in prompts. **Data:** prompt text. **Tags:** `T1` ·
`moderate` · `local`.

**Premature solutioning** — jumping to "do it this way" before establishing
*what* and *why*. **Signal:** opening prompts prescribe an implementation before
any exploration/discussion. **Data:** prompt text + tool sequence. **Tags:**
`T1` · `hard` · `local`. **Mentor:** *"You often prescribe the approach in the
first prompt. When you instead ask 'what are the options', the chosen solution
survives more often."*

## 5.2 Decomposition

**Task-granularity** — big-bang prompts ("build the whole feature") vs stepwise.
**Signal:** scope of first prompt vs number of sub-steps; correlate with rework.
**Data:** prompt text + edit volume. **Tags:** `T1` · `moderate` · `local`.
**Mentor:** *"Features you broke into 3–5 prompts shipped with half the rework
of one-shot prompts."*

**Plan-mode adoption** — do you use plan/spec steps before large work? **Signal:**
`permissionMode=plan` usage and explicit planning prompts before big edits.
**Data:** `permissionMode` + prompt text. **Tags:** `T0`/`T1` · `ready` ·
`local`.

**Scope-creep within a session** — sessions that start narrow and sprawl.
**Signal:** topic drift across prompts (embedding distance from opening intent)
+ growing file set. **Data:** prompt embeddings + file scope. **Tags:** `T1b` ·
`hard` · `local`. **Mentor:** *"This session started on a bug fix and drifted
into a refactor and a dependency bump — three commits' worth in one branch."*

## 5.3 Reasoning quality (T2-leaning)

**Question vs assertion ratio** — using Claude to *think* (questions, "what
am I missing?", "critique this") vs only to *type* (commands). **Signal:**
intent classification of prompts. **Data:** prompt text. **Tags:** `T1` ·
`moderate` · `local`. **Mentor:** *"2% of your prompts ask for critique or
alternatives. Developers who use the model as a reviewer catch design problems
earlier."*

**Assumption-checking** — do you verify the model's reasoning, or accept
confident answers? **Signal:** follow-up "why"/"are you sure"/"show me" after
non-trivial claims. **Data:** prompt text + diff complexity. **Tags:** `T1` ·
`hard` · `local`.

**Reasoning-breakdown localisation** — where in a session does confusion spike
(repeated rephrasing, contradiction, "that's not what I asked")? **Signal:**
clustering of correction/confusion markers in the timeline. **Data:** prompt
text + timing. **Tags:** `T1b` · `hard` · `local`. **Mentor:** *"Confusion in
your sessions clusters right after context compaction — the model loses the
thread and so do you. A recap prompt after compaction helps."*

**Deep reasoning critique (opt-in).** For a self-selected session, send the
prompt-only trace to Claude for a structured critique: framing, decomposition,
where the human could have steered better. **Signal:** Claude-assisted analysis
of the reasoning trace. **Data:** prompt sequence (redacted). **Tags:** `T2` ·
`hard` · `opt-in egress`. **Mentor:** *"On request, I can review a session's
reasoning trace and suggest where a different question would have changed the
outcome."* — The richest metacognitive feedback, gated behind explicit consent.

## 5.4 Principles alignment (the personalised mentor)

Because the owner maintains explicit design defaults in `~/.claude/CLAUDE.md`,
the mentor can measure **drift from your own declared standards** — the most
credible coaching available, since the rubric is *yours*:

| Stated default | Observable drift signal | Tier |
|---|---|---|
| Spec-first (#17) | large work with no preceding spec/plan | `T1` |
| Run-before-claiming (#10) | "done" with no test/run between | `T1` |
| Small verifiable PRs (#9) | oversized diffs before commit | `T0`/`T1` |
| Typed languages (#1) | new untyped JS/Python in greenfield work | `T1` |
| Pin nondeterminism in tests (#7) | flaky-test re-runs in the trace | `T1` |
| No verification theatre (#16) | (meta — applies to the mentor itself) | — |
| Bash: avoid compound chains | long `&&`/pipe chains in Bash calls | `T1` |

**Mentor:** *"You list spec-first as a default, but 3 of this week's larger
changes skipped it. Not a rule from me — a standard you set."* This turns the
mentor from a generic advisor into a *conscience for your own principles*, which
is the strongest possible framing and unique to a user who writes their values
down.

## 5.5 Why keep this section humble

Metacognitive inference is the easiest place to be confidently wrong and the
fastest way to lose user trust. Guardrails:

- **Trace, not psyche.** Always "your prompts show", never "you are".
- **Trend, not snapshot.** One terse session means nothing; a month of
  imperative-only prompts is a pattern.
- **Offer, don't assert.** Especially for T2 critique — invite, summarise, let
  the user judge.
- **The user's own words are the safest rubric.** Prefer alignment-to-stated-
  principles (5.4) over generic "good thinking" claims the tool can't justify.
