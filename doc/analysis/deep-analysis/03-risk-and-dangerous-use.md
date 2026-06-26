# 03 — Risk & Dangerous Use  *(priority)*

The most valuable thing a mentor can do is catch habits that are *cheap now but
expensive later*: changes that ship unverified, trust extended without checking,
destructive commands run on reflex. These are the AI-assisted-development
failure modes — and several are directly observable in the data, because Claude
Code records `permissionMode`, the actual tool inputs, and the timing between a
change and your next move.

This is the catalog's deepest section. Insights are grouped by failure family.
Each names the **proxy nature** of its signal honestly — almost none can *prove*
negligence; they flag patterns worth a second look.

> **Framing note.** The point isn't to scold. Most of these habits are rational
> shortcuts that occasionally bite. The mentor's job is to surface the *rate*
> and the *context* ("twice this week, on `main`") so you can decide if the
> shortcut still pays.

## 3.1 Unverified change (the headline risk)

**Unread-diff acceptance** — large edits accepted with no plausible review
pause. **Signal:** `Edit`/`Write`/`MultiEdit` `tool_use` whose diff size is
large, under `permissionMode ∈ {acceptEdits, bypassPermissions}`, followed by
the next user turn in < N seconds (too fast to have read it). **Data:** tool
input sizes + `permissionMode` + timestamps. **Tags:** `T0` (timing/size) →
`T1` (diff content) · `ready` · `local`. **Mentor:** *"You accepted 14 edits
(>50 lines each) this week with no review pause; 9 in `acceptEdits` mode. Two
landed on `main`."* — This is the single highest-value risk insight and is
mostly `T0`.

**Auto-accept exposure** — share of all mutating actions taken under
`acceptEdits` / `bypassPermissions`. **Signal:** count mutating `tool_use`
(Edit/Write/Bash-that-writes) by `permissionMode`. **Data:** `permissionMode` +
tool names. **Tags:** `T0` · `ready` · `local`. **Mentor:** *"68% of your edits
this month were auto-accepted. That's fine for throwaway scripts; you also did
it in two production-config repos."*

**Run-before-claiming gap** — claiming "done"/"works"/"fixed" with no test or
app run in between. **Signal:** assistant text asserting completion *not*
preceded (within the turn window) by a test/build/run `Bash` invocation or a
verify step. **Data:** response text + tool sequence. **Tags:** `T1` ·
`moderate` · `local`. **Mentor:** *"In 5 sessions a fix was declared complete
with no test/run between the edit and the claim."* — Directly enforces the
owner's own default #10.

**Test-after-edit ratio** — edits followed by a test execution vs edits left
untested. **Signal:** for each edit cluster, was there a subsequent test/build
`Bash` call before session end or next feature? **Data:** tool sequence +
command strings. **Tags:** `T1` · `moderate` · `local`. **Mentor:** *"Only 30%
of your edit bursts were followed by a test run."*

**Commit-without-review** — `git commit` issued moments after a large
AI-generated diff with no intervening read/test. **Signal:** `git commit` Bash
command shortly after big edit, no test/diff-review between. **Data:** Bash
command strings + tool sequence + timing. **Tags:** `T1` · `moderate` ·
`local`.

## 3.2 Destructive & dangerous commands

**Dangerous-command detector** — the actual `Bash` inputs matched against a
risk lexicon. **Signal:** regex over `tool_use.input.command` for
`rm -rf`, `git push --force*`, `git reset --hard`, `git clean -fdx`,
`DROP`/`TRUNCATE`/`DELETE FROM … (no WHERE)`, `curl … | sh`, `chmod 777`,
`kubectl delete`, `terraform destroy`, `cdk destroy`, `aws … delete|terminate`,
`:(){ :|:& };:`. **Data:** Bash command strings. **Tags:** `T1` · `ready` ·
`local`. **Mentor:** *"3 force-pushes and one `rm -rf` outside a temp dir this
week — all auto-approved."* This mirrors the owner's CLAUDE.md "Safety
guardrails" list, so the lexicon can be lifted directly from stated policy.

**Prod-target detector** — write operations whose command/args smell of
production. **Signal:** command contains `prod`/`production`/`live`/`main` near
a mutating verb, or a connection string / profile that matches a prod pattern.
**Data:** Bash command strings, env hints. **Tags:** `T1` · `moderate` ·
`local`. **Mentor:** *"A migration ran against a connection string containing
`prod` with no confirmation step in the transcript."*

**Pipe-to-shell / supply-chain** — `curl|sh`, `npx` of unpinned packages,
installing from arbitrary URLs. **Signal:** command-string patterns. **Data:**
Bash strings. **Tags:** `T1` · `ready` · `local`.

## 3.3 Branch & change-management hygiene

**Direct-to-default-branch work** — committing/editing on `main`/`master`
rather than a feature branch. **Signal:** mutating actions while
`gitBranch ∈ {main, master}`. **Data:** `gitBranch` + tool names. **Tags:**
`T0` · `ready` · `local`. **Mentor:** *"31% of your edits this month were made
directly on `main`."*

