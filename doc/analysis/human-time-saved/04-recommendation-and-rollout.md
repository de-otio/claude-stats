# 04 — Recommendation and rollout

## Recommendation

Build the join, not the guess: ship the **throughput framing** immediately (Option D — zero new claims, arms the human), then the **declared-baseline estimate** (Option A) as the core feature behind the same refuse-when-undeclared discipline the repo already uses for `rate.hourly`, and offer the **cycle-time import** (Option B) as the baseline upgrade for teams that need an org-credible number. Reframe constraint-impact boundaries to cover enablements (Option C) as a cheap hardening step. Never ship a survey, a default baseline table, or an uncaveated FTE headline ([03 §3.5](03-improvement-options.md)).

The resulting artifact a user can hand upward is a conjunctive statement, per [value-per-cost/02 §2.4](../value-per-cost/02-defining-business-result.md):

> "41 tasks landed this month at a median 12 dev-minutes each; against *our declared* baselines that is ≈ 58 hours redirected (≈ 0.41 FTE-equivalent at 140 h/month); token + plan cost €412 ≈ 1.0 dev-day at our configured rate; revert/fixup signal flat vs. the prior period; success detector uncalibrated (0 labels) — label a sample to firm this up."

Each clause is separately defensible, and the weakest one (the baseline) is explicitly attributed to its owner.

## Phased rollout (each phase independently useful)

Phasing style follows [account-attribution/06](../account-attribution/06-recommendation-and-rollout.md): lowest effort first, no phase depends on a later one.

### Phase 1 — Throughput block (Option D) · small

- `answerThroughput` insight (tasks completed + median/p90 dev-minutes per task class) in `packages/core/src/insight.ts`; render in the justification pack headline area and the Insights layer of the dashboard.
- Fix the stale `generate_justification_pack` MCP description while touching the pack ([01 §1.4](01-current-support.md), incidental finding).
- No new config, no new claims. Ships alone.

### Phase 2 — Declared baselines + `get_time_saved` (Option A) · medium

- Config: `baselines.perTaskClass.*`, `baselines.source/declaredAt`, `fte.hoursPerMonth`; Settings-tab surface next to `rate.hourly`.
- Pure module `packages/core/src/timeSaved/` (mirror `constraintImpact/beforeAfter.ts` in shape: inputs in, report object out, `null`s where config is absent); CLI glue; MCP tool `get_time_saved`; pack section "Hours redirected (estimate)" with the mandatory caveat block; `summary.csv` columns (`hoursRedirected`, `fteEquivalent`, `baselineSource`, `baselineCoverageClasses`).
- Hard rules from [03 §3.2](03-improvement-options.md): refusal on missing baselines, negative deltas reported, "hours redirected" vocabulary, per-dev ≠ org capacity.
- i18n: all new user-facing strings across every locale in the same change (project rule).

### Phase 3 — Cycle-time import (Option B) · medium-large

- `claude-stats import cycle-times <csv>` + `ticket_cycle_times` table (local only, org plane untouched); baseline-source upgrade in the Phase-2 report ("imported cycle times, window, n"); optional before/after-adoption cycle-time comparison reusing constraint-impact guardrails (min n, same-type comparison, confound listing).
- Prerequisite reality check: only valuable to users whose tracker history predates adoption — position it as such in user docs.

### Phase 4 — Business-case tie-in (license-advisor join) · small, after 2

- Where both sides exist, let `size_seats` / license-advisor output juxtapose projected seat cost against Phase-2 hours-redirected — still two labelled columns, never a computed "ROI: 4.2×" headline. This is the [license-advisor/](../license-advisor/) consumer noted in the README.

## Open questions

1. **Task-class granularity of baselines** — the rules-based archetypes (`research_qa`, `greenfield`, `mechanical_edit`, `debugging`, `multi_file_refactor`, `other`) may be too coarse for credible baselines; declaring per-ticket-type (Bug/Story) baselines might fit managers' mental models better. Decide before Phase 2 config schema freezes.
2. **Partial-task attribution** — when a task spans human-only work outside Claude sessions, `actual_minutes` undercounts the human side and *overstates* the saving. Consider a configurable uplift factor (declared, printed) or restrict claims to task classes that are session-complete.
3. **Calibration gate** — should the FTE line require a minimum number of user outcome labels (reusing `buildCalibrationReport`) before rendering, the way constraint-impact gates on min n? Leaning yes for the pack, no for the local dashboard.
4. **Team plane** — Phase 2 is per-machine. Whether hours-redirected aggregates may cross to the org plane (and in what granularity) needs a [data-planes/](../data-planes/) review before any sync.
