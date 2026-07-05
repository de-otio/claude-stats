# 07 — Rollout plan

Lowest-effort-first, matching the phasing style already used in
[doc/analysis/account-attribution/06-recommendation-and-rollout.md](../account-attribution/06-recommendation-and-rollout.md).
Each phase should ship and prove useful on its own — none of them require the
next one to be worth building.

| Phase | New infrastructure | GUI change ([08](08-dashboard-surface.md)) | Unlocks |
|---|---|---|---|
| 0 | None — plumbing only | None | An agent can read this machine's current plan/seat tier and its already-computed plan verdict |
| 1 | `planMechanics.ts`, one skill | Extend the existing "Plan" tab | A single developer or IT lead gets a real, sourced plan recommendation for one machine |
| 2 | A privacy-safe export mode | New standalone `plan-advisor --import --html` report | A pilot cohort's *measured* usage distribution replaces generic benchmarks |
| 3 | Revived team-app backend | Same standalone report, fed live instead of by import | Continuous, org-wide sizing without manual export/collation |

## Phase 0 — Surface what's already computed

No new computation, only plumbing:

- Extend `get_stats` to forward `planUtilization` and `recommendations` from
  `buildDashboard()` — already computed on every call
  (`packages/cli/src/mcp/index.ts:95`), currently discarded before the
  response leaves the MCP handler.
- Add `get_account_info`, a thin MCP wrapper over `readClaudeAccount()`
  (`packages/cli/src/account.ts`), which already backs the `account` CLI
  command.
- Extend the `account` CLI command's terminal output
  (`packages/cli/src/cli/account-commands.ts`) to print
  `recommendedPlan`/`currentPlanVerdict` — today that only reaches the web
  dashboard.
- Document the `account` command in
  [doc/user-doc/commands.md](../../user-doc/commands.md), which shipped
  without it.

Dependency: none. Everything here reads data `buildDashboard()` and
`readClaudeAccount()` already produce and already have test coverage for.

## Phase 1 — Enterprise-aware individual classification

- Add `packages/core/src/planMechanics.ts`: the seat ranges, procurement
  mechanics, and benchmark tiers from
  [02](02-plan-mechanics-reference.md), dated and sourced like
  [`pricing.ts`](../../../packages/core/src/pricing.ts).
- Extend the individual classification so usage that exceeds even
  `max_20x`-equivalent gets a meaningful answer — "under Enterprise's metered
  model this is a power-tier user, ~$X/month against Anthropic's own
  benchmark" — instead of silently topping out at the current five-way ladder
  (`packages/cli/src/dashboard/index.ts:879–886`).
- Ship `get_plan_mechanics_reference` and `size_seats`
  ([04](04-proposed-tools-and-workflow.md)), plus the matching
  `plan-advisor` CLI command.
- Ship the license-advisor skill — this is where "tell your agent your
  company's characteristics" becomes a real experience, usable today by a
  single developer or by an IT lead manually running claude-stats on a
  handful of pilot machines one at a time.
- Extend the dashboard's existing "Plan" tab with the Enterprise-tier card
  described in [08](08-dashboard-surface.md) — the conversational and GUI
  paths should show the same classification, not drift apart.

Dependency: Phase 0 only. This phase is where the feature in
[01](01-problem-and-use-case.md) first becomes real, entirely without any
cross-machine capability.

## Phase 2 — Manual multi-developer aggregation, still no backend

- Extend `export`/`spending` with a privacy-safe "licensing-signal" mode:
  monthly tokens/cost by model, cache-hit rate, session cadence, and current
  seat tier — aggregates only, no prompt content, no per-message detail,
  matching the metadata-by-default posture in
  [06](06-staleness-trust-and-privacy.md).
- A handful of pilot developers run it and hand the output to whoever is
  running the sizing exercise (or to the agent directly), who combines the
  per-developer exports into the percentile distribution `size_seats` needs
  — replacing Phase 1's generic Anthropic-benchmark fallback with this
  company's own measured numbers. This is the direct analogue of pulling an
  existing usage log before a sizing review, except the log is Claude-native
  ground truth instead of a proxy.
- **Real dependency, not a nice-to-have:** this phase's output is only
  trustworthy if each contributing machine's account attribution is sound.
  Mixing a developer's personal-plan usage into their employer's export would
  corrupt exactly the percentile data this phase exists to produce — this
  phase sits downstream of
  [doc/analysis/account-attribution/](../account-attribution/), which has
  already shipped forward attribution.
- Ship the standalone `plan-advisor --import --html` report from
  [08](08-dashboard-surface.md) as the way this phase's combined data is
  actually read — deliberately **not** a tab added to the shared
  per-developer dashboard; see 08 for why that distinction matters here.

## Phase 3 — Opt-in team backend for continuous aggregation

Only once Phase 1/2 show recurring demand a manual export-and-collate
workflow can't keep up with — an org running a multi-quarter rollout that
wants this refreshed automatically rather than re-collected by hand each
review cycle.

- Reuse team-app's auth/identity/sync/privacy design
  ([05](05-reusing-the-team-backend.md)) as the blueprint, not its
  gamification aggregation code.
- Build a new sibling aggregate-view computation (percentile/tier bucketing)
  alongside — not inside — the existing sum/average functions in
  `aggregate-stats.ts`.
- Keep its consent flow separate from leaderboard opt-in, per
  [06](06-staleness-trust-and-privacy.md).
- This is the expensive phase: a real AWS deployment with ongoing cost,
  currently nonexistent (CI's deploy jobs are still stubs — see
  [05](05-reusing-the-team-backend.md)). Sequence it last, on demonstrated
  need, not speculatively ahead of it.

## Why not start with Phase 3

The real-world sizing exercise this analysis is grounded in
([01](01-problem-and-use-case.md)) used none of this. Headcount math,
Anthropic's published benchmarks, and an explicit spend-limit policy choice
were enough to produce a defensible recommendation — entirely within what
Phase 1 provides. claude-stats' distinctive contribution is sharpest at the
Phase 1→2 transition, where a company's *own* measured usage replaces a
generic benchmark; Phase 3 is a scale-out for organizations already
committed to a continuous process, not a prerequisite for the feature to be
useful.
