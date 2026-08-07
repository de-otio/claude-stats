# 01 — What constraints cost: the taxonomy and the denominator

## 1.1 Three constraint shapes, one report vocabulary

Orgs withhold AI capability in three ways, and each leaves a different trace
in the local data:

| Constraint | Who applies it | Trace in the data |
|---|---|---|
| **Dollar cap / budget cut** | Enterprise & Bedrock orgs (metered) | Spend flatlines at the cap; sessions stop mid-month; model mix shifts cheaper under pressure |
| **Model-tier removal** ("no Opus") | Metered orgs via API config or Bedrock IAM model allowlists; plan orgs via policy | Per-message `model` distribution changes at a hard date; top-tier disappears entirely |
| **Throttling / quotas** | Seat plans: 5h usage windows, throttle events. Bedrock: TPM/RPM service quotas (429s) | `throttle_events`, `is_throttled`, `usage_windows` (plans); 429-shaped API errors (Bedrock, not yet parsed — [03 §3.2](03-measurement-mechanics.md)) |

The audience split from
[ticket-attribution/README](../ticket-attribution/README.md#who-this-is-acute-for)
applies with full force: on seat plans the marginal token is free and the
constraint is time-shaped (waiting for a window); on Enterprise/Bedrock the
constraint is dollar-shaped and every damage figure can be stated against a
real invoice. **A report must speak one vocabulary or the other** — a Bedrock
user shown "5-hour window" language, or a plan user shown pseudo-dollar
precision, each discredits the tool with its actual reader.

## 1.2 The wrong denominator

Every constraint above is justified by cost per **token** (or per month). But
tokens are an input, not the product. The project's own
[cost-per-successful-task/](../cost-per-successful-task/) analysis makes the
counter-metric precise: **cost per successful task**, computed as
`Σ cost(observable attempts) / count(successful)`
(`packages/cli/src/cost-per-task/index.ts:8`), with four-state outcomes
(`success | failed | in_flight | unobservable`,
`packages/cli/src/cost-per-task/outcome-types.ts:25`).

The failure mode of per-token optimization is concrete: a mid-tier model that
needs three attempts at an Opus-shaped task can consume **more total tokens**
than the top tier one-shotting it — the savings are negative even before any
human cost is counted. Whether that happens, and for which kinds of work, is
an empirical question the local data can answer. Nobody else in the org can
answer it: billing dashboards see spend, not attempts or outcomes.

## 1.3 The salary denominator closes the argument

Token deltas are usually small money. The decisive line is **developer time**:

- `sessions.active_duration_ms` (`packages/cli/src/store/index.ts`, sessions
  row) measures engaged time per session; summed per task via the existing
  task clustering, it yields **dev-minutes per completed task** — the
  shepherding cost. A weaker model that needs 25% more supervision costs more
  in salary than any plausible token saving, and the data shows whether it
  does.
- Throttle-shaped constraints add **wait and re-entry cost**: a session
  resumed hours after a limit pays a full context rebuild, visible as a
  cache-creation spike on resume — measurable, not anecdotal.
- With an optional hourly-rate config (one field, next to the existing
  `AccountFee` shapes in `packages/cli/src/config.ts:14`), both sides land in
  one currency:

> The policy saves **$X/month** in tokens. Since the cutover, cost per
> successful task in the affected classes rose **Y%**, and dev-time per task
> rose **Z minutes**, ≈ **$W/month** at the configured rate. Net: **−$V/month**.

That sentence — the constraint's savings and its damage, same units, same
table — is the entire deliverable. Everything else in this folder exists to
make it true, defensible, and impossible to produce dishonestly.

## 1.4 Damage taxonomy (what to measure per constraint)

| Damage channel | Metric | Source |
|---|---|---|
| Rework | Attempts per successful task | outcome states + task clustering |
| Lost work | Failure/abandonment rate per class | `failed`/`unobservable` shares |
| Token backfire | Tokens per **completed** task (not per message) | messages × clustering |
| Shepherding | Active dev-minutes per completed task | `active_duration_ms` |
| Wait | Throttle-wait hours; sessions dying at window/quota exhaustion | `throttle_events`, `usage_windows`, 429 parsing |
| Re-entry | Cache-creation spike on post-throttle resume | cache token columns around throttle gaps |
| Schedule | Tickets stalled across a constraint boundary | [ticket-attribution/](../ticket-attribution/) joins |

## 1.5 What this report never does

- Never claims business-value damage ("we lost the release") — that is the
  user-owned layer per [value-per-cost/](../value-per-cost/); the report stays
  on machine-owned ground: attempts, failures, minutes, dollars.
- Never produces a one-sided number. The two-sided construction is in
  [02 §2.3](02-model-policy-impact.md) and it is load-bearing, not a tone
  choice.
- Never infers the policy from the data ("model mix shifted, so there must
  have been a mandate") — policy boundaries are declared, not guessed
  ([03 §3.1](03-measurement-mechanics.md)).
