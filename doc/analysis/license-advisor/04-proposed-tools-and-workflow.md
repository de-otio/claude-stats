# 04 — Proposed tools and agent workflow

## Design stance

Don't build one opaque `recommend_our_claude_plan` tool. Two of the five
triggers in [02](02-plan-mechanics-reference.md) — compliance adjudication
and spend-limit philosophy — are judgment calls, not computations, and
[01](01-problem-and-use-case.md)'s non-goals already rule out claude-stats
making them silently. Folding everything into one tool call would hide
exactly the reasoning a stakeholder needs to be able to audit and re-run —
the same "no verification theatre" standard the rest of claude-stats already
holds itself to
([cost-per-successful-task/README.md](../cost-per-successful-task/README.md)).

So split by what's actually computable:

- **Deterministic arithmetic** (seat-ceiling math, cost projections across a
  seat-tier mix) → a tool. An agent doing multi-step arithmetic in its own
  reasoning is more error-prone than a tested pure function; this is exactly
  where a tool call is *more* trustworthy than agent narration, not less.
- **Measured facts** (this developer's usage, this account's seat tier) →
  tools, because claude-stats is the one system that actually has them.
- **Judgment calls** (does our compliance posture require Enterprise, how
  loosely should spend limits be set) → left to the agent's conversation
  with the user, explicitly informed by (but never resolved by) the tools
  above.

claude-stats also has a hard scope boundary worth stating plainly: it has
*no way to know* a company's headcount, technical-role fraction, or
compliance posture from local Claude Code data. Those inputs only ever come
from the user, via the agent. Every tool below that accepts "company
characteristics" is a calculator over caller-supplied inputs, never a lookup
against something claude-stats independently knows.

## New and changed MCP tools

| Tool | Change | What it reuses |
|---|---|---|
| `get_stats` | **Extend.** Add an optional `planAdvice` object: `recommendedPlan`, `currentPlanVerdict`, `usageIntensityTier` (light/typical/power, benchmarked per [02](02-plan-mechanics-reference.md)), per-account breakdown | `buildDashboard()`'s `planUtilization`/`byAccount`, already computed on every `get_stats` call and currently discarded (`packages/cli/src/mcp/index.ts:95`, `packages/cli/src/dashboard/index.ts:417,879–921`) |
| `get_account_info` | **New.** Current login's `seatTier`/`organizationRateLimitTier`/`billingType`/`subscriptionType`/`hasExtraUsageEnabled`, plus the known-accounts table for this machine | `readClaudeAccount()` (`packages/cli/src/account.ts`), already backing the `account` CLI command |
| `get_plan_mechanics_reference` | **New.** Returns the dated snapshot from [02](02-plan-mechanics-reference.md) — seat ranges, pricing shape, benchmark tiers — with a mandatory `verifiedDate` and `staleWarning` field in every response | A new `packages/core/src/planMechanics.ts`, structured like [`pricing.ts`](../../../packages/core/src/pricing.ts)'s dated-constant pattern |
| `size_seats` | **New.** Pure arithmetic: given headcount, technical-role fraction, and a seat-tier mix (measured or assumed), returns a scenario table — seats per scenario, whether each fits Team's range, a cost projection per scenario. Never picks a plan; returns rows for the caller to read against their own compliance/philosophy judgment | New pure function in `packages/core`, calling `planMechanics.ts` for the reference numbers it projects against |

None of these need network access or change claude-stats' local-only,
read-only posture. `get_plan_mechanics_reference`'s data ships with
claude-stats and goes stale like any cached reference — see
[06](06-staleness-trust-and-privacy.md) for why the tool description must
tell the calling agent to prefer a live lookup over it when one is available.

## Matching CLI surface

Keep the terminal and the agent path showing the same numbers:

- Extend the existing `account` command
  (`packages/cli/src/cli/account-commands.ts`) to print
  `recommendedPlan`/`currentPlanVerdict` alongside the seat-tier fields it
  already shows — today that data only reaches the web dashboard, not the
  terminal.
- Add `claude-stats plan-advisor --seats <n> --technical-fraction <pct>
  [--compliance]`, a thin CLI wrapper over the same `size_seats` core
  function, for a stakeholder who wants the scenario table without going
  through an agent at all.
- Document both in [doc/user-doc/commands.md](../../user-doc/commands.md) —
  `account` shipped without a documentation update; don't repeat that for
  this feature.

This document scopes deliberately to tools, commands, and the agent
conversation — the original ask in [01](01-problem-and-use-case.md) is
explicitly conversational. claude-stats also has a dashboard GUI, and part of
this feature already lives there (the existing "Plan" tab); see
[08](08-dashboard-surface.md) for what changes on that surface and, just as
importantly, what deliberately does not — the company-scale view is not a
tab in the shared per-developer dashboard.

## The agent workflow

The actual "help me pick a plan" experience is a skill (a prompt asset), not
a single tool call:

1. **Ask for company characteristics** the tools can't know: headcount,
   technical/developer fraction, whether the org handles data under
   compliance obligations, rollout stage (pilot vs. steady-state vs. full),
   and — if the user has a view — which spend-limit philosophy they lean
   toward (see [02](02-plan-mechanics-reference.md) trigger 4).
2. **Call `get_account_info` and `get_stats`** (per developer with existing
   usage, or across whatever machines are reachable) to classify real usage
   intensity instead of assuming Anthropic's generic benchmark. Where no
   local usage exists yet — the common case for a company that hasn't
   adopted Claude Code at all — say so explicitly and fall back to the
   benchmark tiers from `get_plan_mechanics_reference`, labeled as a fallback,
   not measured.
3. **Prefer a live check of current Anthropic pricing** (WebFetch/WebSearch
   against claude.com/pricing and the support center) over
   `get_plan_mechanics_reference`'s shipped snapshot when network access is
   available; fall back to the snapshot, with its `staleWarning`, when it
   isn't. See [06](06-staleness-trust-and-privacy.md).
4. **Call `size_seats`** with the gathered inputs to get the scenario table —
   seat counts, ceiling checks, cost projections.
5. **Apply the two judgment calls in conversation, not silently:** state
   whether the compliance answer to trigger 2 pushes toward Enterprise
   independent of seat count, and present the spend-limit tradeoff from
   trigger 4 as a choice for the user to make.
6. **Show the work.** The final answer is the scenario table plus the
   reasoning chain that produced it — which row applies and why — not a bare
   verdict. A stakeholder should be able to re-run this next quarter as real
   usage data replaces benchmark assumptions and get a visibly updated,
   explainable answer.

This skill is cheap to ship — a markdown prompt asset distributed with the
extension or the repo, no new infrastructure — and is the first thing to
build once the Phase 0/1 tools above exist. See
[07](07-rollout-plan.md) for sequencing.
