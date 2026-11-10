# Claude Fable 5.2: impact on Claude Stats

**Date:** 2026-11-10 · **Status:** analysis only, nothing implemented ·
**Re-verified** against `master` at `25857b8` (2026-11-10)

The first draft was written against `34b41f8`, a branch 20 commits behind
`master`. The 2.1.311 follow-up work (PRs #126–#137, schema V26 and V27) had
already landed there. This version corrects the findings that work affects. See
[Status against master](#status-against-master).

Anthropic released Claude Fable 5.2 and Claude Mythos 5.2 on 2026-11-09. This
document records what the release changes for Claude Stats and which features
it makes worth building.

The review of the release prompted a wider look at what Claude Code now
records. Three later sections cover that: the data available beyond the
release, whether current-period usage can now be shown in the IDE, and what two
accounts on one machine mean for such a display.

## Summary

Fable 5.2 breaks nothing structurally. The transcript shape is identical to
Fable 5.1, and a pricing cache fetched after launch already carries the correct
row. The exposure is elsewhere: Claude Stats stores several fields it never
uses, and 5.2 makes each of them matter more.

| # | Finding | Kind | Affects | Status on `master` |
|---|---------|------|---------|--------------------|
| 1 | No 5.2 row in the shipped pricing table | Defect (visible) | Offline users; caches fetched 2026-11-02 to 11-08 | Open for Fable and Mythos 5.2. Sonnet and Haiku 5.5 fixed in #127 |
| 2 | Fast mode priced at half its real cost | Defect (silent) | Anyone using fast mode | Open |
| 3 | Classifier fallbacks to other models are not captured | Gap | Fable 5.2 users who hit a block | Planned: spec F4 (expected V33) |
| 4 | Dropped thinking blocks are not captured | Gap | All current models | Open, not planned |
| 5 | Fable and Mythos use the Sonnet energy class | Defect (silent) | Energy dashboard | Open |
| 6 | The "top" tier spans a 2× price gap | Gap | Tier-mismatch hint | Open |
| 7 | Plan data is stale | Gap | Plan advisor, license advisor | Open |

Beyond the release:

- Current-period usage in the IDE is now possible for subscription limits and
  for usage credits. It is still not possible for accounts on usage-based
  billing.
- Claude Code records six kinds of data that the parser does not read, among
  them its own per-session cost and the cause of every cache miss.
- A usage display has to be keyed by account. One login yields one account's
  figures.

## Evidence base

- The [announcement][ann] and the linked [pricing][pricing],
  [models overview][models], [preserved thinking][thinking] and
  [launch offers][offers] pages, read 2026-11-10.
- The code at `master` `25857b8`. The first draft read `34b41f8`; every
  finding was re-checked against `25857b8`.
- The local store (about 950,000 messages) for the fast-mode and geo counts.
- Four days of local Claude Code transcripts: about 46,000 assistant rows, 24 of
  them on `claude-fable-5-2`. The 5.2 sample is one session, so it shows the
  record shape and nothing about behaviour at volume.
- For the sections beyond the release: the Claude Code documentation for the
  [status line][statusline], [hooks][hooks], [monitoring][otel],
  [costs][costs] and the [Agent SDK][sdk-ts], the Claude Platform
  administration API pages, the Claude Code changelog up to 2.1.322, and 14
  days of local transcripts with two accounts in use.

The pricing and preserved-thinking pages were read partly through a model
summary because of their length. Figures in the rate table below come from the
verbatim part of the pricing page. Statements about preserved thinking beyond
the binding rule itself rest on the summary.

## What was released

| | Fable 5.2 / Mythos 5.2 | Fable 5.1 / Mythos 5.1 |
|---|---|---|
| API id | `claude-fable-5-2` | `claude-fable-5-1` |
| Input, per million tokens | $8 | $10 |
| Output | $40 | $50 |
| Cache write, 5-minute | $10 | $12.50 |
| Cache write, 1-hour | $16 | $20 |
| Cache read | $0.20 | $0.25 |
| Fast mode, input / output | $16 / $80 | n/a |
| Context window | 1M at standard pricing | 1M at standard pricing |

Other points that bear on Claude Stats:

- The ids are undated. Bedrock uses `anthropic.claude-fable-5-2`.
- Default effort is `high` on the API and `medium` in Claude Code.
- A request blocked by a safety classifier is answered by another model: Opus
  4.8 for cybersecurity, Opus 5 for biology and a small set of AI-research
  topics.
- Thinking blocks are bound to the conversation prefix and the account for all
  accounts. A mismatch returns an error or drops the block.
- `inference_geo: "us"` applies a 1.1× multiplier to every token category.
- Pro plans and standard Team seats get Fable within 50% of the weekly limit
  until 2026-11-16. After that date Fable runs on usage credits.

## Findings

### 1. No 5.2 row in the shipped pricing table

`DEFAULT_PRICING` in [pricing.ts](../../../packages/core/src/pricing.ts) has no
row for `claude-fable-5-2` or `claude-mythos-5-2`. The longest matching key is
`claude-fable-5`, the remainder `-2` classifies as a point-release suffix, and
the lookup is refused. The model costs $0 with `known: false` and a drift
finding names it. This is the designed failure mode: a visibly missing number,
not a wrong one.

The fetched cache (`~/.claude-stats/pricing.json`) corrects it. A cache fetched
on 2026-11-10 holds the right 5.2 row. The cache refreshes every 7 days, so a
machine that fetched between 2026-11-02 and 2026-11-08 shows $0 for Fable 5.2
until its next refresh, and an offline machine shows $0 indefinitely.

`claude-sonnet-5-5` and `claude-haiku-5-5` were absent too. #127 added both,
and C2 (#136) added the Haiku 5.5 long-context tier.

To fix:

- Add rows for `claude-fable-5-2` and `claude-mythos-5-2`, and bump
  `PRICING_VERIFIED_DATE` (still `2026-09-26`). The cache fetched on
  2026-11-10 holds both rows: $8 / $40, cache read $0.20, cache writes $10
  (5-minute) and $16 (1-hour). These match the rate table below.
- `pricing-drift.test.ts:314` uses `anthropic.claude-fable-5-2` as its example
  of a model the built-in table does not price. That test fails once the row
  exists and needs a different example id.
- New pricing rows change the domain-views golden-figures baseline, which only
  the full suite exercises.

### 2. Fast mode is priced at half its real cost

Fast mode costs exactly 2× standard on input and output, and the cache
multipliers apply on top. The parser reads `usage.speed` and the store keeps it
(schema V23), but `estimateCost` takes no speed argument. A fast-mode row is
priced at the standard rate.

This predates 5.2: Opus fast mode has the same defect. Fable 5.2 raises the
stake, because fast mode is now offered on the most expensive model and is
available in Claude Code. Every row in the local sample is `standard`, so the
sample's figures are unaffected.

The `inference_geo: "us"` multiplier (1.1×) is unapplied in the same way.

The local store has no fast-mode rows and no `us` rows among about 950,000
messages. Its geo values are `not_available`, `global` and empty. The defect is
real but costs nothing today.

What the fix touches on `master`:

- `estimateCost` gained a fourth optional argument in C2:
  `opts?: { longContext?: boolean }`. Speed and geo belong in the same `opts`.
  About 20 call sites pass rows that already carry `speed` and `inference_geo`.
- The hourly rollup `message_hourly` (rebuilt in V27) is keyed by
  `inference_geo`, so geo can be priced from the rollup. It has **no `speed`
  key**. Pricing fast mode in rollup-based aggregates needs a rollup rebuild,
  which is a schema change, as V27 was for `long_context`.

### 3. Classifier fallbacks are not captured

When a classifier blocks a Fable 5.2 request, a cheaper model answers it. The
transcript records two fields the parser does not read:

- `requestedModel` at the entry root
- `serverClassifierRequest` at the entry root

`usage.fallback_credit` is unrelated despite its name: it is a credit token
echoed on a retry so that the cache cost is not paid twice.

Correction: `serverClassifierRequest` is not a fallback marker. It is a
per-request id that appears on ordinary rows too. `requestedModel` against
`message.model` is the only signal.

No fallback occurred in the local sample, nor in a re-scan of the last three
days (243 files, 82 Fable 5.2 rows): `requestedModel` equals `message.model` on
every row. How a fallback appears is therefore unconfirmed. If `message.model`
names the serving model, cost is already correct and only the attribution is
missing. If it names the requested model, the row is over-priced by up to 2×.

Spec F4 in
[`plans/claude-code-2.1.311-followup/`](../../../plans/claude-code-2.1.311-followup/F4.md)
already stores `requestedModel` as `messages.requested_model` and discloses
mismatches (expected V33). This finding adds to F4 and needs no capture task of
its own.

### 4. Dropped thinking blocks are not captured

`message.input_transformations` records each thinking block the API dropped.
The local sample has 227 such events in four days: 222 with reason
`prefix_binding_mismatch` and 5 with `end_user_binding_mismatch`. The second
reason is not in the published list.

Per the documentation, a dropped block is not billed as input, but the model
re-creates the reasoning, which raises output tokens. The parser ignores the
field, so this cost is present in the totals and attributable to nothing.

The events occur on all current models, not only Fable 5.2. The release matters
because 5.2 enforces the binding for every account.

### 5. Fable and Mythos use the Sonnet energy class

`modelClass` in [energy.ts](../../../packages/core/src/energy.ts) matches on
`claude-opus`, `claude-sonnet` and `claude-haiku` prefixes and falls back to
`sonnet`. Fable and Mythos ids match none of them, so the most capable tier is
costed at mid-tier energy coefficients. This has applied since Fable 5.

No published energy figure exists for the Fable tier. The honest options are an
`opus`-class floor, labelled as a floor, or a separate class with a stated
assumption.

### 6. The "top" tier spans a 2× price gap

`modelTier` returns `top` for Opus, Fable and Mythos alike. Opus 5.5 costs
$4 / $20 and Fable 5.2 costs $8 / $40. The tier-mismatch detector compares
outcomes across tier boundaries, so the choice between Opus and Fable, now the
most expensive routing decision a developer makes, is invisible to it.

`master` changed the detector to exclude placeholder output from its cost
measures (A2). The tier boundaries are unchanged.

### 7. Plan data is stale

- No plan-fee table has an entry for the Ultra plan, which the launch-offers
  page names alongside Max. There are two tables, both needing the entry:
  `PLAN_FEES` in [pricing.ts](../../../packages/core/src/pricing.ts) (string
  keys, prefix-matched) and `PLAN_FEES` in
  [config.ts](../../../packages/cli/src/config.ts), keyed by the `PlanType`
  union in [types.ts](../../../packages/core/src/types.ts). Adding Ultra
  widens the union, extends `SUBSCRIPTION_TYPE_MAP`, and touches every locale
  that names plans. Ultra's monthly fee and the `subscription_type` string
  Claude Code reports for it are not known yet.
- The plan-mechanics snapshot was verified in 2026-07 and does not model the
  Fable allowance: a share of the weekly limit until 2026-11-16, usage credits
  afterwards, and one to three limit resets by subscription length.

## Feature opportunities

Ordered by value to a developer against the work required. The first three
need only fields that are already in the transcript.

1. **Cost per task by effort and model.** The release's central claim is that
   medium-effort Fable 5.2 matches Opus 5.5's best result for 40% to 50% of the
   cost per task. *Mostly shipped on `master`:* tokens and cost by effort tier
   in `get_stats` (#131, V26), agent cost by effort (#134), and the
   high-effort-low-output detector (#135). What remains is joining effort and
   model to the cost-per-*successful*-task figures, so a developer can test the
   claim on real work instead of on a benchmark.
2. **Cache-miss attribution.** `message.diagnostics.cache_miss_reason` gives the
   cause of a miss (`model_changed`, `system_changed`,
   `previous_message_not_found`, `unavailable`) and, for the first two, the
   number of input tokens that missed. The sample has 267 such rows. This turns
   the cache-TTL and efficiency hints from inference into measurement, and
   `model_changed` prices the cost of switching model mid-session directly.
3. **Thinking-drop report.** Count dropped thinking blocks per session with the
   reason and an estimate of the re-reasoning cost. Finding 4 supplies the data.
4. **Fallback report.** The share of Fable requests another model served, by
   classifier, and the amount actually paid. It depends on confirming the record
   shape in finding 3.
5. **Counterfactual repricing.** Reprice a past period at another model's rates:
   what last month's Fable 5.1 usage costs at 5.2 rates, or what moving a
   project from Opus 5.5 to Fable 5.2 would cost at equal token volume. Equal
   volume is an upper bound, since 5.2 is reported to use fewer tokens per task.
6. **Advisor attribution.** `advisorModel` is present on almost every row and
   unparsed. Fable 5.2 is positioned as an advisor that smaller models consult.
   Capturing the field is the precondition for saying what the advisor pattern
   costs.
7. **Fable allowance tracker.** The Fable share of the weekly limit against the
   50% cap, and projected credit spend after 2026-11-16. It is useful for about
   a week in its first form and depends on finding 7.

The wider look at the data adds four more:

8. **Limit and spend meter in the status bar.** The status bar shows today's
   tokens and estimated cost. For subscription accounts it can now show the
   limit windows and the month's credit spend. See
   [Current-period usage in the IDE](#current-period-usage-in-the-ide).
9. **Limit-hit impact.** `quotaLimits` marks each request a limit rejected, with
   the limit type and the reset time. Joined to the session, it says what was
   running and how long work stalled. It feeds the existing
   [constraint-impact](../constraint-impact/) design with measured events.
   *Capture is planned:* spec F3 (expected V32) stores the events and adds a
   `get_rate_limits` tool. The join to constraint impact is not part of F3.
10. **Self-check against `cost-state`.** Claude Code writes its own per-session
    cost into the transcript. Comparing it continuously with the Claude Stats
    figure turns the manual reconciliation of 2026-09 into a standing check, so
    an over-report of that kind cannot recur unnoticed.
11. **Contracted rates.** The `modelPricing` managed setting carries an
    organisation's contracted per-model rates. Reading it lets a metered user
    see the rate actually paid, not list price.

## Data available beyond the release

The [2.1.311 review](../claude-code-2.1.311-review/) covers the `api-request`
records and `requestedModel`. The following are also present and nothing in the
parser reads them. Counts are from the four-day sample.

| Source | Where | What it carries | Count |
|---|---|---|---|
| `cost-state` | Transcript entry type | Claude Code's own `totalCostUSD`, per-model usage and durations for the session | 79 |
| `diagnostics.cache_miss_reason` | Assistant `message` | Cause of a cache miss (`model_changed`, `system_changed`, `previous_message_not_found`, `unavailable`) and the input tokens that missed | 267 |
| `input_transformations` | Assistant `message` | Thinking blocks the API dropped, with the reason | 227 |
| `quotaLimits` | Assistant entry root, on API-error rows only | `rateLimitType`, `resetsAt`, `status`, `overageStatus`, `overageDisabledReason`, `isUsingOverage` | 3 |
| `advisorModel` | Assistant entry root | The advisor model configured for the request | almost every row |
| `system/turn_duration` | Transcript entry type | `durationMs`, `messageCount`, `pendingBackgroundAgentCount` per turn | 677 |

`quotaLimits` is a snapshot taken when a request is rejected. It is not a
polled value and says nothing while usage is under the limit.

Three sources outside the transcript are also new since the tool's baseline:

- **Status line input.** The JSON passed to a `statusLine` command carries
  `rate_limits`, `cost.total_cost_usd` and a `prompt_cache` object (hit ratio,
  misses, last miss cause, tokens re-cached).
- **OpenTelemetry.** The `claude_code.api_request` event carries `cost_usd`,
  the cache-write split by TTL, `speed`, `effort` and `query_source`. It carries
  no limit, quota or credit data.
- **`modelPricing` managed setting.** Contracted rates, where an organisation
  has set them.

`~/.claude/stats-cache.json` holds historical totals only, and
`~/.claude/policy-limits.json` holds feature policy, not usage limits.

## Current-period usage in the IDE

[06-limitations.md](../06-limitations.md) states that no local data captures
remaining quota and no endpoint reports account usage. That is no longer true
for subscription accounts.

| Account type | Possible | Source |
|---|---|---|
| Pro, Max, Ultra: 5-hour and weekly limits | Yes | Status line `rate_limits`, or the Agent SDK usage report |
| Usage credits on a seat plan: month's spend against the cap | Yes | Agent SDK usage report, `extra_usage` |
| Team and Enterprise seats: limits | Probably | Agent SDK usage report; untested |
| Behind a self-hosted Claude apps gateway | Yes | Status line `rate_limits.spend_limit` |
| Usage-based Enterprise, API-key billing | No | See below |

### The Agent SDK usage report

Sending `/usage` as a prompt through the Agent SDK (0.3.273 or later) returns
an assistant message with a structured `usage_report`:

- `rate_limits.limits[]`: one entry per limit, with `kind` (`session`,
  `weekly_all`, `weekly_scoped`), `percent`, `resets_at` and, for a
  model-specific weekly limit, `scope`.
- `rate_limits.extra_usage`: `is_enabled`, `monthly_limit`, `used_credits`,
  `utilization` and `currency`. Amounts are in minor units. `monthly_limit` is
  `null` when the account has no cap of its own, which on Team and Enterprise
  does not mean unlimited.

Conditions and limits:

- The session must be signed in with a claude.ai login that carries the
  `user:profile` scope. A `claude setup-token` token does not qualify.
- The report is withheld from accounts on usage-based billing.
- The shape is marked experimental.
- The endpoint behind it is rate limited. Claude Code shares one reading per
  minute across windows and falls back to a snapshot up to 60 minutes old.

### The status line

`rate_limits.five_hour` and `rate_limits.seven_day` each give `used_percentage`
and `resets_at`. The route is documented and stable, but narrower:

- It is documented for Pro, Max and Ultra only.
- It appears only after the first API response of a live session.
- Model-specific weekly limits and credit spend are absent.
- Claude Stats would have to own or wrap the user's `statusLine` command.

### Usage-based accounts

Nothing reaches an IDE extension without an administrator credential:

- The usage report is withheld and the status line `rate_limits` is absent.
- The Spend Limits API gives `period_to_date_spend` per member, and the Usage
  and Cost Analytics API gives cost per actor with a lag of 4 to 24 hours. Both
  need an admin or analytics key.
- Such a key does not belong in a developer's IDE. If this is built, the key is
  held by the team backend, which serves each member that member's own figure.

Without that, the best available is a month-to-date figure computed from the
transcripts. It must be labelled as a list-price estimate for this machine: it
excludes other devices and other Claude surfaces, and it ignores contracted
rates unless `modelPricing` is read.

## Two accounts on one machine

A common setup is a personal subscription and a work seat used on the same
machine. When both are subscription-billed, both qualify for the usage report,
but they rarely look alike: one may have usage credits enabled and the other
have them disabled by its organisation, and limit rejections can fall on one
account only. The transcripts identify accounts only by id, so attributing a
rejection to an account relies on the session's owner record or on fields such
as `overageDisabledReason`.

Consequences for a usage display:

- **One login, one report.** The usage report covers the account the session is
  signed in as. The other account cannot be read live unless it is signed in at
  the same time under a separate configuration directory. See
  [11-parallel-config-dirs.md](../account-attribution/11-parallel-config-dirs.md).
- **Snapshot per account.** Each report is stored against its account. The
  inactive account is shown as of its last reading, and the stored `resets_at`
  says when that reading has expired.
- **Different rows per account.** An account with usage credits shows the
  limits and the month's credit spend against the cap. An account whose
  credits are disabled shows limits only.
- **The status line route may cover one account only.** It is documented for
  Pro, Max and Ultra, not for Team seats.
- **Local estimates are split by account.** The shipped per-account attribution
  already supports this. Sessions without a `session-owner` record cannot be
  attributed, so their limit events stay unassigned.

## Not verified

- The usage report has not been run against a Max account or a Team seat.
  Whether it works on a Team seat is the first thing to test.
- Whether sending `/usage` through the Agent SDK makes a billable model call is
  not stated in the documentation.
- Whether `claude -p "/usage" --output-format stream-json` carries the same
  `usage_report` is not documented. Only the Agent SDK reference describes it.

- The Mythos 5.2 id `claude-mythos-5-2` appears only in documentation metadata.
  The pricing table lists the model by name. The fetched cache holds a row
  under that id, but no transcript has used it.
- Fast-mode cache rates are not tabulated. They are inferred from the statement
  that cache multipliers apply on top of fast-mode pricing.
- The `end_user_binding_mismatch` reason is undocumented in the pages read.

Resolved since the first draft: the Haiku 5.5 tier for prompts over 100,000
tokens is modelled on `master` (C2, #136, V27). C3 in the follow-up plan
covers four analytics that still price it at base rates.

## Suggested order of work

### Status against master

The 2.1.311 follow-up plan
([`plans/claude-code-2.1.311-followup/PLAN.md`](../../../plans/claude-code-2.1.311-followup/PLAN.md))
reserves the next schema numbers, with one schema PR in flight at a time:

| Task | What | Expected schema | State (2026-11-10) |
|---|---|---|---|
| E1 | Per-request records from `api-request` lines | V28 | Draft PR #138 |
| E3 | Prelude composition from `api-request-shape` | V29 | Spec |
| F1 | Permission-prompt friction | V30 | Spec |
| F2 | Idle-compaction economics | V31 | Spec |
| F3 | Rate-limit events (`quotaLimits`) | V32 | Spec |
| F4 | Requested-vs-served model, session titles | V33 | Spec |

Anything here that needs a schema change either joins one of these specs or
takes a number after them.

### Order

1. **No schema change; can start now.**
   - Fable 5.2 and Mythos 5.2 pricing rows and the drift-test fix (finding 1).
     Small, and it removes a user-visible $0.
   - Fast-mode and geo multipliers in `estimateCost` at message level, through
     the existing `opts` argument (finding 2). It changes a shared cost
     function, so it needs a before-and-after comparison on a real store.
   - The energy class and the tier split (findings 5 and 6).
   - Ultra plan data (finding 7), once the fee and `subscription_type` string
     are known.
2. **Fold into queued specs.** Classifier-fallback attribution into F4
   (finding 3); limit-hit impact (feature 9) builds on F3.
3. **New capture task after the queue (V34 or later).**
   `input_transformations`, `diagnostics.cache_miss_reason`, `advisorModel`,
   `cost-state` and `system/turn_duration` (finding 4; features 2, 3, 6 and
   10). Add the `speed` key to `message_hourly` in the same migration, so
   fast mode is priced in rollup aggregates without spending a schema number
   of its own.
4. **Analytics on the captured fields.** Effort and model joined to cost per
   successful task (feature 1) needs no new capture and can run alongside
   step 1.
5. **The usage meter (feature 8), starting with a spike.** Run the usage report
   against both account types and record what comes back. Only the account
   holder can run it, and the design depends on the result, so it comes before
   any interface work.

[statusline]: https://code.claude.com/docs/en/statusline
[hooks]: https://code.claude.com/docs/en/hooks
[otel]: https://code.claude.com/docs/en/monitoring-usage
[costs]: https://code.claude.com/docs/en/costs
[sdk-ts]: https://code.claude.com/docs/en/agent-sdk/typescript
[ann]: https://www.anthropic.com/claude-fable-and-mythos-5-2
[pricing]: https://platform.claude.com/docs/en/about-claude/pricing
[models]: https://platform.claude.com/docs/en/models/overview
[thinking]: https://platform.claude.com/docs/en/build-with-claude/preserved-thinking
[offers]: https://support.claude.com/en/articles/17506494
