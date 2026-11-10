# 09 — Historical account split without hand-labelling

Manual labelling (doc [08](08-manual-labelling.md)) is the *escape hatch*, not the
plan: hand-tagging a whole historical back-catalogue is impractical. This doc finds the
signals that let us attribute a **multi-account back-catalogue automatically**,
from a handful of seeds, and specifies the mechanism.

The premise (doc [03](03-attribution-methods.md)): the timeline is forward-only
and single-account backfill (doc 03 §D.1) abstains once ≥2 accounts are seen. So
pre-observation history across two accounts needs *something else*.

## What the data actually offers

Empirical scan of a local store + transcripts (no identifying values),
cross-checked against the official docs:

| Signal | Verdict | Evidence |
|---|---|---|
| Account in transcript `*.jsonl` | ❌ **absent** | A scan of many transcript lines across many files found a wide set of distinct keys, **none** an account/org/subscription id. Docs confirm: account/org/email are *"only sent to the configured OpenTelemetry exporter, never to local transcript files."* |
| Historical telemetry files | ❌ **negligible** | `~/.claude/telemetry/` holds a handful of small files with no sessionIds and no accounts (failed-event dumps only). |
| `~/.claude.json.backup` anchor | ❌ **same account** | backup holds the *current* account → no historical switch captured (doc 03 §D.2 was opportunistic). |
| `userID` fingerprint | ❌ **not account-derived** | Docs: `user.id` is *"a random anonymous identifier … not derived from your Claude account"*, persisted per-install. Kills doc 03 §D.4. |
| `message.usage.service_tier` | ⚠️ weak | Present per message, but reflects the *request* tier (standard/priority/batch), not the account; both plans commonly resolve to the same tier. |
| **Project / repo affinity** | ✅ **strong** | Session counts are concentrated in a minority of projects, so a few projects cover most sessions. Work vs personal is project-aligned. |
| **5-hour usage-window co-membership** | ✅ **strong, cross-surface** | Docs: the 5-hour limit is **per account** and *"usage of all Claude surfaces (claude.ai, Claude Code, Claude Desktop) counts toward the same limit."* So one window = one account, spanning surfaces. |
| Forward observation timeline | ✅ seed source | Once observation is running, CLI sessions get attributed → seeds. |
| OTEL export | ✅ exact, forward, opt-in | `user.account_uuid` etc. — gold standard going forward, and validates inference. |

Two facts reframe the problem:

1. **A sizeable share of sessions are non-CLI** (vscode / claude-vscode / desktop)
   and are *unattributable* by the CLI timeline. Any per-session method leaves
   that share of history blank.
2. The account is **project-aligned** and the 5-hour window is **per-account
   across surfaces**. These two are surface-independent — they can attribute the
   non-CLI sessions too.

## The solution — seed-and-propagate

Model attribution as **label propagation** over a graph of sessions. A few
sessions are *seeded* with a known account; edges connect sessions that almost
certainly share one; labels spread from seeds to the rest. No per-session
labelling.

### Seeds (known account), strongest first
- **OTEL** events (authoritative) — if enabled.
- **Forward observation timeline** — CLI sessions attributed once observation is running.
- **Anchor pins** (live sessions).
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
- The window edge folds in the non-CLI sessions that no per-session method reaches.
- Only projects **abandoned before** attribution began need a seed — a *handful*
  of project labels, not one tag per session. Because a few projects cover most
  sessions, a small number of confirmations plus forward seeds should resolve the
  bulk at medium-or-better confidence.

## Precedence & storage

Propagated attributions are inferred, so they sit at the **`backfill`** rank
(below `observation`, above `unknown`) with `confidence ∈ {medium, low}` — the
monotonic guard already lets a later `observation`/`telemetry`/`otel`/`anchor`
signal upgrade them, and `reattribute` recomputes them from seeds each run
(idempotent). No new precedence rank; reuse `backfill` with a `method` note
(`propagated`) for provenance. Durable inputs (project labels) live in the doc 08
`account_label_rules` table; everything else is recomputed.

## Shape of the mechanism

Propagation is a pure, clockless function over precomputed inputs: sessions with
their project/repo and 5-hour window bucket, plus the existing strong
attributions as seeds. It returns an account and a confidence per session.
Windows are precomputed as `[start,end)` spans (reusing the 5-hour grouping the
store already keeps). Properties worth testing: idempotent, seed-preserving,
conflict → `unknown`. Manual labelling shrinks from one tag per session to a
handful of *project* seeds; the propagation does the rest, across surfaces.

## Sources

- Claude Code telemetry attributes (account is OTEL-only; `user.id` not
  account-derived): <https://code.claude.com/docs/en/monitoring-usage>
- Usage limits (5-hour per-account window; all surfaces share one limit):
  <https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code>,
  <https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work>
