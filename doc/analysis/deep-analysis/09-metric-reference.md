# 09 — Metric Reference (Appendix)

Every insight from this catalog in one table, with its tags, for triage when
prioritising a build. Tier/effort/privacy as defined in
[`README.md`](README.md) and [`01-tiered-data-model.md`](01-tiered-data-model.md).

**Tier:** `T0` metadata · `T1` local content · `T2` opt-in egress.
**Effort:** `ready` · `mod` (moderate) · `hard`. **Privacy:** `local` · `egress`.

## Usage patterns ([02](02-usage-patterns.md))

| Insight | Signal source | Tier | Effort | Privacy |
|---|---|---|---|---|
| Peak-performance hours | timestamps + churn | T0 | mod | local |
| Cadence & overload | session/prompt counts | T0 | ready | local |
| Interruption / fragmentation | inter-prompt gaps | T0 | mod | local |
| Project drift heatmap | cwd + timestamp | T0 | ready | local |
| Session archetype classification | tool-mix vector | T0 | mod | local |
| Tool-mix profile & drift | tool names | T0 | ready | local |
| Parallelism use | multi-tool turns, subagents | T0 | mod | local |
| Thinking engagement | thinking-block count | T0 | ready | local |
| Model-mix appropriateness | model × archetype × outcome | T0 | mod | local |
| Context-pressure pattern | compaction + token trend | T0 | mod | local |
| Cache-efficiency habits | usage fields | T0 | ready | local |
| Topic clustering | prompt embeddings | T1b | mod | local |
| Intent mix (cmd/question/spec) | prompt classification | T1 | mod | local |
| Recurring-prompt detection | prompt dedup | T1b | mod | local |

## Risk & dangerous use ([03](03-risk-and-dangerous-use.md)) — *priority*

| Insight | Signal source | Tier | Effort | Privacy |
|---|---|---|---|---|
| **Unread-diff acceptance** | edit size + permMode + timing | T0→T1 | ready | local |
| **Auto-accept exposure** | permissionMode × mutating tools | T0 | ready | local |
| Run-before-claiming gap | completion text vs test run | T1 | mod | local |
| Test-after-edit ratio | edit→test sequence | T1 | mod | local |
| Commit-without-review | commit timing vs review | T1 | mod | local |
| **Dangerous-command detector** | Bash regex lexicon | T1 | ready | local |
| Prod-target detector | command/env prod markers | T1 | mod | local |
| Pipe-to-shell / supply-chain | Bash patterns | T1 | ready | local |
| Direct-to-default-branch | gitBranch × mutating tools | T0 | ready | local |
| Oversized change | diff/churn size | T0/T1 | mod | local |
| Uncommitted-work accumulation | edits w/o commit | T1 | mod | local |
| Tool-result blind trust | result size vs inspection | T1 | hard | local |
| Hallucination-exposure surface | not-found tool errors | T1 | mod | local |
| Spec-skipping before big change | prompt + plan-mode + edit size | T1 | mod | local |
| Secret-in-prompt detector | secret/PII regex | T1 | ready | local |
| Confidential-name leakage | deny-set × public remote | T1 | mod | local |
| Dependence ratio | AI vs manual edits | T0 | hard | local |
| Comprehension-check absence | why-questions vs diff complexity | T1 | hard | local |
| **Guardrail index (composite)** | weighted family rollup | T0+ | mod | local |

## Productivity ([04](04-productivity-coaching.md)) — *priority*

