# 06 — Automated Outcome Signals

[05](05-accuracy-gap.md) showed the proxy can detect *landing* but not
*correctness*, and that automatic failure detection barely fires. This doc is the
inventory of signals that could close that gap **without manual labels** — what
each detects, where the data already is, which direction it points, how strong it
is, and how badly it can lie.

Organising principle from the literature: the most reliable automatic oracle for
"did the code work" is **executing tests** — this is exactly how SWE-bench grades
agents (`FAIL_TO_PASS` + `PASS_TO_PASS` test sets as ground truth; all-or-nothing
pass@1) ([OpenAI, *Introducing SWE-bench Verified*](https://openai.com/index/introducing-swe-bench-verified/);
[UTBoost](https://arxiv.org/html/2506.09289v1)). claude-stats can't re-run a
held-out test suite, but it *can* observe the tests the user already ran inside
the session, and whether they ended green. That observation is the single highest-
value signal below.

A second organising fact: signals split by **acquisition cost**.

- **Tier-0 — already on disk.** Derivable from stored `MessageRecord` fields
  ([core/src/types.ts:139](../../../packages/core/src/types.ts#L139):
  `stopReason`, `tools`, `filePaths`, `promptText`, token counts). No re-scan.
- **Tier-1 — one scanner field away.** Present in the raw JSONL but not currently
  parsed (tool *results* / `is_error`, Bash exit codes). Needs a
  [scanner](../../../packages/cli/src/scanner/index.ts) change + schema bump +
  backfill, but no new external calls.
- **Tier-2 — external probe.** Needs `git`/`gh` at report time (revert/churn/PR
  review), extending [recap/git.ts](../../../packages/cli/src/recap/git.ts).
- **Tier-3 — model call.** An LLM-as-judge pass over the transcript.

## 6.1 Mechanical in-transcript signals

### (a) Test / build / lint outcome  — *Tier-1, strongest correctness signal*

What it detects: whether the work actually *ran green*. Mine Bash tool calls for
test/build/lint invocations (`npm test`, `vitest`, `jest`, `pytest`, `go test`,
`cargo test`, `tsc`, `eslint`, `ruff`, `make`) and read the **result** block —
exit code and the pass/fail summary tail.

- Direction: both. A task whose **last** test run is green → strong `success`; a
  task whose last relevant run is red, or that introduced failing tests, →
  strong `failed`. Red-then-green within the task = eventual success (and the
  delta is the *cost of getting it right* — exactly the article's quantity).
- Why it's the keystone: it is the same oracle SWE-bench trusts as ground truth,
  applied to the tests the developer themselves chose to run. It is **correctness-
  aware**, not landing-aware, so it sees the failure mode 05 called invisible
  ("model was wrong, code still committed").
- Status: **needs Tier-1 parsing.** Today the scanner stores `tools` (names) and
  token counts but discards tool *results*. The exit code and summary live in the
  `tool_result` block of the JSONL.
- False-positive risk: medium. Flaky tests, unrelated pre-existing failures,
  `test || true`. Mitigate by scoping to runs after the task's edits and by
  reading the final run, not intermediate ones.
- Privacy: result text is local-only, same as `promptText`.

### (b) Tool-error rate / unresolved errors — *Tier-1*

What it detects: friction and mechanical failure. Every `tool_result` carries
`is_error`; failed `Edit`s ("string not found"), missing files, non-zero Bash,
permission errors. A task with a high error rate that **ends on an unresolved
error** is a `failed`/`in_flight` signal; errors that resolve before the end are
struggle (a cost signal), not failure.

- Direction: failure / struggle. Strength: medium. Status: Tier-1 (same parse as
  (a)). False positives: expected errors (a deliberate `grep` that finds
  nothing). Use *trailing* unresolved errors, not raw counts.

### (c) Output truncation — *Tier-0, weak*

`stopReason == 'max_tokens'` already exists (surfaced as `summary.truncatedOutputs`).
Repeated truncation in a task indicates the model hit limits mid-work — a weak
struggle/incompleteness signal, never decisive on its own. Combine, don't
threshold alone.

### (d) Rework loops & abandonment — *Tier-0, weak*

Same `filePaths` edited across many turns with no commit = thrash. A task that
ends shortly after a mutating edit with no commit and no resolution = abandonment.
These are corroborating signals for `in_flight`/soft-fail; the literature lists
"abandonment" and "rephrase/reformulation" among the canonical implicit-
dissatisfaction signals ([Park et al., implicit feedback for conversational AI](https://arxiv.org/pdf/2010.12251)).

## 6.2 Conversational outcome mining — *Tier-0, medium, both directions*

The user's *next* prompts after the model's work are a rich, free, automatic
verdict. Research on implicit user feedback catalogs the exact markers to mine:
**error-correcting language** ("no, …", "I said …", "that's wrong", "still
broken", "revert", "undo", "doesn't work"), **rephrase/reformulation**, negative
sentiment, and **abandonment/termination**; conversely, acceptance / gratitude /
"ship it" close a task positively ([Park et al.](https://arxiv.org/pdf/2010.12251);
[*Invisible failures in human–AI interactions*](https://arxiv.org/pdf/2603.15423)).

- Data: `promptText` is already stored — no new collection.
- Direction: both. A correction/repair turn immediately after a task is a strong
  *human-sourced* failure label (it's the user telling the model it was wrong);
  explicit acceptance is a success label.
- Strength: medium-high precisely because it is human-generated, not inferred from
  mechanics — it captures the "wrong but salvaged" case the git proxy misses.
- False-positive risk: medium. "That's wrong" may target the user's own earlier
  statement, not the model's output; sentiment lexicons are brittle across
  languages (claude-stats is multi-locale). Scope to repair turns that *follow*
  and *reference* the task's files/topic; prefer high-precision phrase patterns
  over sentiment scoring.
- Privacy: prompt text never leaves the machine — consistent with the project's
  local-only guarantee. Keep any lexicon on-device; do not ship prompt text to a
  model for this tier.

## 6.3 VCS survival & review signals — *Tier-2*

Landing is detected today; **survival** is the missing correctness proxy.

### (a) Revert / churn survival

Industry data frames the exact metric: GitClear defines **code churn** as the
percentage of newly added lines *revised or reverted within two weeks*, and finds
AI assistance roughly doubled it (5.5% in 2020 → a projected ~7.9% in 2024)
([GitClear, *AI Copilot Code Quality*](https://www.gitclear.com/coding_on_copilot_data_shows_ais_downward_pressure_on_code_quality)).
That two-week-survival framing is directly reusable: of the lines a task added,
how many are still present N days later (`git blame`/log)? Low survival, an
explicit `git revert` of the task's commit, or a quick follow-up commit whose
message matches `/revert|undo|rollback|fix|oops|typo/` touching the same files →
the work didn't hold → `partial`/`failed`.

- Direction: failure/rework. Strength: high (it's outcome, not intent). Cost:
  Tier-2 — needs git history at/after report time, so it's retrospective (a task
  can only be judged for survival once N days have elapsed). False positives:
  legitimate iteration on top of correct work; planned refactors. Use a window
  and a threshold, report as probability not verdict.

### (b) PR review state

Extend the existing `gh`-based `prMerged` ([git.ts](../../../packages/cli/src/recap/git.ts))
with review outcome: **approved+merged** = strong success; **changes-requested**
or **closed-unmerged** = failure/rework. Strength: high; cost: Tier-2 and `gh`-
gated (already `null` without `gh`, so it only ever *adds* coverage).

## 6.4 Coverage repair (the denominator side)

05 §5.2 named coverage bias as the second deficit. Cheap mitigations, none
requiring outcome inference:

- **Non-git landing signals** for `git == null` projects: file mtime persistence,
  or the task's edited files still existing/unchanged at report time, lift some
  `unobservable` work into `observable`.
- **Author-match robustness:** `git` is `null` when commit email ≠ `git config
  user.email`. Multi-identity users lose coverage silently. Detect and report
  the email-mismatch rate so coverage loss is visible, not absorbed.

## 6.5 The LLM-as-judge tier — powerful, but handle with care — *Tier-3*

An LLM reading the task transcript and rating the outcome is the most flexible
option and the natural way to combine all the weak signals above. The literature
says it *works* but is **biased and must be calibrated**: documented selection,
position, verbosity and self-reinforcing biases, mitigated by calibration against
human labels and bias-corrected reporting with confidence intervals
([*A survey on LLM-as-a-judge*](https://www.sciencedirect.com/science/article/pii/S2666675825004564);
[CalibraEval](https://arxiv.org/pdf/2410.15393);
[*How to Correctly Report LLM-as-a-Judge Evaluations*](https://arxiv.org/pdf/2511.21140)).

One caveat is decisive for *this* product: **self-attribution bias**. Models rate
their *own* outputs systematically higher than identical work from another source
— "AI monitors go easy on themselves" — with the recommended mitigations being
*blind evaluation, an independent (different) evaluator model, and explicit
calibration* ([*Self-Attribution Bias*](https://arxiv.org/pdf/2603.04582)). Since
the transcript being judged was produced by a Claude model, a Claude judge is
exactly the self-monitoring case the paper warns about. Practical implications:

- Judge with a **different model/provider** where possible, and/or strip
  model-identifying detail from the transcript (blind eval).
- Treat the judge as a **calibrated tier**, never ground truth: measure its
  agreement with the user's manual labels and report it ([07 §7.4](07-accuracy-plan.md)).
- It conflicts with the local-only privacy promise (transcript → external model).
  Gate behind explicit opt-in; prefer a local model if offered. This is why the
  judge is the *last* tier, not the first.

## 6.6 Signal summary

| Signal | Tier | Detects | Direction | Strength | Top false-positive risk |
|---|---|---|---|---|---|
| Test/build/lint result (6.1a) | 1 | correctness | both | **high** | flaky/unrelated failures |
| Tool-error trailing (6.1b) | 1 | mechanical fail | fail | med | expected errors |
| Truncation (6.1c) | 0 | incompleteness | fail | low | benign long output |
| Rework/abandonment (6.1d) | 0 | struggle | fail | low | normal iteration |
| Conversational repair (6.2) | 0 | human verdict | both | **med-high** | correction aimed elsewhere; locale |
| Revert/churn survival (6.3a) | 2 | did it hold | fail | high | legit iteration; retrospective |
| PR review state (6.3b) | 2 | acceptance | both | high | `gh`-gated coverage |
| Non-git landing / author-match (6.4) | 0–1 | coverage | n/a | — | mtime noise |
| LLM judge (6.5) | 3 | holistic | both | med* | self-attribution bias; privacy |

\* med *after* calibration; uncalibrated and self-judging, treat as untrusted.

The throughline: **(6.1a) test outcomes** and **(6.2) conversational repair** are
the two signals that are both high-value *and* mostly correctness-aware, and (6.2)
needs no new parsing at all. They are the recommended first targets in
[07](07-accuracy-plan.md).

## References

- OpenAI — [*Introducing SWE-bench Verified*](https://openai.com/index/introducing-swe-bench-verified/) (test sets as automatic ground truth; pass@1, all-or-nothing).
- [*UTBoost: Rigorous Evaluation of Coding Agents on SWE-Bench*](https://arxiv.org/html/2506.09289v1) (FAIL_TO_PASS / PASS_TO_PASS test grading).
- Park et al. — [*A scalable framework for learning from implicit user feedback…*](https://arxiv.org/pdf/2010.12251) (termination, abandonment, error-correcting language, rephrase as dissatisfaction signals).
- [*Invisible failures in human–AI interactions*](https://arxiv.org/pdf/2603.15423) (silent / unspoken failure signals).
- GitClear — [*Coding on Copilot: downward pressure on code quality*](https://www.gitclear.com/coding_on_copilot_data_shows_ais_downward_pressure_on_code_quality) (code churn = lines revised/reverted within two weeks; AI ~doubled it).
- [*A survey on LLM-as-a-judge*](https://www.sciencedirect.com/science/article/pii/S2666675825004564) and [CalibraEval](https://arxiv.org/pdf/2410.15393) (judge biases; calibration).
- [*Self-Attribution Bias: When AI Monitors Go Easy on Themselves*](https://arxiv.org/pdf/2603.04582) (models over-rate their own output; mitigations: blind eval, independent evaluator, calibration).
