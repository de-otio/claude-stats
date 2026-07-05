# 05 — The Accuracy Gap

Docs 01–04 designed the metric and were honest up front that "a number that is
100% proxy is a hypothesis" ([03 §3.3](03-outcome-model.md)). This doc is the
post-ship diagnosis: now that the metric is live, two failure modes show up in
real use, and both come from the same root — **the automatic outcome proxy
detects success far more readily than it detects failure, and it measures
*landing*, not *correctness*.**

Reported symptoms (real user feedback):

1. *"Many tasks show in-flight even though they are finished."*
2. *"100% success rate is suspicious — either it is a meaningless number or the
   success algorithm is broken."*

Neither is a coding bug in the arithmetic. Both are consequences of the proxy's
design. The first has a clean fix (already applied, §5.1); the second is
structural and motivates the automation work in [06](06-automated-outcome-signals.md)
and [07](07-accuracy-plan.md).

## 5.1 Symptom 1 — finished work shown as "in-flight"

`computeConfidence` ([recap/index.ts:241](../../../packages/cli/src/recap/index.ts#L241))
collapses two genuinely different states into one `medium` bucket:

```
medium = (git.commitsToday > 0 && !git.pushed)        // committed, not pushed
       | (activeMs ≥ 30min && linesChanged ≥ 50)      // long, edit-heavy, NO commit
       | (activeMs ≥ 30min && filesTouched ≥ 5)        // long, broad,      NO commit
```

`classifyOutcome` then mapped **all** of `medium → in_flight`. But a local commit
is a *completion signal* — the user committed the work; it just isn't pushed yet
(batched pushes, no upstream, offline, push later). Calling that "in-flight" (=
unfinished, held out of the rate) is wrong, and for anyone who commits locally
before pushing it mislabels a large fraction of finished tasks.

**Fix applied** in [cost-per-task/index.ts](../../../packages/cli/src/cost-per-task/index.ts)
— split the `medium` branch on whether a commit exists:

```
medium && git.commitsToday > 0   -> success     // committed locally (not yet pushed)
medium (otherwise)               -> in_flight    // substantial edits, nothing committed
```

This is correct on its own terms, but note it makes Symptom 2 *worse*: it moves
tasks out of the held-out bucket and into `success`, pushing the rate higher. The
two reports pull in opposite directions only on the surface — the real ask behind
both is **"make the outcome accurate,"** and accuracy is exactly what the auto
proxy lacks.

## 5.2 Symptom 2 — why the success rate pins at ~100%

The rate is

```
success_rate = |success| / (|success| + |failed|)
```

computed only over `observable = success ∪ failed`. The number trends to 1
because the two terms are wildly asymmetric in how easily they fire.

**Success fires on any of:** pushed commit, merged PR, or (after §5.1) a local
commit. For a developer who commits their work, this is the common path.

**Failure auto-fires on exactly one narrow conjunction**
([classifyOutcome](../../../packages/cli/src/cost-per-task/index.ts), the `low`
branch):

```
failed  ⇔  confidence == 'low'
        ∧  git != null            (repo present AND commit author == you)
        ∧  hasMutatingWork        (the task used Edit/Write/MultiEdit/NotebookEdit)
        ∧  commitsToday == 0      (nothing committed)
        ∧  NOT long-and-substantial   (else it would be 'medium', i.e. in_flight)
```

Read that as English: *"you edited files in your own git repo, committed nothing,
and the session was short or small."* Every escape hatch routes elsewhere:

- Committed anything → `success`.
- Long/large but uncommitted → `medium` → `in_flight` (held out).
- No git, or not your email, or no repo → `unobservable` (held out).
- No mutating tools (a read / Q&A / planning task) → `unobservable`.

So `|failed|` only accumulates the "abandoned a small edit in a tracked repo"
case. For most users that set is nearly empty, `|failed| ≈ 0`, and the rate is
~100% almost by construction — it is not measuring what the label "success rate"
claims to measure.

### The deeper problem: landing ≠ correctness

Even a *perfect* landing detector would report ~100% for someone who ships most
of what they start, because **the proxy can only see whether code landed, not
whether the AI got it right.** The expensive, decision-relevant failure mode —
*the model produced wrong output and you fixed it (or rewrote it) before
committing* — is invisible: the commit still lands, so it scores as success. The
article's whole point ([README](README.md)) is to compare models on *outcome
cost*; a metric blind to "the AI was wrong but I salvaged it" can't do that.

There are therefore **two separate accuracy deficits**, and they need different
fixes:

| Deficit | What it is | Where it bites | Addressed in |
|---|---|---|---|
| **Coverage bias** | `git == null` (no repo / no upstream / wrong email / no `gh`) makes real outcomes `unobservable` | the denominator (`coverage`) | [06 §6.4](06-automated-outcome-signals.md), [07](07-accuracy-plan.md) |
| **Correctness blindness** | landing is detected; *wrongness-then-rework* is not | the numerator (success vs failure) | [06 §6.1–6.3](06-automated-outcome-signals.md), [07](07-accuracy-plan.md) |

## 5.3 What "accurate and automated" has to mean here

To make the rate trustworthy *without* leaning on manual labels, automatic
**failure / rework detection must become as strong as success detection**, and it
must shift from *"did it land"* to *"did it hold / was it right."* Concretely, the
proxy needs to catch, automatically:

- the model's edits that **failed mechanically** (a test/build/lint that ends
  red, a tool call that errors and is never resolved);
- output the user **rejected in conversation** ("no", "that's wrong", "revert");
- commits that **didn't survive** (reverted, or rewritten within days);
- PRs that were **not accepted** (changes-requested, closed unmerged).

Today none of these feed the outcome. Most of the data to compute them is already
on disk (§06). Until they do, the auto success rate should be presented as the
hypothesis it is — see [07 §7.5](07-accuracy-plan.md) for the
calibration-gated presentation.

## 5.4 A note on the asymmetry being deliberate

The conservatism is not an accident — 03 §3.2 states the cardinal rule: *"never
call the absence of a signal a failure."* That rule is right and must survive any
change here (a false `failed` is worse than an honest `unobservable`). The error
was not the rule; it was shipping a **success** detector that is easy to satisfy
alongside a **failure** detector that is nearly impossible to satisfy, and then
printing their ratio as a headline. The remedy is not to loosen the
absence-isn't-failure rule, but to add *positive evidence of failure* the proxy
can actually observe ([06](06-automated-outcome-signals.md)).
