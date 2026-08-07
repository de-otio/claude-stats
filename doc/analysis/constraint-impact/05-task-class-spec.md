# 05 — The task-class classification spec

[03 §3.2](03-measurement-mechanics.md) names the stable task-class taxonomy as
Gap 1 — the main piece of new work the constraint-impact report needs. This
file is that taxonomy's specification. It is written **before** the classifier
exists, so the classifier can be judged against it rather than described by it.

The rule this document is held to: **a class that cannot be separated from its
neighbour by a stated rule over stored signals is not a class.** Where the
stored data cannot make a distinction, this spec merges the classes or drops
one — it does not name a class the implementation would then have to guess at.

## 5.1 What the classifier is for, and what that demands of it

The classifier exists so that [02](02-model-policy-impact.md)'s before/after
comparison runs **within** a class. Its output feeds the tier-mismatch detector
and the constraint before/after engine, both of which produce figures a
developer will put in front of the manager who made the policy decision.

Four properties follow, and they are requirements rather than preferences:

1. **Deterministic.** The same session classifies the same way forever. No
   clock, no RNG, no model call, no dependence on what else is in the store. A
   class that drifts cannot anchor a comparison across a months-long boundary.
2. **Version-stamped.** Every stored classification carries the classifier
   version that produced it. A rule change is itself a timeline annotation
   ([03 §3.2](03-measurement-mechanics.md)), and a store holding two versions
   must be able to say so rather than silently mixing them.
3. **Abstaining.** `unknown` is a first-class outcome, not a failure. A
   confidently-wrong class is worse than no class, because it survives into a
   per-class delta that the reader has no way to audit.
4. **Ungameable.** The vocabulary and the thresholds are fixed and ship with
   the report. Classes cannot be redrawn to manufacture a result
   ([02 §2.6](02-model-policy-impact.md)).

## 5.2 The signals available (and the one deliberately not used)

Everything below is already stored per message or per session. No new parsing,
no new collection.

| Signal | Source | Notes |
|---|---|---|
| Tool names per message | `messages.tools` (V1) | The primary signal |
| File paths touched | `messages.file_paths` (V10) | Empty for rows ingested before V10 |
| Failed tool calls | `messages.tool_error_count` (V11) | `is_error` tool_results |
| Real user turns | `messages.is_turn_start` (V18) | Distinguishes prompts from tool results |
| Assistant message count | `messages` row count | |

**Prompt text is deliberately NOT a classifier input in v1**, although
[03 §3.2](03-measurement-mechanics.md) lists "prompt-shape features" among the
candidates. Three reasons, in order of weight:

- **It is not reliably there.** `prompt_text` arrived in V8 and is captured
  only on turn-start messages. A signal absent for a chunk of the history is
  worse than no signal for a comparison whose whole point is spanning a
  boundary that may pre-date it.
- **It is language-dependent.** A lexicon of English verbs would classify a
  German-speaking developer's sessions as `unknown` and quietly shrink their
  denominators. The tool ships in ten locales.
- **It is the highest-risk surface in the codebase.** Prompt text carries
  customer names and secrets. The precedent set by the outcome model
  (`cost-per-task/outcome-types.ts`) is that detectors may read prompt text
  but may emit only closed enum tags. Not reading it at all is strictly safer,
  and v1 does not need it for any class it actually ships.

The cost of that decision is stated plainly in §5.4: it is what forces `review`
and `explore` to merge.

## 5.3 The feature vector

Pure aggregates over a session's messages, all order-independent (a session's
class must not depend on the order rows come back from SQLite).

| Feature | Definition |
|---|---|
| `toolCalls` | Σ tool-call count over all messages |
| `editCalls` | Σ calls to `Edit`, `MultiEdit`, `NotebookEdit` |
| `writeCalls` | Σ calls to `Write` |
| `mutatingCalls` | `editCalls + writeCalls` |
| `readCalls`, `searchCalls`, `bashCalls` | `Read`; `Grep`+`Glob`; `Bash` |
| `filesTouched` | Distinct file paths seen anywhere, reads included |
| `editedFiles` | Distinct file paths the session appears to have **changed** |
| `configFiles` | Of `editedFiles`, paths matching the config/infra rule (§5.6) |
| `proseFiles` | Of `editedFiles`, paths matching the prose rule (§5.6) |
| `toolErrors` | Σ `tool_error_count` |
| `turns` | Σ `is_turn_start`, else assistant-message count |

