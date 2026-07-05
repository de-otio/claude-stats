# 07 — Accuracy & Automation Plan

How to turn the auto success rate from a ~100% hypothesis ([05](05-accuracy-gap.md))
into a number worth trusting, using the signals in [06](06-automated-outcome-signals.md).
Two non-negotiable principles frame every step:

1. **Symmetry.** Failure detection must become as strong as success detection.
   The current asymmetry is the whole bug; adding more success signals without
   matching failure signals makes it worse.
2. **Absence is never failure** (03 §3.2). Every new signal may only *raise*
   confidence in a verdict from positive evidence. No-signal stays
   `unobservable`. A false `failed` is worse than an honest "don't know."

## 7.1 From a class to a calibrated probability

Today `classifyOutcome` returns one of four labels from a short if-ladder. That
can't express "three weak signals agree" or "strong signal, low confidence." Move
to an **evidence-combining model**:

```
outcome_score(task) = Σ w_i · s_i(task)        s_i ∈ [-1, +1], + = success
```

where each `s_i` is one signal from [06](06-automated-outcome-signals.md) (test
green +, trailing tool-error −, repair turn −, revert −, push +, …) and `w_i` is
its calibrated weight. Map the score to a class with **two thresholds and an
abstain band**:

```
score ≥ τ_hi               -> success
score ≤ τ_lo               -> failed
τ_lo < score < τ_hi        -> in_flight (if any activity) / unobservable (if none)
no signals at all          -> unobservable        (never failed)
```

The abstain band is what enforces principle 2: weak/contradictory evidence lands
in the held-out buckets, not in a fabricated verdict. Keep the per-task evidence
list so the dashboard can show *why* ("tests passed; commit pushed") — turning the
proxy from a black box into something the user can sanity-check and correct.

`computeConfidence` stays as-is and feeds in as one signal; the article-facing
metric owns the combiner, so the recap feature is unaffected.

## 7.2 Phasing (cheapest, highest-value first)

Ordered by value ÷ cost, using the tiers from [06](06-automated-outcome-signals.md):

**Phase A — Tier-0, no re-scan (ship first).**
Add conversational-repair mining (6.2), truncation (6.1c) and rework/abandonment
(6.1d) as signals; split `low` cleanly into `failed`/`unobservable` (partly done);
introduce the score+abstain combiner (7.1). This already injects *human-sourced
failure evidence* (repair turns) into a metric that currently has almost none —
the biggest accuracy gain available with zero schema change. Already shipped from
this investigation: the `medium && committed → success` fix
([05 §5.1](05-accuracy-gap.md)).

**Phase B — Tier-1, scanner + schema (the correctness keystone).**
Parse `tool_result` blocks: capture `is_error` and Bash exit codes / test-summary
tails (6.1a, 6.1b). This is the SWE-bench-style execution oracle applied to the
tests the user already ran — the only *correctness-aware* automatic signal, and
the one that breaks the landing≠correctness ceiling. Cost: a scanner change, a
schema-version bump, and a one-time backfill of historical JSONL.

**Phase C — Tier-2, VCS enrichment.**
Add revert/churn-survival (6.3a) and PR-review state (6.3b) by extending
`git.ts`. Survival is retrospective (needs N days to elapse), so it refines past
windows rather than the live day. Coverage repairs (6.4) ride along here.

**Phase D — Tier-3, optional LLM judge.**
Only behind explicit opt-in, with the self-attribution safeguards from
[06 §6.5](06-automated-outcome-signals.md) (different/blinded evaluator,
calibration, privacy gate). Positioned last because it is the costliest, the
least private, and worthless until there are labels to calibrate it against.

## 7.3 Calibration: you cannot improve what you don't measure

The metric is only as good as the proxy's agreement with truth, and that
agreement is currently **unmeasured**. Build a small calibration harness before
trusting any headline:

1. Sample N tasks across the window (stratified by proxy verdict).
2. The user labels them (the existing ✓/~/✗ controls already write ground truth
   to the corrections DB — that channel is the eval set).
3. Compute, per signal and for the combiner: **precision/recall of `failed`**
   (the weak side), success-class precision, confusion matrix, and a probabilistic
   score (Brier) on `outcome_score`. Fit `w_i`, `τ_hi`, `τ_lo` to maximise
   agreement.
