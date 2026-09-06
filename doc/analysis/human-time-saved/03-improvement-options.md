# 03 — Design options for supporting time-saved / FTE honestly

Time saved is `Σ over completed tasks of (baseline_minutes − actual_minutes)`, and FTE saved is that sum divided by a configured FTE-hours-per-period. claude-stats owns `actual_minutes` and the task count ([01](01-current-support.md)); the options below differ only in **where the baseline comes from** and are ordered from zero-config to org-grade. They compose: D is the floor, A is the core, B upgrades A's baselines, C is a machine-owned complement.

## 3.1 Option D — Throughput framing, no counterfactual (zero config)

Publish the two machine-owned halves and let the reader supply the counterfactual mentally:

> "This month: **41 tasks completed** (success proxy, calibration: uncalibrated) across 5 task classes, at a **median 12 dev-minutes of shepherding each** (p90: 38 min). Token cost €312 ≈ 0.8 dev-days at your configured rate."

- **Data**: all shipped — `costPerSuccessfulTask` counts, per-task `activeMs` from recap clustering, `formatDevTime`.
- **Where**: a new "Throughput" block in the justification pack headline area (`packages/core/src/pack.ts`) and an `answerThroughput` insight card alongside `answerBought` (`packages/core/src/insight.ts`).
- **Honesty**: makes no saving claim at all, so it needs no new caveats beyond the existing confidence/coverage ones. A manager who knows what a task used to cost in dev-time can do the subtraction — the tool doesn't do it for them.
- **Limit**: doesn't answer the FTE question; it arms the human who will.

## 3.2 Option A — Declared-baseline counterfactual (the core proposal)

The user (or team lead) declares, per task class, what that class of work cost in dev-time before AI:

```jsonc
// config
"baselines": {
  "declaredAt": "2026-08-12",
  "source": "team retro estimate",          // free text, printed verbatim in reports
  "perTaskClass": {
    "mechanical_edit":    { "minutes": 45 },
    "debugging":          { "minutes": 90 },
    "greenfield":         { "minutes": 240 },
    "research_qa":        { "minutes": 30 }
  }
},
"fte": { "hoursPerMonth": 140 }             // billable/productive hours, user-owned
```

Computation (pure, `packages/core/`, mirroring `constraintImpact/beforeAfter.ts`):

```
per task class c with declared baseline:
  hours_redirected(c) = n_success(c) × (baseline_minutes(c) − median_actual_minutes(c)) / 60
total = Σ c                       // classes without a declared baseline contribute nothing and are listed as "no baseline declared"
fteEquivalent = total / fte.hoursPerMonth   // null when fte.hoursPerMonth absent
```

Rules, inherited from [02 §2.5](02-why-naive-fte-claims-fail.md):

1. `actual_minutes` is the full shepherding time (active minutes across the task's sessions, so review/repair turns are inside the measurement, not outside it).
2. No declared baseline → that class reports **"time saved unknown"**; the total is labelled "over N of M task classes".
3. Negative deltas are reported, not clamped — if debugging now takes *longer* than the declared baseline, that is the METR result showing up in your own data, and it is the most valuable line in the report.
4. Output vocabulary: per-dev results say **"hours redirected"**, never "org capacity freed" (Faros, [02 §2.2](02-why-naive-fte-claims-fail.md)). The FTE line is explicitly an arithmetic equivalence: "≈ 0.4 FTE-equivalent *at your declared baselines and configured hours*".
5. The caveat block always prints: baseline source + declaration date, success-detector calibration state, coverage of task-class classification, and the revert/fixup defect signal for the period.

- **Where**: new pure module (e.g. `packages/core/src/timeSaved/`), a `time-saved` section in the justification pack, an MCP tool (`get_time_saved`), and a config surface in the Settings tab next to `rate.hourly`.
- **Why this is defensible**: it is the exact structure the repo already ratified for value — machine-owned measurement joined to a user-owned declaration, with refusal on missing declarations ([value-per-cost/03 §3.1](../value-per-cost/03-the-three-questions.md)). The tool never claims the baseline is true; it computes what follows *if* it is, and says so.
- **Limit**: declared baselines are memory-based self-reports and skew flattering ([02 §2.1](02-why-naive-fte-claims-fail.md)). Hence Option B.

## 3.3 Option B — Imported ground truth: pre-adoption cycle times (org-grade)

The ticket key is already the designed join key to Jira-side data ([ticket-attribution/04 §4.1](../ticket-attribution/04-reporting-and-roi.md)), and claude-stats never calls Jira. Keep that boundary: the user exports cycle-time data (ticket key, type, created/resolved timestamps or cycle-time days) to CSV and imports it locally.

- **Baseline mode**: median cycle time per ticket type from the pre-adoption window replaces (or grades) the declared baseline in Option A — "baseline source: imported cycle times, 2025-01→2025-12, n=214" prints instead of "team retro estimate". This directly mitigates the self-report bias.
- **Outcome mode**: compare cycle times per ticket type across a declared **adoption boundary** (a `config.policyEvents` entry, reusing constraint-impact's natural-experiment design and its guardrails — same-task-class comparison, minimum n, seasonality caveats per [constraint-impact/03](../constraint-impact/03-measurement-mechanics.md)). This is the only path in this folder to an *org-credible* number, because cycle time spans the whole flow (review, integration) and therefore answers the Faros objection.
- **Where**: a `claude-stats import cycle-times <csv>` command + a `ticket_cycle_times` table; the join lands in the pack's time-saved section as the baseline-source upgrade.
- **Limits**: needs pre-AI history on the Jira side; ticket-type mix shifts across years; confounds (team size, process changes) must be listed in the methodology block, not adjusted away silently.

## 3.4 Option C — Relative natural experiment (machine-owned, no external data)

Constraint-impact already measures `avgActiveMinutesBefore/After` per task class across a policy boundary, priced at the hourly rate — currently always framed as a *cost* (`constraintImpact/beforeAfter.ts:196-215`). Generalise the framing: a boundary can also be an **enablement** (plan upgrade, agents/workflows turned on, new model). Then `devTimeDeltaMinutes < 0` is machine-owned evidence of dev-time *saved by the change*, per task class, at after-volume.

- **Effort**: small — the computation is shipped; this is report-language and a boundary-type field (`policyEvents[].direction: "restriction" | "enablement"`).
- **Honesty**: strong — no user-declared numbers at all.
- **Limit**: measures AI-config-A vs AI-config-B, never AI vs no-AI. It cannot produce the FTE headline; it hardens the story around it.

## 3.5 What not to build

- A "how much time did Claude save you?" survey prompt or feelings-based field ([02 §2.1](02-why-naive-fte-claims-fail.md)).
- A default/industry baseline table shipped with the tool ("a bugfix takes 2h") — that is a cross-user benchmark, violating "the baseline is you".
- An FTE figure anywhere without its caveat block, or one derived from wall-clock (`last_timestamp − first_timestamp`) instead of `active_duration_ms`.
- Automatic Jira API integration — the import stays a user-initiated local CSV, preserving the privacy posture ([05-privacy-security.md](../05-privacy-security.md)) and the "tool never fetches value data" boundary.