Derived shares: `mutatingShare`, `bashShare` (of `toolCalls`); `configShare`,
`proseShare` (of `editedFiles`); `errorRate = toolErrors / toolCalls`.

**Every file-count rule keys on `editedFiles`, never on `filesTouched`.**
`messages.file_paths` records the path argument of any file-taking tool, reads
included, so files-touched measures breadth of *attention*. Keying the sweep
rule on it would report "read ten files, edit one heavily" — a focused change
informed by wide reading — as a multi-file refactor, which is a confidently
wrong label in the class most likely to be quoted in a tier argument.
`filesTouched` is still derived and carried for context; no rule reads it.

Attributing a path to a change is an approximation, and this is its ceiling:
tool names and path arguments are stored per message but not paired, so a
message containing at least one mutating tool has all of its paths attributed
to the change. That over-counts when one message mixes a Read and an Edit. It
is the same approximation `cost-per-task/evidence/gather.ts` already makes when
building edit events; pairing them properly would need a parser change.

Rows ingested before V10 carry no paths at all. Every rule that consumes a file
count requires a **positive** one — the shares have a zero denominator and the
sweep floor is unreachable — so pre-V10 history is never read as "changed zero
files"; it abstains.

## 5.4 The classes

The vocabulary is fixed by `TaskClass` in `packages/core/src/types/insight.ts`.
This spec decides which members v1 **emits**; the emitted set is a strict
subset, and the version stamp is what makes a later widening detectable.

### Emitted

**`debug` — error-driven or execution-driven work on a narrow surface.**
Inclusion: a meaningful density of failed tool calls on few files, or a session
dominated by running things with almost no mutation. Exclusion: broad edit
sweeps, which are `refactor-multi-file` even when a test fails along the way.

**`greenfield` — writing new files.** Inclusion: `Write` is at least half the
mutation and there are at least two of them. Exclusion: a single `Write` beside
many `Edit`s (that is a refactor that happened to add a file).

**`config-chore` — configuration and infrastructure maintenance.** Inclusion:
mutating, with file evidence, and at least three-quarters of the touched files
are config/infra by the path rule. Exclusion: a config file touched incidentally
during a code change — the three-quarters floor is what keeps it out.

**`refactor-multi-file` — a broad multi-file edit sweep.** Inclusion: at least
four distinct files and at least five edit calls. **Operational honesty:** this
class means "broad edit sweep", not "refactor" in the intentional sense. No
stored signal distinguishes a rename sweep from a feature implementation that
touched six files. Reports must use the operational wording.

**`explore` — non-mutating work: reading, searching, and answering.**
Inclusion: no mutation and no diagnosis signal.

**`unknown` — the classifier declines.** Three reasons, each recorded:
`sparse` (too little tool activity to carry a signal), `prose-dominant` (a
mutating session whose files are overwhelmingly documentation — see below), and
`below-threshold` (a mutating session that fires no build rule; typically a
small targeted edit).

### Not emitted, and why

**`review` is merged into `explore`.** A review session and an exploration
session are both non-mutating reads of a codebase. The only signal that could
separate them is intent, which lives in prompt text — excluded by §5.2. Bash
arguments would show `git diff`, but only tool *names* are stored, not their
inputs. There is no rule, so there is no class: v1 emits `explore` for all
non-mutating sessions, and that bucket contains both. The `review` member stays
in the type as reserved vocabulary for a version that has a signal for it.

**There is no documentation class**, and inventing one would change a shared
type mid-flight. A prose-dominant mutating session that would otherwise be
`refactor-multi-file` is therefore returned as `unknown` / `prose-dominant`
rather than being reported as a code refactor. That is a deliberate hole in
coverage in preference to a wrong label in a per-class delta.

