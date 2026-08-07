# 03 — Measurement mechanics: what exists, what's missing, surfaces

## 3.1 Policy events are declared, never inferred

A `policyEvents` block in `Config` (`packages/cli/src/config.ts:14`):

```jsonc
"policyEvents": [
  { "date": "2026-05-01", "kind": "model-removal", "detail": "opus",
    "scope": "org" },
  { "date": "2026-03-15", "kind": "budget-cap",    "detail": "usd:1500/mo" }
]
```

Reports annotate timelines and split periods at these markers. Inferring a
policy from the data ("the model mix shifted, so there must have been a
mandate") is banned: it would let the tool manufacture boundaries that
maximize apparent damage — exactly the dishonesty the report must be
structurally incapable of. For team-wide consistency the events belong in the
same org-distributable settings channel as the ticket allowlist
([ticket-attribution/03 §3.5](../ticket-attribution/03-org-plane-and-backend.md)).

## 3.2 What the store already captures vs the gaps

**Already there** (per the schema in `packages/cli/src/store/index.ts`):

- `messages.model` per assistant response — mixed-tier history is fully
  analyzable; model *version* strings double as confound annotations.
- Task outcomes and per-task cost: `get_cost_per_task`
  (`packages/cli/src/mcp/index.ts:480`,
  `packages/cli/src/cost-per-task/index.ts`), four-state outcomes with git
  corroboration.
- `sessions.active_duration_ms`, `median_response_time_ms` — the dev-time
  channel.
- Plan-shaped constraint traces: `throttle_events`, `is_throttled`,
  `usage_windows`.
- Cache token columns — the post-throttle context-rebuild spike is computable
  today.
- User outcome labels: CLI `task-outcome` + the corrections store
  (`packages/cli/src/recap/corrections.ts`) sharpen the success/failure data
  the whole analysis rests on.

**Gap 1 — stable task classes (the main new work).** The recap's topic
segments/clusters (`packages/cli/src/recap/segment.ts:211`,
`recap/cluster.ts`) are built per window and have no identity across a
months-long policy boundary. The comparison needs a small **deterministic
classifier** over signals already stored per message/session — tool-usage
profile (edit-heavy vs read-heavy vs bash-heavy), file-touch breadth, session
shape (turn count, subagent use), prompt-shape features — yielding a fixed
vocabulary on the order of: `debug`, `refactor-multi-file`, `greenfield`,
`review`, `config-chore`, `explore/learn`. Requirements: deterministic (same
session always classifies the same), version-stamped (a classifier change is
itself a timeline annotation), and coarse (fewer, fuller classes beat many
sparse ones — small-n classes get suppressed anyway, [02 §2.6](02-model-policy-impact.md)).

**Gap 2 — metered throttling.** Bedrock quota pressure (TPM/RPM 429s) is not
parsed today; plan-throttle detection doesn't cover it. Parser work: recognize
429/`ThrottlingException`-shaped API errors in transcripts and count them per
message/session, feeding the same wait/re-entry metrics the plan path gets
from `throttle_events`. Together with the metered-vs-plan account mode and
Bedrock model-id normalization
([ticket-attribution/README §Who this is acute for](../ticket-attribution/README.md)),
this completes the metered constraint vocabulary.

**Gap 3 — escalation chains.** "Failed on the mid tier, redone later" links
across sessions. Buildable on the cluster-merge machinery
(`recap/cluster.ts`): two clusters, same class and file-set, first ending
`failed`/`unobservable`, second `success` within a bounded gap. Strengthens
the rework number; not load-bearing for v1.

**Gap 4 — the hourly rate.** One optional config field (see `AccountFee`
precedent) powering the salary denominator. Absent, reports state dev-time in
minutes/hours and stop — never a dollar figure from an invented rate.

**Gap 5 — outcome calibration.** Every metric above inherits its validity
from the four-state outcome detection, and its accuracy is currently
unmeasured — the report's largest unacknowledged vulnerability. The
mitigation is cheap because the ground truth already accumulates: manual
outcome labels exist (`task-outcome` CLI, the corrections store). Compute
agreement between mechanical detection and manual labels over the labeled
subset, surface it wherever outcomes are load-bearing ("outcome detection
agrees with manual labels 91% of the time, n=140"), and add a light labeling
nudge (a few unlabeled high-cost tasks per week in the dashboard) so the
calibration sample keeps growing. Below a minimum n, reports say
"uncalibrated" rather than implying precision.

## 3.3 Report surfaces

- **MCP**: `get_constraint_impact` — inputs: policy event (or explicit
  boundary), period, project/account filters; output: per-class before/after
  metric table with n, distribution summaries, timeline annotations, the
  net-effect statement when a rate is configured, and the tiered-access
  proposal rows. A `mode: "prospective"` variant computes current per-class
  parity with no boundary ([02 §2.5](02-model-policy-impact.md)).
- **CLI/report**: `report --constraint-impact [--since-event <n>]` rendering
  the same table; exports CSV for the slide the developer will inevitably
  have to make.
- **Dashboard**: a timeline view (spend + failure rate + dev-time per task,
  policy events as vertical markers) — the before/after picture managers
  actually absorb.
- **Team pooling without a backend**: per-dev n per task class is often too
  small; a local merge command combining several devs' machine-readable
  exports into one team report fixes that with zero infrastructure —
  individual attribution dissolves into team totals unless each contributor
  opts into per-dev rows. This is the same mechanism the
  [justification pack](../ticket-attribution/05-justification-pack.md) uses
  for team packs.
- **Org plane**: per-class aggregate deltas fit the existing narrow-aggregate
  pattern (numeric, no free text) and would follow the
  [ticket-attribution/03](../ticket-attribution/03-org-plane-and-backend.md)
  playbook — new narrow shape, consent-gated. But v1 should stay **local +
  export**: the report's natural consumer is a human conversation with a
  manager, and a hand-carried, reconcilable document is enough until a team
  asks for automation.

## 3.4 Sequencing

| Phase | Scope | Depends on |
|---|---|---|
| 1 | Policy-event config + timeline annotations in existing reports | nothing |
| 2 | Task-class classifier (deterministic, version-stamped) | nothing — also benefits `get_cost_per_task` |
| 3 | Before/after engine + `get_constraint_impact` + CLI/CSV | 1, 2 |
| 4 | Metered throttling parse (Bedrock 429s) + wait/re-entry metrics | metered account mode |
| 5 | Escalation chains; dashboard timeline; prospective mode | 3 |
| — | [Pricing-model comparison](04-pricing-model-comparison.md) — independent track | only ticket-attribution phase 0 (metered mode) |

Phases 1–3 already produce the two-sided model-policy report for the org
scenario that motivated this folder; 4 extends the same vocabulary to quota
pressure; 5 is sharpening. The pricing-model comparison runs on its own
track and can ship first — it is the fastest path to a constructive
conversation with the org.
