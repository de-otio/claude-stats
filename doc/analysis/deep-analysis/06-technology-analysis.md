# 06 — Technology & Stack Analysis

Feedback specific to the technologies you actually work in: which stacks cost
you the most effort, where your error density is highest, where your tooling is
immature, and where the model itself struggles with your stack. Tech identity
is inferable from `cwd`, file paths in tool inputs, and command strings — so a
surprising amount is `T0`/`T1`-local.

## 6.1 Inferring the stack

**Tech fingerprint per project** — languages, frameworks, build/test tools.
**Signal:** file extensions in `Edit`/`Read`/`Write` paths; manifest files
(`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `*.tf`, `cdk.json`);
command verbs (`npm`, `cargo`, `pytest`, `terraform`, `kubectl`). **Data:**
tool input paths + Bash strings. **Tags:** `T1` · `ready` · `local`. **Mentor:**
*"Your active stacks: TypeScript (5 repos), Python (2), Terraform/CDK (2),
React Native (1)."*

**Tech sprawl** — breadth vs depth across projects. **Signal:** count of
distinct languages/frameworks weighted by usage. **Data:** fingerprints.
**Tags:** `T0` · `moderate` · `local`. **Mentor:** *"You touched 7 languages
this month; context-switching cost (time-to-first-edit) is highest in the two
you use least."*

## 6.2 Effort & friction per stack

**Cost-per-stack** — tokens/sessions/rework attributed by technology. **Signal:**
join session metrics to tech fingerprint. **Data:** metrics × fingerprint.
**Tags:** `T1` · `moderate` · `local`. **Mentor:** *"Terraform work costs 2.3×
the tokens per surviving change of your TypeScript work — the plan/apply loop
and HCL verbosity dominate."*

**Error density per stack** — where failed Bash runs / tool errors concentrate.
**Signal:** error-result rate bucketed by tech. **Data:** `tool_result` errors
× fingerprint. **Tags:** `T1` · `moderate` · `local`. **Mentor:** *"Your Python
sessions have the highest test-failure-loop rate; a stricter type setup
(pyright strict) would catch more before runtime."* — Echoes the owner's
Python-strict-typing default.

**Model-fit per stack** — does the model handle some of your stacks better?
**Signal:** rework/correction rate by (model × tech). **Data:** metrics ×
fingerprint. **Tags:** `T1` · `hard` · `local`. **Mentor:** *"Rework on your
Rust work drops noticeably on Opus vs Sonnet; on TS the two are equivalent —
route by stack."*

## 6.3 Tooling & practice maturity

**Test-presence per stack** — which technologies you test vs cowboy. **Signal:**
ratio of edit-sessions with a test run, per tech. **Data:** tool sequence ×
fingerprint. **Tags:** `T1` · `moderate` · `local`. **Mentor:** *"Your CDK/
infra changes are rarely followed by a synth/diff or test; that's your least-
verified stack."*

**Build/lint/format adoption** — are quality gates present and run? **Signal:**
presence of lint/format/typecheck commands in sessions per project. **Data:**
Bash strings. **Tags:** `T1` · `moderate` · `local`.

**Practice-alignment per stack** — adherence to the owner's stated defaults by
technology (typed languages, declarative-over-imperative, multi-env CDK).
**Signal:** detect e.g. single-env CDK apps, imperative deploy scripts, untyped
JS in new code. **Data:** file content + structure. **Tags:** `T1` · `hard` ·
`local`. **Mentor:** *"A new CDK app this month is single-environment; your
stated default is dev+prod from the outset."*

## 6.4 Knowledge & ramp

**Per-stack ramp cost** — exploration overhead before productivity, by tech.
**Signal:** time-to-first-edit and Read volume by stack. **Data:** timing × tech.
**Tags:** `T0` · `moderate` · `local`. **Mentor:** *"Your React Native ramp is
3× your TS ramp — a per-project notes/architecture file would amortise it."*

**Dependency & version drift (opt-in / local).** Surface aging or risky deps
seen in manifests across projects. **Signal:** parse manifests, optionally check
against advisory data. **Data:** manifest files (local) + advisory feed (`T2`).
**Tags:** `T1` local / `T2` for live advisories · `moderate` · mixed. **Mentor:**
*"Three projects pin a package with a known advisory; one has a public remote."*

## 6.5 Caveats

- **Inference, not declaration.** Stack detection from paths/commands is
  heuristic; a repo may be polyglot or mislabelled. Show confidence.
- **Local content for deep practice checks.** Judging "is this CDK
  multi-environment?" needs reading files (`T1`/sometimes `T2`); the mentor
  should say what tier produced the claim.
- **Don't moralise tool choice.** Report friction and cost; suggest, don't
  insist. The user picks the stack for reasons the data can't see.
