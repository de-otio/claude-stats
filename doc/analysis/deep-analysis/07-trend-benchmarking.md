# 07 — Trend Benchmarking

"How does my usage compare to the latest trends?" This is the most
data-constrained goal, because the comparison data isn't on your machine. Be
honest: most *external* benchmarking is `T2` (needs egress) and noisy, while the
always-available, more-relevant baseline is **your own past self**. This section
covers both and is candid about what each can and can't deliver.

## 7.1 Self-benchmarking (always available, most relevant)

Your trailing history is the highest-signal baseline — same person, same work,
controlled for everything external. Lead with this.

**Personal baselines & deltas** — every metric in this catalog vs your rolling
30/90-day baseline. **Signal:** trailing-window mean ± band; flag deviations.
**Data:** historical metrics. **Tags:** `T0`+ · `ready` · `local`. **Mentor:**
*"Your cache efficiency is down 25 points and corrective-prompt rate is up 40%
vs your 90-day norm — something changed three weeks ago."*

**Change-point detection** — when did a habit shift? **Signal:** changepoint
analysis on metric time-series (e.g. PELT/CUSUM). **Data:** time-series. **Tags:**
`T0` · `moderate` · `local`. **Mentor:** *"Your auto-accept rate stepped up
sharply around 2026-05-01 — did a workflow change?"*

**Personal-best patterns** — what your *best* weeks looked like, as an
aspirational self-target (reuses the session-quality score from
[04](04-productivity-coaching.md)). **Tags:** `T1` · `moderate` · `local`.

**Goal tracking** — if you set a target ("cut rework 20%", "more spec-first"),
track progress against it. **Signal:** user-set goal vs measured metric. **Data:**
goal config + metrics. **Tags:** `T0`+ · `moderate` · `local`.

## 7.2 External benchmarking (egress, noisy, caveated)

Comparing to "the field" requires data the machine doesn't have. Options, worst
to best:

**Curated public benchmarks (static, bundled).** Ship a periodically-updated
reference set of *published* aggregates — e.g. typical tool-mix, model adoption,
agentic-coding norms from public reports/surveys. **Signal:** compare your T0
aggregates to bundled reference percentiles. **Data:** local metrics + bundled
JSON. **Tags:** `T0` compute / reference bundled · `moderate` · `local`.
**Mentor:** *"Your Agent/subagent usage is below the typical range reported for
agentic-coding adopters; worth exploring given your serial file sweeps."*
*Caveat: published norms age fast and rarely match your exact context.*

**Live trend fetch (opt-in egress).** On request, fetch current public data —
model releases, pricing, feature/best-practice shifts, community benchmarks —
and contextualise your usage. **Signal:** web fetch + compare. **Data:** queries
egress; your metrics stay local unless you ask for a richer comparison. **Tags:**
`T2` · `hard` · `opt-in egress`. **Mentor:** *"A newer model tier was released
last week at lower cost for your dominant session type — worth a trial."* — Note
this overlaps the built-in `deep-research` harness, which can do the fetch+verify
pass on demand.

**Cohort comparison (team, T0-only).** If a team server exists
([`../team-app/`](../team-app/)), compare against *anonymised team aggregates*
— same org, more relevant than global norms, and shareable because it's T0-only.
**Signal:** your aggregates vs team distribution. **Data:** T0 aggregates.
**Tags:** `T0` · `moderate` · egress-to-team-server. **Mentor:** *"Your cache
efficiency sits in the team's top quartile; your spec-first rate is below
median."*

## 7.3 What external benchmarking honestly can't do

- **No private peer data exists locally.** There is no "average developer"
  dataset on the machine; any individual external comparison is bundled,
  fetched, or team-sourced — never derived from raw peer transcripts.
- **Published numbers are coarse and stale.** Treat external percentiles as
  rough orientation, never as a target to optimise toward.
- **Context dominates.** A "low" exploration ratio is good for a senior in a
  familiar codebase and bad for a newcomer; external benchmarks can't see that.
  Prefer self-benchmarking whenever a metric is context-sensitive.

## 7.4 Recommended posture

1. **Default to self-benchmarking.** It's local, always available, and the most
   actionable. Make it the spine of the "trends" experience.
2. **Bundle a small, dated reference set** for orientation, clearly labelled
   with its vintage and source.
3. **Make live external comparison an explicit, opt-in action** (reuse
   `deep-research`), never a background egress.
4. **Offer team-cohort comparison only as T0 aggregates** if/when the team app
   exists.
