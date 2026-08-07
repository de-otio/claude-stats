# 04 — Pricing-model comparison: the constructive counter-offer

Everything else in this folder measures the damage of a cost-cutting policy.
This file designs the report that changes the conversation: the org wants to
save money, and claude-stats uniquely holds the data to propose saving the
**same money a different way** — with no capability loss. A manager offered
"here's what your policy costs" resists; a manager offered "here's a cheaper
way to keep what we have" has a way to win.

## 4.1 The arbitrage that only usage data can price

The same Claude usage can be bought under different pricing models: metered
per-token (Bedrock, Anthropic API, Enterprise usage components) or flat-rate
seats (Team/Max plans, seat-based Enterprise terms). Which is cheaper depends
entirely on the team's actual usage shape — intensity, burstiness, model mix
— and claude-stats has all three, per user, from the local history. Both
price sheets already exist in the codebase: per-token in `PRICING`
(`packages/core/src/pricing.ts:36`) and per-seat in `PLAN_FEES`
(`pricing.ts:100`), and the `size_seats` MCP tool
(`packages/cli/src/mcp/index.ts:593`) already sizes seat mixes from usage for
plan users. This report is that logic pointed the other way: **price a
metered org's real history under seat plans** (and vice versa).

For the motivating scenario — an org removing top-tier access to cut metered
spend — the punchline is often available: heavy users moved to flat-rate Max
seats can cost *less per month than the tier-removal saves*, while keeping
top-tier access. Whether that's true for a given team is exactly one report
run against their own data.

## 4.2 Mechanics

1. **Actual side**: the period's metered cost = the store's per-message
   pricing sums (post model-id normalization,
   [ticket-attribution/README](../ticket-attribution/README.md)) — the same
   number that reconciles against the invoice
   ([ticket-attribution/04 §4.3](../ticket-attribution/04-reporting-and-roi.md)).
2. **Simulated side**: replay each user's usage against plan mechanics —
   5-hour windows and weekly caps from the plan-mechanics reference
   (`get_plan_mechanics_reference`, `mcp/index.ts:564`) — to find the
   smallest seat tier per user that would have absorbed their history, then
   price the resulting mix via `PLAN_FEES` / `size_seats`. Usage that
   overflows every tier stays metered in the simulation (a **hybrid mix** —
   heavy users on seats, long tail metered — is a first-class scenario, not
   a fallback).
3. **Scenario table**: status quo · the org's policy (tier removal, with its
   measured damage from [02](02-model-policy-impact.md)) · seat mix · hybrid.
   Columns: monthly cost, capability retained, and the damage column carried
   over — so the policy's "savings" sit next to what they cost.
4. **Enterprise custom pricing** can't be looked up: seat and usage terms
   enter via config (like the hourly rate,
   [03 §3.2 Gap 4](03-measurement-mechanics.md)); the report degrades to
   "fill in your negotiated numbers" rather than guessing.

## 4.3 Honesty constraints

- **Plan limits are opaque and movable.** The simulation is an estimate and
  says so: windows and caps are modeled from the plan-mechanics reference,
  which carries its own verification date. Robust conclusions ("usage fits
  comfortably inside the tier with 3× headroom") should be distinguished
  from marginal ones ("fits in 11 of 12 months").
- **Flat-rate changes behavior.** History recorded under metered pressure
  (or under a tier ban) understates what usage would be on a flat plan;
  the report notes the direction of this bias instead of pretending the
  replay is a counterfactual.
- **Terms-of-service reality check**: seat plans are subscription products
  with their own conditions (fair-use, org account requirements); the report
  recommends a procurement conversation, not a unilateral migration.
- The report can conclude **against** the switch — a genuinely metered-cheap
  team should be told so plainly. Like the two-sided model report
  ([02 §2.3](02-model-policy-impact.md)), the willingness to conclude either
  way is what makes the favorable conclusion worth something.

## 4.4 Relationship and surfaces

This operationalizes the **license-advisor** direction (plan/seat right-
sizing from real usage) for metered orgs, reusing `size_seats` rather than
duplicating it. Surfaces: a `compare_pricing_models` MCP tool and a section
in the [justification pack](../ticket-attribution/05-justification-pack.md)
(conditional, metered accounts with a policy event or budget pressure).
Sequencing: it needs ticket-attribution phase 0 (normalization, metered
mode) and nothing else from this folder — it can ship before the
before/after engine and is arguably the fastest path to a constructive
conversation with the org that motivated this analysis.
