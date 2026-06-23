# 03 — Outcome Model

This is where the metric is won or lost. The numerator (cost) is arithmetic; the
denominator (what counts as success) is a judgement, and a naive judgement
produces a confident, wrong number.

## 3.1 Four states, not two

Every task is classified into exactly one of:

| State | Meaning | In `observable`? | In numerator cost? |
|---|---|---|---|
| **success** | Shipped or user-confirmed correct | yes | yes |
| **failed** | Observably did not land, or user-marked fail/hide | yes | yes |
| **in_flight** | Substantial work, not yet shipped | no | no (held out) |
| **unobservable** | No signal either way | no | no (held out, but counted in coverage) |

```
observable = success ∪ failed
success_rate              = |success| / |observable|
cost_per_successful_task  = ( Σ_{t∈observable} cost(t) ) / |success|
coverage                  = |observable| / |T|
```

`in_flight` and `unobservable` are **held out of the rate**, not counted as
failures. A 45-minute session that added 200 lines but hasn't been pushed yet is
not a failure — it's unfinished, and counting it as failure would punish you for
measuring mid-stream. An equally-real task in a non-git scratch dir is not a
failure either — it's invisible to our instruments.

## 3.2 The classifier (deterministic, proxy tier)

Wrap the existing `confidence` and consult `git` for observability:

```
classifyOutcome(item) =
  // 1. Explicit user labels win, always.
  if label(item) == 'success'            -> success
  if label(item) in {'fail'} or hidden   -> failed
  if label(item) == 'partial'            -> in_flight

  // 2. Proxy from git + confidence.
  if confidence == 'high'                -> success        // pushed commit or merged PR
  if git != null && git.commitsToday==0 && git.pushed-able && active work present
                                          -> failed         // we COULD see a landing; none came
  if confidence == 'medium'              -> in_flight       // local commits / substantial, unshipped
  if git == null                         -> unobservable    // no instrument
  otherwise                              -> in_flight
```

The crucial line is the `failed` proxy: we only assert failure when git was
**observable** (repo present, author matched, upstream exists) and *still* showed
no landing despite real activity. That is the only defensible automatic
negative. Everything we can't see is `unobservable`, never `failed`.

> Implementation note: `git != null` already implies repo + author match, since
> `getGitActivity` is only called when `resolveEmail` succeeds. "pushed-able" =
> an upstream exists; if it can't be determined, treat as `in_flight`
> (conservative — don't manufacture a failure).

## 3.3 The proxy → label hierarchy

Three tiers, weakest to strongest, each overriding the one below:

1. **Confidence proxy** (free, T0, always on). Mechanical/git-derived. Flatters
   or punishes by workflow. Good for a *relative* model comparison on one
   person's consistent workflow; weak as an *absolute* success rate.
2. **Git-landing proxy** (free, T0/T1, when git observable). "Did a commit by me
   land / get pushed / merge in this task's window." Much better, still not
   correctness — a landed commit can be wrong; an abandoned-but-correct
   experiment never lands.
3. **Explicit label** (opt-in, the ground truth). User marks a task
   success / partial / fail. This is what makes it an *evaluation* in the
   article's sense. When present, it overrides all proxies.

The report always prints `labelledCount / observable` so the reader knows which
tier the number rests on. A number that is 90% labelled is an eval; a number
that is 100% proxy is a hypothesis.

## 3.4 Why not just use `score`?

`DailyDigestItem.score` ([`recap/index.ts:1016`](../../../packages/cli/src/recap/index.ts#L1016))
is a continuous blend (`commits*3 + lines/100 + activeMin/30 + prMerged?5 +
pushed?1`). It is great for *ranking* a day's work but wrong as a success
oracle: it has no zero that means "failed," it rewards *effort* (active minutes,
lines) which correlates with *struggle* as much as success, and it is unbounded.
Success is categorical; keep the categorical classifier and leave `score` to
ranking.

## 3.5 Labeling UX — and why it stays out of the MCP server

The MCP server is **read-only by design** ([`mcp/index.ts`](../../../packages/cli/src/mcp/index.ts)
header: "Exposes read-only tools"). Writing outcome labels through an MCP tool
would break that invariant and hand a model the ability to mark its own work
successful — a obvious integrity problem for a metric whose entire value is
honest labels. So labeling is a **human** action through two surfaces:

- **CLI:** `claude-stats task-outcome <id|signature> success|partial|fail`
  (and `--clear`), mirroring the existing `claude-stats tag` command. Writes the
  corrections DB.
- **Dashboard:** a success / partial / fail control on each task card in the
  webview, posting back through the extension to the corrections DB. Note this
  is a **net-new write channel** — recap corrections are CLI-only today and the
  dashboard webview bridge currently handles no correction writes
  ([`extension/panel.ts`](../../../packages/cli/src/extension/panel.ts) only
  handles `changePeriod/changeAccount/refresh/tabChanged/getConfig/saveConfig`).
  The control must be gated to the VS Code webview and must **not** be exposed by
  the read-only `serve` HTTP path. This is why it is split into its own plan
  phase (4b), separate from the read-only card.

The new MCP tool `get_cost_per_task` is **read-only**: it reports the metric,
including how much of it is labelled, but cannot set a label. This keeps the
producer of the number (the model) separate from the judge of success (you).

## 3.6 Honest defaults

- Default denominator is `observable` (success ∪ failed), **never** `T`.
- Default proxy is the **git-landing** tier (2), not raw confidence, when git is
  observable; fall back to confidence only for the `success`/`in_flight`
  boundary.
- If `coverage` is below a floor (say 20%), the CLI/dashboard prints the headline
  **with a warning** that the rate rests on a small observable slice, and leads
  with `mean_cost_per_attempt` (which needs no outcome) instead. Better to show
  the exact half loudly than the shaky half confidently.