**Oversized change** — diffs too large to review in one sitting (violates the
owner's default #9). **Signal:** cumulative changed-line count between commits,
or per-edit `new_string` size distribution; file-history churn per session.
**Data:** edit sizes + file-history. **Tags:** `T0`(churn)/`T1`(line counts) ·
`moderate` · `local`. **Mentor:** *"This branch accumulated ~900 changed lines
across 11 files before its first commit — past your one-session review budget."*

**Uncommitted-work accumulation** — long sessions, many edits, no commit.
**Signal:** edit count and session span with zero `git commit` Bash calls.
**Data:** tool sequence. **Tags:** `T1` · `moderate` · `local`.

## 3.4 Trust-without-verification

**Tool-result blind trust** — accepting a tool result (search output, test
result, API response) and acting on it with no inspection. **Signal:** large
`tool_result` immediately followed by a confident action with no Read/grep of
the result. *Inherently a weak proxy* — label it. **Data:** result sizes + tool
sequence. **Tags:** `T1` · `hard` · `local`.

**Hallucination-exposure surface** — acting on file paths / APIs / symbols
that don't exist. **Signal:** `Edit`/`Read` targeting a path that errors as
not-found, then retried — counts of "referenced something that wasn't there".
**Data:** `tool_result` errors. **Tags:** `T1` · `moderate` · `local`.
**Mentor:** *"7 edits this week targeted files that didn't exist yet — a sign
of acting before grounding in the codebase."*

**Spec-skipping before big change** — large implementation with no preceding
plan/spec/acceptance criteria (violates owner default #17). **Signal:** large
edit burst in a session whose opening prompts contain no constraints/criteria
and no plan-mode usage. **Data:** prompt text + `permissionMode=plan` usage +
edit size. **Tags:** `T1` · `moderate` · `local`. **Mentor:** *"Three large
features this month went straight to code with no spec or plan step."*

## 3.5 Secrets & data exposure

**Secret-in-prompt detector** — credentials pasted into prompts or surfaced in
tool inputs. **Signal:** secret/PII regex (the existing scrubber's patterns)
over prompt text, `pastedContents`, and Bash command strings. **Data:** prompt
+ paste + command text. **Tags:** `T1` · `ready` · `local`. **Mentor:** *"A
value matching an API-key pattern appeared in a prompt on 2026-05-12 — rotate
if real."* — Runs entirely locally; never echoes the matched value (see the
owner's confidentiality rules).

**Confidential-name leakage (repo-aware)** — customer/employer names written
into a repo with a public remote. **Signal:** scan written-file content for a
configured deny-set when `git remote` resolves to a public host. **Data:** file
content + git remote. **Tags:** `T1` · `moderate` · `local`. **Mentor:** *"A
deny-set term was written to a file in a repo with a public GitHub remote."* —
This is exactly the `repo-aegis` use case from the owner's CLAUDE.md; the mentor
can surface a *trend* ("near-misses rising") rather than just per-write hits.

## 3.6 Over-reliance & skill atrophy

**Dependence ratio** — share of changes generated wholesale by Claude vs
authored/edited by you. **Signal:** AI-`Write`/`Edit` volume vs manual file
edits visible in file-history not attributable to a tool call. **Data:**
file-history vs tool edits. **Tags:** `T0` · `hard` · `local`. *Proxy; label
clearly.* **Mentor:** *"95% of code changes in this project originated from
Claude edits. Worth occasionally hand-writing the tricky parts to keep the
mental model fresh."*

**Comprehension-check absence** — never asking "why" / "explain this" before
accepting non-trivial generated logic. **Signal:** ratio of explanatory
questions to acceptances on complex diffs. **Data:** prompt text + diff
complexity. **Tags:** `T1` · `hard` · `local`.

## 3.7 Scoring & calibration

Risk insights must not become a wall of red. Proposed shape:

- **Per-family rate, not raw count.** "12% of edits unreviewed" beats "47
  unreviewed edits" — rate is comparable across volume.
- **Context weighting.** The same action is riskier on `main`, in a prod-named
  repo, or under `bypassPermissions`. Weight accordingly.
- **A single composite "guardrail index"** (0–100) trended over time, decomposed
  into families on demand — so the mentor leads with one number and drills down.
- **Calibrated thresholds.** Start permissive; only flag once a behaviour
  exceeds *your own* trailing baseline or a clearly dangerous absolute (a
  force-push to `main` is always worth a line).
- **T2 escalation for ambiguity.** When a heuristic is uncertain (is this Bash
  command actually dangerous in context?), *offer* a Claude-assisted judgement
  rather than guessing — opt-in, per the tier model.

See [`08-mentor-engine.md`](08-mentor-engine.md) for how these surface without
becoming noise, and [`09-metric-reference.md`](09-metric-reference.md) for the
consolidated signal table.