4. Re-fit as more labels arrive.

This mirrors LLM-judge best practice: calibrate the automatic judge against human
labels and report bias-corrected estimates with confidence intervals rather than a
bare point number ([survey](https://www.sciencedirect.com/science/article/pii/S2666675825004564);
[CalibraEval](https://arxiv.org/pdf/2410.15393);
[*How to Correctly Report LLM-as-a-Judge Evaluations*](https://arxiv.org/pdf/2511.21140)).
The same statistics double as the validation gate in 7.4 and the trust signal in
7.5.

## 7.4 Validation gates (so a regression can't sneak in)

- **Unit:** the four-state truth table per signal and for the combiner
  (extend [cost-per-task.test.ts](../../../packages/cli/src/__tests__/cost-per-task.test.ts),
  which already covers the classifier end-to-end).
- **Calibration floor:** in CI / on a labelled fixture, require `failed`-class
  precision ≥ a floor (a wrong "failed" is the costly error). If a new signal
  drops precision below the floor, its weight is capped or it abstains.
- **Behaviour comparison** (per the repo's refactor default): capture the full
  per-task outcome vector on a representative history before/after each signal
  change; review the diff, not just the aggregate rate.

## 7.5 Honest presentation until accuracy is earned

Accuracy work is incremental; presentation must stay truthful at every step.
Drive the display off the **measured** trust level (labelled coverage + calibrated
precision), not the raw rate:

- **No / low ground truth** (proxy-only, the current state): don't present a bare
  "100% success rate." Lead with `mean_cost_per_attempt` (needs no outcome) and
  show the rate only with a caveat that auto-detection under-counts failure —
  prompt the user to label a few tasks. (03 §3.6 already specifies leading with
  the attempt cost under low coverage; extend the trigger from *coverage* to
  *labelled-coverage × calibrated-precision*.)
- **Reframe the proxy honestly:** when the number rests on landing signals only,
  it is a **ship rate**, not a correctness rate — name it accordingly so it stops
  implying something the data can't support.
- **Calibrated:** once labelled precision clears the floor, show the success rate
  with its confidence interval and the labelled/observable share, as 03 §3.3
  intended ("90% labelled is an eval; 100% proxy is a hypothesis").

These three states correspond to the presentation options weighed during this
investigation (caveat / reframe-as-ship-rate / gate-behind-labels) — the plan
makes them a **progression** keyed to measured trust rather than a one-time pick.

## 7.6 Guardrails carried forward

- Failure must come from **positive evidence**, never absence (07 principle 2).
- Outcome labelling stays **human / read-only-MCP** (03 §3.5): a model must not
  mark its own work successful — the self-attribution risk
  ([06 §6.5](06-automated-outcome-signals.md)) is the empirical reason this
  invariant matters.
- All new content (test output, prompt text) is **local-only**; the LLM-judge
  tier is the sole exception and is opt-in and gated.
- Per-task **evidence is shown**, so a user can spot and correct a bad proxy
  verdict — keeping the human the final judge.

## 7.7 Bottom line

The current ~100% is neither a coding bug nor a meaningless accident: it is a
landing-only proxy with a near-dead failure detector, reported as if it were a
correctness rate. The path to "automated *and* accurate" is (A) mine the
human-sourced and mechanical failure signals already on disk, (B) parse the
in-session test/execution oracle for true correctness, (C) add VCS survival, and
throughout **calibrate against the user's own labels and present only as much
confidence as that calibration earns.**

## References

- [*A survey on LLM-as-a-judge*](https://www.sciencedirect.com/science/article/pii/S2666675825004564) — judge biases and calibration overview.
- [CalibraEval](https://arxiv.org/pdf/2410.15393) — calibrating judge prediction distributions to mitigate bias.
- [*How to Correctly Report LLM-as-a-Judge Evaluations*](https://arxiv.org/pdf/2511.21140) — bias-corrected estimators, confidence intervals.
- OpenAI — [*Introducing SWE-bench Verified*](https://openai.com/index/introducing-swe-bench-verified/) — execution/test as ground-truth oracle.
- See [06 References](06-automated-outcome-signals.md#references) for the full signal-source list.
