# 01 — Attribution signals and the accuracy ladder

The feature's promise is a number that will be defended in front of a skeptical
manager. That sets the quality bar: the failure mode is not fuzziness — it is a
reader finding **one obviously-wrong attribution** and discounting the entire
report. So every figure must carry *how it was attributed*, and the design must
be explicit about which signals it trusts how much.

## 1.1 What a ticket key looks like

Jira keys match `[A-Z][A-Z0-9]+-\d+` (`PROJ-123`, `AB2C-9`). For validation we
use a bounded form — `^[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}$` — everywhere a key is
stored or transmitted. This matters twice: locally it keeps extraction
low-noise, and on the wire it is what lets a ticket key cross to the org plane
without being free text (see [03 §3.2](03-org-plane-and-backend.md)).

False-positive sources to filter at extraction time: RFC/CVE-style identifiers,
ISO dates fragments, and all-caps words followed by numbers in prose
(`HTTP-2` never matches the two-char minimum prefix rule barely — keep an
org-configurable **project-key allowlist** (`["PROJ", "CORE", ...]`) as the
primary noise filter; with an allowlist configured, extraction precision is
essentially perfect).

## 1.2 The accuracy ladder

Ranked by trust, with what already exists in the codebase:

| Rung | Signal | Confidence | What exists today |
|---|---|---|---|
| 1 | **Explicit, contemporaneous link** — developer (or a session-start hook) links the session/messages to a key | high | `session_tags` table + CLI `tag` command (`packages/cli/src/store/index.ts:177`, `packages/cli/src/cli/index.ts:613`); no ticket semantics yet |
| 2 | **Branch name at message time** — `feature/PROJ-123-...` | high | branch is captured but **first-seen-only per session** (`packages/core/src/parser/session.ts:188`); per-message capture is a required change ([02 §2.3](02-local-data-model.md)) |
| 3 | **Commit subject** — `PROJ-123: fix ...` committed during/near the session | medium | commit subjects already collected per project per day by the recap pipeline (`packages/cli/src/recap/git.ts`) |
| 4 | **Key mentioned in prompt text** — user pasted the ticket into the prompt | low–medium | sanitized ≤2000-char `prompt_text` stored per turn since schema V8 (`packages/cli/src/store/index.ts:251`) |

Notes on the ranking:

- **Rung 1 beats everything** because it is intentional. The cheapest
  high-accuracy path for teams that want this is a session-start hook that
  reads the current branch, extracts the key, and writes the link — the
  developer changes no habits, and the link is contemporaneous rather than
  inferred after the fact.
- **Rung 2 is where the bulk of spend gets attributed** for branch-per-ticket
  teams, which is why fixing the first-seen-only capture is in scope: a session
  that switches branches mid-way mis-attributes everything after the switch,
  and long-lived sessions are exactly the expensive ones.
- **Rung 3 confirms more than it attributes**: the commit lands *after* the
  spend, and one commit may close work spread across several sessions. Use it
  to corroborate rung-2/4 links (upgrade confidence) and to catch sessions
  with no branch signal (e.g. work on `main`).
- **Rung 4 is suggestive only.** A prompt can mention `PROJ-123` while doing
  work for `PROJ-456` ("same bug as PROJ-123?"). It earns medium confidence
  only when the same key also appears in rung 2 or 3 for the same session.

## 1.3 Attribution unit: message ranges, not just sessions

The natural grain is the session, but sessions span tickets: a developer
finishes PROJ-123, gets a review comment on PROJ-99, and handles it in the same
window. Two mechanisms keep this honest:

1. **Per-message branch** ([02 §2.3](02-local-data-model.md)) splits a session
   at branch switches for free.
2. Where only session-level evidence exists (rung 1 tag, rung 3 commit), the
   link applies to the whole session and says so — `granularity: session` vs
   `granularity: messages` on the link record. A session with links to two
   tickets and no message-level evidence is reported as **ambiguous**, its cost
   shown under both keys with an "overlapping" marker — never silently split
   50/50. Invented precision is the discrediting kind.

**Subagent sessions** fold into their parent via the existing
`parent_session_id` / `is_subagent` columns (schema V9,
`packages/cli/src/store/index.ts:261`), the same way `get_cost_per_task`
already folds them (`packages/cli/src/recap/index.ts:1013`). A subagent
inherits its parent's ticket links unless it has stronger evidence of its own.

## 1.4 The denominator is the harder half

Per-ticket cost only convinces if the *unattributed remainder* is small and
explainable. Real usage includes work that legitimately maps to no ticket:
exploration, code review, CI debugging, learning a codebase, tooling. Two
consequences:

1. **Coverage is a first-class output**: "83% of this month's spend is
   ticket-attributable" belongs next to every per-ticket table, and the
   *trend* of that number (it rises as tagging habits and hooks land) is
   itself part of the story a developer tells.
2. **Never force-map overhead onto tickets** to flatter coverage. A
   "non-ticket work" category with its own breakdown — the existing topic
   clustering in `get_cost_per_task` can label it (review, debugging,
   exploration) — is more credible and actively *helps* the developer's case:
   "40% of my usage is review and maintenance, which no ticket captures" is an
   argument for the budget, not against it.

## 1.5 Evidence travels with the number

Every link record stores `source` (tag | branch | commit | prompt),
`confidence` (high | medium | low), and the matched evidence (the branch name
or commit subject — locally only; evidence text never syncs, see
[03 §3.2](03-org-plane-and-backend.md)). Every report renders totals **tiered
by confidence** — "€X high, €Y medium, €Z low, €W unattributed" — and lets the
reader drill from a ticket row to the sessions and the evidence behind it.
That drill-down is what survives the skeptical-manager test: the answer to
"why do you claim PROJ-123 cost €41?" is on screen, not in a methodology
footnote.
