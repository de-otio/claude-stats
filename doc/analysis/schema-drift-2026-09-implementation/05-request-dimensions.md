# 05 — Per-Request Dimensions: Effort, Thinking, Speed, Attribution

Implements [§4.5](../schema-drift-2026-09/04-feature-opportunities.md).

Measurements below are from a 1.9 GB local corpus: 47 project dirs, 224 session
files, 282,079 assistant entries, 2026-06 → 2026-09-01. **One operator, one
machine, four months** — treat every distribution as an existence proof of the
*shape*, not a population estimate.

> Ratios here (thinking share, effort share) are computed over raw assistant
> entries, which include the `message.id` duplicates documented in
> [03 §3.0](03-cost-verification.md). Duplicates carry identical usage, so
> *ratios* are largely unaffected; **absolute token totals in this chapter are
> inflated by the same factor and should not be quoted as spend.**

## 5.1 Two field locations, and both are the opposite of what the parent doc implies

| Field | Actual location | Occurrences |
|---|---|---|
| `effort` | **`entry.effort`** — the root of the JSONL entry | 281,787 |
| `effort` at `entry.message.effort` / `…usage.effort` | — | **0** |
| `speed` | **`entry.message.usage.speed`** — inside the usage block | 282,073 |
| `speed` at `entry.speed` / `entry.message.speed` | — | **0** |

[02 §2.2](../schema-drift-2026-09/02-transcript-schema-changes.md) lists `effort`
under "Assistant entries" (correct, but ambiguous about depth) and `speed` under
"Usage block" (correct). The trap is that they are at *different* depths and both
fail **silently to `null`** if read from the wrong one — coverage would drop to
0% with no error. This is risk R3 in §5.9 and gets a dedicated negative test.

## 5.2 Observed reality

### `effort` — two values, and `low`/`medium` do not occur

| value | count | share of assistant entries |
|---|---|---|
| `high` | 276,014 | 97.85% |
| `xhigh` | 5,773 | 2.05% |
| *(absent)* | 292 | 0.10% |

**`effort` never appears on a non-assistant entry.** Cross-tabbed across all 20
observed entry types, the result is exactly two buckets: `assistant:high` and
`assistant:xhigh`.

Of the 292 assistant entries without it: 176 are `model: "<synthetic>"` (zero
usage); the other 116 are from 2026-06, before the field existed. Coverage by
month is 0% (Jun) → 100% (Jul onward).

> **`xhigh` is not in the codebase's enum.** `EffortTier = 'low'|'medium'|'high'`
> (`packages/cli/src/cost-per-task/efficiency/types.ts:41-46`) is wrong in *both*
> directions: it omits the second-most-common observed value, and `low`/`medium`
> do not occur at all here. They are plausible — this operator runs high by
> policy — but **UNVERIFIED**.

### `speed` — one value, zero `fast`

| value | count |
|---|---|
| `"standard"` | 281,942 |
| `null` | 176 (all `<synthetic>`) |

**Zero occurrences of `"fast"`, or any other value, in 1.9 GB spanning four
months at 100% field coverage since 2026-06.** Effort × speed is degenerate.

This is decisive for §4.5's third analytic: **there is no fast-mode data to build
against, validate against, or write a non-synthetic fixture from.** See §5.6c.

### `output_tokens_details` — one key, and it is recent

Exactly one shape occurs, 191,269 times, with no variants:
`"output_tokens_details":{"thinking_tokens":N}`. No `reasoning_tokens`, nothing
else.

| month | n | `output_tokens_details` | `effort` | `speed` | `iterations` | attribution |
|---|---|---|---|---|---|---|
| 2026-06 | 98 | 0% | 0% | 100% | 100% | 0.0% |
| 2026-07 | 2,666 | 0% | 100% | 100% | 100% | 5.4% |
| 2026-08 | 276,443 | 68% | 100% | 100% | 100% | 3.2% |
| 2026-09 | 2,909 | **100%** | 100% | 100% | 100% | 2.0% |

The 32% August gap is temporal — the field landed mid-month — not structural.
Forward coverage is 100%.

`thinking_tokens` is a **subset** of `output_tokens`: 191,181 entries have
`thinking ≤ output`; 88 (0.046%) have `thinking > output`, in **every** case
because `output_tokens` is 0 or absent. Max ratio among entries with
`output_tokens > 0` is 0.992.

**Thinking share, over rows that actually carry the field** — the only honest
denominator:

