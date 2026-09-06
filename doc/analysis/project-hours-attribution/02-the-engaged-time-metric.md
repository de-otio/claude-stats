# 02 — The engaged-time metric

## 2.1 Definition

**Engaged time** for a set of sessions over a window is the union of their
message timestamps with inter-message gaps capped at *N*:

```
engaged(T, N) = Σ min(tᵢ₊₁ − tᵢ, N)   over sorted, deduplicated T
```

where `T` is every `messages.timestamp` from every session in scope, merged
into **one** timeline before sorting. Merging before summing is the whole
point: it is what makes parallel sessions and subagents collapse into the
single wall-clock minute they actually occupied.

Two properties follow directly, and both are testable:

- **Bounded by wall clock.** `engaged(T, N) ≤ max(T) − min(T)`, always. This
  is the invariant that [01](01-why-the-shipped-fields-cannot-answer-it.md)
  showed the shipped field violating on 4.4 % of sessions.
- **Bounded by the day.** Bucketed into local calendar days, no day can exceed
  24 h. Measured over a real machine-month the maximum was 12.5 h.

Day bucketing is by the **local timezone**, configurable, defaulting to the
system zone — day boundaries must match whatever the user reconciles against.

## 2.2 Cap the gap, do not drop it

The parser currently *drops* gaps at or above the threshold — a gap of 30 min
or more contributes zero
([`parser/session.ts:469`](../../../packages/core/src/parser/session.ts#L469)).
This produces a discontinuity at the boundary: a 29-minute break counts in full
(29 min of "engaged" time for a coffee break), while a 31-minute break counts
nothing. Two nearly identical days can differ by an hour on the strength of
which side of the line a few breaks landed.

Capping is the better rule. Every gap contributes `min(gap, N)`, so the
function is monotone and continuous in the gap length, and the semantic is
clean: *engagement is assumed to continue for at most N minutes after the last
observed message*. A long idle contributes exactly N — the tail of the burst —
rather than either its full length or nothing.

**The cap is a modelling choice, and the metric is sensitive to it.** On one
project group over a month: 60.1 h at a 15-minute cap, 71.6 h at 30 minutes —
a **19 % swing**. That sensitivity is not a defect to be hidden; it is a
parameter to be disclosed. Hence two rules:

1. `capMinutes` is echoed in every response. A figure without its cap is
   meaningless.
2. Pick one cap and keep it fixed for any series that will be compared over
   time. The tool cannot detect a caller silently changing the cap between
   calls, so it defaults to **15 minutes** and echoes the value; consistency
   across a series is the caller's responsibility.

15 minutes is the default because a burst of agent work has sub-minute
inter-message gaps; the cap only ever governs the *edges* of bursts, and a
15-minute tail is generous for "was still at the keyboard".

## 2.3 Contested intervals — where the money-side analogy breaks

[project-fee-attribution/](../project-fee-attribution/) can attribute a fee
pool to projects by weight, because every message belongs to exactly one
project. It is tempting to conclude that time needs no such split: sessions
carry a `project_path`, so just union each project separately.

**Measured, that is wrong.** Over the same machine-month:

| Basis | August total |
|---|---|
| Union over all projects (the day's true engaged time) | 272.1 h |
| Sum of per-project unions | 540.5 h |
| Over-attribution | **1.99×** |

The cause is structural, not a bug. A developer alternating between two
projects — a message in project A at 10:00, project B at 10:03, A again at
10:06 — produces a 3-minute gap inside *each* project's timeline, and each
project claims it. The minute is real and singular; the attribution is double.
Per-project figures that sum to twice the day are unusable for a budget split,
which is exactly the use case.

The tool therefore exposes an explicit `split` rule:

| Value | Behaviour | Use when |
|---|---|---|
| `proportional` (default) | Each contested interval is divided across the groups active in it, weighted by their message counts in that interval. Per-group hours **reconcile to the day union** | Splitting a day across clients or cost centres |
| `duplicate` | Each group gets the full interval; sums exceed the day total | "How long was I in project X at all?", answered per project independently |
| `exclusive` | Each interval is assigned wholly to the group with the most messages in it; ties broken by the earliest message | Coarse days where a single owner per interval is the honest reading |

Whichever is chosen, the response reports `dayUnionHours` alongside the
per-group figures and an `overlapHours` field, so a caller can always see how
much of the day was contested rather than inferring it from a mismatch. Under
`duplicate` the reconciliation gap is stated, never silent.

## 2.4 Grouping: path prefixes, declared by the user

`sessions.project_path` is the only trustworthy label in the data — it is the
working directory, recorded per session, never inferred. Repo URL is null for a
meaningful share of sessions, and account attribution is best-effort by
construction (telemetry retains only failed events; the fallback stamps the
currently logged-in account), which is why
[project-fee-attribution/02](../project-fee-attribution/02-data-model-and-attribution.md)
insists on a visible `(unknown)` bucket. This tool inherits that: if a caller
slices by account, the unknown bucket is rendered, not hidden.

Grouping is by **user-declared path prefix**, because the unit a consultant
bills is rarely one repo. Config shape:

```jsonc
// ~/.claude-stats/config.json
{
  "projectGroups": [
    { "label": "client-a",  "prefixes": ["~/repos/client-a/"] },
    { "label": "internal",  "prefixes": ["~/repos/acme-internal/", "~/repos/tooling/"] }
  ]
}
```

Rules: prefixes are matched longest-first so a nested prefix can carve a
subtree out of its parent; anything unmatched lands in a group literally
labelled `(ungrouped)` which is always rendered; and with no config the tool
falls back to one group per `project_path`, so it is useful before it is
configured.

Prefix grouping — rather than tags or ticket keys — is deliberate. It requires
no per-session action, so it cannot silently degrade when the user forgets to
tag, and it is retroactive: declaring a group today correctly attributes every
session ever recorded under that path.

## 2.5 What the number is, and what it is not

Engaged time is a **floor on human time**, and the tool must present it as one.

**Not captured:** meetings, browser work (issue trackers, code review, wikis),
reading, whiteboarding, pairing — any working time with no Claude session
running in that project. On the machine measured here, engaged time ran on the
order of a third to a half of plausible booked time.

**Over-captured:** autonomous activity — scheduled runs, background agents,
long unattended tool loops — accrues engaged time with nobody at the keyboard.
The mitigation is to report `promptCount` (from `messages.is_turn_start`)
beside the hours in every bucket: a bucket with hours and near-zero prompts was
mostly autonomous, and the caller can see that without being told.

**Therefore, three refusals** (see [03 §3.4](03-mcp-tool-design.md) for how they
are enforced):

1. **No conversion to booked or billable hours.** The tool has no rate, no
   calendar, and no timesheet. It emits engaged hours; the human does the
   reconciliation.
2. **No time-saved, no FTE, no productivity ratio.** This is settled in
   [human-time-saved/](../human-time-saved/) — the machine computes minutes,
   the user supplies baselines, and a counterfactual is not derivable from this
   data at any confidence. Nothing in this analysis reopens it.
3. **No cross-user comparison.** The baseline is the user's own history. A
   floor metric with unmeasured coverage cannot rank people, and attempting it
   would invert every caveat above into a weapon.

What it *is* good for is narrower and genuinely useful: a daily burn-down
signal, corroborating evidence beside a timesheet the human still writes, and
the project split for a day that touched several — which is the question the
shipped fields cannot answer at all.
