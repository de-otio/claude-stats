# 03 — `get_project_hours`: the MCP tool

## 3.1 Surface

One new read-only MCP tool, registered in
[`cli/src/mcp/index.ts`](../../../packages/cli/src/mcp/index.ts) alongside the
existing ones, plus CLI parity. No new dashboard tab — per
[business-value-visibility/](../business-value-visibility/), this is a
business-grain *export*, and the consumers are an agent answering "where did
today go?" and a human piping CSV into a spreadsheet.

| Surface | Invocation |
|---|---|
| MCP | `get_project_hours` |
| CLI | `claude-stats hours --since 2026-08-01 --until 2026-08-31 [--group <label>] [--csv]` |

The name follows the shipped convention (`get_cost_per_ticket`,
`get_context_carry`, `list_projects`) and says *hours*, not *time*, because
the ambiguity of "time" is precisely what [01](01-why-the-shipped-fields-cannot-answer-it.md)
is about.

## 3.2 Input schema

Reuses `dateRangeShape` ([`mcp/index.ts:73-80`](../../../packages/cli/src/mcp/index.ts#L73-L80))
so the window semantics match every other tool.

```ts
{
  ...dateRangeShape,                       // period | since+until
  group: z.string().optional()
    .describe("Filter to one declared project group by label; omit for all groups"),
  capMinutes: z.number().int().min(1).max(120).default(15)
    .describe("Idle-gap cap in minutes. Engagement is credited for at most this long after the last message. The metric is sensitive to this value (~19% between 15 and 30) — keep it fixed across a series you intend to compare."),
  split: z.enum(["proportional", "duplicate", "exclusive"]).default("proportional")
    .describe("How to attribute intervals where several groups were active. 'proportional' reconciles per-group hours to the day total; 'duplicate' lets them exceed it; 'exclusive' assigns each interval one owner."),
  timezone: z.string().optional()
    .describe("IANA timezone for day bucketing (default: system zone)"),
  account: z.string().optional()
    .describe("Filter to a specific account UUID (full or prefix match)"),
}
```

`byDay: false` is deliberately **not** offered as a way to get only a total.
The daily series is the product; a caller wanting a total sums it and can see
which days it came from.

## 3.3 Response shape

```ts
interface ProjectHoursResult {
  window: { since: string; until: string; timezone: string };
  capMinutes: number;              // echoed — a figure without its cap is meaningless
  split: "proportional" | "duplicate" | "exclusive";

  days: Array<{
    date: string;                  // YYYY-MM-DD, local
    dayUnionHours: number;         // ceiling: engaged time across ALL projects
    overlapHours: number;          // contested time, before the split rule
    groups: Array<{
      label: string;               // declared group, "(ungrouped)", or "(unknown)"
      hours: number;
      promptCount: number;         // human turn-starts — the attention signal
      sessionCount: number;
      projectPaths: string[];      // what fed this group, for auditability
    }>;
  }>;

  totals: {
    unionHours: number;            // NOT the sum of per-group hours under `duplicate`
    byGroup: Array<{ label: string; hours: number; promptCount: number }>;
  };

  coverage: {
    attributedHours: number;       // hours landing in a declared group
    ungroupedHours: number;        // matched no prefix — always rendered
    attributedFraction: number;    // 0..1
    reconciles: boolean;           // do per-group hours sum to unionHours?
  };

  collection: {
    lastCollectedAt: number;
    stalenessMinutes: number;
    warning: string | null;        // set when the window may be incomplete
  };

  caveat: string;                  // see §3.4 — always present, never null
}
```

Three fields carry the honesty burden and none is optional:

- **`coverage.reconciles`** is `false` under `split: "duplicate"`, so a caller
  who sums per-group hours and gets more than the day cannot mistake it for an
  arithmetic error. It is `true` under `proportional`.
- **`collection.stalenessMinutes`** exists because this tool will be asked
  about *today*, mid-day, when the last collection may predate the last hour of
  work. Reporting a confidently wrong low number is the failure mode to avoid.
- **`caveat`** ships the floor-metric statement into the payload, not just the
  docs. Agents summarize payloads, not documentation.

## 3.4 Refusal modes

Following the human-time-saved contract — *refuse rather than fabricate*:

| Condition | Behaviour |
|---|---|
| No messages in window | `days: []` with an explicit `"no recorded activity in window"` note — never `0.0 hours` presented as a measurement |
| Collection stale beyond a threshold | Return the figures **with** `collection.warning` naming the gap; do not silently serve a partial day |
| `since` after `until`, or a window in the future | Error, not an empty success |
| Caller asks for hours *saved*, FTEs, or a billable conversion | Not representable in the schema at all — there is no field to put it in, and the description says so |

The last row is the design decision, not a runtime check. The cheapest way to
prevent a metric being misused is to give it no slot in the output. There is no
`rate`, no `baseline`, no `savedHours`, no `productivity` field, and adding one
should be treated as reopening [human-time-saved/](../human-time-saved/).

## 3.5 The description string

The MCP description is the only documentation most callers will ever read —
the shipped tools treat it as a full doc surface, and this one must carry the
floor caveat, because an agent that reads only the tool list will otherwise
report engaged hours as worked hours:

> Get engaged hours per project per day — measured working time, bucketed by
> local calendar day and grouped by declared project prefixes.
>
> Engaged time is the union of message timestamps with idle gaps capped at
> `capMinutes`; parallel sessions and subagents merge into one timeline, so a
> day can never exceed 24 h. This is NOT `sessions.active_duration_ms`, which
> is per-session and cannot be summed across concurrent sessions.
>
> **This is a FLOOR on human working time, not a timesheet.** It excludes
> meetings, code review in a browser, reading, and any work without a Claude
> session in that project; it includes autonomous background activity with
> nobody at the keyboard — check `promptCount` beside the hours to tell them
> apart. Do not present these figures as booked, billable, or saved hours, and
> do not convert them into FTEs.
>
> The metric is sensitive to `capMinutes` (~19 % between 15 and 30), which is
> echoed in the response; keep it fixed across any series you compare. Where
> several groups were active in the same interval, `split` governs
> attribution — read `coverage.reconciles` before summing per-group hours.

## 3.6 What not to build

- **A "billable hours" mode.** Rates, calendars, and timesheet reconciliation
  belong to the user. The moment the tool multiplies hours by a rate it is
  making a claim it cannot support.
- **An auto-detected project grouping.** Inferring client boundaries from path
  heuristics or repo remotes would be wrong silently and occasionally
  embarrassingly. Groups are declared.
- **A team/org rollup of hours.** Per-dev hours as an org capacity or
  comparison figure is exactly what human-time-saved rejected. The org
  aggregate plane already carries `activeMs`
  ([`org/aggregate.ts:298`](../../../packages/cli/src/org/aggregate.ts#L298));
  it should not gain a per-person hours league table.
- **Backfilling a corrected `active_duration_ms` into history.** The field's
  30-minute drop semantic is shipped and consumed; fix the upsert bug
  ([04 §4.2](04-implementation-plan.md)) and leave the semantic alone.
- **Storing computed hours.** The union is cheap over an indexed scan and
  depends on `capMinutes` and `split`; caching it would freeze parameters that
  are meant to be varied.