| model × effort | n | % with thinking>0 | share |
|---|---|---|---|
| `claude-opus-5` × high | 132,616 | 68% | **38.9%** |
| `claude-fable-5` × high | 41,894 | 79% | **41.4%** |
| `claude-opus-5` × xhigh | 5,719 | 78% | **46.8%** |
| `claude-sonnet-5` × high | 7,390 | 69% | **50.9%** |
| `claude-opus-4-8` × high | 3,701 | 80% | **48.7%** |
| **all** | 191,320 | 71% | **40.6%** |

Two real signals:

- **Thinking is ~41% of all output tokens.** The existing `HIGH_THINKING` flag
  (`thinking_blocks > 0`, `dashboard/index.ts:~2566-2569`, commented
  "Approximate") fires on the *majority* of messages and therefore carries no
  information.
- **`xhigh` measurably shifts both thinking share and output volume.** Same
  model, same corpus: share 38.9% → 46.8% (+7.9 pp), and mean output tokens per
  message 766 → 984 (**+28.4%**). That is the empirical content of a "cost per
  effort" claim — and §5.5 states exactly what it is not.

### `iterations` — definitively an array, and the parent doc's guess is wrong

[02 §2.3](../schema-drift-2026-09/02-transcript-schema-changes.md) lists
`iterations` as a usage sub-field with unconfirmed semantics. It is
`entry.message.usage.iterations`, and it is an **array of per-attempt usage
records**:

| literal | count |
|---|---|
| `"iterations":[{"` | 281,945 |
| `"iterations":null` | 176 |
| `"iterations":[],` | 6 |

Length: 0 → 6; **1 → 281,859 (99.99%)**; 2 → 29. Element `type` is `"message"`
(281,888) or `"fallback_message"` (29).

**`model` appears only when a fallback occurred.** All 29 multi-element arrays
have `iterations[0].model = "claude-fable-5"` and a final `fallback_message` with
`model ∈ {claude-opus-4-8 (24), claude-opus-5 (5)}`.

```json
"usage": {
  "input_tokens": 2, "output_tokens": 6432,
  "cache_read_input_tokens": 124162, "cache_creation_input_tokens": 0,
  "speed": "standard",
  "iterations": [
    { "input_tokens": 2, "output_tokens": 181,
      "cache_read_input_tokens": 115153, "cache_creation_input_tokens": 15516,
      "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 15516 },
      "type": "message", "model": "claude-fable-5" },
    { "input_tokens": 2, "output_tokens": 6432,
      "cache_read_input_tokens": 124162, "cache_creation_input_tokens": 0,
      "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0 },
      "type": "fallback_message", "model": "claude-opus-4-8" }
  ]
}
```

### Double-count verdict: **no** — the risk is the opposite

Testing `top.output_tokens` against `Σ iterations[]` and against
`iterations[last]` over all 281,894 arrays:

| relation | count |
|---|---|
| `top == sum == last` (length-1) | 281,677 |
| `top == sum` only | **0** |
| `top == last` only | **9** |
| neither | 202 |

**The top-level `usage` block is a copy of the FINAL iteration, not a sum.** The
codebase's current behaviour — parse top-level usage — is correct. There is no
double-count here.

What it *is* is **incomplete**. Tokens on non-final (failed) attempts, absent
from the top-level block, corpus-wide:

| kind | tokens invisible to top-level usage |
|---|---|
| input | 58 |
| output | 3,334 |
| cache **creation** | **338,487** |
| cache **read** | **9,521,638** |

Whether those are billed is **UNVERIFIED**. Here the magnitude is negligible —
~9.5M cache-read tokens against a 63.6B total — but a fallback-heavy workload
would differ, and the *direction* of the error matters for a tool whose headline
claim is cost accuracy.

The 202 "neither" cases are more interesting: **the top-level usage is all zeros
while `iterations[0]` holds the real numbers** (e.g. `top.output = 0` /
`iter.output = 1247`, `stop_reason: "end_turn"`). So `iterations` can *recover*
usage the top-level block lost. 0.07% — small, real, and a genuine reason to
parse the array rather than skip it. It also means **the top-level block is not
unconditionally authoritative**, an assumption the parser currently makes
everywhere.

`iterations` is also a **better model-fallback source** than the system-entry
fallback records of [06](06-friction.md): it is structurally attached to the
message that fell back, carries both models, and carries the token cost of the
abandoned attempt. The system entries carry none of that.

### Attribution — a sticky *context-carry* marker, not a per-call label

JSONL keys are camelCase at the entry root: `attributionMcpServer` (7,341),
`attributionMcpTool` (7,341), `attributionSkill` (1,781). **Assistant entries
only**; zero of the 162,197 entries bearing a `toolUseResult` carry any.

Coverage: **3.22%** of assistant entries, **3.16%** of tokens (2.010B of 63.63B).

