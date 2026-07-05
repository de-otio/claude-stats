# 03 — Current state and gaps

claude-stats turns out to already be much closer to this feature than the
user story in [01](01-problem-and-use-case.md) suggests — for **one developer
on one machine.** The gap is almost entirely at company scale. This file
separates the two so [04](04-proposed-tools-and-workflow.md) and
[05](05-reusing-the-team-backend.md) can propose the smallest change that
closes each.

## What already exists

### A working, tested, individual plan-recommendation engine — with a shipped UI, not just tested logic

`buildDashboard()` (`packages/cli/src/dashboard/index.ts:417`) already
computes a `planUtilization` block on every dashboard build, and it isn't
just backend logic waiting for a surface: the dashboard's tab bar already
registers a dedicated **"Plan" tab**
(`packages/cli/src/server/template.ts:497`), whose panel
(`:674–797`) renders a color-coded plan-verdict card, a suggested-plan card,
and per-account breakdown cards. This ships today in both the browser
dashboard and the VS Code panel. See
[08](08-dashboard-surface.md) for what extending it for this feature looks
like — the individual half of this feature has a GUI head start too, not
just a data-model one.

- `recommendedPlan` — one of `pro` / `team_standard` / `max_5x` /
  `team_premium` / `max_20x`, chosen by a monthly-cost-equivalent threshold
  ladder (`:879–886`).
- `currentPlanVerdict` — `good-value` when the account's usage meets its
  plan's weekly budget, `underusing` otherwise (`:890–891`), computed
  per-account too (`byAccount[].planVerdict`, `:196–205`, `:917`, `:921`).
- This feeds a human-readable entry in the dashboard's `Recommendation[]`
  list (`id: "plan-underusing"`, `:1273–1287`) — the same mechanism the
  dashboard already uses for other insights.

This isn't a stub: `packages/cli/src/__tests__/dashboard.test.ts:540–584`
exercises it against real seeded stores and asserts on the output (e.g. a
low-usage store correctly recommends `pro`). **The core question this whole
analysis is about — "is this usage pattern on the right plan?" — already has
a real, tested answer for individual consumer/Team plans.** Nothing in
[04](04-proposed-tools-and-workflow.md) needs to reinvent that logic.

### Per-account plan/seat visibility, already read from disk

`packages/cli/src/account.ts` reads `oauthAccount.{seatTier,
organizationRateLimitTier, userRateLimitTier, billingType, subscriptionType,
hasExtraUsageEnabled}` directly from `~/.claude.json` — no inference needed,
the current login's seat tier is sitting in plain text. It's surfaced today
via the `account` CLI command (`packages/cli/src/cli/account-commands.ts`),
shipped as part of the account-attribution work (`git log --oneline -- packages/cli/src/cli/account-commands.ts`
shows four commits under that effort, three `feat` and one `fix`). Two gaps on an otherwise
complete feature: it isn't in
[doc/user-doc/commands.md](../../user-doc/commands.md)'s command reference
(added after that doc was last updated), and it isn't exposed through any MCP
tool — an agent can't currently ask claude-stats "what plan is this developer
on" at all.

### Attribution: the prerequisite this feature depends on

