# 09 — Historical account split without hand-labelling

Manual labelling (doc [08](08-manual-labelling.md)) is the *escape hatch*, not the
plan: hand-tagging ~960 historical sessions is impractical. This doc finds the
signals that let us attribute a **multi-account back-catalogue automatically**,
from a handful of seeds, and specifies the mechanism.

The premise (doc [03](03-attribution-methods.md)): the timeline is forward-only
and single-account backfill (doc 03 §D.1) abstains once ≥2 accounts are seen. So
pre-observation history across two accounts needs *something else*.

## What the data actually offers (measured, not assumed)

Empirical scan of the local store + transcripts (counts only; no identifying
values), cross-checked against the official docs:

| Signal | Verdict | Evidence |
|---|---|---|
| Account in transcript `*.jsonl` | ❌ **absent** | Scanned 10k+ lines / 64 files → 1540 distinct keys, **none** an account/org/subscription id. Docs confirm: account/org/email are *"only sent to the configured OpenTelemetry exporter, never to local transcript files."* |
| Historical telemetry files | ❌ **negligible** | `~/.claude/telemetry/` = 2 files / 29 lines, **0** sessionIds, **0** accounts (failed-event dumps only). |
| `~/.claude.json.backup` anchor | ❌ **same account** | backup holds the *current* account → no historical switch captured (doc 03 §D.2 was opportunistic). |
| `userID` fingerprint | ❌ **not account-derived** | Docs: `user.id` is *"a random anonymous identifier … not derived from your Claude account"*, persisted per-install. Kills doc 03 §D.4. |
| `message.usage.service_tier` | ⚠️ weak | Present per message, but reflects the *request* tier (standard/priority/batch), not the account; both plans commonly resolve to the same tier. |
| **Project / repo affinity** | ✅ **strong** | 961 sessions over **94 projects**; **23 projects cover 80%**, 59 cover 95%. Work vs personal is project-aligned. |
| **5-hour usage-window co-membership** | ✅ **strong, cross-surface** | Docs: the 5-hour limit is **per account** and *"usage of all Claude surfaces (claude.ai, Claude Code, Claude Desktop) counts toward the same limit."* So one window = one account, spanning surfaces. |
| Forward observation timeline | ✅ seed source | Once 0.11.x runs, CLI sessions get attributed → seeds. |
| OTEL export | ✅ exact, forward, opt-in | `user.account_uuid` etc. — gold standard going forward, and validates inference. |

Two facts reframe the problem:

1. **26% of sessions are non-CLI** (vscode / claude-vscode / desktop) and are
   *unattributable* by the CLI timeline. Any per-session method leaves a quarter
   of history blank.
2. The account is **project-aligned** and the 5-hour window is **per-account
   across surfaces**. These two are surface-independent — they can attribute the
   non-CLI 26% too.

## The solution — seed-and-propagate

Model attribution as **label propagation** over a graph of sessions. A few
sessions are *seeded* with a known account; edges connect sessions that almost
certainly share one; labels spread from seeds to the rest. No per-session
labelling.

### Seeds (known account), strongest first
- **OTEL** events (authoritative) — if enabled.
- **Forward observation timeline** — CLI sessions attributed once 0.11.x runs.
- **Anchor pins** (live sessions, doc [08]/#31).
- **User *project* labels** (doc 08) — but at project granularity (≤ tens), and
  only for projects never seen forward.

### Affinity edges (same account, high probability)
1. **Project edge** — sessions sharing `project_path` (or `repo_url`). A project
   is worked under one account; this **bridges time** (a forward-seeded session
   pins that project's whole history). Strongest and highest-coverage.
2. **Window edge** — sessions whose activity falls in the same **5-hour usage
   window**. Per-account and cross-surface (doc-confirmed), so this **bridges
   surfaces**: a CLI seed pins the vscode/desktop sessions sharing its window.
3. **Contiguity edge** — temporally adjacent sessions with no detected login
   switch between them (largely subsumed by the window edge).

### Propagate + score
Spread seed labels through edges to a fixpoint over each connected component.
Confidence from agreement:
- **authoritative/high** — directly seeded (OTEL / observation / anchor / label).
- **high** — project *and* window edges agree.
- **medium** — reached via a single edge type.
- **low / conflict** — edges disagree (e.g. a repo genuinely used by both
  accounts): do **not** force it; leave `unknown` and surface it for a one-click
  project label. Never guess silently (doc [05](05-reliability-validation-and-limitations.md)).

### Why it converges here
- Forward use re-touches the active projects → they self-seed, and the project
  edge pins their back-catalogue automatically (**zero** input).
- The window edge folds in the non-CLI 26% that no per-session method reaches.
- Only projects **abandoned before** attribution began need a seed — a *handful*
  of project labels, not ~960 session tags. With 23 projects at 80% coverage, a
  dozen confirmations plus forward seeds realistically resolve the bulk at
  medium-or-better confidence.

## Precedence & storage

Propagated attributions are inferred, so they sit at the **`backfill`** rank
(below `observation`, above `unknown`) with `confidence ∈ {medium, low}` — the
monotonic guard already lets a later `observation`/`telemetry`/`otel`/`anchor`
signal upgrade them, and `reattribute` recomputes them from seeds each run
(idempotent). No new precedence rank; reuse `backfill` with a `method` note
(`propagated`) for provenance. Durable inputs (project labels) live in the doc 08
`account_label_rules` table; everything else is recomputed.

## Implementation sketch (phased)

1. **Pure core** `attribution/propagate.ts` — `propagate(sessions, seeds, {windowMs})
   → Map<sessionId, {accountUuid, confidence}>`. Clockless; windows precomputed
   as `[start,end)` spans (reuse the 5-hour grouping already in the store). Fully
   unit-testable; property test: idempotent, seed-preserving, conflict → unknown.
2. **Store** — read the inputs (sessions + project/repo + window bucket + existing
   strong attributions as seeds); write propagated rows via the existing
   `applyAttribution` guard (source `backfill`, confidence medium/low).
3. **Wire** into `reattribute` (after inference, before window recompute) and
   expose `account backfill --propagate [--dry-run]` so the user can run it once
   forward seeds exist; print a per-project resolution table + the residual
   `unknown` projects to label.
4. **Tests + coverage** to the repo gate; fixtures use placeholder UUIDs.

## The user's practical path

1. Update to 0.11.x and `collect` for a while so **forward seeds** accrue (each
   account gets observed as you switch; each active project gets pinned).
2. Run `account backfill --propagate --dry-run` → review the per-project split.
3. Label only the **residual** projects it couldn't resolve (a short list), then
   run it for real. Optionally enable OTEL for exact forward attribution.

Manual labelling shrinks from ~960 sessions to a handful of *project* seeds; the
propagation does the rest, across surfaces.

## Sources

- Claude Code telemetry attributes (account is OTEL-only; `user.id` not
  account-derived): <https://code.claude.com/docs/en/monitoring-usage>
- Usage limits (5-hour per-account window; all surfaces share one limit):
  <https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code>,
  <https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work>

## Confidentiality

All figures here are aggregate counts; no project names, repo URLs, account
UUIDs, or emails appear. Fixtures/tests for the implementation use the
`00000000-…` / `@example.com` placeholders (doc 08).
