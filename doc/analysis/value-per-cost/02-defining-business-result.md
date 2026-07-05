# 02 — Defining "business result"

The owner's Q1 — *"was the AI investment justified for the given business
result?"* — is unanswerable until "business result" has a definition. This is
the crux of the whole reanalysis, so it gets its own document. The conclusion:
**the tool cannot define a business result; the user must — and that is a
feature, not a limitation.**

## 2.1 The output → outcome → impact hierarchy

The cleanest framing in the literature is Josh Seiden's (*Outcomes Over Output*,
2019): **"an outcome is a change in human behaviour that drives business
results."** It stacks three levels:

| Level | Definition | Example (solo/client dev) | Measurable by a local tool? |
|---|---|---|---|
| **Output** | the thing you make | a merged PR, a shipped feature, 200 surviving lines | **Yes** — git/commits/survival |
| **Outcome** | a change in someone's behaviour | the client accepts the feature; users activate; tickets close | **Partly** — only if it touches the repo / an external signal the user wires in |
| **Impact** | the aggregate business result | revenue earned/protected, cost avoided, risk reduced, an invoice paid | **No** — lives entirely outside the dev's machine |

The trade-off is monotonic and unavoidable: the further *down* you measure, the
easier and more local, but the weaker the link to value; the further *up*, the
more meaningful but the less the tool can see. Marty Cagan's version: "Output
means shipping. Outcome is output **plus user value**." Amplitude's North Star
work operationalises an outcome as a single leading indicator that "best captures
the value customers derive" — explicitly *not* a lagging number like revenue.

**A defensible definition of a business result:** *a durable, attributable change
in a quantity the business cares about — revenue gained/protected, cost avoided,
cycle-time-to-customer reduced, or risk/defects reduced — traceable through a
behaviour change (outcome) back to the work done (output).*

By that definition, a business result lives at the **outcome/impact** layer, and
**a developer-analytics tool watching one machine cannot observe it.** That is
not a gap to engineer around; it is a fact to design around.

## 2.2 Why the tool must not invent the value unit

The unit-of-work survey ([01 §1.1](01-the-critique.md)) and the measurement-unit
literature both converge on the same warning: the moment a single machine-derived
proxy becomes the value number, **Goodhart's law** applies — "when a measure
becomes a target, it ceases to be a good measure." Story points, commits, LOC,
accepted suggestions all fail here. The McKinsey-2023 episode is the cautionary
tale: four of its five proposed metrics measured *effort/output*, drawing the
Orosz/Beck rebuttal — *"the only folks who care about these metrics are the
people collecting them. Customers don't care."* Their prescription: **measure
like sales does — on results, not on the number of emails sent.**

If `claude-stats` auto-labels a topic-cluster "successful" and multiplies by
cost, it is McKinsey-ing its own user: producing a confident output-proxy dressed
as a value number. The honest move is the opposite — **let the human supply the
result, and measure the cost of achieving it precisely.**

## 2.3 The least-bad business-result definition for a solo dev / small team

Large orgs answer this with DX Core 4 dashboards, DXI surveys, and change-failure
statistics that need a *population*. A solo dev or two-person team has no such
population. Distilling the literature to what survives at n=1:

1. **The value unit is whatever you ship to someone who pays** — a billable
   client feature, a released product capability, a fixed production incident, a
   delivered research conclusion. **Not** diffs, commits, or "tasks." The user
   names it.
2. **Make cost the denominator you control.** Value-per-cost =
   *(business result)* ÷ *(AI subscription + token spend + your hours, **including
   review/debug/test time**)*. The review-debug tax (METR's time-shifting) is the
   most-omitted term and the one that flips ROI negative — it must be counted.
3. **Use cycle-time / flow-efficiency as a flow proxy, never as the verdict.**
   Lead-time-to-customer and active-vs-wait time are cheap, hard for one person
   to game, and useful *inputs* — but they are not the result.
4. **Counterbalance against quality.** Pair any speed/throughput gain with a
   rework/defect signal (reverts, churn, reopened bugs). Faros and DORA both show
   AI can buy speed by spending stability; watching only the numerator declares
   victory while debt accrues.

The honest bottom line, on which every 2023–2026 source agrees: **there is no
single number.** The defensible justification claim is therefore not "AI made me
55% faster" (perception, contradicted by METR) but the conjunctive, hedged form:

> *Over the last N weeks, the valuable units I delivered to people who pay reached
> them at total cost C (tool + tokens + my hours incl. rework), with no rise in
> defects — and a cheaper model/effort path would (not) have produced the same
> units.*

## 2.4 What this means for the design

The tool's contract with the user becomes a clean division of labour:

- **The tool supplies the cost side exactly** — equivalent-API dollars and
  tokens per unit, with the review/rework tax made visible (it already has the
  data: tool calls, edits, follow-up turns).
- **The tool supplies a rigorous output/survival proxy** — the best *automatic*
  approximation of "did this land and stick" ([05 §3](05-prior-art-and-whitespace.md)).
- **The user supplies the value** — a thin tag on a delivered unit:
  a category (`client-billable` / `product` / `prod-fix` / `spike` / `research` /
  `no-value`) and, optionally, a magnitude (a € figure, a story-size, or just
  high/med/low). Only the user can.
- **The tool refuses to compute Q1 from proxies alone.** When value tags are
  absent it reports the cost and output layers honestly and says *"value not
  declared — Q1 unanswerable for these units,"* rather than fabricating a
  justification. This is the [04 §4.4](../cost-per-successful-task/04-limitations-and-privacy.md)
  "no verification theatre" rule applied to the value layer.

This is what dissolves "the task is too vague." The *cost/effort* unit can stay
fuzzy because the efficiency analysis is relative and self-baselined
([04](04-efficiency-frontier.md)); the *value* unit is sharp because the user
draws it. The machine never again pretends to know what mattered.
</content>