**There is no "small targeted edit" class.** The single most common session
shape has no member in the fixed vocabulary. It is returned as `unknown` /
`below-threshold` at the fine grain — and rescued at the coarse grain, which
is the point of §5.5.

## 5.5 The coarse taxonomy is not a fallback mode — it is always computed

`CoarseTaskClass` (`build | diagnose | support | unknown`) is computed for
**every** session, alongside the fine class, in the same pass.

- `build` — the session changed code.
- `diagnose` — the session was error- or execution-driven.
- `support` — the session read without changing anything.

The relation is fixed: `debug → diagnose`; `greenfield`,
`refactor-multi-file`, `config-chore` → `build`; `explore`, `review` →
`support`. When the fine class is decided, the coarse class is its image under
that map — enforced by construction so the two can never disagree. When the
fine class abstains, coarse rules decide independently, and they abstain only
on `sparse`.

This is what makes the mandated fallback structural rather than a mode switch.
A consumer that cannot get a defensible fine-grained number reads the coarse
column and still gets a per-class comparison over essentially the whole corpus;
the honest cost is three buckets instead of five. The report states which grain
it used, and §5.8 fixes when it is allowed to use which.

## 5.6 Path rules

Matched by extension, basename, or path segment using set lookup only. **No
regular expression is applied to a file path** — the same ReDoS guard the
archetype classifier documents (`cost-per-task/efficiency/archetype.ts`).

- **Config/infra extensions:** `.json .yaml .yml .toml .ini .cfg .conf .env
  .properties .lock .tf .tfvars .hcl .gradle .bzl .plist`
- **Config basenames:** `dockerfile makefile procfile .gitignore .dockerignore
  .npmrc .nvmrc .editorconfig .eslintrc .prettierrc .babelrc .gitattributes`
- **Config segments:** `.github .circleci .gitlab .vscode k8s helm charts
  terraform deploy`
- **Prose extensions:** `.md .mdx .txt .rst .adoc`

`package-lock.json` lands in config by extension, which is correct: a lockfile
churn session is config-chore work.

## 5.7 The decision procedure

First match wins. Evaluated in this order, and the order is load-bearing.

| # | Rule | Condition | Result |
|---|---|---|---|
| R0 | `sparse` | `toolCalls < 3` | `unknown` / `sparse` |
| R1 | `diagnosis` | see below | `debug` |
| R2 | `write-dominant` | `mutatingCalls > 0` ∧ `writeCalls ≥ 2` ∧ `writeCalls / mutatingCalls ≥ 0.5` | `greenfield` |
| R3 | `config-dominant` | `editedFiles > 0` ∧ `configShare ≥ 0.75` | `config-chore` |
| R4 | `prose-dominant` | `editedFiles > 0` ∧ `proseShare ≥ 0.75` | `unknown` / `prose-dominant` |
| R5 | `multi-file-sweep` | `editedFiles ≥ 4` ∧ `editCalls ≥ 5` | `refactor-multi-file` |
| R6 | `non-mutating` | `mutatingCalls === 0` | `explore` |
| R7 | fallback | — | `unknown` / `below-threshold` |

R1's condition is a disjunction of two independent shapes:

```
(toolErrors ≥ 2 ∧ errorRate ≥ 0.12 ∧ (mutatingCalls = 0 ∨ editedFiles ≤ 3))
∨ (bashCalls ≥ 6 ∧ bashShare ≥ 0.5 ∧ mutatingShare ≤ 0.15)
```

The first is failure-driven work; the narrow-surface conjunct is what keeps a
broad sweep with one flaky test out of `debug`. The second is
execution-dominant investigation — running things repeatedly while changing
almost nothing.

**Why R1 precedes the build rules.** A session can be both error-driven and
multi-file. Binning it as `debug` narrows the class the tier-removal analysis
cares most about; binning it as a refactor would dilute it. The narrow-surface
conjunct bounds the damage: only sessions on ≤ 3 files can be pulled out of the
sweep rules by the error clause.