**The ~3% is a real ceiling, not a sampling artifact.** 82 of 224 sessions carry
any attribution, and those 82 hold 93.9% of all tokens. Within them: MCP 2.9%,
skill 0.5%, **median 1.6%**, top five sessions 88.2%, 61.4%, 53.0%, 51.4%, 44.0%.

**The entries carrying it are not the entries that invoked the tool.** Four
independent measurements:

| measurement | result |
|---|---|
| assistant entries issuing an `mcp__*` tool_use | 2,390 — only **1,439** carry `attributionMcpServer` |
| attributed entries whose own tool_use matches the attributed server | **1,390** of 7,341 (18.9%) |
| attributed entries with **no tool_use at all** | **4,174** (46%) |
| assistant entries issuing a `Skill` tool_use | 36 — yet **1,781** entries carry `attributionSkill` (**49×**) |

Run structure settles it: attribution appears in contiguous runs of consecutive
assistant turns, and **777 of 848 runs (91.6%) begin on the turn immediately
following a tool_use for that same server**. Run lengths are long-tailed — 92
runs of ≥20 turns versus 57 of length 1.

> **These fields mark the assistant turns whose context is *carrying* an MCP
> result or skill payload** — the cache-read tail a tool result creates on every
> subsequent turn until compaction — not the call itself.

That is exactly the quantity `attributeToolCosts` (`spending.ts:41`) and
`groupByMcpServer` (`:99`) **cannot** compute today, because they key off the
`tools` JSON array (the invocation) and so see only the ~2,390 calling turns and
none of the 4,174 carrying turns.

`attributionMcpTool` holds the **bare** method name, not `mcp__server__tool`.

## 5.3 Non-finding

11,402 `mode` entries exist with shape `{mode, sessionId, type}` and value
`"normal"` in 100% of cases. Not a source of an effort or speed timeline. Ignore.

## 5.4 Schema refinements to the V23 column set

### `messages.effort TEXT` — keep; fix the parser path and the enum

Read **`entry.effort`**. Widen `EffortTier` to
`'low' | 'medium' | 'high' | 'xhigh'`, marking `low`/`medium` UNVERIFIED in the
docstring. Store the raw string; **do not validate against a closed set at write
time** — `effort` and `speed` are server-controlled vocabularies that will grow.
Normalise at read time and bucket unknowns as `other`.

### `messages.speed TEXT` — keep the column, gate the analytic

Read **`entry.message.usage.speed`**. Capture is cheap and forward-looking, but
with 281,942/281,942 non-null values equal to `"standard"`, every fast-mode
analytic would render a constant. **Gate the analytic behind observed variance**
(`COUNT(DISTINCT speed) > 1`), exactly as the tickets UI is gated behind
`tickets.showUi`.

### `messages.thinking_tokens` — **must be NULLABLE**, not `NOT NULL DEFAULT 0`

This is the single most important refinement in the chapter, and it overrides
the sketch in [01 §1.4](01-foundation.md).

`output_tokens_details` is absent on 32% of the corpus (everything before
mid-August). `NOT NULL DEFAULT 0` makes *"field not reported"* indistinguishable
from *"the model did not think"*, silently fabricating a 0% thinking share for
every historical message and dragging every model's reported share down by the
historical fraction. This is not hypothetical: it produced 23.7% instead of the
correct 38.9% for `claude-opus-5` in the first pass of this very research.

```sql
ALTER TABLE messages ADD COLUMN thinking_tokens INTEGER;  -- NULL = not reported
```

Every ratio becomes
`SUM(thinking_tokens) / SUM(output_tokens) WHERE thinking_tokens IS NOT NULL`.

Use `COALESCE(excluded.thinking_tokens, messages.thinking_tokens)` in
`upsertMessages` (the `file_paths` pattern, `store/index.ts:1192`). That also
gives the `keepIfNoUsage()` protection for free — a compaction replay with no
usage writes NULL, and COALESCE preserves the prior value.

Guard on write: 88 entries have `thinking > output` (all with
`output_tokens = 0`). Clamp or accept, but the ratio query must not divide by
zero.

Do **not** add it to `message_hourly` in V23; when it is added later, the
positional-`INSERT` hazard at `store/index.ts:896-917` applies
([01 §1.6](01-foundation.md)).

### `messages.iterations INTEGER` — **wrong column type; replace it**

An INTEGER can only hold `length`, which is 1 for 99.99% of rows, and discards
the entire payload: the fallback from-model, the to-model, and the abandoned
attempt's tokens. Once written, the array is unrecoverable from the DB without
re-scanning `~/.claude/projects` — which the transcript-cleanup behaviour makes
unreliable.

