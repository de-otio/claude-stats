# 05 — Reusing the team backend

[03](03-current-state-and-gaps.md) established that cross-person aggregation
doesn't exist in claude-stats today. The user's own recollection is that an
earlier effort designed — and partly built — exactly that, for a different
purpose: team dashboards and gamification. This file asks how much of a head
start that gives this feature.

## What actually exists

Two prior efforts, in sequence:

- [doc/analysis/team-dashboard/](../team-dashboard/) — an earlier, lighter
  exploration (sync options, a team model, shared-metrics rules,
  gamification) that its own README frames as "local-first... no dedicated
  server."
- [doc/analysis/team-app/](../team-app/) — superseded and replaced it with a
  full AWS backend: Cognito auth with domain-restricted signup, an
  AppSync/GraphQL API, DynamoDB, an S3/CloudFront SPA, cross-device sync, and
  gamification (leaderboards, achievements, challenges).

Team-app isn't just a design document. `packages/infra` contains real CDK
stacks (`Api`, `Auth`, `Data`, `Frontend`, `Mcp`, `Monitoring`) and
`packages/infra/lambda` contains real, substantial implementation —
`aggregate-stats.ts` (710 lines), `team-dashboard.ts` (1117 lines),
`achievement-definitions.ts`, `challenge-scoring.ts`,
`inter-team-scoring.ts`, plus the Cognito auth Lambdas.

**None of it is deployed.** `.github/workflows/ci.yml`'s `deploy-dev` and
`deploy-prod` jobs are literally `echo "Deploy to dev — configure AWS
credentials and run cdk deploy here"` — never a real `cdk deploy` (lines 161
and 182). `packages/infra/lib/config/dev.ts` and `prod.ts` read as
placeholder/template configuration, not a live environment. The shipped VS
Code extension has zero integration hooks for it: its
`contributes.configuration` block (`extension/package.json:67–91`) has only
`port`, `autoRefreshSeconds`, and `recap.embeddings` — no backend URL setting,
no sign-in command. `packages/extension`, the workspace package the team-app
docs describe as the client, is an empty directory. This is real,
sophisticated, code-complete-looking scaffolding that was never wired up or
turned on.

## What reviving it would give this feature for free

If it were ever stood up, the parts that transfer directly:

- **Identity and org boundary.** Cognito with domain-restricted signup
  already solves "who is a member of this company" — arguably a *better* fit
  for an IT-run licensing pilot than for casual gamification, since a
  procurement decision has a clean, definable cohort (this quarter's pilot
  developers) in a way a fun leaderboard doesn't need.
- **The privacy posture.** Team-app's design principle 8
  ([team-app/README.md](../team-app/README.md)) — metadata by default,
  prompt text opt-in, code and file paths never synced — is exactly the
  boundary this feature needs (see [06](06-staleness-trust-and-privacy.md)).
  It doesn't need to be redesigned, just inherited.
- **A team/membership model.** `Team` / `TeamMembership`
  (`packages/core/src/types/team.ts:25–49`) map directly onto "the pilot
  cohort."

## What it does not give this feature

The analytics are the wrong shape. `aggregate-stats.ts` and
`team-dashboard.ts` have zero references to percentile, p50/p90, median, or
usage-tier anywhere in either file. Their computation produces
`TeamMemberStats` and `TeamAggregate`
(`packages/core/src/types/team.ts:60–97`) — per-member and team-wide **sums
and simple averages** (`avgSessionsPerMember`, `avgCostPerMember`) feeding
leaderboards, achievements, and challenges. That's the right shape for "who's
had the biggest week" and the wrong shape for a licensing decision: a blended
average is precisely what [02](02-plan-mechanics-reference.md)'s spend-limit
guidance warns against — it hides the power-user tail that Standard/Premium
seat-mix and spend-limit sizing actually depend on. This feature needs a
**distribution** (percentile bands, counts-in-band), not a mean, and nothing
in the existing lambda code computes one.

## A design tension worth naming, not papering over

Team-app's stated principles — "fun, not surveillance," leaderboards that
motivate rather than punish — were written for a peer-social feature: being
ranked is something a member opts into because it's fun among colleagues.
"IT wants a percentile spend distribution to negotiate an Enterprise
contract" is a different relationship — an employer looking at aggregated
employee usage for a budget decision. That doesn't make the two
incompatible; both need the same aggregated-metadata-only, opt-in data
boundary (see [06](06-staleness-trust-and-privacy.md) for the specific
minimum-cohort-size and no-individual-attribution rules this implies). But it
does mean a licensing-sizing aggregate view should not be bolted onto the
leaderboard's consent flow. A developer might reasonably want to contribute
to their company's seat-sizing exercise while declining to appear on a
leaderboard, or vice versa — conflating the two opt-ins would misrepresent
consent in both directions.

## Recommendation: reuse the design, not the deployment — and not yet

Don't revive team-app to build this feature. Two independent reasons:

1. **The math is different enough that "extend" is the wrong verb.**
   `aggregate-stats.ts`'s functions would need a genuinely new aggregate-view
   computation (percentile/tier bucketing over the same synced data), not a
   modification of the existing sum/average functions that leaderboards and
   achievements depend on. If team-app is ever revived, this feature's
   aggregate view is a sibling lambda reading the same synced records, not a
   patch to the gamification one.
2. **Standing up Cognito/AppSync/DynamoDB is a real, ongoing cost and
   maintenance surface** for a project the main README describes as "an
   informal side-project... built for fun, inspiration, and experimentation."
   [01](01-problem-and-use-case.md)'s own grounding example was sized
   entirely without company-wide telemetry — headcount math plus Anthropic's
   published benchmarks were enough to produce a defensible recommendation.
   [07](07-rollout-plan.md) sequences this feature so the backend is only
   revisited once Phase 1/2 demonstrate that a spreadsheet-and-CLI-export
   workflow genuinely can't keep up with real demand — not built speculatively
   ahead of it.

If that day comes, team-app's design docs — particularly
[06-sync-strategy.md](../team-app/06-sync-strategy.md)'s data-boundary
section and [10-team-features.md](../team-app/10-team-features.md)'s privacy
controls — are the right blueprint to start from. The CDK stacks and auth
Lambdas are a real head start; the aggregation Lambdas are not.