**Why R4 precedes R5.** Otherwise every documentation sweep is reported as a
code refactor, and the class most likely to be quoted in a tier argument would
be contaminated by the class least affected by model tier.

### Thresholds

| Constant | Value | Rationale |
|---|---|---|
| `MIN_TOOL_CALLS` | 3 | Below this, tool shares are noise |
| `ERROR_MIN_COUNT` / `ERROR_RATE_FLOOR` | 2 / 0.12 | Both required — a rate off one call is not a signal |
| `DEBUG_MAX_FILES` | 3 | The narrow-surface bound on the error clause |
| `BASH_MIN_CALLS` / `BASH_SHARE_FLOOR` / `BASH_MUTATION_CEILING` | 6 / 0.5 / 0.15 | Execution-dominant with near-zero mutation |
| `GREENFIELD_MIN_WRITES` / `GREENFIELD_WRITE_SHARE` | 2 / 0.5 | One `Write` is not a greenfield session |
| `CONFIG_SHARE_FLOOR`, `PROSE_SHARE_FLOOR` | 0.75 | Dominance, not incidence |
| `REFACTOR_MIN_FILES` / `REFACTOR_MIN_EDITS` | 4 / 5 | Matches `MULTI_FILE_THRESHOLD` in the shipped archetype classifier |

`REFACTOR_MIN_FILES` is deliberately the same 4 the value-per-cost archetype
classifier already uses, so the two never disagree about what "multi-file"
means in the same product.

### Confidence

Every classification carries a `Confidence`. `unknown` is always `low`. A fired
rule is `medium` by default and `high` when its deciding signal is unambiguous:
`errorRate ≥ 0.25` or `bashCalls ≥ 12` (R1); `writeShare ≥ 0.7` ∧
`writeCalls ≥ 3` (R2); `configShare = 1` ∧ `configFiles ≥ 2` (R3);
`editedFiles ≥ 6` ∧ `editCalls ≥ 8` (R5); `toolCalls ≥ 8` (R6).

## 5.8 Falsification: the corpus and the agreement thresholds

The classifier is falsifiable only against labelled data, and real sessions
cannot be committed to this repository (transcript paths and prompts carry
customer names). The corpus is therefore **generated** from behavioural
recipes: each recipe is a prose description of what a developer did, turned
into a plausible tool/file/error trace with seeded noise. The label is the
recipe's identity; the classifier sees only the derived signals.

**What that ground truth is and is not.** It is the generator's intent, not a
human's reading of a real session. It measures whether the rules recover the
behaviour that produced a trace — which is exactly what the rules claim to do —
and it does not measure whether the recipes resemble real developers. The
recipes are written from the narratives in §5.4 without reference to the
threshold table, so agreement is a measurement rather than a tautology; the
honest residual risk is that recipe authorship and rule authorship share an
author. Reports quoting per-class figures carry this limitation.

The corpus includes **ambiguous recipes** whose label is "should abstain".
A classifier that scores well on decidable recipes while confidently labelling
these has failed, not passed.

**Release thresholds:**

| Grain | Threshold |
|---|---|
| Fine | overall agreement ≥ 0.80 on decidable recipes, **and** no emitted class below 0.60 recall |
| Coarse | overall agreement ≥ 0.90 on decidable recipes |
| Abstention | ≥ 0.70 of ambiguous recipes returned as `unknown` |

If the fine grain misses either of its conditions, **the coarse grain is the
one the reports use**, the fine column stays stored but is marked
not-report-grade, and both this spec and the shipping notes say so. Shipping a
five-class taxonomy the corpus does not support would be precisely the
"confident number that is quietly wrong" the whole suite exists to prevent.

The measured numbers live in the classifier's test file and in this file's
§5.10, which is updated whenever the thresholds or rules move.

## 5.9 Storage and invalidation

