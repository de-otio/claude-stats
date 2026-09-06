# Project hours attribution — engaged hours per project per day, as an MCP tool

> Can claude-stats answer "how many hours did I work on project X today?" —
> well enough to drive a consulting budget burn-down?

## The one-paragraph conclusion

Yes, but not from any field that ships today. The right metric — a
*gap-capped union of message timestamps*, bucketed by local calendar day and
grouped by project — is already implemented inside the parser
([`core/src/parser/session.ts:462-472`](../../../packages/core/src/parser/session.ts#L462-L472)),
but it is computed at the wrong grain (per session) and then corrupted by an
accumulating upsert
([`cli/src/store/index.ts:1109`](../../../packages/cli/src/store/index.ts#L1109)),
so it cannot be summed. Measured over one machine-month, naively summing
`sessions.active_duration_ms` per day yields **719.9 h in a 31-day month —
2.6× the true engaged time, with 11 of 31 days exceeding the 24-hour physical
ceiling and one day claiming 144 h**. Recomputing the same union at query time
from `messages.timestamp` gives 272.1 h, never exceeds 12.5 h on any day, and
costs one indexed scan. The recommendation is therefore a new read-only MCP
tool, **`get_project_hours`**, that computes the union at query time, groups
projects by user-declared path prefixes, and — this is the part the money-side
sibling does not need — resolves *contested intervals*, because a developer
interleaving two projects inside one gap window is genuinely in both, and
naive per-project unions over-attribute by **1.99×**. The tool reports engaged
hours only. It never converts them into time saved, FTEs, or a billable
figure; the measured number is a **floor on human time**, and the doc says so
in the response payload, not just in the docs.

## The core design choices (decide these first)

| # | Choice | Recommendation | Where argued |
|---|--------|----------------|--------------|
| 1 | Time basis | Gap-capped union of `messages.timestamp`, computed at query time. Not wall clock, not summed `active_duration_ms` | [01 §1.2](01-why-the-shipped-fields-cannot-answer-it.md), [02 §2.1](02-the-engaged-time-metric.md) |
| 2 | Fix or replace `active_duration_ms`? | **Replace at the call site, don't redefine the field.** Its 30-min semantic is documented and shipped; fix the upsert bug separately | [01 §1.4](01-why-the-shipped-fields-cannot-answer-it.md), [04 §4.1](04-implementation-plan.md) |
| 3 | Gap treatment | **Cap** the gap, don't **drop** it. Dropping creates a cliff where a 29-min break counts fully and a 31-min break counts zero | [02 §2.2](02-the-engaged-time-metric.md) |
| 4 | Cap value | 15 min default, always echoed in the response; the metric is threshold-sensitive (+19 % at 30 min) | [02 §2.2](02-the-engaged-time-metric.md) |
| 5 | Project → group mapping | User-declared path prefixes in config. `project_path` is the only trustworthy label; account grain is best-effort and inherits the `(unknown)` bucket | [02 §2.4](02-the-engaged-time-metric.md) |
| 6 | Contested intervals | `split: "proportional"` by default, so per-project hours reconcile to the day total; `"duplicate"` and `"exclusive"` available, always disclosed | [02 §2.3](02-the-engaged-time-metric.md) |
| 7 | What the number means | Engaged time = a **floor** on human time. Refuse to extrapolate to booked hours, FTEs, or time saved | [02 §2.5](02-the-engaged-time-metric.md), [03 §3.4](03-mcp-tool-design.md) |
| 8 | Surface | One MCP tool `get_project_hours` + CLI `claude-stats hours` parity; no new dashboard tab | [03 §3.1](03-mcp-tool-design.md) |

## The pipeline

```
messages.timestamp  ──┐
sessions.project_path ┤
                      ↓
        filter window [since, until]          ← local TZ, day buckets
                      ↓
        map project_path → group              ← user-declared prefixes
                      ↓
        per day: sort timestamps, sum gaps capped at N min
                      ↓
        ┌─────────────┴─────────────┐
        ↓                           ↓
  day union (ceiling)      per-group unions
        └─────────────┬─────────────┘
                      ↓
        resolve contested intervals (split rule)
                      ↓
        + coverage, capMinutes, promptCount, staleness
                      ↓
              get_project_hours
```

## Documents

| # | File | Contents |
|---|------|----------|
| 01 | [01-why-the-shipped-fields-cannot-answer-it.md](01-why-the-shipped-fields-cannot-answer-it.md) | The three shipped time signals, measured against a physical-plausibility invariant; two code defects found (accumulating upsert, per-segment duration sum) |
| 02 | [02-the-engaged-time-metric.md](02-the-engaged-time-metric.md) | The union metric, cap-vs-drop, contested intervals and the split rule, grouping, and what the number is not |
| 03 | [03-mcp-tool-design.md](03-mcp-tool-design.md) | `get_project_hours` — input schema, response shape, refusal modes, CLI parity, and what not to build |
| 04 | [04-implementation-plan.md](04-implementation-plan.md) | Store method, the two defect fixes, tests that would fail on today's code, rollout |

## Relationship to existing analysis

- **[project-fee-attribution/](../project-fee-attribution/)** is the money twin
  of this analysis and its nearest sibling: same day × project grain, same
  user-declared grouping, but it carries no time dimension at all. This
  analysis supplies the hours axis. One inherited caution and one correction:
  the `(unknown)` account bucket must stay visible here too
  ([02-data-model-and-attribution.md §account grain](../project-fee-attribution/02-data-model-and-attribution.md)),
  but the assumption that time needs no proportional split — because sessions
  already carry a project — is **wrong at day grain**, and [02 §2.3](02-the-engaged-time-metric.md)
  measures by how much.
- **[human-time-saved/](../human-time-saved/)** is the binding constraint. It
  is a decision record: naive time-saved and FTE claims are **not pursued**,
  and the machine-owned/user-owned split is a hard contract — the tool computes
  minutes, the user supplies baselines and rates. This analysis stays strictly
  on the machine-owned side: hours *spent*, never hours *saved*. It also
  inherits that doc's ban on wall clock (`last_timestamp − first_timestamp`)
  as a time basis, and its inventory of the hours primitives is cited rather
  than re-derived.
- **[business-value-visibility/](../business-value-visibility/)** set the
  verdict that the product should build a BI *bridge* — metric catalog and
  business-grain exports — not an in-product BI suite. Hours per project per
  day is exactly a business-grain export, so `get_project_hours` fills a slot
  in that bridge rather than making a new value claim.
- **[ticket-attribution/](../ticket-attribution/)** supplies the vocabulary
  reused here: every figure carries its coverage, and the response states what
  fraction of the window is attributed rather than implying totality.
- **[06-limitations.md §"Session duration is ambiguous"](../06-limitations.md)**
  still suggests first-to-last as a rough duration. That predates the
  human-time-saved ruling and is superseded for any human-time purpose; this
  analysis follows the newer ruling and notes the conflict rather than
  silently contradicting it.
