# 06 — Staleness, trust, and privacy

Two trust problems are specific to this feature and don't show up elsewhere
in claude-stats. Both need an explicit design answer, not an implicit one.

## Problem 1: the plan-mechanics side goes stale

Everything in [02](02-plan-mechanics-reference.md) is a snapshot. Anthropic's
seat ranges, pricing, and metering rules change on their own schedule, not
claude-stats'. Pricing and plan-mechanics claims are exactly the kind of fact
that looks authoritative once it's written down in a table and stops being
checked — that's a general failure mode of any cached reference data, and
this feature's entire output is downstream of that table.

claude-stats already has a house convention for this problem:
[`pricing.ts`](../../../packages/core/src/pricing.ts) ships a dated default
table (`PRICING_VERIFIED_DATE`), overwritten by an auto-fetched cache when
available, with an explicit source comment. `planMechanics.ts`
([04](04-proposed-tools-and-workflow.md)) should follow the identical
pattern — a `PLAN_MECHANICS_VERIFIED_DATE` constant, a source comment per
figure, structured so bumping it is a small, obvious diff.

That's necessary but not sufficient here, for one reason `pricing.ts` doesn't
have to deal with: per-token API prices are consumed only inside claude-stats'
own cost math, but plan-mechanics data is consumed by an **agent**, which can
independently check the current truth in a way claude-stats' own pricing
cache cannot. So the design should go further than pricing.ts's pattern:

1. **`get_plan_mechanics_reference`'s tool description should instruct the
   calling agent to prefer a live check** (WebFetch/WebSearch against
   claude.com/pricing and the Anthropic support center) over the shipped
   snapshot whenever network access is available, falling back to the
   snapshot only when it isn't.
2. **The snapshot's staleness must be a field in the payload, not just a code
   comment.** An LLM won't reliably surface a caveat it only saw in a tool
   description or docstring once several turns have passed. Every response
   from `get_plan_mechanics_reference` — and every `size_seats` result
   derived from it — should carry a literal `verifiedDate` and `staleWarning`
   string, so it survives being relayed into the agent's final answer to the
   user.
3. **The final recommendation should say which source produced its numbers**
   — "verified live against claude.com/pricing just now" reads very
   differently from "using claude-stats' cached reference as of {date},
   re-verify before purchasing," and a stakeholder acting on the
   recommendation needs to know which one they got.

### Label every number by what kind of claim it is

This extends a convention [doc/analysis/account-attribution/](../account-attribution/)
already uses (every attribution carries a confidence and a source) and
[doc/analysis/cost-per-successful-task/](../cost-per-successful-task/)'s
"no verification theatre" charter (a proxy is labelled a proxy). Applied here,
every figure in a recommendation is one of four kinds, and the output should
say which:

| Kind | Example | How it's labelled |
|---|---|---|
| **Verified fact** | Team's seat range is 5–150 | Cite the source and date checked |
| **Measurement** | This company's pilot developers average $X/month | Only when real claude-stats data backs it — say how many developers, over what period |
| **Estimate** | Assume the "typical" $215/month Anthropic benchmark | Explicitly flagged as a generic fallback, not this company's data |
| **Strategic choice** | Spend limits sized tight vs. loose | Presented as a choice with tradeoffs, never resolved by the tool |

Silently blending these — presenting a benchmark estimate with the same
confidence as a measured figure, or presenting a philosophy choice as a
computed answer — is the specific failure mode this table exists to prevent.

## Problem 2: aggregating usage across people is a different act than aggregating it across one person's accounts

[doc/analysis/team-app/](../team-app/)'s design principles already establish
the right privacy defaults for any cross-device sync in claude-stats:
metadata by default, prompt text opt-in, code and file paths never synced
([team-app/README.md](../team-app/README.md), principle 8). This feature
needs nothing looser than that — a percentile spend distribution, a seat-tier
mix, and a growth trend are all metadata-shaped already. The defaults don't
need relaxing; they need inheriting.

What's new is the *relationship* the data sits inside of. Team-app's original
framing — "fun, not surveillance," leaderboards among peers — assumes a
member chooses to be ranked among colleagues. "IT wants a spend distribution
to negotiate a contract" is an employer looking at aggregated employee usage
for a budget decision. Both can be done inside the same privacy boundary, but
the power-differential case needs guardrails the peer case doesn't:

1. **Never expose an identified individual's usage in the org-facing
   rollup.** Only cohort aggregates — percentile bands, counts-in-band — ever
   leave a developer's own view.
2. **Enforce a minimum cohort size before a bucket is shown** (team-app's own
   `TeamSettings.minMembersForAggregates` field already exists for this
   reason in the leaderboard context — reuse the concept here). A "power-user
   band: 1 person, $X/month" bucket de-anonymizes that person as surely as
   naming them.
3. **The individual self-check stays local by default.** Phase 1's "am I
   personally on the right plan" answer
   ([04](04-proposed-tools-and-workflow.md)) is for the developer's own use
   and should not flow into any org-wide rollup without a separate, explicit
   opt-in — participating in your own dashboard is not the same act as
   contributing to your employer's procurement data.
4. **Keep the two consent flows separate**, as [05](05-reusing-the-team-backend.md)
   already flags: "contribute to the company's seat-sizing exercise" and
   "appear on the team leaderboard" are different opt-ins. Neither should
   imply the other.

The throughline: claude-stats should not become a tool an employer can point
at an individual developer's Claude usage, even under the entirely legitimate
banner of a licensing decision. The aggregation minimums above exist to make
that technically impossible, not just policy-discouraged — consistent with
[01](01-problem-and-use-case.md)'s framing of this as a company-level sizing
question, never an individual-performance one.