**One denormalised counter on the hot table plus a sparse side table:**

```sql
ALTER TABLE messages ADD COLUMN attempt_count       INTEGER NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN fallback_from_model TEXT;   -- iterations[0].model when attempt_count > 1

-- Sparse: rows only for NON-FINAL attempts. 29 rows in this 282k-message corpus.
CREATE TABLE IF NOT EXISTS message_attempts (
  message_uuid          TEXT    NOT NULL,
  idx                   INTEGER NOT NULL,   -- 0-based position in iterations[]
  kind                  TEXT    NOT NULL,   -- "message" | "fallback_message"
  model                 TEXT,               -- present only on fallback arrays
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  ephemeral_5m_tokens   INTEGER NOT NULL DEFAULT 0,
  ephemeral_1h_tokens   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_uuid, idx)
) WITHOUT ROWID;
```

Write only `idx < length - 1` rows — the final iteration *is* the top-level
usage, and storing it would create the double-count that does not otherwise
exist. The hot table gains two narrow columns, `WHERE attempt_count > 1` is a
cheap scan, and the full shape survives for a retry/fallback-cost view without a
later migration.

**Optional recovery path** (0.07% of rows): when top-level usage is all zero and
`iterations[0]` is non-zero, prefer the iteration's numbers. Worth doing only
because the parser already has the array in hand — and put it behind a counter so
the effect is measurable rather than assumed.

### `attribution_*`, `request_id`, `prompt_id` — keep as designed

All nullable TEXT with `COALESCE(excluded.x, messages.x)`. JSONL keys are
camelCase while columns are snake_case; the parser mapping is the only place that
matters, but it is an easy typo. `attribution_mcp_tool` stores the **bare** name;
compose `'mcp__' || server || '__' || tool` at read time, never at write time.

```sql
CREATE INDEX IF NOT EXISTS idx_messages_attr_server
  ON messages (attribution_mcp_server) WHERE attribution_mcp_server IS NOT NULL;
```

A partial index over 3% of rows — which is what every attribution query filters
on.

### A third file the foundation chapter missed: sync-merge

`packages/cli/src/sync-merge/merge.ts:64-76` declares
`MONOTONIC_COUNTER_FIELDS`, including `thinking_blocks`. That list is
session-level, so a session-level `thinking_tokens` must be added there or two
devices' shards will not converge on it. `sync-merge/apply.ts:59`, `:84` map
`thinking_blocks → thinkingBlocks` and need the parallel mapping. **Any V23 token
column touches three packages, not two.**

## 5.5 Cost correctness: pricing is unaware of both

`packages/core/src/pricing.ts` contains **zero** occurrences of `speed`,
`effort`, `fast`, or `thinking`. Rates are keyed on the normalised model id and
nothing else; the only non-model rate dimension in the whole system is cache TTL.

**Precise consequence.** A per-effort cost figure from this codebase is a
**correlational attribution of observed token volume to an observed label**. It
says: *messages tagged `xhigh` consumed 28.4% more output tokens each, priced at
the same per-token rate as everything else.*

It does **not** say, and must never be worded to imply:

- that `xhigh` tokens are billed at a different rate — as far as this codebase
  and the transcript know, they are not;
- that switching a task from `xhigh` to `high` would save 28.4% — effort is
  confounded with task difficulty, and nothing in the data separates them;
- that any of this extends prospectively to `low`/`medium`, which do not occur.

The same caveat applies harder to fast mode: with **zero** `speed:"fast"`
observations and no rate awareness in `pricing.ts`, a fast-mode cost impact would
be entirely constructed.

**The honest framing on every surface: observed-token attribution, not a rate
difference.** The `NOT_MEASURED` convention
(`packages/core/src/constraintImpact/beforeAfter.ts:53-57`) is the right
precedent for saying so in-product.

## 5.6 The three analytics

### (a) Effort distribution and cost per effort

**Metric.** Per `(effort, project | task_class)`: message count, share, tokens by
kind, `estimateCost` over them, mean output tokens per message, mean cost per
message. **The comparison of interest is mean cost per message across effort
levels *within a fixed model*** — across models confounds effort with rate.

