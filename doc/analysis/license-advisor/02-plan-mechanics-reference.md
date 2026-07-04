# 02 — Anthropic's plan mechanics, as a reference the recommendation logic can cite

Any recommendation ("buy Team, not Enterprise", "default new hires to Premium
seats") has to be checked against how Claude is actually sold. This file
distills that as of the date below, in the same spirit as
[`packages/core/src/pricing.ts`](../../../packages/core/src/pricing.ts): a
dated, sourced snapshot, not a fact claude-stats owns. See
[06](06-staleness-trust-and-privacy.md) for how to keep this from being
presented as more current than it is.

**Verified:** 2026-07. **Re-verify at
[claude.com/pricing](https://claude.com/pricing) and the Anthropic support
center before using any figure below in a real recommendation** — the
relative *structure* (seat ranges, what each tier unlocks, the bundled-vs-metered
distinction) is more durable than any individual dollar figure.

## Plans at a glance

| Plan | Seat type | Price (list, annual/monthly billing) | Seat range | Usage model |
|---|---|---|---|---|
| Team | Standard | $20 / $25 per seat/mo | 5–150 | Bundled usage allowance (~1.25× an individual Pro plan per rolling 5-hour window); admin-controlled overage |
| Team | Premium | $100 / $125 per seat/mo | 5–150 | Bundled usage allowance (~6.25× Pro), includes Claude Code; admin-controlled overage |
| Enterprise | Unified seat | Seat fee (quoted floor ~$20/seat; actual pricing negotiated) for platform access **only** | 20 (self-serve) / 50 (sales-assisted) minimum, no published max | **No bundled usage** — every token metered at API rates from the first request, bounded by configured spend limits |

Sources: [What is the Team plan?](https://support.claude.com/en/articles/9266767-what-is-the-team-plan),
[What is the Enterprise plan?](https://support.claude.com/en/articles/9797531-what-is-the-enterprise-plan),
[claude.com/pricing](https://claude.com/pricing).

## Procurement motion — where the friction actually is

| | Team | Enterprise, self-serve (20–49 seats) | Enterprise, sales-assisted (50+ seats) |
|---|---|---|---|
| How you buy | Self-serve, credit card | Self-serve, org settings | Named Anthropic account team |
| Lead time | Minutes | Minutes–hours | **Weeks** (typical enterprise sales cycle) |
| Seat reduction | — | Only at renewal | Contact account manager |

Source: [Purchase and manage seats on Enterprise plans](https://support.claude.com/en/articles/13393991-purchase-and-manage-seats-on-enterprise-plans).

The 150-seat number itself isn't the friction point — crossing into a
*sales-assisted* Enterprise contract is, because it introduces a multi-week
cycle a self-serve Team purchase never has. That argues for starting the
Enterprise conversation before it's strictly necessary, not at the wall.

## The core asymmetry a recommendation must not gloss over

**Team bundles usage. Current-model Enterprise does not.** They are not "the
same model with more seats."

- On Team, what happens when a user exhausts their bundle is
  **admin-controlled**: an Owner can enable overage billing at API rates, but
  the default failure mode is a hard block, not a bill. Source: [Manage usage
  credits for Team and seat-based Enterprise plans](https://support.claude.com/en/articles/12005970-manage-usage-credits-for-team-and-seat-based-enterprise-plans).
- On the current Enterprise seat, **metering starts at the first token, for
  everyone, always** — the seat fee buys platform access only. Source: [How am
  I billed for my Enterprise plan?](https://support.claude.com/en/articles/11526368-how-am-i-billed-for-my-enterprise-plan).
- Anthropic's help center also documents an older *seat-based Enterprise*
  variant (Standard/Premium-tiered, bundled usage like Team) that existing
  customers are reportedly being migrated away from at renewal. Whether a new
  large contract can still negotiate into that structure instead of the fully
  metered one is exactly the kind of thing to ask Anthropic's account team,
  not assume from public docs either way.

Enterprise's exposure is bounded only by spend limits the org configures —
org-wide, per-seat-tier, and per-user, all **hard stops** ("usage will stop,"
not "you'll get a bigger invoice"). That makes Enterprise cost-*predictable*
in principle, but only if the limits are actually set — an org that adopts
Enterprise and leaves limits unset has *more* exposure than Team, not less.

## Per-user planning benchmarks (Anthropic's own)

Published specifically because current-model Enterprise has no bundled
allowance to size against instead:

| User intensity | Claude Code | Cowork | Chat |
|---|---|---|---|
| Power (top 10%) | $500/mo | $100/mo | $90/mo |
| Typical (mean) | $215/mo | $40/mo | $30/mo |
| Light (median) | $40/mo | $10/mo | $5/mo |

Source: [Claude Enterprise consumption guide](https://support.claude.com/en/articles/14782391-claude-enterprise-consumption-guide).
Anthropic's own caveat: *"these figures are rough planning estimates —
actual consumption will vary based on your team's size, workflows, and usage
patterns."* Claude Code is the highest-intensity surface by a wide margin,
which is exactly the surface claude-stats already instruments in detail. A
company that has real Claude Code usage data — even from a handful of
developers on individual plans before any company-wide rollout — can replace
this generic table with its own measured distribution. That substitution is
claude-stats' entire value proposition for this use case; see
[03](03-current-state-and-gaps.md).

## What Enterprise adds beyond seat count

None of the following require crossing 150 seats — a 60-seat org with real
compliance requirements can reasonably choose Enterprise at the 20-seat
self-serve minimum on these merits alone:

- SSO/SCIM (automated provisioning tied to the org's identity provider)
- Audit logs
- Custom data retention controls
- Compliance & Analytics APIs (programmatic usage/cost data, not just CSV export)
- Customer-managed encryption keys, US-only inference option
- Org/seat-tier/per-user spend limits (more granular than Team's)

Source: [Claude Code on Team and Enterprise](https://www.anthropic.com/news/claude-code-on-team-and-enterprise).

## The decision framework, generalized

Stripped of any one company's specifics, a recommendation walks these
triggers in order:

1. **Seat-ceiling trigger.** Is the addressable technical population at,
   near, or over Team's 150-seat range? "Near" matters as much as "over" —
   a rollout that will plausibly cross the ceiling within its planning
   horizon should start the Enterprise conversation early, given the
   sales-assisted lead time above.
2. **Compliance trigger.** Does the org handle regulated or customer data
   under contractual obligations that make SSO/SCIM, audit logs, or custom
   retention non-cosmetic? This can force Enterprise regardless of (1).
   claude-stats can surface that this trigger exists; whether it fires is a
   legal/IT judgment call, not a data question.
3. **Seat-tier mix.** Within Team, what fraction of the population is a
   light/typical/power Claude Code user? This sets the Standard/Premium
   split. This is the trigger claude-stats' own usage data answers best —
   see [03](03-current-state-and-gaps.md).
4. **Spend-limit sizing.** Within Enterprise, per-user and org-wide limits
   are a real strategic choice, not a computed answer — two documented,
   equally legitimate positions:
   - **Cost-predictable:** size limits tight to the "typical" benchmark,
     accept that genuine power users will occasionally be throttled.
   - **Usage-maximizing:** size limits at 2–3× the "power" benchmark so a
     real power user never feels the ceiling; treat the limit purely as
     insurance against non-human failure modes (a leaked key, a runaway
     script), signalled by spend velocity inconsistent with human work
     patterns rather than by absolute dollar totals.

   A recommendation tool should present this as a choice with its tradeoffs,
   not silently pick one. See [01](01-problem-and-use-case.md#non-goals) and
   [06](06-staleness-trust-and-privacy.md).
5. **Timing trigger.** Given the multi-week sales-assisted lead time, at what
   committed-seat count should the Enterprise conversation start, relative to
   the seat-ceiling trigger in (1)? Starting early converts a hard wall into
   a non-event; waiting for the wall risks a rollout pause mid-momentum.
