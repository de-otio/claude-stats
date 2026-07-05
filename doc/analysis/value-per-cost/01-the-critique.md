# 01 — The critique: what's questionable about "cost per successful task"

The owner's instinct is correct, but the defect is more specific — and more
fixable — than "the task is vague." There are four distinct problems, of which
the task unit is only the most visible.

## 1.1 The task unit is a flow proxy masquerading as a unit of value

A "task" today is a `DailyDigestItem`: a heuristic cluster of topic-segments,
bounded by a weighted shift score (time gap, file-path Jaccard, prompt-vocabulary
drift, an explicit "okay, next" marker, and git commits), then merged across
sessions by file/prompt/time overlap (`recap/segment.ts`, `recap/cluster.ts`).

This is an honest, well-built *segmenter*. But it has documented, irreducible
fuzziness:

- **Cross-midnight split** — a task spanning local midnight becomes two items,
  double-counting it.
- **Non-git / scratch / notebook work** is `unobservable` forever.
- **Author-email mismatch** or **no upstream** demotes finished work to
  `in_flight`.
- The boundaries are heuristic blends; two reasonable people would cluster the
  same day differently.

The deeper issue is **category, not calibration**. Even a *perfect* segmenter
would not produce a unit of *value*, because the segmenter knows nothing about
why the work mattered. Tightening the heuristics cannot close that gap.

And this is not a `claude-stats` failing — it is universal. Every credible
delivery framework picks a different unit and **none claims it equals value**:

| Framework | Unit of work | Claims it = value? |
|---|---|---|
| DORA (4 keys) | a deployment / change | No — measures the *delivery system* |
| DX Core 4 | a diff / PR | No — explicitly counterbalanced; warns diffs-per-eng is gameable |
| Flow / value-stream | a "flow item" | No — a *flow* proxy; value comes from Flow Distribution |
| SPACE | *deliberately none* | No — productivity is multidimensional by thesis |

The lesson from the field is not "find the true unit." It is **stop trusting any
single machine-derived unit as a value proxy, and counterbalance instead.** See
[02](02-defining-business-result.md).

## 1.2 "Successful" means *shipped*, and shipped ≠ valuable

The current success oracle is, at best, "a commit by me landed / a PR merged in
this task's window." The feature is admirably honest that this is *shipped*, not
*correct* ([`../cost-per-successful-task/04-limitations-and-privacy.md §4.3`](../cost-per-successful-task/04-limitations-and-privacy.md)).
But "value per cost" demands a stronger thing still: even *correct* ≠ *valuable*.

- A perfectly-correct, merged, surviving feature that no user wanted is **zero
  business value** — the canonical outcomes-over-output failure (Cagan: "Bad
  teams celebrate when they finally release something").
- A throwaway spike that shipped *nothing* but killed a bad idea early can be
  **high value**.

So "successful task" sits at the *output* layer and is being asked to stand in
for the *impact* layer. That is the load-bearing confusion. The fix is not to
make the success oracle better (though we should — [05 §3](05-prior-art-and-whitespace.md));
it is to **stop conflating the layers** and let value be declared, not inferred
([02](02-defining-business-result.md), [03](03-the-three-questions.md)).

## 1.3 The counterfactual is missing — and Q2 *is* the counterfactual

Q2 ("was AI used as efficiently as possible?") and Q1 ("was the investment
justified?") are both **counterfactual** questions:

- Q1: would the business result have happened *without* this spend, or *cheaper*?
- Q2: would a *smaller model* / *lower effort* / *fewer tokens* have produced the
  *same* outcome?

The shipped metric measures only what *did* happen (cost ÷ successes). It never
estimates the *cheaper path*. Yet the prior-art survey found this is precisely
the question **no existing tool asks** ([05 §4](05-prior-art-and-whitespace.md)),
and the efficiency literature says the answer is large: FrugalGPT-style cascades
match frontier quality at up to **98% lower cost**; routing "simple" requests
away from reasoning models cut one assistant's spend **68%** with no quality loss
([04](04-efficiency-frontier.md)). A "value per cost" tool that cannot estimate
the cheaper path is leaving its single biggest insight on the table.

## 1.4 The self-report trap — why measuring this at all is the point

A tempting shortcut is to *ask* the developer whether the spend was worth it. The
strongest empirical finding of 2025 forbids it: **developers cannot reliably
self-report AI's effect on their own productivity.**

- **METR (July 2025):** 16 experienced devs, 246 real tasks in repos they'd
  worked in for ~5 years. With AI allowed, tasks took **19% *longer*** — yet the
  same devs *forecast* a 24% speed-up and **still believed AI sped them up ~20%
  after experiencing the slowdown.** A ~39-point perception gap.
- **DX (38,880 devs):** real gains landed at **5–15%**, against vendor claims of
  50–100% and developers' own felt speed-up.
- **Faros (≈10,000 devs):** individual throughput up, **organisational DORA
  metrics flat**, with a **91% rise in review time** — the gains were
  *time-shifted* into review/rework, not removed.

The implication is the justification for the entire feature: **the tool's value
is that it measures rather than asks.** A vibe ("AI is saving me hours") is not
just unreliable, it is reliably *wrong-signed* in exactly the expert-in-mature-
codebase context this tool's user inhabits. That makes a measured, local
value-per-cost instrument more valuable, not less.

## 1.5 What this critique does *not* say

It does not say the feature was a mistake. The substrate it built — local cost
attribution per unit, a four-state outcome model that never counts *unobservable*
as *failed*, a proxy→label hierarchy, coverage reported next to the rate, and a
hard "no verification theatre" rule — is exactly the rare, hard-won machinery a
real value-per-cost tool needs. The reframe in [06](06-what-to-build.md) keeps
all of it. The problem is the **headline** ("cost per successful task," one
number, value-flavoured) and the **implied promise** (that a topic-cluster is a
business result). Those are framing defects, and framing is cheap to change.
</content>