```sql
SELECT s.project_path, m.model,
       COALESCE(m.effort, 'unknown')            AS effort,
       COUNT(*)                                 AS messages,
       SUM(m.input_tokens)                      AS input_tokens,
       SUM(m.output_tokens)                     AS output_tokens,
       SUM(m.cache_read_tokens)                 AS cache_read_tokens,
       SUM(m.cache_creation_tokens)             AS cache_creation_tokens,
       SUM(m.ephemeral_5m_cache_tokens)         AS ephemeral_5m_cache_tokens,
       SUM(m.ephemeral_1h_cache_tokens)         AS ephemeral_1h_cache_tokens,
       CAST(SUM(m.output_tokens) AS REAL) / COUNT(*) AS mean_output_per_message
  FROM messages m
  JOIN sessions s ON m.session_id = s.session_id
 WHERE s.is_interactive = 1 AND s.source_deleted = 0
   AND (? IS NULL OR s.project_path = ?)
   AND (? IS NULL OR m.timestamp >= ?)
   AND (? IS NULL OR m.timestamp <  ?)
 GROUP BY s.project_path, m.model, effort
 ORDER BY output_tokens DESC;
```

Cost is computed in TypeScript by feeding each row to `estimateCost`, exactly as
`buildSpendingSection` does (`dashboard/index.ts:2536-2553`). **Never do rate
arithmetic in SQL.**

**Caveats that must appear in-product, not only here:** (1) same rate per token
at every effort level; (2) effort is confounded with difficulty — not a saving
forecast; (3) `low`/`medium` unobserved, render only present levels;
(4) **suppress the card below a minimum cell count** — suggest hiding unless ≥2
levels each with ≥100 messages, following the `insufficientDataRow` precedent
(`beforeAfter.ts:366-410`). This corpus is 97.9% `high`, so the comparison is a
two-cell table.

**Surface.** `get_efficiency_hints` and the Efficiency dashboard tab — because
the actionable output is the existing `'default_effort_down'` lever
(`cost-per-task/efficiency/types.ts:98`, `levers.ts:24`), currently unpopulated
for exactly this reason.

### (b) Thinking-token share per model and effort

**Metric.** `thinkingRatio = SUM(thinking_tokens) / SUM(output_tokens)` over rows
where `thinking_tokens IS NOT NULL`, **plus a coverage figure**.

```sql
SELECT m.model,
       COALESCE(m.effort, 'unknown') AS effort,
       COUNT(*)                                                       AS messages,
       SUM(CASE WHEN m.thinking_tokens IS NOT NULL THEN 1 ELSE 0 END) AS measurable_messages,
       SUM(CASE WHEN m.thinking_tokens > 0         THEN 1 ELSE 0 END) AS messages_with_thinking,
       SUM(CASE WHEN m.thinking_tokens IS NOT NULL THEN m.output_tokens ELSE 0 END)
                                                                      AS measurable_output_tokens,
       SUM(COALESCE(m.thinking_tokens, 0))                            AS thinking_tokens
  FROM messages m
  JOIN sessions s ON m.session_id = s.session_id
 WHERE s.is_interactive = 1 AND s.source_deleted = 0
 GROUP BY m.model, effort;
```

`thinkingShare = thinking_tokens / NULLIF(measurable_output_tokens, 0)`;
`coverage = measurable_messages / messages`. **Suppress the ratio entirely when
`coverage < 0.5`**, and render coverage beside the ratio always. This is what
stops a historical window from reporting a fabricated 0%.

**Caveats.** Thinking tokens are a *subset* of output tokens — a composition
metric, never added to a cost total. The field is post-mid-August-2026 only;
earlier windows are *unmeasurable*, not zero. Exclude or clamp the 88 anomalous
rows.

**Fix the stub immediately** (`dashboard/index.ts:~2566-2569`):

```ts
// before: if (a.message.thinking_blocks > 0) { /* Approximate */ flags.push("HIGH_THINKING"); }
const th = a.message.thinking_tokens;          // nullable
if (th != null && a.message.output_tokens > 0 && th / a.message.output_tokens > 0.5) {
  flags.push("HIGH_THINKING");
}
```

At a corpus mean of 40.6%, a >50% threshold is genuinely discriminating — and it
matches the design already recorded at
[09-token-spending-analysis.md:377](../09-token-spending-analysis.md).

**Surface.** `buildSpendingSection` → a `thinkingShare` column on the existing
cost-by-model table; the `HIGH_THINKING` chip; `printSpendingReport`
(`reporter/index.ts:683-840`, per-model at `:733-751`); `get_stats.byModel[]`.

### (c) Fast-mode share and cost/limit impact — **specified, not built**

**If data ever appears:** `fastShare = COUNT(speed='fast') / COUNT(speed IS NOT
NULL)` per model/day/project, with `NOT_MEASURED` for the cost delta until a
verified rate exists.

**Why it does not ship in this pass — three independent blockers:**

1. **Zero observations.** Every fixture would be synthetic, every test would
   assert against invented data, and the card would show one bar.
2. **Pricing cannot express it.** A cost impact requires a rate dimension
   `pricing.ts` does not have (§5.5). Without it, any dollar figure is
   fabricated.
