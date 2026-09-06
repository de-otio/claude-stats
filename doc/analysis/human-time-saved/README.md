# Human time saved — can claude-stats justify token spend in FTEs?

> **Status: not pursued (2026-08-12).** The counter-arguments in [02](02-why-naive-fte-claims-fail.md) were judged decisive: even the honest declared-baseline join rests on a self-reported counterfactual, and the resulting number invites exactly the misuse it caveats against. The folder is kept as the record of *why*, so the idea isn't re-litigated from scratch. The broader goal — making business value visible to management as cost pressure rises — is taken up in [business-value-visibility/](../business-value-visibility/) instead.

## The one-paragraph conclusion

claude-stats does **not** currently compute "human time saved" or FTE savings anywhere — not in shipped code, not as a designed-but-unbuilt feature. That is deliberate: the design corpus explicitly rejects the naive "AI made us X% faster ≈ Y FTEs" claim as self-report-biased and empirically discredited (METR 2025 found devs *slowed down* 19% while believing they were ~20% faster; Faros found individual throughput up but org-level delivery flat). What the tool does own, and owns well, is every ingredient **except the counterfactual**: measured human time *spent* per task (`active_duration_ms` → dev-minutes, including the shepherding/review tax), tasks completed with a conservative success proxy, cost per work item, and an hourly-rate config. Time saved is `counterfactual − measured`, and the counterfactual (how long the work would have taken without AI) is unobservable by a tool that only ever sees AI-assisted sessions. The honest path to an FTE number is therefore a **join**: claude-stats supplies the measured half exactly; the user declares or imports the baseline half (declared per-task-class baselines, or Jira-side cycle times from before adoption); and the tool refuses to emit a number when the baseline is missing — "time saved unknown", never a fabricated figure. This folder inventories what exists, explains why the naive metric is rejected, and designs the join.

## Relationship to existing analysis

- [value-per-cost/](../value-per-cost/) is the parent framing: value = user-owned, cost = machine-owned, ROI is a join the tool must never fake. This folder applies the identical split to the *time* axis: baseline = user-owned, measured dev-minutes = machine-owned, time-saved is the join.
- [constraint-impact/](../constraint-impact/) built the only human-time-priced machinery in the repo (dev-minutes per task class across a policy boundary, priced at the configured hourly rate — as a *cost*). Its before/after natural-experiment design is the methodological template here, with the direction reversed.
- [cost-per-successful-task/](../cost-per-successful-task/) supplies the task denominator and the success proxy; every time-saved estimate inherits that detector's calibration state.
- [ticket-attribution/](../ticket-attribution/) supplies the join key (ticket) to external ground truth (Jira cycle time) — the only path to an org-credible baseline.
- [license-advisor/](../license-advisor/) and `size_seats` are the consumer: seat-cost projections become a business case only when a defensible benefit side exists.

## Documents

| # | File | Purpose |
|---|------|---------|
| 01 | [01-current-support.md](01-current-support.md) | Inventory: what shipped code and existing designs already provide, with file refs |
| 02 | [02-why-naive-fte-claims-fail.md](02-why-naive-fte-claims-fail.md) | The evidence against self-reported/naive time-saved metrics, and the repo's own principles |
| 03 | [03-improvement-options.md](03-improvement-options.md) | Four designs for supporting time-saved/FTE honestly, from zero-config to org-grade |
| 04 | [04-recommendation-and-rollout.md](04-recommendation-and-rollout.md) | What to build, in what order, each phase independently useful |
