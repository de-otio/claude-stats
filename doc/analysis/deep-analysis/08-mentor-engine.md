# 08 — The Mentor Engine

Insights are worthless if they're noise. This section covers *delivery*: when
the mentor speaks, how it phrases things, where it surfaces, and how it learns
whether its advice actually helped. A coaching tool's hardest problem is not
*computing* the insight — it's earning the right to give it.

## 8.1 Cadence — when the mentor speaks

Different insights want different rhythms:

| Mode | Trigger | Content | Surface |
|---|---|---|---|
| **Just-in-time nudge** | session-end hook | one high-confidence, in-context flag | terminal line / notification |
| **Daily reflection** | end of day | rhythm, cost, top-1 coaching point | extends [`../daily-recap/`](../daily-recap/) |
| **Weekly review** | weekly | trends, deltas vs baseline, 2–3 themes | dashboard "Mentor" tab |
| **On-demand** | user asks (MCP/CLI) | answer + evidence | wherever asked |
| **Milestone** | changepoint / threshold | "something shifted" alert | notification |

**Principle: at most one unsolicited point per surface.** A nudge that lists
ten things is ignored. Pick the single highest-value, highest-confidence
observation for the moment; keep the rest for the weekly review or on-demand
queries.

## 8.2 The session-end hook (the killer integration)

Claude Code's hook system (the owner already uses hooks heavily) makes a
`SessionEnd` mentor nudge natural and powerful — it's the moment behaviour is
freshest and change is cheapest. Flow:

```
SessionEnd hook → claude-stats analyses the just-closed session (T0/T1, local)
               → if one finding clears the confidence+value bar, emit one line
               → else stay silent (silence is the default, not the exception)
```

Example single-line nudges:

- *"3 large edits this session were auto-accepted on `main` — worth a glance
  before pushing."*
- *"`api.ts` hit 7 revisions; pinning the goal up front usually settles it
  faster."*
- *"Declared done with no test run — your call, just flagging."*

The bar to interrupt must be high. **Silence is success**, not failure.

## 8.3 Tone — observational, not parental

The difference between a mentor users keep and one they mute:

- **Evidence-linked.** Every claim cites the sessions/counts behind it; clicking
  shows the trace. No unfalsifiable vibes.
- **Rate & context, not scolding.** "12% of edits, twice on `main`" — let the
  user judge.
- **Offer, don't command.** "worth a glance", "usually settles faster", "your
  call" — never "you should always".
- **Your standards, not mine.** Lead with alignment to the user's *own* declared
  defaults ([05](05-metacognition.md) §5.4) over generic best practice.
- **Celebrate, not only correct.** Surface improvements too — "rework down 30%
  this week" builds the trust that lets a hard message land later.

## 8.4 Surfaces

1. **Dashboard "Mentor" tab.** The weekly review home: guardrail index,
   productivity score, deltas vs baseline, themes, drill-downs. Builds on the
   existing webview.
2. **MCP tool — `ask_mentor`.** Lets *you, in any Claude session,* ask "how am I
   doing on verification lately?" and get a grounded, data-backed answer. This
   is the most natural fit for claude-stats' existing MCP surface and turns the
   mentor into a conversational coach.
3. **CLI — `claude-stats mentor`.** Terminal summary for non-VS-Code users.
4. **Session-end hook.** §8.2.
5. **Notifications.** Reserved for milestones/changepoints only — rare by design.

## 8.5 The feedback loop — does the advice work?

A mentor that never checks whether its advice helped is just opinion. Close the
loop:

- **Advice ledger.** Record each suggestion, when given, and the metric it
  targeted.
- **Did-it-move?** After a suggestion, watch the target metric. *"Two weeks ago
  I flagged auto-accept on `main`; it's dropped from 31% to 9% — nice."*
- **Suppress what doesn't land.** If a nudge is repeatedly shown and ignored
  with no metric movement, *stop showing it* (or reframe) rather than nagging.
- **User feedback.** A one-tap "useful / not useful / mute this" on every nudge,
  feeding suppression. Mute must be honoured permanently per-insight.

This makes the mentor *adaptive* — it learns which advice you act on and which
you've consciously rejected, and respects the latter.

## 8.6 Calibration & anti-theatre guardrails

The owner's design default #16 ("no verification theatre") applies to the mentor
*itself*. Self-imposed rules:

- **No uncalibrated scores.** A "productivity score" ships only with a defined,
  inspectable formula and a stable baseline — never a black-box 0–100.
- **Confidence is explicit.** Proxy-based findings (most of [03](03-risk-and-dangerous-use.md)/[04](04-productivity-coaching.md))
  are labelled as inferences with their tier; the mentor never overstates.
- **Falsifiable or silent.** If an insight can't be tied to evidence the user
  can inspect and dispute, it doesn't ship.
- **No diff-paraphrase "insights".** Restating what you did is not coaching.
- **Tune for precision over recall on risk.** A false "you're being reckless"
  costs trust faster than a missed flag. Start conservative; widen as the user
  confirms findings are useful.

## 8.7 Configuration & consent

- **Tier toggle** (per [01](01-tiered-data-model.md)) is the master control:
  T0-only, +T1 local content, +T2 egress — each with a plain-language
  explanation and an egress log.
- **Per-mentor opt-out.** Disable risk coaching, productivity coaching,
  metacognition, etc. independently.
- **Cadence control.** Choose which surfaces are active (e.g. weekly only, no
  session-end nudges).
- **Goal setting.** Optionally declare goals ([07](07-trend-benchmarking.md))
  so the mentor coaches toward what *you* care about, not a generic ideal.

## 8.8 Minimum lovable mentor (if extracting a first slice)

This catalog is deliberately broad. If a later spec wants the smallest version
that's genuinely useful, the highest value-to-effort slice is:

1. **T0 risk:** unread-diff acceptance + auto-accept exposure + direct-to-`main`
   + dangerous-command detector (the last is T1 but cheap regex). *Mostly
   already-collected data.*
2. **T0 productivity:** session-quality score (coarse), model-fit savings,
   token-per-commit, rework via file-history churn.
3. **Self-benchmarking:** deltas vs 30-day baseline + changepoint alerts.
4. **Delivery:** weekly dashboard tab + `ask_mentor` MCP tool + one optional
   session-end nudge.

That's a credible "wise mentor" on almost-entirely-local, mostly-`T0` data —
shippable without the harder semantic tiers, and a foundation the T1/T2 insights
extend.
