# 01 — What claude-stats provides today

Verdict up front: **no shipped or designed feature computes time saved, hours saved, FTE, or any productivity gain.** A case-insensitive sweep for `time saved / hours saved / FTE / productivity` across source and docs finds only a gamification category named `PRODUCTIVITY` (`packages/infra/lambda/api/achievement-definitions.ts:37`, `packages/core/src/types/team.ts:13`) — unrelated to ROI. What exists is a cost-attribution stack plus one genuine human-time measurement. This file inventories the pieces a time-saved feature would stand on.

## 1.1 The measured half: human time *spent*

The tool already measures the term every time-saved formula needs on the "actual" side.

| Piece | Where | What it gives |
|---|---|---|
| `sessions.active_duration_ms` | column added `packages/cli/src/store/index.ts:282`; computed `packages/core/src/parser/session.ts:462-482` | Engaged time per session: sum of consecutive timestamp gaps < 30 min; idle gaps ≥ 30 min excluded (not recorded separately) |
| `first_timestamp` / `last_timestamp` | `packages/cli/src/store/index.ts:147-148` | Wall-clock span; ambiguous across resumes ([06-limitations.md](../06-limitations.md) §"Session duration is ambiguous") |
| `median_response_time_ms` | `store/index.ts:283` | Assistant latency after a user prompt |
| Per-message `timestamp`, `is_turn_start`, `tool_error_count`, `stop_reason` | `store/index.ts:171,174,344`; parser `session.ts:448` | Turn-level granularity: follow-up/repair turns are countable, which is how the review tax becomes measurable |
| Dev-minutes **per task** | recap task clustering (`packages/cli/src/recap/segment.ts`, `recap/index.ts:1017-1026` — per-item `duration: { wallMs, activeMs }`) | The "shepherding cost" unit from [constraint-impact/01 §1.3](../constraint-impact/01-what-constraints-cost.md) |
| Dev-minutes per **task class**, priced | `packages/core/src/constraintImpact/beforeAfter.ts:171-215,444-470` | `avgActiveMinutesBefore/After`, `devTimeDeltaMinutesAtAfterVolume`, `devTimeCostAtAfterVolume = (minutes/60) × hourlyRate` — `null` when no rate configured, never invented |
| `getTotalActiveHours`, `getVelocityMetrics` | per [sessions/implementation-checklist.md](../sessions/implementation-checklist.md) | Σ active hours; tokens/minute, prompts/hour |
| Org rollup | `packages/cli/src/org/aggregate.ts:298,327` | `active_duration_ms` → `activeMinutes` on the team plane |

Note the direction everywhere: in constraint-impact, dev time sits on the **cost** side of the ledger (`netEffectAtAfterVolume = tokenSavings − devTimeCost`). There is no term anywhere for time the AI saved — but the machinery is direction-reversible.

## 1.2 The task denominator

`get_cost_per_task` (`packages/cli/src/mcp/index.ts:536` → `packages/cli/src/cost-per-task/index.ts:523`) yields tasks in four states (`success | failed | in_flight | unobservable`), with success decided by user labels first, then a conservative git-grounded ladder (pushed commit / merged PR → success; mutating work with nothing landed → failed; absence of signal is **never** failure). Extended conversational/mechanical signals exist behind an off-by-default flag with uncalibrated placeholder weights (`cost-per-task/outcome-types.ts:62-86`). Any "N tasks completed" numerator for a time-saved claim inherits this detector's calibration state ([cost-per-successful-task/07-accuracy-plan.md](../cost-per-successful-task/07-accuracy-plan.md)).

## 1.3 The money-to-time bridge (denominator framing only)

`formatDevTime(t, cost, hourlyRate)` (`packages/core/src/insight.ts:210-236`) renders **spend ÷ hourly rate** as "≈ N dev-minutes / dev-hours / dev-days (÷8)". Its own doc comment states the purpose: show that a month of heavy usage is a low single-digit percentage of one salary. This is the *salary-denominator* framing — systematically **not** a claim about saved time, and the justification pack uses it exactly that way.

Config already carries the two knobs a benefit-side computation would reuse: `rate.hourly` and `plan.monthly_fee` ([user-doc/commands.md](../../user-doc/commands.md), `hourly` key; `netEffectAvailable: true` when set).

## 1.4 The reporting vehicle: the justification pack

`generate_justification_pack` (`packages/cli/src/mcp/index.ts:970` → `packages/cli/src/pack/index.ts:295` → pure builder `packages/core/src/pack.ts:479`) writes `report.html` + three CSVs. Its content is entirely cost-side: headline spend with the dev-days-at-rate denominator framing, per-ticket spend with confidence tiers, non-ticket work by task class, optional hygiene/constraint/calibration sections, and a methodology section. `summary.csv` (`pack.ts:1106`) carries 24 columns — coverage, confidence mix, reconciliation, `hygieneWasteRatio`, `constraintNetEffect` — and **no value, benefit, or time-saved column**. The pack is the natural home for a time-saved section: it is already the "hand this to your manager" artifact ([ticket-attribution/05](../ticket-attribution/05-justification-pack.md)).

> **Incidental finding while auditing:** the MCP tool description at `packages/cli/src/mcp/index.ts:980-982` still claims the hygiene/constraint/calibration sections "render an honest 'not available in this build' block, since those detectors/engines are not shipped yet." That is stale — `pack/index.ts:256-258` wires all three engines and the unavailable block only fires on a wiring fault. The description under-promises what ships; fix independently of this analysis.

## 1.5 The join keys to external ground truth

- **Ticket keys** from git branches, commit subjects, and prompt mentions (`packages/cli/src/ticketing/index.ts:108-131`), evidence-graded, with a coverage denominator. [ticket-attribution/04 §4.1](../ticket-attribution/04-reporting-and-roi.md) is explicit: "cost per ticket is half of ROI — own that half well"; the ticket key is the join key to Jira-side value (story points, **cycle time**), and claude-stats never calls Jira and never computes ROI itself.
- **Policy events** (`config.policyEvents`) declare boundaries for the constraint-impact natural experiment ([constraint-impact/README](../constraint-impact/README.md)) — the same mechanism can declare an *adoption* boundary.

## 1.6 What the designs already committed to (unbuilt)

The value-per-cost Q1 design ([value-per-cost/03 §3.1](../value-per-cost/03-the-three-questions.md)) formalises `human_cost(U) = hours × rate` with the tool providing the hours proxy and the user providing rate + value, and the hard rule **"value not declared → ROI unknown"**. None of the value-declaration layer is implemented (no `unitsDelivered`, `valueTag`, or ROI ratio exists in source). This folder's proposal is the time-axis twin of that design and should ship against the same principles.

## 1.7 Summary table

| Ingredient of `FTE saved = Σ tasks × (baseline − actual) ÷ FTE-hours` | Status |
|---|---|
| `actual` — dev-minutes per task, incl. review/shepherding | **Shipped** (`active_duration_ms` + task clustering + turn-level repair signals) |
| `tasks` — completed-task count with success proxy | **Shipped**, calibration pending |
| `baseline` — time without AI | **Absent and unobservable by the tool** — must be declared or imported (see [03](03-improvement-options.md)) |
| `FTE-hours`, hourly rate | Config half-exists (`rate.hourly`); FTE-hours knob absent |
| Reporting vehicle with caveat discipline | **Shipped** (justification pack) |
| Principle framework (never fabricate the user-owned half) | **Designed** ([value-per-cost/](../value-per-cost/)) |