Any company-scale aggregation is only trustworthy if a developer's personal
usage doesn't leak into their employer's sizing numbers. That's exactly what
[doc/analysis/account-attribution/](../account-attribution/) covers, and per
its own recommendation doc it has shipped: forward per-account attribution via
an observation timeline, an `accounts` table (schema v13: `account_uuid`,
`organization_uuid`, `email_hash`, `seat_tier`, `billing_type`), append-only
`account_observations`, and `account reattribute` / OTEL ingest commands. The
`get_cost_per_task` MCP tool already accepts an `account` filter
(`packages/cli/src/mcp/index.ts`, documented in its input schema as "Filter to
a specific account UUID"). Section [07](07-rollout-plan.md) treats this as a
hard dependency, not a nice-to-have.

### Cost modeling already separates three things this feature needs kept apart

- **Equivalent per-token API cost** — `estimateCost()` in
  [`packages/core/src/pricing.ts`](../../../packages/core/src/pricing.ts),
  cache-read/cache-write aware, explicitly documented as "not what
  subscription plans actually charge."
- **Flat monthly plan fees** — `PLAN_FEES` in the same file (`pro: 20,
  max_5x: 100, max_20x: 200, team_standard: 25, team_premium: 125`), looked
  up from the telemetry `subscriptionType` field.
- **A per-account fee override** — `packages/cli/src/config.ts:179–197`
  (`resolveAccountFee`) and `:308–329` (`getPlanConfig`), letting a user
  record what they actually pay, in their own currency, per account. This
  duplicates `PLAN_FEES` rather than reading it — a pattern already present
  in the codebase before this analysis, and one more place any new
  plan-mechanics data must avoid re-duplicating.

A single-machine rolling spend-threshold check already exists too:
`packages/cli/src/alerts.ts:20–59` sums `estimateCost()` since the start of
the current day/week/month and reports `{currentCost, threshold, exceeded,
percentage}`, wired to the CLI `config` command. It's a real, if narrow, seed
for "spend limit" — narrow because it's one machine's rolling window, not an
org-wide or per-user-across-the-company limit.

## What's missing

### The richer data is computed, then thrown away before it reaches an agent

`get_stats` and `list_projects` — the two MCP tools most relevant to this
feature — both call `buildDashboard()` internally
(`packages/cli/src/mcp/index.ts:95` and `:201`), which means
`planUtilization`, `byAccount`, and `recommendations` are computed on **every
single MCP call already being made today.** Neither tool forwards them —
`get_stats` returns only the flat `DashboardSummary` fields. An agent asking
"what plan should I be on" cannot get an answer claude-stats has *already
computed*, purely because the MCP handler discards it. This is the cheapest
possible gap to close — see [04](04-proposed-tools-and-workflow.md).

### No Enterprise awareness anywhere

`PlanType` and `PLAN_FEES` cover exactly five values, all flat-fee
consumer/Team plans. Enterprise's fully-metered, seat-fee-plus-API-rate model
(section [02](02-plan-mechanics-reference.md)) has no representation — the
`PlanType.custom` bucket is a free-text-or-zero fallback a user fills in
manually, not a computed model. `recommendedPlan`'s five-way threshold ladder
structurally cannot recommend Enterprise; it tops out at `max_20x`. Nothing
in the codebase encodes seat *ranges* (Team's 150-seat ceiling, Enterprise's
20-seat self-serve / 50-seat sales-assisted split) at all — that entire
vocabulary from [02](02-plan-mechanics-reference.md) is absent. claude-stats
today reasons in dollars and tokens for one person; it has no concept of a
*seat*, and no concept of a *company*.

### No cross-person, cross-machine aggregation

This is the real gap, and it's worth being precise about what does and
doesn't exist. The `accounts` / `account_observations` / attribution
machinery exists specifically to disambiguate **multiple Anthropic accounts
used on one person's machine over time** (their work account vs. their
personal account) — not multiple people. `Store` opens exactly one local
SQLite file (`~/.claude-stats/stats.db`); no schema migration (through v15)
adds a device or person identifier. The single `deviceId` reference anywhere
in the codebase — `os.hostname()` in
`packages/cli/src/extension/sync-integration.ts:255` — is unreferenced dead
code, absent from the shipped VS Code extension. **Two developers' exported
databases cannot be merged or compared today.** That capability — sync,
identity, cross-member aggregation — exists only in the separately designed,
not-yet-shipped team-app backend, covered in
[05](05-reusing-the-team-backend.md).

### The seat-tier recommendation logic is duplicated, not shared

The `22.5 / 62.5 / 112.5 / 162.5` thresholds in `recommendedPlan`'s ladder
are midpoints between the dollar figures already sitting in `PLAN_FEES` — but
hand-coded separately rather than derived from that table. It works today
because both copies happen to agree; it's a latent drift risk the same way
`config.ts`'s `PLAN_FEES` duplicate is. Worth fixing opportunistically
whenever either copy is touched, independent of this feature.

## The shape of the gap

| | Individual, single machine | Company, across a fleet |
|---|---|---|
| "What plan am I on" | **Done** — `account.ts` / `oauthAccount` | Doesn't exist |
| "Am I on the right plan" | **Done, tested** — `planUtilization` | Doesn't exist |
| Shown in a GUI | **Done, shipped** — the dashboard's "Plan" tab | Doesn't exist — and shouldn't be bolted onto the shared per-developer dashboard, see [08](08-dashboard-surface.md) |
| Exposed to an agent (MCP) | **Missing** — computed, then discarded | Doesn't exist |
| Knows about Enterprise / seats | **Missing** | Doesn't exist |
| Aggregates across people | N/A | **Missing** — no sync, no shared identity |

The individual column is a small, well-scoped extension of code that already
works. The company column is a genuinely new capability. Both are needed for
the full use case in [01](01-problem-and-use-case.md), but they don't need to
ship together — see [07](07-rollout-plan.md).