| Insight | Signal source | Tier | Effort | Privacy |
|---|---|---|---|---|
| File-thrash detection | file-history version counts | T0 | mod | local |
| Edit-survival rate | file-history diffs | T1 | hard | local |
| Repeated-failure loops | repeated Bash error results | T1 | mod | local |
| Clarification thrash | corrective-prompt bursts | T1 | mod | local |
| Session abandonment | edits w/o commit, no resume | T1 | hard | local |
| Time-to-first-edit | start→first edit | T0 | ready | local |
| Exploration↔implementation balance | read vs write tools | T0 | ready | local |
| Bottleneck attribution | time per tool, repeat Reads | T1 | mod | local |
| Verification cost share | verify vs generate effort | T1 | mod | local |
| Model-fit savings | model × archetype × cost | T0 | mod | local |
| Cache-efficiency coaching | usage fields | T0 | ready | local |
| Context-bloat tax | tokens + compaction + rework | T0 | mod | local |
| Token-per-outcome | tokens ÷ surviving change | T1 | mod | local |
| Underused parallelism | serial sweeps, no Agent | T0 | mod | local |
| Missing automation | recurring prompts + Bash | T1b | mod | local |
| **Skill-creation opportunity** | recurrence + procedure + re-explain + no match | T1b | mod | local |
| Skill-vs-script disambiguation | decision/judgement content in cluster | T1 | mod | local |
| Skill-decay / over-fragmentation | skills inventory × invocation × clusters | T0/T1b | mod | local |
| Skill/tool blind spots | registered vs used | T0 | mod | local |
| Prompt-leverage gap | specificity vs rework | T1b | mod | local |
| **Session-quality score** | composite of above | T1 | mod | local |

## Metacognition ([05](05-metacognition.md))

| Insight | Signal source | Tier | Effort | Privacy |
|---|---|---|---|---|
| Goal-clarity in opening prompts | prompt classification | T1 | mod | local |
| Constraint articulation | constraint markers | T1 | mod | local |
| Premature solutioning | prescribe-before-explore | T1 | hard | local |
| Task-granularity | scope vs sub-steps | T1 | mod | local |
| Plan-mode adoption | permissionMode=plan + prompts | T0/T1 | ready | local |
| Scope-creep within session | topic drift + file growth | T1b | hard | local |
| Question vs assertion ratio | intent classification | T1 | mod | local |
| Assumption-checking | follow-up why-questions | T1 | hard | local |
| Reasoning-breakdown localisation | confusion-marker clusters | T1b | hard | local |
| Deep reasoning critique | Claude-assisted trace review | T2 | hard | egress |
| **Principles-alignment (own defaults)** | per-rule drift signals | T0/T1 | mod | local |

## Technology ([06](06-technology-analysis.md))

| Insight | Signal source | Tier | Effort | Privacy |
|---|---|---|---|---|
| Tech fingerprint per project | paths + manifests + commands | T1 | ready | local |
| Tech sprawl | weighted distinct stacks | T0 | mod | local |
| Cost-per-stack | metrics × fingerprint | T1 | mod | local |
| Error density per stack | errors × fingerprint | T1 | mod | local |
| Model-fit per stack | rework by model × tech | T1 | hard | local |
| Test-presence per stack | test-run ratio × tech | T1 | mod | local |
| Build/lint/format adoption | quality-gate commands | T1 | mod | local |
| Practice-alignment per stack | structure vs defaults | T1 | hard | local |
| Per-stack ramp cost | time-to-first-edit × tech | T0 | mod | local |
| Dependency / version drift | manifests (+advisories) | T1/T2 | mod | mixed |

## Trends ([07](07-trend-benchmarking.md))

| Insight | Signal source | Tier | Effort | Privacy |
|---|---|---|---|---|
| Personal baselines & deltas | historical metrics | T0+ | ready | local |
| Change-point detection | metric time-series | T0 | mod | local |
| Personal-best patterns | session-quality history | T1 | mod | local |
| Goal tracking | goal config vs metric | T0+ | mod | local |
| Curated public benchmarks | local metrics + bundled ref | T0 | mod | local |
| Live trend fetch | web fetch + compare | T2 | hard | egress |
| Cohort comparison (team) | T0 aggregates vs team | T0 | mod | egress |

## Reading the table for a build

- **Ship-first candidates:** everything `T0 · ready · local` — already-collected
  data, deterministic, no privacy escalation. That alone yields a credible
  mentor (see [`08-mentor-engine.md`](08-mentor-engine.md) §8.8).
- **High value, moderate cost:** `T1 · ready/mod · local` risk and productivity
  rows — the dangerous-command detector, run-before-claiming gap, file-thrash,
  session-quality score. These are where the mentor gets *interesting*.
- **Defer / gate:** anything `hard` or `T2 · egress` — high value but needs
  semantic scoring or consent; build once the local foundation has earned trust.
