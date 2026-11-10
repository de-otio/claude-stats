# 01 — Feature Vision

## The user's question

> *As a developer I often feel at the end of the day as if I got nothing done.
> As a user of Claude Stats, I would like to be able to ask my agent
> "What did I get done today?"*

This is a phrasing question, not a data question. The data already exists in
`~/.claude-stats/stats.db` and the surrounding git repos. What's missing is a
synthesis step that turns numerical activity into a readable account of work.

## What "got done" actually means

The literal request is "summarize my day," but the underlying need is
**reassurance about progress**. A good recap therefore prioritises *outcomes*
over *activity*:

| Activity (low value alone) | Outcome (what the user wants) |
|----------------------------|-------------------------------|
| 47 prompts sent           | Shipped auth-refactor PR (12 commits, 8 files) |
| 142 minutes of session time | Diagnosed the cache-miss bug; root cause documented |
| 23k output tokens         | Migrated three integration tests off the mock DB |
| 4 sessions in `project-a` | Drafted a design doc and got it reviewed |

The first column is what the existing dashboard shows. The recap feature must
reach the second column. That requires combining:

1. **Intent** — what the user *asked* the agent to do (the first user prompt
   of a session is usually the task statement).
2. **Execution** — what the agent and user actually did (tool calls,
   files touched, commits authored, tests run).
3. **Outcome** — did it ship? Was it abandoned? Is it in flight?
   Inferable from git state (committed/pushed/PR-open/PR-merged) and from
   whether the session ended on `end_turn` versus an abort.

## Quality bar

A recap is "good" when:

- A user reading it three weeks later can recognise *which day this was*.
- It distinguishes finished work from in-flight work without lying about
  either.
- It groups related activity (e.g. five sessions all touching the auth
  refactor become *one* line item, not five).
- It surfaces the day's *one or two* notable items rather than a flat list of
  everything.
- It is honest about days that were genuinely thin — never inflate.

A recap is "bad" when:

- It hallucinates outcomes that aren't grounded in commits/PRs ("you fixed
  the bug" when no commit landed).
- It paraphrases the user's own first prompt and loses precision.
- It treats every session as equally important.
- It re-narrates token counts ("you used 142k tokens today") as if that were
  an accomplishment.

## Implications for the pipeline

These quality requirements drive the hybrid design in
[03-hybrid-pipeline.md](03-hybrid-pipeline.md):

- **Extractive beats generative for intent.** The first user prompt is the
  best possible task statement — it was written by the user themselves.
  Quoting it verbatim is both cheaper and more accurate than asking an LLM
  to paraphrase it. (Sanitised; wrapped as untrusted content.)
- **Outcomes must be grounded in deterministic signals.** Whether something
  "shipped" is a property of git, not of the conversation. The pipeline
  reads `git log --since=midnight` per project and joins by repo path.
- **Clustering is genuinely an LLM-shaped task.** Deciding that
  "five sessions all titled differently are the same auth-refactor work"
  needs semantic understanding. This is one of the few places an LLM pays
  for itself — but it can run on tiny inputs (just the first prompts and
  commit subjects, not full transcripts).
- **Ranking is mostly deterministic.** "Notable" can be approximated by
  `(commits_landed * 3) + (files_changed * 0.2) + duration_minutes`, and
  that approximation is good enough for a top-3 highlight ordering.

## Non-goals

- **Coaching or judgement.** The recap reports; it does not nag about
  unfinished work or low velocity.
- **Cross-day inference.** "Today" is a clean boundary. Trends across days
  belong to a separate report.
- **Real-time recaps mid-day.** This is a once-or-twice-a-day artefact.
  Cache aggressively.

## Example output (target)

Illustrative only: a synthetic day with invented projects, prompts and figures.

```
Today (Mon Jan 3, UTC)

  ▸ Added CSV export to the report command (project-a)
      3 commits on main, 4 files changed, +120 −8
      Started from: "add a csv export option to the report command"
      ~1h 05m across 2 sessions

  ▸ Drafted caching design notes (project-a)
      No commits yet — 2 files added under doc/
      Started from: "write up the options for caching the report output"
      ~35m, 1 session

  ▸ Investigated a flaky nightly job (project-b)
      No commits, no resolution — left an open question in the session
      Started from: "the nightly job failed again"
      ~20m, 1 session — looks unfinished

  2 projects · 4 sessions · 2h 00m active · ~$1.50
```

The first three lines per item come from extractive deterministic data.
Only the leading verb ("Shipped" / "Drafted" / "Investigated") and the
clustering of multiple sessions into one item benefit from an LLM pass.
