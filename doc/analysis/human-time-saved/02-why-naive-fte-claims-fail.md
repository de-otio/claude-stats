# 02 — Why the naive "X% faster ≈ Y FTEs" claim is rejected

The absence of a time-saved metric in claude-stats is a position, not a gap. Before designing one, restate why the obvious versions fail — every improvement option in [03](03-improvement-options.md) is shaped by these constraints.

## 2.1 Self-reported time saved is anti-correlated with measured time saved

The METR RCT (July 2025, experienced OSS maintainers on their own repos) found tasks took **19% longer** with AI while the developers believed they were ~20% faster ([value-per-cost/01 §1.4](../value-per-cost/01-the-critique.md)). The gains devs *feel* are time-shifted into review and rework, not removed. Consequences:

- A survey field ("how much time did Claude save you this week?") produces a number management will multiply into FTEs, and it will be wrong in the flattering direction. Don't build it.
- **Declared baselines inherit the same bias in milder form**: "this used to take me 45 minutes" is a memory-based self-report. Any design using declared baselines must label the output as resting on them, and prefer imported ground truth (pre-adoption cycle times) where it exists.

## 2.2 Individual throughput does not compose into org capacity

Faros' ~10k-developer study ([value-per-cost/05 §5.2](../value-per-cost/05-prior-art-and-whitespace.md)): individual task throughput up, org-level DORA metrics flat, review time +91%, PR size +154%. Time saved at the individual keyboard partially reappears as time spent elsewhere in the org (review load, integration, rework). Consequences:

- Per-dev hours saved must **not** be presented as org FTE capacity. The honest per-dev claim is "hours redirected", and the org claim needs org-level evidence (cycle time per ticket across the whole flow, not per session).
- The measured `actual` term must include the shepherding/review tax — which claude-stats' `active_duration_ms`-per-task measure already does, and follow-up/repair turns make partially visible ([01 §1.1](01-current-support.md)).

## 2.3 The tool never sees the counterfactual

claude-stats only observes AI-assisted sessions. "Time without AI" is structurally outside its data. Anything the tool computes alone is either a *relative* comparison between AI configurations (constraint-impact's before/after) or a *presentation* of measured facts. The counterfactual must come from the user (declaration) or from external systems (Jira cycle times before adoption) — which is exactly the machine-owned/user-owned split the repo already committed to for value ([value-per-cost/03 §3.1](../value-per-cost/03-the-three-questions.md): "value not declared → ROI unknown").

## 2.4 Success ≠ correct ≠ valuable

The success detector measures *landed* (pushed commit, merged PR), not correct, not valuable ([cost-per-successful-task/04 §4.3](../cost-per-successful-task/04-limitations-and-privacy.md)). A time-saved figure multiplied over "successful tasks" inherits that: if AI output lands faster but with higher defect escape, the saving is overstated. Mitigations available in-repo: the revert/fixup signal (`cost-per-task/signals/mechanical.ts`), the calibration report against user labels, and the "no verification theatre" rule — below minimum calibration n, say **uncalibrated**, don't decorate.

## 2.5 The standing principles any design must satisfy

Distilled from [value-per-cost/](../value-per-cost/), [constraint-impact/](../constraint-impact/), and [cost-per-successful-task/](../cost-per-successful-task/):

1. **Machine-owned vs user-owned, never blurred.** The tool computes minutes, attempts, dollars; the user supplies baselines, rates, value. Reports state which is which.
2. **Refuse rather than fabricate.** Missing baseline → "time saved unknown", exactly as missing hourly rate already yields `devTimeCost: null` (`constraintImpact/beforeAfter.ts`).
3. **Every derived figure carries its caveats inline** (coverage %, confidence mix, calibration state, "resting on your declared baselines") — the justification pack's existing house style.
4. **The baseline is you** — comparisons are against the user's own history or declarations, never a cross-user benchmark.
5. **No single number.** The defensible artifact is a conjunctive statement (tasks delivered, measured dev-time, declared baseline, resulting estimate, defect-signal check), not a headline percentage ([value-per-cost/02 §2.4](../value-per-cost/02-defining-business-result.md)).
