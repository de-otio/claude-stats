# 02 — The model-policy impact report ("what did taking Opus away cost?")

The sharpest constraint scenario: an org removes top-tier model access to save
money, so developers run mid-tier models on tasks the top tier should be
doing. This file designs the report that measures what that policy actually
did — built to survive the reading of the manager who made the decision.

## 2.1 The natural experiment

A model-removal policy has a property most measurement problems lack: a
**clean cutover date**. Before it, the org's own history contains top-tier
runs across every task class; after it, the same developers, projects, and
(roughly) task mix run on the mid tier. Per-message `model` is already stored,
so mixed history is fully analyzable. The comparison, per task class, across
the boundary:

| Metric | Question it answers |
|---|---|
| Attempts per successful task | Is work being redone? |
| Failure + abandonment rate | Is work being lost? |
| Tokens per completed task | Did the "saving" backfire in tokens alone? |
| Active dev-minutes per completed task | What is the shepherding cost? |
| Median response time (`median_response_time_ms`) | What did the downshift do to flow? |
| Escalation chains (failed → redone later) | Which failures were tier-shaped? |

Where [ticket-attribution/](../ticket-attribution/) is also running, add the
most concrete framing available: **cost per closed ticket, trend across the
boundary**. "Cost per ticket rose 30% after the tier removal" is the version
of this analysis a manager absorbs without reading a methodology section —
the two features are designed to join.

All five reduce to data already captured
([03 §3.2](03-measurement-mechanics.md) lists the two genuine gaps: a stable
task-class taxonomy and escalation-chain detection).

## 2.2 Confound honesty — the report's survival condition

Before/after comparisons are confounded: model versions change under the same
name, developers learn the tools, workloads shift with project phase. An
overclaimed causal story gets one rebuttal and dies. Mitigations, all
mandatory:

1. **Compare within task classes**, never globally — a workload shift toward
   harder tasks would otherwise masquerade as policy damage.
2. **Show distributions, not just means** — one pathological task must not
   carry the argument, and the reader must be able to see that it doesn't.
3. **Annotate the timeline** with everything else that changed: model version
   bumps (visible in the per-message model strings), pricing-table updates,
   team size. The policy marker ([03 §3.1](03-measurement-mechanics.md)) is
   one event on an honest timeline, not the only one.
4. **Label the output "evidence, not proof."** The claim is "these metrics
   moved at the boundary, per class, in these directions" — strong evidence a
   manager can act on, not a randomized trial.

## 2.3 Two-sided by construction

On real data, a substantial share of task classes will show the mid tier at
parity — routine edits, config work, well-scoped fixes. **The report says so,
first and prominently.** This is not diplomacy; it is the mechanism that makes
the rest believable:

- It proves the tool is a measurement instrument, not an advocacy instrument.
  A report that only ever finds damage is indistinguishable from a complaint.
- It concedes the org's premise where the org is right ("the mid tier is fine
  for most of what we do"), which converts the remainder from a rebellion
  into a refinement.
- It gives developers their own hygiene half
  ([the clean-hands principle](../efficiency-hygiene/README.md)):
  the same data that defends top-tier access for hard classes also tells devs
  to stop using the top tier on trivial ones — the tier-mismatch detector in
  [efficiency-hygiene/](../efficiency-hygiene/README.md) is that nudge. An
  org that sees devs voluntarily downshifting where parity holds has far
  less reason to enforce a blanket ban.

## 2.4 The output: a costed tiered-access proposal

"Give us Opus back" is a binary fight, and developers lose binary fights about
budgets. The report's output is a **negotiable middle**:

> Mid-tier-only is fine for ~70% of our task classes (list). Three classes
> (deep debugging, cross-module refactors, unfamiliar-codebase work) show
> +40% failure rate, +1.8 attempts per success, and +25% dev-time since the
> cutover. Restoring top-tier access **for those classes only** costs a
> projected **+$X/month** in tokens and recovers a projected **Y dev-hours
> ≈ $Z/month**. Net: **+$V/month in the org's favor.**

Properties that matter: it is *costed* (the manager can weigh it), it is
*scoped* (accepting it does not reverse the manager's decision, it refines
it), and it is *falsifiable* (run the report again two months after the
adjustment; the projection is checkable). On Bedrock the enforcement mechanism
is the same IAM model-allowlist that implemented the removal — the proposal
maps to a concrete permissions change, and both sides of the ledger reconcile
against the AWS bill.

## 2.5 Prospective mode — decision support instead of damage documentation

Everything above runs *after* the damage. The same machinery inverted runs
*before* it: a team considering (or fearing) a tier removal computes, from its
own history, per-class parity **today** — "where does the mid tier already
match the top tier for us, and where doesn't it?" That answers "what would
mid-tier-only cost us?" with the org's own data before the policy lands, and
its output is the same tiered proposal, offered proactively.

Prospective mode is also the honest posture for the tool itself: it can
recommend *more* downshifting than the org dared mandate (where parity holds)
and defend the top tier only where the data does. A tool that sometimes sides
with the cost-cutter is the only kind whose defense of capability is worth
anything.

## 2.6 Failure modes to design against

- **The cherry-picked window**: reports default to the full post-policy period
  and refuse windows shorter than a configurable minimum of completed tasks
  per class (small-n honesty; show n everywhere).
- **Class gerrymandering**: the taxonomy is fixed and deterministic
  ([03 §3.3](03-measurement-mechanics.md)); classes cannot be redrawn to
  manufacture a result, and the class definitions ship with the report.
- **Survivorship**: abandoned tasks must be counted in the damage, not
  silently excluded because they never reached an outcome — this is what the
  `unobservable` state is for.
- **The lone bad week**: annotate incidents (model outage, holiday) the same
  way policy events are annotated; a fair timeline is the report's spine.
- **Uncalibrated outcomes**: the whole comparison inherits its validity from
  the success/failure detection — the skeptic's best attack is "your labels
  are guesses." The report carries the calibration figure
  ([03 §3.2 Gap 5](03-measurement-mechanics.md)) or, absent enough manual
  labels, says so.
