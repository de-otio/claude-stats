# 10 — Cost-ownership attribution: guided project classification

The generalizable answer to "split a multi-account back-catalogue by cost."

## Problem

Users run more than one Claude subscription (e.g. a personal plan and a
work/client plan) and often use **both accounts within the same project**. For
**cost** attribution the question is not *which account was logged in* — it is
*which subscription should bear the project's cost*, by the project's nature
(personal vs work/client). That is a **business policy**, so:

- it **cannot be inferred** from the transcripts (the account isn't even there —
  doc [09](09-historical-split-without-labelling.md));
- it **cannot be hardcoded** — every user's projects, orgs, and personal/work
  split are different;
- and per-session (or even per-project) hand-labelling of a whole history is
  impractical.

So the tool must let **each user declare their own policy with a handful of
well-guided decisions**, and apply it deterministically.

## Requirements (from the product owner)

1. **General** — ship no user-specific patterns; the tool provides the
   mechanism, the user supplies the rules.
2. **Minimal effort** — a handful of decisions, not per-session/per-project.
3. **GUI-guided** — the tool must actively guide the classification.
4. **Deterministic** — a policy, not a guess; must handle "both accounts in one
   project" (the owner is fixed by policy, independent of the logged-in account).

## Rule model

An **owner rule** maps a project matcher to an owning account (= subscription):

```
rule := { match: { path?: glob, remote?: glob }, account: <uuid|label> }
```

- **Matcher basis: path + remote** (chosen default). A session matches if its
  `project_path` matches `path` **or** its `repo_url` owner matches `remote`.
  Path is always present; the remote is a robust fallback (survives moved
  folders) but only ~25% of sessions carry one — hence *both*.
- **Resolution**: most-specific match wins (longer path prefix / exact remote >
  broader), ties broken by most-recent rule.
- **Unmatched → `unknown`** (chosen default): surfaced, never guessed.
- Rules live in the user's **local `~/.claude-stats/config.toml`** — never in the
  repo. Applied as the `override` rank (authoritative user policy), so they win
  over all inference and survive `reattribute`.

## The guided GUI flow (what keeps it a "handful")

The tool does the clustering so the user only makes cluster-level decisions:

1. **Auto-cluster** the user's projects by natural owner-signals:
   - **path roots** — the shallowest directory segments that group multiple
     projects (e.g. the 1–3 levels under `$HOME`/a repos root);
   - **git-remote owners** — org/host of each project's remote, where present.
   Generic detection; no baked-in patterns.
2. **Rank clusters by cost** (est. $ / sessions), descending. Because a small
   number of clusters cover most spend (in the reference dataset, ~23 projects =
   80%), the top few decisions capture almost everything.
3. **"Classify your projects" panel** — one row per cluster: label, # projects,
   # sessions, **$ at stake**, and a **subscription picker** (the known accounts,
   shown by their plan label). Assign top-down; stop when the remainder is
   negligible.
4. Each pick creates a **rule** covering the whole cluster (a handful of clicks,
   not per project). **Drill in** to reassign the odd project that differs.
5. **Live preview** — cost-by-subscription updates as rules are added, with
   "**$X still unclassified**" pulling attention to high-value stragglers.
6. **Persist** rules to local config; write `override` cost attributions for all
   matching sessions.

The CLI mirror (headless / power users):
`account own --account <a> --path '<glob>' [--remote '<glob>']`,
`account own --list`, `account own --clear <id>`, `account classify` (prints the
ranked unclassified clusters + $ at stake).

## Why it generalizes

Clustering, ranking, the picker, and the rule engine are all **content-free** —
they operate on whatever projects/remotes a user happens to have. The concrete
globs are per-user data entered through the GUI and stored locally. The shipped
tool contains **no** org names, paths, or client identifiers.

## Two lenses, one surface

- **Cost-ownership** (this doc) — policy: project → owning subscription,
  regardless of the account used. Answers "what did each subscription cost me."
- **Actual account** (docs [03](03-attribution-methods.md)/[09]) — measurement:
  which account actually ran each session. Answers "why am I hitting *this*
  account's limits."

They diverge exactly when you use the non-owning account on a project. Both are
useful; the dashboard exposes cost-ownership as the default cost view and keeps
the measured account available for usage-limit analysis. Doc
[08](08-manual-labelling.md)'s date-range labels and this doc's project-owner
rules are the same `override` rule engine with two matcher types, surfaced by the
one guided GUI.

## Data model

Extend doc 08's `account_label_rules` with the matcher columns
(`path_glob`, `remote_glob`) alongside the existing date-range/session kinds — one
rule table, one `applyOverride` writer, one precedence rank. Clustering is a pure,
read-only computation over `sessions` (`project_path`, `repo_url`, cost); no new
persistence beyond the rules.

## Phases

| Phase | Work | Model / effort |
|---|---|---|
| P1 | pure `ownership.ts`: `clusterProjects(sessions)` + `resolveOwner(session, rules)` (glob match, specificity, unmatched→unknown) | Opus / high |
| P2 | store: extend rule table (path/remote matchers) + `applyOverride`; CLI `account own/classify` | Sonnet / medium |
| P3 | dashboard "Classify your projects" panel (ranked clusters, picker, drill-in, live $ preview) + config read/write | Sonnet / medium |
| P4 | wire into reattribute/collect; i18n across 10 locales | Haiku / low + Sonnet |
| P5 | tests (glob match, specificity, unmatched, clustering, precedence over inference) + coverage | Sonnet / medium |

## Tests (fail-when-wrong)

- `resolveOwner`: path-glob and remote-glob match; **both** bases; specificity
  (longer prefix wins); recency tiebreak; unmatched → `unknown`; override beats
  every inferred source.
- `clusterProjects`: groups by shared path root and by remote owner; ranks by
  cost; stable/deterministic; singletons handled.
- e2e: a rule reclassifies all of a project's sessions (both accounts) to the
  owning subscription; `reattribute` re-applies; clearing a rule reverts.
- property: resolution is total and order-independent given fixed specificity.

Coverage to the repo gate; fixtures use `00000000-…` UUIDs, `@example.com`,
`~/repos/work/**`, `github.com/example-org/*` — **no real orgs, paths, or client
names** (public repo + published artifact; marker-grep every diff).

## Confidentiality

The tool ships pattern-free. Docs/tests/CLI help use neutral placeholders. A
user's real orgs/paths exist only in their local `~/.claude-stats/config.toml`.