3. **"Limit impact" would require inventing a consumption model that does not
   exist.** `packages/core/src/planMechanics.ts` is a *procurement* reference —
   seats, prices, benchmarks — with zero speed/fast/effort references and **no
   consumption model at all**. Its only 5-hour statements are two comments
   (`:95`, `:100`) that nothing reads. Windows are pure time-and-dollars
   (`aggregator/index.ts:423-500`); `weeklyPlanBudget = planFee / 4.33`
   (`dashboard/index.ts:235-249`). **Adding fast mode to plan mechanics means
   building a consumption model from scratch, not extending one.** That is a
   separate, larger project.

**Ship the cheap half only.** Add `"speed-mode"` to `PolicyEvent.kind`
(`packages/core/src/types/insight.ts:100-107`) and its validator
(`packages/cli/src/config.ts:322-325`) — 2 lines, and since the enum is inert
(read only as a tie-break at `beforeAfter.ts:293`) the existing before/after
machinery immediately compares across it. A user can *record* a fast-mode policy
change today.

**Do not thread `speed` through the constraint-impact metric path.** That is five
hardcoded sites (`ClassImpactComparison:135-224`, `insufficientDataRow:366-410`,
`compareOneClass:412-526`, `CSV_HEADER:634-659`, CSV row `:671-696`) plus
`toHygieneMessageRow` (`constraintImpact/index.ts:91-110`) and its accumulation
loop (`:156-160`), plus `speed` on `HygieneMessageRow` and on
`getMessagesForHygiene`'s projection — for a metric with no data behind it. Name
the gap in `NOT_MEASURED` instead.

## 5.7 MCP and skill carry attribution — the most valuable item in §4.5

**Verdict: build it. 3% is the *answer*, not a limitation.**

The existing MCP cost view (`getMcpMessages`, `store/index.ts:4089-4116` →
`spending.ts`) filters on `m.tools LIKE '%mcp__%'` — it can only see the ~2,390
turns that *made a call*. The attribution fields see the 9,076 turns that
*carried the result*, 4,174 of which make no tool call at all. These measure
different things, and the second is the one that costs money: an MCP result is a
one-time output cost and then a **recurring cache-read cost on every subsequent
turn until compaction**.

The 49× gap between `Skill` tool_use entries (36) and `attributionSkill` entries
(1,781) is the clearest demonstration: **a skill's cost is almost entirely
carry**, and the invocation-based view is blind to essentially all of it.

**What it is good for:**

- **The skewed tail.** 2.9% of tokens in attributed sessions, 1.6% at the median
  — but the worst session is **88.2%**. A per-session MCP-carry share is an
  outlier detector: *"this session spent 88% of its budget carrying one server's
  results."* Actionable — trim the result, cap the tool's output, drop the server
  from that workflow — in a way a corpus average never is.
- **Per-server and per-skill carry cost**, which the existing card cannot
  compute.
- **Ranking which specific tool method** is expensive to carry.

**What it is not good for:** a headline "MCP costs you X%". At 3.16% of tokens
with a 1.6% median and an 88% max, **the mean is meaningless**. Present it as a
per-session / per-server ranked list with a distribution, never one aggregate.

```sql
SELECT COALESCE(m.attribution_mcp_server, '(none)') AS server,
       m.attribution_mcp_tool                       AS tool,
       s.session_id, s.project_path,
       COUNT(*)                     AS carried_messages,
       SUM(m.cache_read_tokens)     AS carried_cache_read_tokens,
       SUM(m.input_tokens)          AS input_tokens,
       SUM(m.output_tokens)         AS output_tokens,
       SUM(m.cache_creation_tokens) AS cache_creation_tokens
  FROM messages m
  JOIN sessions s ON m.session_id = s.session_id
 WHERE s.is_interactive = 1 AND s.source_deleted = 0
   AND m.attribution_mcp_server IS NOT NULL
 GROUP BY server, tool, s.session_id
 ORDER BY carried_cache_read_tokens DESC;
```

The skill variant keys on `attribution_skill`. A share needs the session total —
a second grouped query or a window function over the same join.

