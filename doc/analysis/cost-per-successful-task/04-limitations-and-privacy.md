# 04 — Limitations and Privacy

## 4.1 The biases that move the number

Stated up front because a metric you don't understand the failure modes of is
worse than none.

| Bias | Direction | Mitigation |
|---|---|---|
| **Git coverage** — non-git work, no upstream, author-email mismatch, no `gh` | Genuine successes look unobservable/thin → understates success, shrinks denominator | Report `coverage`; hold unobservable out of the rate; allow labels to fill the gap |
| **Landed ≠ correct** — a pushed commit can be wrong | Overstates success | Only labels fix this; that's their purpose. Proxy is labelled a proxy |
| **Abandoned-but-correct** — a throwaway spike that proved a point and was deleted | Understates success | Labels; or tag such work and exclude |
| **Dominant-model assignment** — multi-model task credited to one model | Mis-attributes per-model success | Show exact cost split beside assigned success; label the assignment as such |
| **Midnight split** — a task across local midnight becomes two daily items | Inflates `|T|`, halves each task's signal → can shift the rate either way | Documented v1 limitation; window-native pipeline (option B in [02](02-signal-inventory.md)) removes it |
| **Confidence rewards effort** — active minutes / lines correlate with struggle | A hard task that shipped and a hard task that flailed both score "substantial" | Use the categorical classifier, not `score`; prefer the git-landing tier |
| **Short windows** — few tasks → noisy rate | Wild swings | Require a minimum observable count (e.g. ≥10) before showing a per-model rate; otherwise show counts only |
| **CI / non-interactive sessions excluded** — `buildDailyDigest` hardcodes `includeCI:false` | Headless/CI work vanishes from both numerator and denominator | Defensible default for a "*my* workflow" metric; documented; `--include-ci` escape hatch for parity with `report` |
| **Subagent folding** — a delegated task's cost (and its model usage) is folded into the parent | The parent task's dominant model may be a model the *subagent* chose, not the one you invoked | Correct for *cost* attribution; for the dominant-model rule, fold means the parent reflects total model usage incl. delegation — note it where per-model success is shown |

The honest framing: **this metric is a relative instrument before it is an
absolute one.** On one person's consistent, git-backed workflow it reliably
ranks models against each other (the article's actual use case). As an absolute
"3% of my tasks succeed" claim it is only as good as the labels behind it.

## 4.2 Privacy

Nothing here escalates the project's local-first posture.

- All inputs are already-collected `T0` metadata (tokens, models, timestamps,
  tool *names*, git stats) plus, for clustering only, the same `T1` local prompt
  text the recap feature already reads on-device. **No new data leaves the
  machine.**
- Git enrichment shells out to `git` / `gh` against local repos exactly as the
  recap feature already does — no new network surface.
- Outcome labels are stored in the existing local `recap-corrections.db`. They
  are user-authored and never transmitted.
- The read-only MCP tool returns the same shape of aggregate the dashboard shows;
  any prompt-derived strings (e.g. a task's `firstPrompt` if surfaced) must pass
  through `wrapUntrusted` like every other MCP string
  ([`mcp/index.ts:39`](../../../packages/cli/src/mcp/index.ts#L39)). The metric
  itself is numbers and model names — no prompt text required in the default
  payload, so the default payload carries none.

## 4.3 Scope boundaries (what this feature is *not*)

- **Not** a correctness oracle. It measures *shipped* and *user-judged*, not
  *correct*. Said everywhere it's shown.
- **Not** a cross-user benchmark. The deep-analysis catalog's rule holds: the
  baseline is *you*. Comparing your cost-per-success to someone else's conflates
  workflow, repo conventions, and labeling discipline.
- **Not** a subscription-cost tracker. It is equivalent-API dollars by design
  (see [01 §1.5](01-metric-definition.md)); the existing plan-fee/usage-window
  features answer the "what did my flat fee buy" question.
- **Not** an autonomous labeler. Labels are a human act, kept off the MCP write
  path on purpose ([03 §3.5](03-outcome-model.md)).

## 4.4 No verification theatre

Per the owner's design default #16 and the deep-analysis charter: this feature
ships only if it is *actionable* and *falsifiable*. The falsifiable claim is
narrow and true — *"of your observable tasks on model X, this fraction shipped,
at this cost each."* It does not emit an uncalibrated 0–100 "success score," it
does not paraphrase your work back at you, and it refuses to print an absolute
rate when coverage is too thin to support one. If the labels aren't there and
the git coverage is low, the right output is the exact half (mean cost per
attempt) plus an honest "not enough outcome signal to rate success" — not a
confident fabrication.
