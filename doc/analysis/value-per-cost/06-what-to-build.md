# 06 — What to build: the recommendation

## 6.1 The verdict on the current feature

**Reframe, don't cut.** The shipped cost-per-successful-task feature built the
expensive, hard-to-build, genuinely-rare part — a local, honest substrate that
joins cost to an outcome proxy per unit, with a four-state model that never
counts *unobservable* as *failed*, a proxy→label hierarchy, coverage reported
beside the rate, and a hard no-verification-theatre rule. That machinery is
**90% of what a value-per-cost tool needs.** Its only real defects are framing:

1. a **single value-flavoured headline** ("cost per successful task"), which the
   whole measurement literature says cannot exist; and
2. an **implied promise** that a machine-segmented topic-cluster is a business
   result.

Both are cheap to fix. Cutting the feature would throw away the substrate and
keep nothing.

## 6.2 The reframe in one move

Split the one number into the **three layers** ([README](README.md)) and change
what leads:

- **Lead with efficiency** (Layer 1) — realised-vs-frontier cost and the
  recoverable-waste counterfactual. Complete, local, ungameable, needs no value
  tag or crisp task. This becomes the headline.
- **Keep output/survival** (Layer 2) — the existing four-state model, hardened
  with a survival signal and bias-guarded judging. The honest automatic proxy.
- **Add value as a thin, optional, user-owned layer** (Layer 3) — value tags on
  delivered units; ROI computed only where tagged, an honest "not declared"
  otherwise.

The "cost per successful task" number does not disappear — it moves *inside*
Layer 2 as one honest proxy among several, no longer the headline, no longer
asked to mean "value."

## 6.3 Phased plan

Ordered by leverage and dependency. Each phase ships something usable.

### Phase 0 — fix the substrate (prerequisite, already partly scoped)
- Fix per-task **cost double-count** (attribute by `Segment.messageUuids`, not
  whole-session) — the numerator must be correct before any ratio is trustworthy.
- Confirm subagent cost folding and per-model `costByModel` populate correctly.

### Phase 1 — the efficiency frontier (the new headline; highest leverage)
- Tag each cost unit with **archetype** (tool-mix vector → nearest archetype).
- Compute **frontier[archetype]** and **recoverableWaste** from the user's own
  history, with the §4.3 honesty guards (empirical, min-sample, hedged).
- Emit Q3 **levers** grounded in own history (route-by-archetype, default-effort-
  down, cache hygiene, stop-after-K-repairs, best-day profile).
- Report cost as **distributions (p90/p95)**, not means ([04 §4.5](04-efficiency-frontier.md)).

### Phase 1b — record the effort-level dimension (enabler for full Q2)
- Capture a per-message/session **effort tier** (direct from JSONL if exposed,
  else a thinking-token-share proxy, labelled as proxy). Without it the frontier
  can only recommend model switches, not the often-cheaper "keep model, drop
  effort" ([04 §4.4](04-efficiency-frontier.md)).

### Phase 2 — harden the output/survival oracle (Layer 2)
- Add a **survival signal**: was a unit's code reverted/rewritten within N weeks
  (`git blame --reverse` / churn), feeding the outcome model as evidence.
- Add **test-pass** evidence where a local test command + result is observable.
- **De-bias the LLM judge**: objective signals first; judge only on held-out
  bases; position-swap, length control, and prefer a **non-self judge family**
  to neutralise self-preference bias ([05 §5.4](05-prior-art-and-whitespace.md)).

### Phase 3 — the value layer (Layer 3)
- A frictionless **value-tagging** surface (CLI + dashboard card, mirroring the
  existing human-only, off-the-MCP-write-path label design): category
  (`client-billable` / `product` / `prod-fix` / `spike` / `research` / `no-value`)
  + optional magnitude (€, size, or high/med/low) + the user's hourly rate.
- Compute **value-per-cost** and **justified** *only* over tagged units; output
  an explicit "value not declared → ROI unknown" otherwise.
- Include the **review/rework tax** in `human_cost` via existing repair-turn /
  revert / tool-error proxies ([03 §3.1](03-the-three-questions.md)).

## 6.4 What stays unchanged (load-bearing invariants)

- **Local-first / equivalent-API dollars.** No new egress; the cost basis stays
  the post-subsidy number, which is the whole point of measuring now.
- **Human owns the judge of value.** Value tags and outcome labels remain a human
  act, off the read-only MCP write path — the producer of the number (the model)
  stays separate from the judge of success/value.
- **No verification theatre.** Every proxy is labelled a proxy; the counterfactual
  is labelled an estimate; unobservable is never failure; ROI is never fabricated
  from absent value. Coverage and sample-size gates print beside every rate.
- **Relative before absolute.** The instrument ranks *your* models/efforts/
  archetypes against each other on *your* workload first; cross-user benchmarks
  remain out of scope.

## 6.5 How the three questions end up answered

| Question | Answered by | Honest limit surfaced |
|---|---|---|
| **Q1** justified for the business result? | Layer 3 ROI over value-tagged units | "value not declared → ROI unknown" when untagged; human_cost is a rate × proxy-hours estimate |
| **Q2** used as efficiently as possible? | Layer 1 realised-vs-frontier + counterfactual | frontier is empirical & hedged; effort axis needs Phase 1b |
| **Q3** what to do differently? | Layer 1 levers, grounded in own history | each lever carries a $/% from the user's own data, not generic advice |

The thread tying it together — and the answer to the owner's original objection —
is that **the machine measures what it can see honestly (cost, effort, output,
survival) and the human supplies what only they can know (value)**. "The task is
too vague" stops mattering, because the analysis that needs precision (value) gets
it from the person, and the analysis the machine owns (efficiency) never needed a
sharp task boundary to begin with.
</content>
