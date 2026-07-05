# Value per Cost — reanalysing the "cost per successful task" feature

This directory steps back from the shipped **cost-per-successful-task** feature
([`../cost-per-successful-task/`](../cost-per-successful-task/)) and re-derives
what it should actually be measuring.

The trigger is a sound objection from the owner:

> "Cost per *successful task* is of questionable value because the definition
> of a *task* is too vague. … At the end of the day I want insights into the
> **value per cost**. How AI is billed is expected to change, with pressure for
> more efficiency — it will become necessary to deeply understand the usage of
> different models and effort-levels. I need to answer:
> **(Q1)** was the AI investment justified for the given business result?
> **(Q2)** was AI used as efficiently as possible to achieve the result?
> **(Q3)** what do devs need to do differently to maximise efficiency?"

## The one-paragraph conclusion

The shipped feature **accidentally built the hard and valuable part** — a
rigorous, local, honest substrate that joins *cost* to an *outcome proxy* per
unit of work. What it got wrong is the **headline and the framing**, not the
machinery. It tried to compress everything into a single value-flavoured number
("cost per successful task"), and a single number is exactly what every credible
2023–2026 source — DORA, SPACE, DX Core 4, GitHub/Google/Microsoft researchers,
Orosz/Beck — says is impossible and gameable
([02](02-defining-business-result.md), [05](05-prior-art-and-whitespace.md)).
**Do not cut the feature. Reframe it into three honest layers.**

## Why "task is too vague" is a real defect — and what actually fixes it

The current "task" is a `DailyDigestItem`: a heuristic cluster of topic-segments
bounded by time gaps, file-path drift, prompt-vocabulary shift, and git commits
([01 §1.2](01-the-critique.md)). It is a *flow proxy*, and it is fuzzy by
design. Every productivity framework dodges the "what is one unit of work"
question the same way — DORA picks the *deployment*, DX picks the *diff/PR*,
Flow picks the *flow item*, SPACE refuses to pick one at all — and **none of
them claims its unit equals value**. They lean on counterbalancing instead.

So the fix is *not* "find a crisper task boundary." The fix is to **stop letting
the machine define the unit of value at all**:

- The **machine** owns the unit of **cost / effort**. It can segment your work
  into cost-bearing units locally and honestly, and — crucially — the most
  valuable analysis (relative efficiency on *your own* workload) **does not need
  a crisp task boundary**, because it is relative and self-baselined.
- The **user** owns the unit of **value** — the "business result." Only the user
  knows whether a chunk of work was a billable client feature, a prod bug fix, a
  throwaway spike, or research. The tool's job is to *attach cost to the user's
  unit*, not to invent the unit.

Join those two and the vagueness dissolves: the cost/effort side is measured,
the value side is declared, and the tool never pretends a topic-cluster is a
business result.

## The three-layer model

| Layer | Question it answers | Who defines the unit | Locally computable? |
|---|---|---|---|
| **1. Efficiency** | Q2 / Q3 — was AI used efficiently; what to change | machine (cost/effort unit) | **Yes, fully.** Cost & tokens per unit, sliced by `model × effort × archetype`, plus the counterfactual "cheaper path" estimate. Needs no value judgement and no crisp task. |
| **2. Output / survival** | the honest *automatic* outcome proxy | machine | **Yes.** Did it ship (commit/PR), did it *survive* (not reverted/rewritten within N weeks). Better than acceptance-rate; better than "looks done." |
| **3. Value / impact** | Q1 — was the investment justified | **user** (business result) | **No — and it shouldn't try.** A thin, frictionless user-supplied value tag on a delivered unit. Q1 is answerable only when the user has tagged value; the tool says so honestly rather than fabricating. |

Layer 1 is the strongest, most defensible, ship-now thing the tool can do, and
the thing **nobody else does for a solo developer**
([05](05-prior-art-and-whitespace.md)). Layer 2 is the best automatic oracle a
*local* tool can compute (it sees the full git history and test runs that cloud
dashboards never do). Layer 3 is deliberately thin: the tool provides the cost
side exactly and lets the human own the value side.

## Document index

| # | File | Contents |
|---|------|----------|
| 01 | [01-the-critique.md](01-the-critique.md) | Why the current framing is questionable: the task-unit problem, *shipped ≠ valuable*, the missing counterfactual, and the self-report trap (METR's 39-point perception gap) |
| 02 | [02-defining-business-result.md](02-defining-business-result.md) | The output → outcome → impact hierarchy; a defensible "business result" for a solo dev / small team; why the tool cannot measure value alone |
| 03 | [03-the-three-questions.md](03-the-three-questions.md) | Q1/Q2/Q3 formalised into a measurement model; each mapped to a layer and to what is locally computable vs user-supplied |
| 04 | [04-efficiency-frontier.md](04-efficiency-frontier.md) | Q2/Q3 in depth: `model × effort × archetype × cost-per-outcome`, the counterfactual "cheaper path," routing/effort evidence, and the **effort-level schema gap** |
| 05 | [05-prior-art-and-whitespace.md](05-prior-art-and-whitespace.md) | What vendors and EI platforms measure, the biases of acceptance-rate and LLM-judge, and the white space `claude-stats` uniquely occupies |
| 06 | [06-what-to-build.md](06-what-to-build.md) | The recommendation: keep the substrate, reframe the headline, add value-tags + efficiency frontier + effort dimension, de-bias the judge; phased plan and the fate of the current feature |
| — | [references.md](references.md) | Consolidated, dated citations for every empirical claim |

## Relationship to existing analysis

This supersedes the *framing* of
[`cost-per-successful-task/`](../cost-per-successful-task/) but **inherits its
machinery** — the four-state outcome model, the proxy→label hierarchy, the
coverage discipline, and the "no verification theatre" charter all survive intact
and become Layer 2. It also promotes three ideas from the
[`deep-analysis/`](../deep-analysis/) "wise mentor" catalog — *Model-fit
savings*, *Token-per-outcome*, and *Model-mix appropriateness* — from catalogue
entries into Layer 1's core ([04](04-efficiency-frontier.md)).
</content>
</invoke>