Schema **V21** (`session_task_class`, pre-allocated to this lane in the build
plan) holds one row per session: the fine class, the coarse class, the
confidence, the rule id that decided, the abstain reason, the **classifier
version**, and the classification timestamp.

The version stamp is the invalidation mechanism. Sessions with no row, or with
a row at a version below the current one, are what the classify pass selects;
the pass is therefore idempotent and resumable, and a rule change reclassifies
exactly the affected corpus with no manual purge. A store holding rows at more
than one version can report that fact, so a mixed-version comparison is visible
rather than silent.

`taskClass` and `coarseTaskClass` join the filter-symmetry contract as
narrowing dimensions in **both** halves — `getSessions` and
`buildMessageFilter`. Phase 0 deliberately deferred this because there was no
table to filter against.

## 5.10 Measured agreement (v1)

Measured against the generated corpus of §5.8 — 14 recipes (11 decidable, 3
ambiguous), 20 sessions each: **220 decidable + 60 ambiguous**. Seeded;
reproduced by `packages/cli/src/__tests__/task-class-agreement.test.ts`, which
prints these figures on every run.

| Grain | Measured | Threshold | Verdict |
|---|---|---|---|
| Fine, overall | **0.968** | ≥ 0.80 | pass |
| Fine, worst per-class recall | **0.875** (`refactor-multi-file`) | ≥ 0.60 | pass |
| Coarse, overall | **0.991** | ≥ 0.90 | pass |
| Abstention on ambiguous recipes | **1.000** | ≥ 0.70 | pass |

Per-class recall: `config-chore` 1.000 (40/40) · `debug` 0.967 (58/60) ·
`explore` 1.000 (40/40) · `greenfield` 1.000 (40/40) ·
`refactor-multi-file` 0.875 (35/40).

**The fine grain ships.** Both of its conditions are met, so reports may use it,
and the coarse column stays alongside as the always-computed companion rather
than a fallback that had to be activated.

### How it fails matters more than how often

Of the 7 fine-grain misses, **5 were abstentions and 2 were a wrong class.**
That ratio is the design premise holding: an abstention costs coverage, a wrong
label costs credibility, and the rules err toward the cheaper mistake. The
abstentions are `cross-module-feature` draws that landed on exactly 4 files and
4 edits — one edit short of `REFACTOR_MIN_EDITS` — which fall to
`unknown` / `below-threshold` with a coarse class of `build`. That is the
intended behaviour at a threshold boundary, not a defect. A test asserts the
ratio never inverts.

Agreement was re-measured at 7 and 35 sessions per recipe, drawing different
seeded traces, and clears every floor at all three sizes. A threshold set fitted
to one draw would not.

### The corpus caught a real defect

An earlier draft of the rules keyed the file-count conditions on files
**seen** rather than files **changed**, because `messages.file_paths` records
the path argument of reads too. That reported "read eight files, edit one
heavily" as a multi-file refactor — a confidently wrong label in the class most
likely to be quoted in a tier argument, and precisely the failure mode §5.1
lists as the reason to abstain.

The corpus did not catch it, because every recipe read and edited the same
files, so files-seen and files-changed coincided. The rules were fixed (§5.3)
and a `focused-fix-wide-read` recipe added, which is now one of the three
ambiguous recipes and abstains correctly. That gap is worth recording: a
generated corpus only falsifies the shapes its author thought to generate, and
the aggregate agreement figure was blind to a defect that a single missing
recipe hid.

### Read these numbers with §5.8's limitation in front of them

They say the rules recover the behaviour the recipes encode; they do not say the
recipes are a representative sample of real work, and a figure this high is
itself evidence that generator and rules share an author. The number that would
move a manager is agreement against *human-labelled real sessions*, which this
repository cannot hold. The first team to run this locally should label a few
dozen of their own sessions and re-measure. Until then the fine grain is
**report-grade under a stated caveat**, not report-grade unconditionally, and
any surface quoting a per-class figure carries the caveat with it.

The threshold table in §5.8 is nevertheless the gate that matters, because it
was written before the measurement and is what a future rule change is held to.
