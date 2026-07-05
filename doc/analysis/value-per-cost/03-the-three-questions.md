# 03 — The three questions, formalised

The owner posed three questions. They are not three views of one metric — they
are three *different* questions that need three *different* instruments, drawing
on the three layers ([README](README.md)). Conflating them is what produced the
single value-flavoured number that doesn't work. This document maps each question
to what is locally computable versus user-supplied, and to a concrete output
contract.

## 3.1 Q1 — "Was the AI investment justified for the given business result?"

**Layer: Value (3).** This is an **ROI** question, and ROI needs a numerator the
tool cannot see. It is answerable *only* over units the user has value-tagged
([02 §2.4](02-defining-business-result.md)).

```
For a set of value-tagged delivered units U in a window:
  ai_cost(U)        = Σ equivalent-API $ attributed to U                 (tool: exact)
  human_cost(U)     = Σ your hours on U × your rate, incl. review/rework (user rate; tool: hours proxy)
  value(U)          = Σ user-declared value of U (€, or category weight) (user: declared)

  value_per_cost(U) = value(U) / ( ai_cost(U) + human_cost(U) )
  justified(U)      = value_per_cost(U) ≥ your threshold
```

**What the tool provides:** `ai_cost` exactly; an *hours proxy* (active minutes,
already computed) so `human_cost` needs only a rate; and the value-tagging
surface. **What the user provides:** the value figure/category and their hourly
rate. **What the tool must refuse:** computing `justified` when `value(U)` is
undeclared — output instead *"N units delivered at AI-cost X; value not declared
→ ROI unknown."* Honest non-answer over fabricated answer.

> Note on the review/rework tax: METR's finding that AI *time-shifts* effort into
> review means `human_cost` must include review/debug, or Q1 is biased optimistic.
> The tool can proxy this from post-edit follow-up turns, tool-error counts, and
> revert/fixup commits — signals it already gathers for the outcome model.

## 3.2 Q2 — "Was AI used as efficiently as possible to achieve the result?"

**Layer: Efficiency (1).** This is the **counterfactual** question and the one the
tool can answer *best and fully locally*, because it is **relative** — it compares
your actual spend against the cheapest path that would have cleared *your own*
quality bar on *your own* workload. It needs **no value tag and no crisp task
boundary**: a fuzzy cost unit is fine when the comparison is within-workload.

```
For each cost unit, attribute:  model × effort-level × archetype × cost × outcome-proxy

efficiency frontier = for each archetype, the (model, effort) that achieved the
                      outcome-proxy at least cost on YOUR history

waste(unit) = cost(unit) − cost of the cheapest (model, effort) that has
              historically cleared the same outcome-proxy on the same archetype
```

The headline is **realised vs frontier cost**: "you spent \$X; the
cheapest-historically-sufficient path for this kind of work was \$Y; the gap is
recoverable waste." This is *Model-fit savings* + *Model-mix appropriateness*
from the deep-analysis catalogue, made into the primary metric
([04](04-efficiency-frontier.md)). The efficiency literature says the prize is
large (routing/effort savings of 50–98% are documented), and the prior-art
survey says **no existing tool computes it for a solo dev** ([05](05-prior-art-and-whitespace.md)).

**Blocker to call out now:** the tool cannot currently slice by **effort-level**
— the message schema records `model` and token counts but no reasoning-effort /
thinking-budget tier. Q2 is only half-answerable until that dimension is recorded
([04 §4.4](04-efficiency-frontier.md)).

## 3.3 Q3 — "What do devs need to do differently to maximise efficiency?"

**Layer: Efficiency (1), coaching projection.** Q3 is Q2's frontier turned into
*prescriptions*. It is not a new measurement; it is the actionable read-out of
the frontier plus a few well-evidenced levers.

The tool can emit concrete, self-derived advice of the form:

- **Route by archetype.** "≈35% of your Opus spend went to mechanical / single-
  file edits that Sonnet has cleared at equal outcome on your history — routing
  them saves ≈\$X/month."
- **Default effort down.** "Your high-effort runs on bounded refactors cost ≈Nx
  and did not beat medium on outcome — default to medium; reserve high for the
  archetypes where it measurably paid."
- **Cache hygiene.** "Cache-read share is K%; the sessions with >70% cache reads
  cost Z% less per outcome — front-load stable context."
- **Know when to stop.** "Tasks with ≥3 repair turns rarely recovered — a
  restart-with-fresh-context beat grinding, on your data."
- **Self-derived best-day profile** (the highest-leverage coaching move): "your
  top-decile-efficiency sessions share a scoping prompt with acceptance criteria,
  exploration before editing, and a test run before the 'done' claim."

Every Q3 line must be **grounded in the user's own history**, never a generic
best-practice list — that is what separates coaching from a blog post, and it is
why the local, per-user substrate matters.

## 3.4 The combined output contract

A single `ValuePerCostReport` for a window, with the three layers kept visibly
separate so no layer borrows false confidence from another:

```
efficiency:                       # Layer 1 — always available, no tags needed
  realisedCost, frontierCost, recoverableWaste
  byArchetype[]:  { archetype, dominantModel, effort?, cost, outcomeProxyRate,
                    cheaperSufficientPath?, estSaving }
  levers[]:       Q3 prescriptions, each with a $ or % grounded in own history

output:                           # Layer 2 — automatic proxy
  shipped, survived, reverted, coverage     # honest, never counts unobservable as failed

value:                            # Layer 3 — only populated where user tagged
  taggedUnits, untaggedUnits
  valuePerCost?   | "value not declared → ROI unknown"
  justified?      | null
```

The reading order is deliberate: **efficiency first** (the strong, complete,
ungameable half), **output second** (honest proxy), **value last and optional**
(the half only the user can complete). That ordering is the structural answer to
"the task is too vague": the parts that don't need a sharp unit lead; the part
that needs a sharp *value* unit gets it from the human.
</content>
