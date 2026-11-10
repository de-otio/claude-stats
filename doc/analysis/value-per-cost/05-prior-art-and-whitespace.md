# 05 — Outcome oracles and judge bias

Before building, it is worth knowing which outcome signals are credible, where
they live, and how the automatic fallback — an LLM judge — is biased. The short
version: **acceptance rate is adoption, not value; the trustworthy outcome
signals (test-pass, code survival) live in benchmark harnesses and org
analytics, and the judge fallback carries self-preference bias a Claude-on-Claude
tool would inherit.**

## 5.1 The credible outcome oracles — and why they don't reach the desktop

Two non-vendor signals are the trustworthy alternatives to acceptance rate:

- **Test-pass (SWE-bench style).** The unit is a real issue; value is operational
  — a patch *resolves* only if the repo's own tests pass (FAIL_TO_PASS +
  PASS_TO_PASS). Rigorous, but **only because the suites are curated**; real solo
  repos have weak/absent tests, so "tests pass" can't be a wild oracle on its own.
- **Code survival / churn (GitClear).** Churn = lines reverted/rewritten within
  two weeks; GitClear's 211M-line study projects churn **doubling** vs the 2021
  pre-AI baseline and **4× growth in copy-pasted blocks**. The survival framing —
  does AI code *persist* — is exactly computable from local `git blame --reverse`.
  (Caveat for citation integrity: GitClear's data is **correlational with no
  author attribution**; a 2026 survival study, Rahman & Shihab, actually finds
  agent code modified *less*, contradicting the "disposable AI code" narrative.
  Use survival as a *signal*, not proof.)

The decisive observation: **these oracles live in benchmark harnesses or org
analytics, not on the solo desktop — yet a local-first tool can compute them**,
because it has the full local git history and the local test runs that cloud
dashboards never see.

## 5.2 LLM-as-judge: usable, but Claude-judging-Claude is biased

When a repo has no tests (the common solo case), the only automatic fallback is
LLM-as-judge — and the bias literature is unambiguous that it must be handled
carefully:

- **Self-preference / self-recognition** (Panickssery et al., NeurIPS 2024): a
  *causal* link between a model recognising its own output and scoring it higher;
  the mechanism is over-rewarding low-perplexity (familiar) text.
- **Position bias** (Wang et al.): ordering "can be easily hacked" — swapping
  positions flipped the winner on 66 of 80 queries.
- **Verbosity / self-enhancement** (Zheng et al., NeurIPS 2023): GPT-4 reaches
  >80% human agreement *but* exhibits these biases.

The direct trap for `claude-stats`: **a Claude-family judge scoring
Claude-generated work will inflate the success score**, with effect sizes large
enough to flip rankings. The existing judge tier already blinds model identity —
good — but the design must go further: **objective local signals first
(test-pass, survival, revert-rate), LLM-judge only as a bias-corrected last
resort** (position-swap, length control, and ideally a *non-self* judge family).