**In-product caveat:** attribution marks turns whose context *carries* a result;
it does not prove the result caused that turn's cost — the turn would have had
*some* context regardless. **It is an upper bound on carry cost, not an isolated
marginal cost.** The run structure (91.6% of runs starting immediately after that
server's tool_use) supports the causal reading, but "upper bound" is the honest
word.

## 5.8 Surfaces

### A traced card, end to end: "MCP Server Token Usage"

| Stage | Location |
|---|---|
| query | `packages/cli/src/store/index.ts:4089-4116` — `getMcpMessages(filters)`, filtered `s.is_interactive = 1 AND s.source_deleted = 0 AND m.tools LIKE '%mcp__%'` |
| pure aggregation | `packages/cli/src/spending.ts:188` — `aggregateMcpServerUsage(rows)`, no store access |
| builder | `packages/cli/src/dashboard/index.ts:2494-2600+` — `buildSpendingSection`; type at `:623-683` |
| render | `packages/cli/src/server/template.ts:1667-1700`, inside `sectionOpen("spending")` (`:1586`); `<canvas id="chart-mcp-servers">`; chart JS in the inline script (~`:3532-3550`) |
| tab shell | `template.ts:810-815` — `sectionOpen(id)`, heading from `t('dashboard:tabs.<id>')` |
| i18n | **NONE for the card body.** The Spending tab's headings and columns are hardcoded English literals — `"MCP Server Token Usage"`, `"Cost by Model"`, `"Server"`, `"Cost"`, `"Cache Hit Rate"`, … Only the tab *label* is translated. Contrast the Efficiency tab (`:1547-1580`), which uses `t("dashboard:charts.…")` throughout. |

> **A pre-existing i18n gap in the Spending tab**, worth tracking separately. A
> new card should be i18n'd from the start regardless of its neighbours —
> otherwise it looks like a bug in the nine non-English locales.

### Files a new card touches

| # | File | Change |
|---|---|---|
| 1 | `packages/cli/src/store/index.ts` | new `getX()` + row interface; `migrateToV23()`; `SCHEMA_VERSION` at `:30`; dispatch at `:134`; `upsertMessages` at `:1153-1216` |
| 2 | `packages/core/src/parser/session.ts` | extract `entry.effort`, `usage.speed`, `usage.output_tokens_details.thinking_tokens`, `usage.iterations[]`, the attribution trio (usage reads live at `:341-362`, `:437-445`) |
| 3 | `packages/core/src/types.ts` | `UsageData` gains `speed`, `output_tokens_details`, `iterations`; the entry type gains `effort` + the trio; `MessageRow` gains the columns |
| 4 | `packages/cli/src/spending.ts` | new pure aggregator alongside `aggregateMcpServerUsage` |
| 5 | `packages/cli/src/dashboard/index.ts` | `DashboardSpending` at `:623-683`; builder at `:2494-2600`; `HIGH_THINKING` fix at `~:2566-2569` |
| 6 | `packages/cli/src/server/template.ts` | card markup + optional Chart.js block |
| 7 | `packages/core/src/locales/*/dashboard.json` | 10 files |
| 8 | `packages/cli/src/reporter/index.ts` | CLI parity — `printSpendingReport:683-840`, per-model `:733-751` |
| 9 | `packages/cli/src/mcp/index.ts` | new/extended tool + its description |
| 10 | `packages/cli/src/sync-merge/merge.ts` + `apply.ts` | `MONOTONIC_COUNTER_FIELDS` (`merge.ts:64-76`) and the row↔object mappings (`apply.ts:59`, `:84`) |
| 11 | `packages/cli/src/__tests__/*.test.ts` | §5.10 |

Existing tests that construct `MessageRow` literals and will need the new fields:
`spending.test.ts:14`, `cost-per-task-evidence.test.ts:23`,
`classify-integration.test.ts:58`, `owner-store.test.ts:81`,
`energy.test.ts:410`.

## 5.9 i18n

12–13 new `dashboard:` keys × 10 locales:

```
charts.effortDistribution     charts.thinkingShareByModel     charts.mcpCarryCost
spending.thinkingShareColumn  spending.effortColumn
spending.carriedMessages      spending.carriedCacheRead
effort.caveat        "Effort levels are billed at the same per-token rate. Differences shown are observed token volume, not a rate difference."
effort.confounded    "Higher effort is typically chosen for harder tasks; this is a correlation, not a saving forecast."
thinking.coverage    "Measurable on {{percent}}% of messages in this window"
thinking.notMeasured "Thinking tokens were not reported before this window"
mcp.attributionCaveat    "Marks turns whose context carried this result — an upper bound on carry cost, not an isolated marginal cost."
mcp.attributionCoverage  "{{percent}}% of tokens in this window carry an attribution tag"
```

**The caveat strings matter most** — they are the difference between a correct
feature and a misleading one, and they must be translated, not left English-only.

## 5.10 Tests

**Parser** — field placement is the highest-risk area and the easiest to get
backwards:

- Table-driven fixture asserting `effort` reads from the **entry root** and
  `speed` from **`message.usage`**, with **negative assertions** that swapping
  them yields `null`.
- `output_tokens_details` present → `thinking_tokens` set; **absent → `null`, not
  `0`.** This is the regression the `NOT NULL DEFAULT 0` design would introduce.
- `iterations`: length 0, 1, and 2 with `fallback_message`. Assert
  `attempt_count`, `fallback_from_model`, and that `message_attempts` receives
  exactly `length - 1` rows, **never the final one**. Use the real two-element
  shape from §5.2 — the numbers carry no identifying content.

**Store**

- V22→V23 migration on a populated fixture DB: rows survive, `thinking_tokens IS
  NULL`, `attempt_count = 1`.
- **Compaction-replay idempotence** — re-upsert a message with `usage` absent and
  assert `thinking_tokens` is preserved. The failure mode is a silent zeroing no
  other test would catch.
- `recomputeMessageHourly` unchanged in V23, with an explicit test that the
  rollup's column ordering is stable (the positional `INSERT` at `:896-917`).

**Aggregation (pure)**

- Thinking share with mixed NULL/non-NULL rows: the ratio uses only non-NULL
  rows and the reported coverage matches.
- `thinking > output` with `output = 0` → no division by zero, no `Infinity`, no
  `NaN` rendered.
- Single observed effort level → card suppressed. Single observed `speed` →
  analytic suppressed.

**Property-based (fast-check)**

- `Σ(per-effort tokens) === total tokens` — the sums-exactly invariant
  `get_stats` already documents.
- `0 ≤ thinkingShare ≤ 1` whenever coverage > 0.
- For any `iterations` array, `top-level usage === last element` is the parse
  contract; assert **no path produces a sum**.

**Behaviour comparison for `HIGH_THINKING`** — capture the flag set on a fixture
corpus before and after; assert the count drops from "fires on most messages" to
"fires on the >50% tail". A code-diff review would not catch a threshold
inversion.

## 5.11 Effort, risks, open questions

| Item | Size |
|---|---|
| V23 migration + parser + types + upsert + sync-merge | M — three packages, the positional-INSERT and COALESCE hazards |
| **`HIGH_THINKING` fix** | **XS — one predicate, immediate correctness win, ship first** |
| (b) thinking share: store query + aggregator + Spending column + `get_stats.byModel` | S–M |
| (a) effort distribution + the `'default_effort_down'` lever | M — needs the task-class join and the suppression rules |
| MCP/skill carry-attribution card | M |
| `PolicyEvent.kind += "speed-mode"` | XS — 2 lines |
| (c) fast-mode metric | **do not start** |

**Risks**

1. **`thinking_tokens NOT NULL DEFAULT 0` ships as originally sketched.** It
   silently fabricates 0% thinking for 32% of the corpus and is invisible in
   review — the number renders, it is just wrong. **Highest severity here.**
2. **`iterations INTEGER` ships as originally sketched.** Discards the only
   structurally-attached model-fallback record in the transcript, unrecoverably.
3. **Field-placement inversion** (`effort` in usage, `speed` on the entry). Both
   are one-character-plausible and both fail silently to `null`.
4. **Building fast-mode analytics against zero observations**, then being
   contradicted when real `fast` data arrives at a rate the table cannot model.
5. **A single aggregate MCP percentage** read as "MCP costs 3%" when the
   distribution runs 1.6% median to 88.2% max.
6. **One operator's corpus.** 97.9% `high`, 100% `standard`, one machine, four
   months.

**Open questions / UNVERIFIED**

- **Are non-final-attempt tokens billed?** 9.52M cache-read + 338K
  cache-creation tokens sit outside the top-level block. Needs an invoice or
  console cross-check on a window containing a known fallback. Determines whether
  `message_attempts` is a correctness fix or a diagnostic nicety.
- **Do `low` and `medium` effort exist?** Not observed at 100% field coverage
  over 281,787 entries. Affects whether `'default_effort_down'` has anywhere to
  point.
- **What makes attribution appear at all?** 82/224 sessions, ~3% of turns, runs
  terminating for unknown reasons (compaction? a fixed carry window? the result
  leaving context?). The termination rule would sharpen the carry-cost bound
  considerably.
- **Is fast mode billed at a different rate?** If yes, `ModelPricing` needs a
  `speed` dimension and a verified table. If no, the fast-mode story collapses
  into "fewer tokens, same rate" — a thin feature.
- **Why do 202 entries have a zeroed top-level usage block with intact
  `iterations`?** 0.07% is small, but it means the top-level block is not
  unconditionally authoritative — an assumption the parser makes everywhere.
- **Should the Spending tab's hardcoded English be i18n'd as part of this work,
  or tracked separately?** — [09 §9.5](09-sequencing.md).
