# 05 — Prior art and the white space

Before building, it is worth knowing what every existing tool measures, why their
metrics are distrusted (often by their own makers), and the specific gap
`claude-stats` is positioned to fill. The short version: **everyone counts output
and hopes it proxies value; the few who reach for outcome do so only in benchmark
conditions or only at org scale. Nobody closes the loop for a solo developer
asking "was this AI spend worth this result, and could I have gotten it
cheaper?"**

## 5.1 Vendor analytics: all built on "acceptance rate," all distrusted

Every assistant's native telemetry rests on one primitive — a *suggestion* — and
one headline metric: **acceptance rate** = acceptances ÷ suggestions.

| Tool | Unit | Headline | Value attribution |
|---|---|---|---|
| GitHub Copilot | suggestion / line | acceptance rate, lines accepted | adoption, not quality; docs admit a line counts "even if later deleted" |
| Cursor | tab completion / agent LOC | accept rate, "AI share of committed code" | accepted ≠ retained |
| Windsurf (Codeium) | suggestion | % code written; **rejects acceptance rate** as gameable, proposes "Characters per Opportunity" | a vendor admitting the standard metric is broken |
| **Claude Code** | suggestion + **PR attribution** | lines accepted, **PRs with CC**, **USD spend** | the *only* native dash that joins **cost to retained code** — but org-scale, heuristic attribution |
| Amazon Q | inline suggestion | accept %, accepted LOC | AWS itself maps these to SPACE "Activity" (i.e. output) |

The recurring failure: acceptance rate is *adoption*, trivially gamed (shorter/
more suggestions, accept-without-review), and a >45% rate may signal *uncritical*
acceptance rather than value. GitHub/Google/Microsoft researchers' 2025 consensus
warns plainly: **do not mistake output for impact; LOC is a bad AI metric.**
Claude Code is the closest to the right idea (cost ↔ retained PR) but stops at
team-level attribution heuristics and never reaches per-task or counterfactual.

## 5.2 Engineering-intelligence platforms: outcome-aware, but org-scale

Faros AI, Jellyfish, LinearB, Swarmia, and DX (getdx.com) define a unit of
*delivered* value (PR, cycle-time, investment allocation) and have each bolted on
an AI-impact layer — several now have **token-spend-to-outcome** dashboards
(Faros "Token Intelligence," Jellyfish "AI Token Spend"). Their findings are the
strongest caution in the field:

- **Faros productivity paradox** (~10k devs): individual throughput up, **org
  DORA flat**, **+91% review time, +154% PR size**. Gains time-shifted into
  review/rework.
- **DX** (38,880 devs, 184 companies): real gains **5–15%**, against vendor
  claims of 50–100%.
- **Swarmia:** "coding 3× faster translates to only 2–5% at the org level";
  recommends watching **rework/maintenance cost** and **agent merge rate**.

But all of this **requires a team to benchmark against and org-wide tool
integrations.** None serves a solo developer, and none computes the
*counterfactual* (cheaper path). They answer "is AI helping the org," not "was
this spend efficient for me."

## 5.3 The credible outcome oracles — and why they don't reach the desktop

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
analytics, not on the solo desktop — yet a local-first tool is uniquely placed to
compute them**, because it has the full local git history and the local test runs
that cloud dashboards never see. That is the white space.

## 5.4 LLM-as-judge: usable, but Claude-judging-Claude is biased

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
This belongs in [06](06-what-to-build.md) as a hardening of the shipped judge.

## 5.5 The white space, stated precisely

Mapping all four categories onto the owner's question exposes four holes nobody
fills:

1. **Cost and value are never joined at the task grain.** Vendors have cost and
   output but join them only at org scale; EI platforms need a team. **Nobody
   computes cost-per-outcome for one developer's one unit of work** — the natural
   solo unit is exactly what every tool aggregates away.
2. **The credible outcome signals don't reach the solo desktop.** A local-first
   tool can compute survival and test-pass from local history; cloud dashboards
   structurally cannot.
3. **The counterfactual is asked by no one.** Every tool measures what AI *did*;
   none estimates what a *cheaper path* would have produced. This is "value per
   cost" in its sharpest form — and it is `claude-stats`'s to take
   ([04](04-efficiency-frontier.md)).
4. **Outcome scoring is unsolved exactly where solo devs need it** (no tests) —
   and the LLM-judge fallback carries self-preference bias a Claude-on-Claude
   tool would inherit. Defensible design uses objective-first, bias-guarded
   judging.

**State of the art:** the field has converged on *multi-dimensional output
measurement with org-scale outcome attribution* (DX Core 4, Faros, Swarmia) plus
a *rigorous-but-curated outcome oracle* (SWE-bench) that doesn't transfer to messy
repos. The white space `claude-stats` occupies is the intersection nobody holds:
**a local-first, per-unit join of AI cost to a locally-computable outcome signal
(test-pass + survival + revert-rate), framed as a counterfactual ("cheaper
path?") rather than an adoption metric, with explicit guards against LLM-judge
self-preference.** That is distinctive, defensible, and grounded in the documented
failures of every alternative.
</content>
