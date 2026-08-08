# Efficiency hygiene — finding waste before someone else does

> Devs sometimes "waste" tokens on unnecessary things — and a justification
> report from a team that visibly self-audits is believed, while one that only
> ever finds value is advocacy.

This is the **clean-hands principle** that both
[ticket-attribution/](../ticket-attribution/) and
[constraint-impact/](../constraint-impact/) rely on: the credibility of every
"our usage is justified" number depends on the same tool demonstrably hunting
the opposite conclusion. This folder designs that hunt — a set of local,
deterministic waste detectors and the rules that keep them a developer's tool
rather than a surveillance feed. It is a single-document analysis; the
detectors are individually small and share one design contract.

## The one-paragraph conclusion

Waste has recognizable, machine-detectable shapes in data the store already
holds: cache churn (context rebuilt over and over instead of read back),
retry loops (turns burned on repeatedly failing tool calls), abandoned spend
(costly tasks that reached no outcome), context bloat (enormous input per
turn for little output), and tier mismatch (top-tier models on task classes
where the developer's own history shows parity). Each detector must be
deterministic and explainable, produce a card with an estimated waste figure,
the offending sessions, and **one remedy sentence** — and stay strictly
local: per-developer waste scores never sync. What is designed for sharing is
the **trend** ("self-audited waste down from 14% to 6% of spend"), which is
exactly the line a justification pack needs.

## The detectors

| Detector | Signal (all already stored) | Remedy it suggests |
|---|---|---|
| **Cache churn** | High cache-creation vs cache-read ratio per project/window — context paid for repeatedly but rarely read back (frequent session restarts, config edits invalidating the prefix) | Keep sessions alive; batch config changes |
| **Retry loop** | Dense runs of `tool_error_count` within a session; repeated failing attempts at the same operation | Stop and fix the environment; escalate model tier for the stuck step |
| **Abandoned spend** | Task clusters above a cost threshold ending `failed`/`unobservable` with no successor ([escalation chains](../constraint-impact/03-measurement-mechanics.md)) | Review what stalls tasks; smaller scopes |
| **Context bloat** | Sustained very high input-tokens-per-turn with low output-to-input ratio | Trim context; scoped reads instead of whole-file loads |
| **Tier mismatch** | Top-tier messages in task classes where the user's own parity data ([constraint-impact/02 §2.5](../constraint-impact/02-model-policy-impact.md)) shows the mid tier at equal outcomes | Downshift the default for that class |
| **Re-entry burn** | Cache-creation spikes on resume after throttle/window gaps | Schedule around limits; see [constraint-impact/01](../constraint-impact/01-what-constraints-cost.md) — this one is partly the org's cost, not the dev's |

`09-token-spending-analysis.md` ("where did my tokens go?") is the analytical
groundwork; these detectors are its recurring, actionable form.

## The design contract

1. **Deterministic and explainable.** No LLM in the detection path; every
   card carries its rule, its threshold, and links to the sessions behind it.
   A waste claim the developer can't verify breeds distrust of the tool that
   the justification features can't afford.
2. **Estimated waste in currency** (metered accounts) or tokens (plans),
   with the same estimate-vs-actual language rules as everywhere else.
3. **One remedy sentence per card.** A detector that only accuses is noise;
   the deliverable is the behavior change.
4. **Weekly digest, not real-time nagging** — a "top waste patterns" card in
   the dashboard and a `get_efficiency_hints` MCP tool; opt-out per detector.
5. **Strictly local; only the trend is shareable.** Per-dev waste scores are
   surveillance-shaped and never sync — the two-plane rule
   ([data-planes/](../data-planes/)) applies with no exceptions. The
   aggregate trend line (waste % of spend over time) is computed locally and
   included in the [justification pack](../ticket-attribution/05-justification-pack.md)
   only by the developer's choice, like everything else in it.
6. **Tuned to precision over recall.** A false accusation costs more than a
   missed pattern; thresholds start conservative and every card has a
   "not waste" dismissal that teaches the local config (a suppression list,
   like the negation tombstones in
   [ticket-attribution/02 §2.4](../ticket-attribution/02-local-data-model.md)).

## Relationship to existing analysis

- **[constraint-impact/](../constraint-impact/)** consumes this directly: its
  two-sided report ([02 §2.3](../constraint-impact/02-model-policy-impact.md))
  cites voluntary downshifting where parity holds — the tier-mismatch
  detector is how that behavior actually happens.
- **[ticket-attribution/05](../ticket-attribution/05-justification-pack.md)**
  includes the hygiene trend as the pack's credibility section.
- The **model-mix advisor** is split deliberately: parity *measurement* lives
  in constraint-impact (it needs the task-class engine); the *nudge* lives
  here (it needs the card/digest surface).
- [value-per-cost/04-efficiency-frontier.md](../value-per-cost/04-efficiency-frontier.md)
  is the theory of which efficiency questions are machine-ownable; this
  folder implements the machine-owned subset.
