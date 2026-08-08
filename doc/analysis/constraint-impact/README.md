# Constraint impact — what withholding capability actually costs

> "They reduced our token budget, but they don't see how that slows us down.
> They don't see the consequences of their decision." — and, in at least one
> real org, the strategy is to take the top-tier model away entirely, so
> developers must use a mid-tier model for tasks the top tier should be doing.

This folder designs the mirror image of
[ticket-attribution/](../ticket-attribution/): where that analysis shows what
the tokens *bought*, this one shows what withholding them *cost*. Three
constraint shapes are covered — dollar caps, model-tier removal, and
throttling/quotas — with one report vocabulary for all three: the constraint's
savings and its damage stated in the same currency, side by side.

## The one-paragraph conclusion

Cost-cutting decisions optimize the wrong denominator — cost per **token** —
and the counter-argument claude-stats can make is cost per **outcome**, which
is already this project's thesis
([cost-per-successful-task/](../cost-per-successful-task/)). A constraint
(budget cap, Opus removal, quota) is a natural experiment with a clean cutover
date; the per-message `model`, task-outcome, and active-duration data already
captured let us compare attempts-per-success, tokens-per-completed-task,
failure rates, and dev-minutes-per-task across the boundary — per task class,
so the comparison survives confounds. The report must be **two-sided by
construction**: it will show task classes where the cheaper tier performs at
parity (agreeing with the org where it is right), which is what buys
credibility for the classes where it doesn't. Its output is not "give us Opus
back" but a **costed tiered-access proposal** — and the decisive line is
usually not tokens at all but the salary-denominated shepherding time, which
lets the whole argument close in one currency: "the policy saves $X/month in
tokens and costs $Z/month in dev time — net −$W."

## The core design choices (decide these first)

| # | Choice | Recommendation | Where argued |
|---|--------|----------------|--------------|
| 1 | The counter-metric | Cost per successful task (per task class), never cost per token | [01](01-what-constraints-cost.md) |
| 2 | The closing currency | Net effect in dollars: token savings minus salary-denominated dev-time delta | [01](01-what-constraints-cost.md) |
| 3 | Report stance | Two-sided by construction — name the classes where the constraint is harmless, then the classes where it isn't | [02](02-model-policy-impact.md) |
| 4 | Report output | A costed tiered-access / cap-adjustment proposal, not a reversal demand | [02](02-model-policy-impact.md) |
| 5 | Causal honesty | Within-task-class comparison, distributions not means, "evidence not proof" labelling | [02](02-model-policy-impact.md) |
| 6 | Comparison stability | A small deterministic task-class taxonomy (new work) — recap clusters have no cross-month identity | [03](03-measurement-mechanics.md), spec in [05](05-task-class-spec.md) |
| 7 | Policy boundary | An explicit policy-event marker in config; never inferred from the data | [03](03-measurement-mechanics.md) |
| 8 | Plan vs metered | Two constraint vocabularies: windows/throttles for seat plans, quotas/caps/model-allowlists for Enterprise & Bedrock — never mixed in one report | [01](01-what-constraints-cost.md), [03](03-measurement-mechanics.md) |

## Documents

| # | File | Contents |
|---|------|----------|
| 01 | [01-what-constraints-cost.md](01-what-constraints-cost.md) | Constraint taxonomy, the wrong-denominator argument, the salary denominator, the net-effect statement |
| 02 | [02-model-policy-impact.md](02-model-policy-impact.md) | The model-tier-removal report: metrics, the natural experiment, two-sidedness, the tiered-access proposal, prospective mode |
| 03 | [03-measurement-mechanics.md](03-measurement-mechanics.md) | What the store already captures, the gaps (task-class taxonomy, policy markers, escalation chains, metered throttling, outcome calibration), surfaces |
| 04 | [04-pricing-model-comparison.md](04-pricing-model-comparison.md) | The constructive counter-offer: price the org's real usage under seat plans vs metered — save the same money without the capability loss |
| 05 | [05-task-class-spec.md](05-task-class-spec.md) | **Implemented.** The task-class taxonomy (choice 6 above): class definitions with inclusion/exclusion rules, the signals used and the one deliberately excluded, the decision procedure and thresholds, storage and version-stamped invalidation, and the measured agreement against a labelled corpus |

## Relationship to existing analysis

- **[cost-per-successful-task/](../cost-per-successful-task/) is the parent
  metric.** Its outcome-cost-per-model thesis is exactly the counter-argument
  to per-token cost cutting; this folder operationalizes it around a policy
  boundary.
- **[ticket-attribution/](../ticket-attribution/) is the mirror**: same
  audience (acute for Enterprise/Bedrock orgs — see its "Who this is acute
  for"), same honesty rules (coverage, confidence, no invented precision),
  opposite direction of argument. A team running both can answer "what did
  the tokens buy?" and "what did withholding them cost?" from one dataset.
- **[value-per-cost/](../value-per-cost/)** supplies the layer model: the
  machine owns efficiency and output; the constraint-impact report stays on
  machine-owned ground (attempts, failures, minutes) and never claims to
  measure business value.
- The **license-advisor** design (plan/seat right-sizing) is the constructive
  sibling: where this folder measures the damage of a blunt constraint,
  [04-pricing-model-comparison.md](04-pricing-model-comparison.md)
  operationalizes the non-destructive alternative for metered orgs.
- **[efficiency-hygiene/](../efficiency-hygiene/)** is the clean-hands half
  this folder's two-sided report relies on
  ([02 §2.3](02-model-policy-impact.md)): voluntary tier-downshifting where
  parity holds is what makes the defense of top-tier access credible.
