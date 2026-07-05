# 10 — Cost-ownership attribution: guided project classification

The generalizable answer to "split a multi-account back-catalogue by cost."

## Problem

Users run more than one Claude subscription (e.g. a personal plan and a
work/client plan) and often use **both accounts within the same project** —
sometimes by *nature* (a work project touched from a personal login), sometimes
by *necessity* (rotating through several subscriptions on one project because
even the largest plan's limits are insufficient). For **cost** attribution the
question is usually not *which account was logged in* — it is *which subscription
should bear the project's cost*, by the project's nature (personal vs
work/client). That is a **business policy**, so:

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

An **owner rule** maps a project matcher to a cost target:

```
rule := { match: { path?: glob, remote?: glob }, target: <uuid|label> | "split" }
```

- **Matcher basis: path + remote** (chosen default). A session matches if its
  `project_path` matches `path` **or** its `repo_url` owner matches `remote`.
  Path is always present; the remote is a robust fallback (survives moved
  folders) but only ~25% of sessions carry one — hence *both*.
- **`target`** is one of:
  - **an account/subscription** — the project has a single owner; every session
    in it is billed there regardless of the account actually used (`override`
    rank, authoritative).
  - **`split`** — the project has **no single owner** because the user rotates
    through several subscriptions on it to get enough capacity (a single plan's
    5-hour/weekly limits are insufficient). Cost must divide across subscriptions
    **by actual usage**, so these sessions are *not* overridden — they fall
    through to the measured-account engine (observation timeline → propagation →
    OTEL, docs [03](03-attribution-methods.md)/[09](09-historical-split-without-labelling.md)),
    and each session lands on whichever account actually ran it. This is why the
    actual-account inference is part of the **cost** path, not merely a
    usage-limit view.
- **Resolution**: most-specific match wins (longer path prefix / exact remote >
  broader), ties broken by most-recent rule.
- **Unmatched → `unknown`** (chosen default): surfaced, never guessed.
- Rules live in the user's **local `~/.claude-stats/config.toml`** — never in the
  repo. Owner rules are applied at the `override` rank; `split` rules apply no
  override and defer to inference. Both survive `reattribute`.

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
   # sessions, **$ at stake**, and a picker with the choices **[a subscription] ·
   [Split by usage] · [Leave unknown]**. "Split by usage" marks a project whose
   cost should divide across subscriptions by the account actually used (the
   limits-driven multi-subscription case). Assign top-down; stop when the
   remainder is negligible.
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

## How the two engines compose

Cost attribution is **policy first, measurement second** — per project:

- **Owned** project → **policy** wins: every session billed to the owning
  subscription (`override`), regardless of the account used.
- **`split`** project → **measurement**: cost divides across subscriptions by the
  account that actually ran each session, via the inference engine (observation
  timeline → propagation → OTEL, docs [03](03-attribution-methods.md)/[09]).
- **Unknown** project → surfaced for classification; excluded from per-account
  totals until resolved.

So the actual-account inference (doc 09) is not a separate "usage-limit view" —
it is the **cost method for split projects**, and it independently answers "why
am I hitting *this* account's limits." The measurement only diverges from the
policy on owned projects where you used the non-owning account — there, policy
(cost) and measurement (limits) legitimately differ, and the dashboard shows
each in its own view.

Doc [08](08-manual-labelling.md)'s date-range labels and this doc's
project-owner/`split` rules are the same `override`/rule engine surfaced by the
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
- `split` target: a matching project writes **no** override — its sessions
  retain their measured account, so a project used from two accounts divides
  across both (cost splits by actual usage, not forced to one owner).
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
