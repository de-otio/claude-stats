# Command Reference

All commands follow the pattern:

```
claude-stats <command> [options]
```

Run `claude-stats --help` or `claude-stats <command> --help` for inline help.

---

## Language and locale

Every command, and the dashboard it serves, is translated into 10 languages:

| Code | Language | Code | Language |
|---|---|---|---|
| `en` | English (default and fallback) | `pl` | Polish |
| `de` | German | `pt-BR` | Portuguese (Brazil) |
| `es` | Spanish | `ru` | Russian |
| `fr` | French | `uk` | Ukrainian |
| `ja` | Japanese | `zh-CN` | Chinese (Simplified) |

| Global option | Description |
|---|---|
| `--locale <lang>` | Force the display language for this run. Accepts any code from the table above |

The option is global — it applies to every command, and it is parsed before
command dispatch so `--locale` also translates `--help` output:

```sh
claude-stats report --locale de
claude-stats --locale ja report --period week
```

**Automatic detection.** Without `--locale`, the language comes from the
environment: `LC_ALL`, then `LC_MESSAGES`, then `LANG`.

Tags are accepted in both the POSIX form (`pt_BR.UTF-8`) and the BCP 47 form
(`pt-br`), in any casing, and resolve in this order:

| Step | Example | Result |
|---|---|---|
| Exact regional match | `pt_BR.UTF-8`, `pt-br` | `pt-BR` |
| Primary subtag | `de_DE.UTF-8` | `de` |
| Sole regional variant of that subtag | `zh`, `zh_TW` | `zh-CN` |
| No match | `C`, `POSIX`, `it_IT.UTF-8` | `en` |

The third step exists because Simplified Chinese and Brazilian Portuguese are
the only Chinese and Portuguese bundles that ship: a near-miss serves a reader
who told us their language better than English does. If a second variant of
either is ever added, that language stops matching loosely and needs its exact
code. Anything unrecognised falls back to English, so output is never
half-translated.

`--locale` runs through the same resolution, so `--locale pt_BR`,
`--locale pt-br` and `--locale pt-BR` are equivalent.

**VS Code extension.** The extension ignores the shell environment and follows
VS Code's own display language (`vscode.env.language`), resolved by the same
rules above — change it with the **Configure Display Language** command. There
is no `--locale` equivalent and no extension setting for it.

**What `--locale` does not change: number and currency formatting.** Money and
token counts render in a fixed format on every surface regardless of the
selected language — deliberately, so a report or justification pack does not
change shape with the machine that produced it (see `formatMoney` in
`packages/core/src/insight.ts`). `--locale de` translates the labels around a
figure, not the figure itself. A few incidental timestamps and counts use the
host system's default formatting, which is independent of both `--locale` and
the detected language.

---

## `collect`

Scan `~/.claude/projects/` and write new session data to the local database.

```
claude-stats collect [--verbose]
```

| Option | Description |
|---|---|
| `-v, --verbose` | Print one line per file as it is processed |

**How it works:**

- Each session file is compared against a stored checkpoint (mtime, size, and a SHA-256 of the first 1 KB).
- If the file is unchanged, it is skipped.
- If lines were appended, only the new lines are read (incremental).
- If the file was rewritten from scratch, it is reprocessed in full.
- Unparseable lines are recorded in a quarantine table rather than aborting the run.
- Files that have been deleted since the last run are marked `source_deleted` in the database.

**Example output:**

```
Collecting...
Done. 3 files processed, 41 skipped, 2 sessions upserted, 14 messages upserted.
```

---

## `report`

Print a usage summary to stdout, or write a graphical HTML report to a file.

```
claude-stats report [options]
```

| Option | Default | Description |
|---|---|---|
| `--project <path>` | _(all projects)_ | Filter to one project by its filesystem path (e.g. `/Users/you/repos/myproject`) |
| `--repo <url>` | _(all repos)_ | Filter to sessions whose git remote origin matches this URL |
| `--account <uuid>` | _(all accounts)_ | Filter to sessions associated with a specific Anthropic account UUID |
| `--period <period>` | `all` | `day`, `week`, `month`, or `all` |
| `--since <date>` | — | Explicit lower bound (`YYYY-MM-DD`), instead of a named period |
| `--until <date>` | — | Explicit upper bound (`YYYY-MM-DD`), instead of a named period |
| `--timezone <tz>` | System timezone | IANA timezone name used for day/week/month boundaries (e.g. `America/New_York`) |
| `--source <entrypoint>` | _(all)_ | Filter by entrypoint: `claude` (CLI) or `claude-vscode` |
| `--include-ci` | _(excluded)_ | Include sessions that appear to be from CI or automation |
| `--detail` | _(aggregate)_ | Show a per-session table instead of an aggregate summary |
| `--trend` | _(aggregate)_ | Show usage broken down by time period (day/week/month) |
| `--session <id>` | — | Show the full message-by-message detail for one session (prefix match) |
| `--tag <tag>` | _(all)_ | Filter to sessions with a specific tag |
| `--ticket <key>` | — | Show cost and evidence attributed to one work-item ticket key (e.g. `PROJ-123`), from the same locally-observed evidence `get_cost_per_ticket` reads. See [`ticket`](#ticket) to correct a wrong automatic link |
| `--html [outfile]` | — | Write a self-contained HTML dashboard to a file instead of printing to stdout |

**Periods** are calculated from the start of the current day/week/month in the specified timezone to now.

**CI sessions** are those without an interactive queue-operation entry. They are excluded by default because they can inflate token counts significantly.

**`--html`** generates a standalone HTML file with interactive Chart.js charts. If `outfile` is omitted, the file is written to `claude-stats-<YYYY-MM-DD>.html` in the current directory. Cannot be combined with `--trend` or `--detail`.

**Examples:**

```sh
# Usage for the current week in Pacific time
claude-stats report --period week --timezone America/Los_Angeles

# Usage for a single project, all time
claude-stats report --project /Users/you/repos/myproject

# Usage for a repo, regardless of which local clone was used
claude-stats report --repo https://github.com/org/myrepo

# Include CI/automated sessions
claude-stats report --period month --include-ci

# Per-session table for the past week
claude-stats report --period week --detail

# Trend breakdown (week-by-week for the past month)
claude-stats report --trend

# Full detail for a single session
claude-stats report --session abc123

# Write an HTML dashboard for this week
claude-stats report --period week --html

# Write an HTML dashboard to a specific file
claude-stats report --period month --html ~/Desktop/april.html
```

---

## `status`

Show database statistics and the time of the last collection run.

```
claude-stats status
```

No options. Example output:

```
─── Claude Stats Status ───

Database size   : 1.2 MB
Sessions        : 42
Messages        : 1 876
Quarantined     : 0 unparseable lines
Last collected  : 3/8/2026, 9:15:04 AM
```

---

## `account`

Show the current logged-in Claude account, its suggested plan, and the accounts known to claude-stats. Also manages cost-ownership rules and account re-attribution.

```
claude-stats account [subcommand] [options]
```

| Subcommand | Description |
|---|---|
| _(none)_ | Print the current account plus the known-accounts table |
| `reattribute [--dry-run] [--force]` | Recompute account attribution across all stored sessions |
| `own [options]` | Manage cost-ownership rules (assign a path or remote glob to an account) |
| `classify` | Show project clusters ranked by estimated cost, to help identify ownership |
| `otel ingest --file <path>` | Apply authoritative per-account attribution from a Claude Code OpenTelemetry (OTLP) export. See [account-otel.md](account-otel.md) for enabling telemetry and what gets read |

**`account` (no subcommand)** prints, when a Claude login is present: account UUID, organization type, rate-limit tier, seat tier, billing type, extra-usage status, plus (when local usage data exists) a suggested plan, a verdict on the current plan (good value / underusing / no plan), and a usage-intensity tier (light / typical / power) benchmarked against Anthropic's per-seat usage tiers. It never recommends a company-wide seat count — see `plan-advisor` for that.

| Option (`account reattribute`) | Description |
|---|---|
| `--dry-run` | Preview the changes without writing or creating a backup |
| `--force` | Proceed even if re-attribution would clear existing attributions |

| Option (`account own`) | Description |
|---|---|
| `--account <uuid\|split>` | Account UUID to assign cost to, or `split` to keep measured attribution |
| `--path <glob>` | Glob pattern matching project paths (e.g. `~/repos/work/**`) |
| `--remote <glob>` | Glob pattern matching git remote owner (e.g. `github.com/example-org/*`) |
| `--dry-run` | Preview how many sessions the rule would match, without creating it |
| `--force` | Create the rule even if it matches more than 90% of sessions |
| `--list` | List all existing owner rules |
| `--clear <id>` | Remove the owner rule with the given id and revert its sessions |

**Examples:**

```sh
# Show the current account and suggested plan
claude-stats account

# Recompute attribution across the whole store (dry run first)
claude-stats account reattribute --dry-run
claude-stats account reattribute

# Assign a path glob to a specific account
claude-stats account own --account <uuid> --path "~/repos/work/**"

# List and clear ownership rules
claude-stats account own --list
claude-stats account own --clear 3

# Show project clusters ranked by cost
claude-stats account classify

# Apply authoritative attribution from an OTLP export
claude-stats account otel ingest --file /path/to/claude-otlp.jsonl
```

---

## `plan-advisor`

Size Team vs Enterprise seats for a company-wide Claude rollout from a headcount and a technical-role fraction. Prints a scenario table across adoption levels — seat counts, whether each fits Team's seat range, procurement motion, and a cost projection per plan — with the source data's staleness warning. Never picks a plan for you.

```
claude-stats plan-advisor --headcount <n> --technical-fraction <pct> [options]
```

| Option | Default | Description |
|---|---|---|
| `--headcount <n>` | _(required)_ | Total company headcount (whole number, at least 1) |
| `--technical-fraction <pct>` | _(required)_ | Share of headcount that would get a Claude Code seat, as a fraction 0–1 or a percentage like `50` |
| `--tier-mix <light,typical,power>` | Anthropic's benchmark mix | Optional measured light/typical/power intensity split (e.g. `0.5,0.4,0.1`); must sum to 1 |
| `--compliance` | _(off)_ | Surface the compliance trigger prominently in the output. Does not change the numbers or pick a plan |

The scenario table is computed for adoption fractions 25% / 50% / 75% / 100% of the technical population. Every dollar figure is an estimate resting on the tier-mix assumption and the negotiated Enterprise seat floor — not a quote; re-verify current pricing at claude.com/pricing before purchasing. Two questions are always left open for the user to decide, never resolved by this command: whether their compliance posture requires Enterprise independent of seat count, and which spend-limit philosophy (pooled vs per-user) they prefer. See the `license-advisor` skill (`skills/license-advisor/SKILL.md`) for an agent-guided walkthrough of the same tradeoffs.

**Examples:**

```sh
# Size seats for a 400-person company, half technical roles
claude-stats plan-advisor --headcount 400 --technical-fraction 0.5

# With a measured usage-intensity split instead of the default benchmark mix
claude-stats plan-advisor --headcount 400 --technical-fraction 0.5 --tier-mix 0.6,0.3,0.1

# Surface the compliance trigger prominently
claude-stats plan-advisor --headcount 200 --technical-fraction 0.25 --compliance
```

---

## `export`

Export raw session data to JSON or CSV for use in other tools.

```
claude-stats export [--format <fmt>] [--project <path>] [--period <period>]
```

| Option | Default | Description |
|---|---|---|
| `--format <fmt>` | `json` | `json` or `csv` |
| `--project <path>` | _(all projects)_ | Filter to one project |
| `--period <period>` | `all` | `day`, `week`, `month`, or `all` |
| `--since <date>` | — | Explicit lower bound (`YYYY-MM-DD`, inclusive). Must be paired with `--until`; overrides `--period` when both are set |
| `--until <date>` | — | Explicit upper bound (`YYYY-MM-DD`, inclusive). Must be paired with `--since` |
| `--timezone <tz>` | System timezone | IANA timezone for period boundaries |

**Examples:**

```sh
# Export all sessions as JSON
claude-stats export > sessions.json

# Export this month's sessions as CSV
claude-stats export --format csv --period month > this-month.csv
```

The CSV format includes these columns:

```
session_id, project_path, first_timestamp, last_timestamp,
claude_version, entrypoint, prompt_count,
input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
account_uuid, subscription_type
```

---

## `serve`

Start a local web dashboard in your browser.

```
claude-stats serve [--port <n>] [--open]
```

| Option | Default | Description |
|---|---|---|
| `--port <n>` | `9120` | TCP port to listen on |
| `--open` | _(off)_ | Open the dashboard in the default browser immediately after starting |

The server runs until you press `Ctrl+C`. Every page load queries the live database, so the charts always reflect the most recently collected data.

The dashboard shows:
- **Summary bar** — sessions, prompts, total tokens, cache efficiency, estimated cost
- **Daily trend** — tokens and cost per day (line chart)
- **Model split** — token share per Claude model (doughnut)
- **Top projects** — token consumption by project (horizontal bar)
- **Entrypoint** — CLI vs VS Code usage (pie)
- **Stop reasons** — end_turn / tool_use / max_tokens distribution (bar)
- **Cache efficiency** — cached vs uncached tokens (doughnut)

Use the period selector on the page to switch between Day / Week / Month / All without restarting the server. The auto-refresh toggle reloads the page every 30 seconds.

**URL query parameters** — You can filter the dashboard by appending parameters to the URL. All the same filters available on `report` work here:

| Parameter | Example | Description |
|---|---|---|
| `period` | `?period=week` | `day`, `week`, `month`, or `all` |
| `project` | `?project=/Users/you/repos/myproject` | Filter to one project path |
| `repo` | `?repo=https://github.com/org/myrepo` | Filter to one git remote |
| `entrypoint` | `?entrypoint=claude-vscode` | `claude` or `claude-vscode` |
| `timezone` | `?timezone=America/New_York` | IANA timezone for day/week/month boundaries |
| `includeCI` | `?includeCI=true` | Include CI/automated sessions |

Parameters can be combined: `http://localhost:9120/?period=week&project=/Users/you/repos/myproject`

The period selector on the page preserves any other parameters already in the URL.

**Examples:**

```sh
# Start the dashboard on the default port
claude-stats serve

# Start and open in browser
claude-stats serve --open

# Use a different port
claude-stats serve --port 8080
```

---

## `search`

Search your prompt history for a keyword.

```
claude-stats search <query> [--project <path>] [--limit <n>] [--count]
```

| Option | Default | Description |
|---|---|---|
| `--project <path>` | _(all)_ | Restrict search to one project |
| `--limit <n>` | `20` | Maximum number of results to show |
| `--count` | _(off)_ | Print only the match count, not the results |

Results are sorted newest-first and show the timestamp, project, session ID prefix, and matching prompt text with the matched substring highlighted.

**Examples:**

```sh
claude-stats search "refactor"
claude-stats search "sqlite" --project /Users/you/repos/myproject
claude-stats search "deploy" --count
```

---

## `tag`

Add or remove tags on a session, or list a session's tags.

```
claude-stats tag <session-id> [tags...] [--remove] [--list]
```

| Option | Description |
|---|---|
| `--remove` | Remove the listed tags instead of adding them |
| `--list` | Show current tags for the session (no other action) |

`<session-id>` can be a prefix (first 6+ characters) — the command resolves it to the matching session.

Tags are lowercase strings matching `[a-z0-9][a-z0-9_-]{0,49}`.

**Examples:**

```sh
# Add tags
claude-stats tag abc123 refactor important

# Remove a tag
claude-stats tag abc123 --remove refactor

# List tags for a session
claude-stats tag abc123 --list
```

---

## `tags`

List all tags with their session counts.

```
claude-stats tags
```

No options.

---

## `ticket`

Manually link (or unlink) a session to a work-item ticket key, or list a
session's current links. This is how you correct the automatic ticket
attribution described under [`report --ticket`](#report) and the
`get_cost_per_ticket` MCP tool — a manual link always wins over an automatic
one, and `--negate` tombstones a wrong automatic link so a future
re-extraction pass cannot resurrect it.

```
claude-stats ticket <session-id> [key] [--negate] [--remove] [--list]
```

| Option | Description |
|---|---|
| `--list` | Show the session's current ticket links (source, confidence, active/negated) — the default when no key is given |
| `--negate` | Tombstone an automatic link for `<key>` so extraction cannot resurrect it (requires `key`) |
| `--remove` | Remove a manual link for `<key>` (requires `key`) |
| _(key given, no flag)_ | Add a manual, high-confidence link to `<key>` |

`<session-id>` can be a prefix (first 6+ characters), same as `tag`. `<key>`
is a work-item key like `PROJ-123`.

**Examples:**

```sh
# Show a session's current ticket links
claude-stats ticket abc123 --list

# Manually link a session to a ticket
claude-stats ticket abc123 PROJ-123

# Tombstone a wrong automatic link
claude-stats ticket abc123 PROJ-999 --negate

# Remove a manual link
claude-stats ticket abc123 PROJ-123 --remove
```

Ticket extraction itself needs no manual step — it runs automatically from
git branch names, commit subjects, and prompt-text mentions during
`collect`/`report`/`recap`, gated by the `tickets.projectKeys` allowlist. See
[Configuration](#configuration) below for what that allowlist changes and
what it costs to leave unset.

---

## `task-class`

Classify sessions into task classes and print the resulting distribution.
Backs `constraint-impact`'s per-class comparison and the non-ticket breakdown
in `pack`.

The fine taxonomy: `debug`, `refactor-multi-file`, `greenfield`, `review`,
`config-chore`, `explore`, `unknown` (the classifier abstained). A reduced
coarse taxonomy (`build`, `diagnose`, `support`, `unknown`) is used wherever
the fine classification misses its agreement threshold.

```
claude-stats task-class [--limit <n>]
```

| Option | Default | Description |
|---|---|---|
| `--limit <n>` | _(all pending)_ | Classify at most `n` sessions this pass |

The classifier is versioned: a session already classified at the current
version is skipped, and a rule change reclassifies exactly the affected
sessions on the next run — no manual purge needed. Output shows how many
sessions were classified this pass, how many were already current, how many
remain, the classifier version, and a fine/coarse breakdown with each class's
confidence-tier mix (high/medium/low) so a count is never shown without its
reliability.

The classifier's own published agreement figure (see
`get_calibration`) is measured against a generated corpus at build time — it
is **not** a measurement of your data, because nothing on your machine
records a human disagreeing with a session's task class yet.

**Examples:**

```sh
# Classify everything pending
claude-stats task-class

# Classify at most 200 sessions this pass
claude-stats task-class --limit 200
```

---

## `config`

View or update tool configuration (cost alert thresholds).

```
claude-stats config <action> [key] [value]
```

| Action | Description |
|---|---|
| `show` | Print all current configuration |
| `set <key> <value>` | Set a configuration value |
| `unset <key>` | Remove a configuration value |

Valid keys: `cost.day`, `cost.week`, `cost.month` (dollar thresholds that trigger a warning after `collect`).

**Examples:**

```sh
claude-stats config show
claude-stats config set cost.day 5
claude-stats config set cost.month 50
claude-stats config unset cost.day
```

---

## Configuration

`claude-stats config` only manages `costThresholds` (the `cost.*` keys
above). The blocks below are **not** settable through `config set` — edit
`~/.claude-stats/config.json` directly (create it if it doesn't exist; it's a
plain JSON object) and re-run the relevant command. Every key is optional;
its absence has a defined, honest meaning — usually "this feature reports
what it can and states what it can't," never a silent full-precision claim
with a stale or invented default underneath.

An invalid or malformed value in any of these blocks is dropped on read
rather than crashing the tool, so a typo degrades a feature to its
absent-config behaviour instead of breaking every command.

### `tickets`

```json
{ "tickets": { "projectKeys": ["PROJ", "OPS"] } }
```

| Key | Default | Meaning when absent |
|---|---|---|
| `projectKeys` | _(unset)_ | Without an allowlist, ticket extraction (git branch, commit subject, prompt mentions) still runs, but every attribution is capped at **medium confidence** — the scanner cannot otherwise tell a real ticket key from an unrelated identifier of the same shape. With an allowlist, precision is essentially perfect and `high` confidence becomes reachable. |

Each entry is a project-key prefix: an uppercase letter followed by 1–9
uppercase letters/digits (2–10 characters total), e.g. `PROJ` matches
`PROJ-123`.

### `policyEvents`

```json
{
  "policyEvents": [
    { "date": "2026-05-01", "kind": "model-removal", "detail": "opus", "scope": "org" }
  ]
}
```

| Key | Default | Meaning when absent |
|---|---|---|
| `policyEvents` | `[]` | **Required** for `constraint-impact` and `get_constraint_impact` — both refuse to run and explain why when this is empty. A boundary is never inferred from the data, only from what you declare here, so the report cannot pick the split that maximises apparent damage. |

Each entry: `date` (`YYYY-MM-DD`), `kind` (`model-removal` \| `budget-cap` \|
`quota-change` \| `other`), optional `detail` (free text, **local-only** —
see the [privacy documentation](../analysis/05-privacy-security.md)), and
optional `scope` (`org` \| `team` \| `self`).

### `rate`

```json
{ "rate": { "hourly": 85, "currency": "USD" } }
```

| Key | Default | Meaning when absent |
|---|---|---|
| `hourly` | _(unset)_ | Without an hourly rate, `constraint-impact`'s dev-time cost and the pack's salary-denominator framing stay in **minutes/hours** — never an invented dollar figure. Setting it enables the dollar comparison (`netEffectAvailable: true`). |
| `currency` | `USD` | ISO 4217 code. Never auto-converted against other currencies in the same report. |

### `pricing`

```json
{ "pricing": { "mode": "metered", "rates": { "bedrock": { "claude-opus-4-6": { "inputPerMillion": 15, "outputPerMillion": 75, "cacheReadPerMillion": 1.5, "cacheWritePerMillion": 18.75 } } } } }
```

| Key | Default | Meaning when absent |
|---|---|---|
| `mode` | Inferred per-account | `plan` speaks in equivalent-API-value against a flat monthly fee; `metered` speaks in actual metered dollars and supports reconciliation. Unset, the vocabulary is inferred from each account's detected subscription/billing evidence (or `mixed` when in-scope accounts disagree) — see the dashboard's Insights tab caveat when that happens. |
| `rates` | Built-in first-party table | Without partner (Bedrock/Vertex) rate overrides, partner-account usage prices at first-party rates and every such figure is flagged as an estimate. |

### `reconciliation`

```json
{ "reconciliation": { "invoiceTotal": 1240.50, "tolerancePercent": 5, "scopeNote": "AWS account 111122223333, Bedrock only, calendar month" } }
```

| Key | Default | Meaning when absent |
|---|---|---|
| `invoiceTotal` | _(unset)_ | Without it, no reconciliation panel or pack reconciliation section renders — there is nothing top-down to compare against. This figure is always **imported** (by hand, or per-run via `pack --invoice-csv`); the tool never fetches it. |
| `tolerancePercent` | `5` | Percent difference below which a reconciliation reads as "reconciles" rather than flagging drift. |
| `scopeNote` | _(unset)_ | **Strongly recommended whenever `invoiceTotal` is set.** States what the invoice figure actually covers (an AWS account id, an org, a date range). Left unset, the report states the scope as unconfirmed rather than assuming the local store and the invoice cover the same thing — a reconciliation run against mismatched scopes can otherwise "prove" the estimates are wrong when the real problem is that the two sides are counting different things. |

Reconciliation can conclude the local estimates are **wrong** — that is the
point of measuring against a real invoice, not a caveat on it.

### `hygiene`

```json
{ "hygiene": { "suppressions": ["cache-churn"] } }
```

| Key | Default | Meaning when absent |
|---|---|---|
| `suppressions` | `[]` | Detector ids (`cache-churn`, `retry-loop`, `abandoned-spend`, `context-bloat`, `re-entry-burn`, `tier-mismatch`) to dismiss as "not waste" for this store. A suppressed detector still runs — its findings are withheld from `get_efficiency_hints`'s output, and it appears in that tool's `suppressedDetectors` list, so a dismissal is visible rather than a silent permanent blind spot. |

### `experimentalSignals`

```json
{ "experimentalSignals": true }
```

| Key | Default | Meaning when absent |
|---|---|---|
| `experimentalSignals` | `false` | Off, the `cost-per-task` outcome rests on the Tier-0 proxy (git activity and recap confidence) alone. On, additional unvalidated signals are allowed to influence the outcome — and the LLM judge below is *only* consulted when this is also true. Calibrate before flipping it: run `cost-per-task --calibrate` and compare against outcomes you labelled by hand with [`task-outcome`](#task-outcome). |

### `llmJudge`

**This is the one local feature that can send your prompt text off the
machine.** Read this block before enabling it.

```json
{
  "experimentalSignals": true,
  "llmJudge": {
    "enabled": true,
    "endpoint": "http://localhost:11434/v1/chat/completions",
    "model": "llama3.1",
    "maxCalls": 25
  }
}
```

An independent model rules on tasks the proxy finds ambiguous. The request it
sends is a **blinded** summary — the transcript is stripped of model and
assistant identity so the judge rules on the work rather than on who produced
it, follow-up turns are capped, and the judge's reply re-enters the report as a
verdict only, never as text. **Blinded is not redacted: the summary contains
your own prompt text.** It goes wherever `endpoint` points. A local endpoint
(Ollama, llama.cpp, LM Studio) keeps it on the machine; a hosted endpoint sends
it to that provider, outside every guarantee in the
[privacy documentation](../analysis/05-privacy-security.md). Prefer a model
from a different family than the one being judged.

| Key | Default | Meaning when absent |
|---|---|---|
| `enabled` | `false` | The judge never runs. `cost-per-task --llm-judge` turns it on for one run without editing config |
| `endpoint` | _(unset)_ | Required. Any URL speaking the OpenAI `/v1/chat/completions` shape. Without it (or `model`) the judge is skipped with a warning on stderr rather than silently ignored |
| `model` | _(unset)_ | Required. Model name as that endpoint expects it |
| `apiKey` | _(unset)_ | Sent as a bearer token. Omit for local endpoints that need none |
| `maxCalls` | `25` | Hard cap on judge calls per report run, so an ambiguous month cannot run up an unbounded bill |

Both `experimentalSignals` and the judge must be on for a verdict to affect
the metric — `--llm-judge` alone builds the provider but the pipeline ignores
it while `experimentalSignals` is false.

---

## `dashboard`

Output pre-aggregated dashboard JSON to stdout.

```
claude-stats dashboard [--period <period>] [--project <path>] [--repo <url>]
```

| Option | Default | Description |
|---|---|---|
| `--period <period>` | `all` | `day`, `week`, `month`, or `all` |
| `--since <date>` | — | Explicit lower bound (`YYYY-MM-DD`, inclusive). Must be paired with `--until`; overrides `--period` when both are set |
| `--until <date>` | — | Explicit upper bound (`YYYY-MM-DD`, inclusive). Must be paired with `--since` |
| `--project <path>` | _(all)_ | Filter to one project |
| `--repo <url>` | _(all)_ | Filter to one repo |

Outputs a JSON object with `summary`, `byDay`, `byProject`, `byModel`, `byEntrypoint`, and `stopReasons` fields. Useful for piping into other tools or building custom visualisations.

```sh
claude-stats dashboard --period week | jq '.summary'
```

---

## `ttl-fit`

Is this workload cheaper on the 5-minute or the 1-hour ephemeral cache TTL?
Measures the idle-gap distribution between consecutive messages in a session,
the cache-creation volume broken down by origin (session-start / mid-work /
resume-short / resume-long), and a per-model net-cost comparison between the
two TTLs — from data the local store already holds. No config change and no
re-run of your sessions is needed to see it.

```
claude-stats ttl-fit [options]
```

| Option | Default | Description |
|---|---|---|
| `--period <period>` | `month` | `day`, `week`, `month`, or `all` |
| `--since <date>` | — | Explicit lower bound (`YYYY-MM-DD`, inclusive). Must be paired with `--until`; overrides `--period` when both are set |
| `--until <date>` | — | Explicit upper bound (`YYYY-MM-DD`, inclusive). Must be paired with `--since` |
| `--project <path>` | _(all projects)_ | Filter to one project |
| `--account <uuid>` | _(all accounts)_ | Filter to a specific Anthropic account UUID |
| `--json` | _(off)_ | Print the full result as JSON instead of formatted text |

**The arithmetic, per model:**

```
extra = R    × (write5m − read)     # reads recovered by the 1-hour TTL become writes again under 5 minutes
saved = W1h  × (write1h − write5m)  # the 1-hour premium no longer paid
net   = extra − saved               # negative ⇒ the 5-minute TTL would have been cheaper
```

`R` counts cache-read tokens on requests whose preceding same-session idle gap
falls between the two TTLs (5–60 minutes by default) **and** which were
actually recorded at the 1-hour TTL — a gap in that band under a 5-minute TTL
had already rebuilt, so its reads were never "recovered." `W1h` is the
cache-creation volume actually **written** at the 1-hour TTL, not total
cache-creation volume `W` — the 1-hour premium is only ever paid on tokens
written at that TTL, so using the total would overstate the saving from
switching to 5 minutes on any window that mixes both TTLs. The command prints
both `W` (for the histogram/origin breakdown) and `W1h` (the term the cost
arithmetic uses) so the two are never confused.

**How to read the verdict — never separately from its margin.** Before any
verdict-like line, the command always prints: the window's total estimated
cost, the recovered-read/write/write-at-1h totals, the dominant model's
break-even ratio (the `R`/`W` ratio above which the 1-hour TTL pays off for
its resolved rates — derived from the pricing table, not a hardcoded
constant), and the near-boundary sensitivity band (idle gaps just under the
short TTL, and how much the verdict would move if that band also turned out
to expire). The verdict itself is one of:

- **`prefer-5m`** / **`prefer-1h`** — the net cost difference clears both a
  5%-of-window-cost margin and the near-boundary sensitivity band.
- **`too-close-to-call`** — the difference exists but doesn't clear one of
  those two margins; switching isn't worth it either way.
- **`insufficient-data`** — fewer than 50 timestamped messages, fewer than 5
  MTok of TTL-attributed cache-creation volume, every model's 1-hour rate is
  synthesized rather than reported, or the window predates the TTL-breakdown
  columns entirely (`observedTtl: unknown`) — the gap distribution still
  prints, but no dollar verdict is ever guessed at.

**Projection vs. measurement.** `observedTtl` states which TTL this window's
messages were actually recorded at — `1h`, `5m`, `mixed`, or `unknown`. A
verdict that recommends the *other* TTL from the one actually observed (e.g.
`prefer-5m` printed for a window recorded at `1h`) is a **projection**: a
counterfactual computed from this window's own gap/write shape, not a
measurement of what that other setting would actually have produced (the
tool does not simulate the TTL's own second-order effect — see
Limitations below). The command labels this explicitly rather than printing
it with the same confidence as a same-TTL result. Never quote a projected
verdict as advice for a workload it wasn't computed from — this answer is
workload-specific, and a few-turn session-heavy workload and a long-running,
many-turn one can get opposite verdicts from the same rate table.

**Limitations, always in the output, not only here:**

- Idle gaps are a **proxy** for cache expiry, not an observation of it.
- The second-order effect — under a 5-minute TTL, the reads this tool counts
  as "recovered" would themselves rebuild the cache, and that rebuild would
  itself be re-read later — is **not modelled**.
- Subagent traffic is recorded at the 5-minute TTL regardless of the parent
  session's setting; if it isn't separable in your data, `R` is overstated
  for a workload with heavy subagent use.
- 1-hour TTL availability varies by model on Bedrock — a model row with a
  blank net-cost figure may reflect that unavailability rather than a bad
  rate (see the `--json` output's per-model `netCostOfShortTtl: null`).

**Examples:**

```sh
# This month's TTL fit
claude-stats ttl-fit

# Last 7 days, one project
claude-stats ttl-fit --period week --project ~/repos/myproject

# Full JSON result for scripting
claude-stats ttl-fit --period all --json
```

---

## `context`

Answers the same question as Claude Code's own `/context` — but **over
time**, across a window of past sessions, rather than a live snapshot of
what's in context right now.

Measures the same billed context every request pays for (input +
cache-read + cache-creation), broken into context-size bands, tokens
carried above a set of caps, reset (compaction) cycles and their sawtooth
shape, and the session-start "prelude" every fresh session repays across
the window — from data the local store already holds.

```
claude-stats context [options]
```

| Option | Default | Description |
|---|---|---|
| `--period <period>` | `month` | `day`, `week`, `month`, or `all` |
| `--since <date>` | — | Explicit lower bound (`YYYY-MM-DD`, inclusive). Must be paired with `--until`; overrides `--period` when both are set |
| `--until <date>` | — | Explicit upper bound (`YYYY-MM-DD`, inclusive). Must be paired with `--since` |
| `--project <path>` | _(all projects)_ | Filter to one project |
| `--account <uuid>` | _(all accounts)_ | Filter to a specific Anthropic account UUID |
| `--json` | _(off)_ | Print the full result as JSON instead of formatted text |

See [output-guide.md](output-guide.md#context-command-output) for how to
read every field — in particular, why the amplification ratio is not a
bound and why every dollar figure printed here is a **lower bound**, not
the cost of doing anything differently.

**Auto-compact window fit.** Whenever the window has enough resets to
describe a sawtooth shape, the output ends with a recommendation for
`autoCompactWindow` — the per-cycle context ceiling Claude Code compacts
against — computed by simulating each candidate window size against the
window's own observed context growth, not by reading the caps table above it
out loud. This ships as part of the same `context` output (text and
`--json`) and the same `get_context_carry` MCP payload; there is no new flag
to turn it on or off, and no flag exists to change the candidate grid it
tries. See [output-guide.md](output-guide.md#auto-compact-window-fit) for how
to read the candidate table — in particular, why the median cycle length
column, not the dollar figure, is the one to make a decision from — and
[faq.md](faq.md#why-does-it-give-me-a-range-instead-of-a-number) for why the
tool hands you a range instead of a single number, and what it can and
cannot know about your current setting.

**Examples:**

```sh
# This month's context-carry breakdown
claude-stats context

# Last 7 days, one project
claude-stats context --period week --project /Users/you/repos/myproject

# Full JSON result for scripting
claude-stats context --period all --json
```

---

## `spending`

Show a detailed cost breakdown for a period: total cost by model, top sessions, top tools by estimated token cost, MCP server costs, anomalous prompts, and cache efficiency.

```
claude-stats spending [options]
```

| Option | Default | Description |
|---|---|---|
| `--period <period>` | `day` | `day`, `week`, `month`, or `all` |
| `--since <date>` | — | Explicit lower bound (`YYYY-MM-DD`, inclusive). Must be paired with `--until`; overrides `--period` when both are set |
| `--until <date>` | — | Explicit upper bound (`YYYY-MM-DD`, inclusive). Must be paired with `--since` |
| `--project <path>` | _(all projects)_ | Filter to one project |
| `--model <name>` | _(all models)_ | Filter to sessions using a specific model (prefix match, e.g. `claude-opus`) |
| `--top <n>` | `5` | Number of top sessions/tools/anomalies to show |
| `--sort <key>` | `cost` | Sort sessions by: `cost`, `tokens`, or `prompts` |
| `--timezone <tz>` | System timezone | IANA timezone for period boundaries |
| `--account <uuid>` | _(all accounts)_ | Filter to a specific Anthropic account UUID |
| `--json` | _(off)_ | Output full breakdown as JSON instead of a formatted report |

**What it shows:**

- **Total cost by model** — estimated API-equivalent cost broken down by model with input/output token counts
- **Top sessions** — most expensive sessions in the period (session ID prefix, project, prompt count, duration, model)
- **Top tools** — tools ranked by estimated cost contribution (based on tokens used in messages where the tool was called)
- **MCP servers** — cost and call volume grouped by MCP server
- **Anomalies** — prompts with unusually high token counts (relative to your average)
- **Cache efficiency** — hit rate and estimated savings from cache hits
- **Subagent overhead** — tokens consumed by spawned agent tool calls

**Examples:**

```sh
# Today's spending breakdown
claude-stats spending

# This week's spending, top 10 sessions
claude-stats spending --period week --top 10

# Sorted by prompt count rather than cost
claude-stats spending --period month --sort prompts

# Export as JSON for processing
claude-stats spending --period week --json | jq '.topSessions'
```

---

## `cost-per-task`

Show **cost per successful task** — equivalent-API dollars spent per *shipped / confirmed* task, overall and per model. This is an outcome-cost metric: it divides cost over observable attempts by the number that succeeded, rather than stopping at tokens.

```
claude-stats cost-per-task [options]
```

| Option | Default | Description |
|---|---|---|
| `--period <period>` | `month` | `day`, `week`, `month`, or `all` |
| `--since <date>` | — | Explicit lower bound (`YYYY-MM-DD`, inclusive). Must be paired with `--until`; overrides `--period` when both are set |
| `--until <date>` | — | Explicit upper bound (`YYYY-MM-DD`, inclusive). Must be paired with `--since` |
| `--project <path>` | _(all projects)_ | Filter to one project |
| `--account <uuid>` | _(all accounts)_ | Filter to a specific Anthropic account UUID |
| `--repo <url>` | _(all repos)_ | Filter to a specific git remote URL |
| `--include-ci` | _(off)_ | Include CI/automated sessions |
| `--by-model` | _(off)_ | Show the per-model breakdown table |
| `--timezone <tz>` | System timezone | IANA timezone for period boundaries |
| `--json` | _(off)_ | Output the full report as JSON |
| `--calibrate` | _(off)_ | Output calibration metrics as JSON — how often the outcome proxy agreed with the outcomes you labelled by hand. Reports `uncalibrated` rather than a number below the minimum sample |
| `--llm-judge` | _(off)_ | Use a configured LLM to judge task outcomes instead of the git/recap proxy. Requires the [`llmJudge`](#llmjudge) config block; without it the flag is refused rather than silently ignored |

**What it shows:**

- **Headline** — cost per successful task, with its decomposition: `mean cost per attempt ÷ success rate`.
- **Coverage & labelling** — a task is one of four states (`success` / `failed` / `in-flight` / `unobservable`). The success rate is computed over the **observable** subset (success ∪ failed) only; `coverage` and the labelled share are reported beside it. If coverage is low, the report leads with mean cost per attempt and warns.
- **Per-model table** (`--by-model`) — cost-per-success and success rate by dominant model (suppressed below a minimum number of observable tasks).

Outcome is proxied from git activity and recap confidence unless you label a task explicitly with `task-outcome`. A note: `--period all` on a cold cache is slow (per-day git enrichment) — run `recap precompute` first to warm it.

**Examples:**

```sh
# This month's cost per successful task
claude-stats cost-per-task

# Last 7 days, with the per-model breakdown
claude-stats cost-per-task --period week --by-model

# As JSON
claude-stats cost-per-task --json
```

---

## `task-outcome`

Label a task's outcome so the cost-per-task metric rests on ground truth instead of a proxy. Explicit labels override the git/confidence proxy.

```
claude-stats task-outcome <item> <success|partial|fail>
claude-stats task-outcome <item> --clear
```

`<item>` is an id prefix or prompt substring from **today's** recap (the same selector style as `recap correct hide`/`rename`). Use `--clear` to remove an existing label.

Labelling is a human action — the read-only MCP server cannot set labels, which keeps the producer of the number (the model) separate from the judge of success (you). The same control is also available per-task in the VS Code dashboard webview.

**Examples:**

```sh
# Mark a task as successfully shipped
claude-stats task-outcome a1b2c3 success

# Mark by prompt substring
claude-stats task-outcome "refactor auth" partial

# Remove a label
claude-stats task-outcome a1b2c3 --clear
```

---

## `constraint-impact`

Measure what a **declared** constraint — a budget cap, a model-tier removal, a
quota change — actually cost or saved, by comparing the windows either side of
it, **per task class** (never in aggregate, so a workload shift can't
masquerade as policy damage).

```
claude-stats constraint-impact [options]
```

| Option | Default | Description |
|---|---|---|
| `--date <yyyy-mm-dd>` | Most recently declared event | Which entry in `config.policyEvents` to compare around — must match a declared `date` |
| `--since <date>` | _(full available history)_ | How far back the BEFORE window looks |
| `--until <date>` | _(full available history)_ | How far forward the AFTER window looks |
| `--project <path>` | _(all)_ | Filter to one project |
| `--account <uuid>` | _(all)_ | Filter to one account |
| `--min-sessions <n>` | `8` | Per-class, per-side sample-size floor. A class below this on either side reports `insufficient-data` instead of a delta computed on noise |
| `--csv <path>` | — | Also write the report as CSV |

**Requires at least one declared policy event.** This command refuses to run
and explains why if `config.policyEvents` is empty — boundaries are never
inferred from the data, only from what you declared. See
[Configuration](#configuration) for `policyEvents`' shape.

**What it reports, and what it doesn't:**

- **Two-sided by construction.** Both `totalTokenSavings` (what the
  constraint saved) and `totalDevTimeCost` (what it cost in developer time)
  are reported — `totalDevTimeCost` is only priced in dollars when
  `config.rate.hourly` is set; otherwise it stays in minutes/hours and
  `netEffectAvailable` is `false`. A report is expected to lead with whichever
  side is true, including a favourable or negligible result.
- **Evidence, not proof.** A policy change is not a controlled experiment —
  workload, team, and codebase all move too. Comparing within task class
  reduces the confound; it does not eliminate it. The output's
  `confoundNote` states this, and `classes[].modelsBefore`/`modelsAfter` let
  you check whether a model-*version* change rode along with the policy
  before quoting a class's delta to anyone outside the team.
- **Insufficient-data classes are reported, not dropped.** A class below the
  sample floor is returned with `verdict: "insufficient-data"` — read that as
  "too little data to compare," not silence.
- **Out of scope:** this does not compute a recap-task-grained "attempts per
  successful task" — the outcome model behind that is not calibrated at
  session grain (see `get_calibration`), and the recap task unit has no
  stable identity across a months-long boundary. `avgTurnsBefore/After` and
  `toolErrorRateBefore/After` are the stated proxy for rework instead.

**Examples:**

```sh
# Compare around the most recently declared policy event
claude-stats constraint-impact

# Compare around a specific declared date, with a higher sample floor
claude-stats constraint-impact --date 2026-05-01 --min-sessions 10

# Bound the before-window and export CSV
claude-stats constraint-impact --since 2026-03-01 --csv impact.csv
```

Output is JSON only (piped to `jq` if you want a subset) — this is a
structured diagnostic, not localized prose, the same precedent as
`cost-per-task --calibrate`.

---

## `pack`

Generate the **justification pack**: a self-contained HTML document plus a
CSV bundle for one calendar month, written to local disk — the artifact you
hand to a manager or finance contact who does not run claude-stats.
Equivalent to the `generate_justification_pack` MCP tool.

```
claude-stats pack --period <yyyy-mm> [options]
```

| Option | Default | Description |
|---|---|---|
| `--period <yyyy-mm>` | _(required)_ | Calendar month to report on |
| `--timezone <tz>` | System timezone | IANA timezone for month bucketing |
| `--sections <list>` | `headline,tickets,nonticket` | Comma-separated: `headline`, `tickets`, `nonticket`, `hygiene`, `constraint`, `calibration` |
| `--project <path>` | _(all)_ | Filter to one project |
| `--account <uuid>` | _(all)_ | Filter to one account |
| `--out <dir>` | Current directory | Directory to write the pack bundle into |
| `--json` | _(off)_ | Print the written file paths and section list as JSON instead of a sentence |
| `--invoice-csv <path>` | — | Import an invoice/Cost-Explorer-style CSV total for this run's reconciliation section (overrides `config.reconciliation.invoiceTotal` for this run only — never written back) |
| `--disclose-scope` | _(off)_ | Print the literal project path / account UUID in the pack instead of a `[withheld:…]` marker. See **Scope** below |

**Redaction:** the pack runs the same stricter redaction the org-sync plane
uses — prompt text, file paths, and session ids can never appear in it,
structurally, not by a filter applied after the fact. This is a stricter bar
than the local dashboard, because this document is designed to leave the
machine. See the [privacy documentation](../analysis/05-privacy-security.md)
for what that means in practice.

**Scope is stated, but its value is withheld.** A pack always says whether it
was filtered — a one-project total and a whole-machine total must never read
alike — but when `--project` or `--account` was used, the scope line and the
`projectPath`/`accountUuid` CSV column render a stable marker
(`[withheld:a1b2c3d4]`) instead of the literal value. An absolute path
routinely encodes an employer, a client, or an unreleased product name in a
parent directory, and this is the one artifact built to be handed to someone
else. The marker is deterministic, so two packs scoped alike still compare and
a monthly series stays readable. It is **not** a security boundary — an
eight-hex digest of a guessable path is guessable — it defeats disclosure *by
accident*, which is the real failure mode. Pass `--disclose-scope` when the
recipient is entitled to the literal values.

**Sections are opt-in.** The default (`headline,tickets,nonticket`) is the
smallest complete pack. The other three are computed from the same engines as
their standalone commands, and each costs real work, so you ask for them
explicitly:

| Section | What it adds | Its window |
|---|---|---|
| `hygiene` | Self-audited waste as a share of spend, per detector, with the direction of travel against the preceding period. Same engine as `get_efficiency_hints`. | The pack's month, plus the equal-length month before it for the trend |
| `constraint` | Before/after across the **latest policy boundary declared on or before the end of the period** (`config.policyEvents`), as a two-sided ledger: token cost saved *and* developer time spent. Same engine as `constraint-impact`. | **All recorded history either side of that boundary** — stated in the section |
| `calibration` | How often the automatic ticket-attribution pass agreed with rulings you made by hand, with its 95% interval and denominator. Same gate as `get_calibration`. | **Whole store** — every ruling ever made — stated in the section |

Two of the three deliberately do **not** use the pack's own month, and each
says so where it is rendered. A month either side of a policy boundary almost
never clears the per-class session floor, and a per-month cut of an
already-scarce set of manual rulings would read "uncalibrated" forever.

None of them ever fabricates a number in place of a missing one. Each has an
honest empty state that names the reason and the way out — no spend in the
period, no policy event declared, fewer than 30 rulings — and those states are
kept textually distinct from a real zero, so "0% waste" never stands in for
"no data". A `constraint` section that compared nothing opens by saying the
boundary is **not evaluated**, rather than leaving that to a footnote.

`summary.csv` gains five columns for these sections
(`hygieneWasteRatio`, `hygieneWasteCost`, `constraintNetEffect`,
`attributionAgreementRate`, `attributionAgreementN`). They are empty — never
zero — when the section was not requested or could not be computed.

The `constraint` section needs `rate.hourly` configured to state a net effect
at all: without it the developer-time half of the ledger has no price, and a
token saving on its own is half a ledger, not a result.

**Determinism:** generating the pack twice from the same inputs under a
frozen clock produces byte-identical output — every collection is sorted
before rendering and nothing reads the wall clock except the injected
generation timestamp.

**Examples:**

```sh
# Generate the default pack for July 2026
claude-stats pack --period 2026-07

# All sections, written to a specific directory
claude-stats pack --period 2026-07 --sections headline,tickets,nonticket,hygiene,constraint,calibration --out ~/Desktop

# Reconcile against an imported invoice total for this run
claude-stats pack --period 2026-07 --invoice-csv ~/Downloads/july-invoice.csv

# Machine-readable output (paths + section list)
claude-stats pack --period 2026-07 --json
```

---

## `recap`

"What did I get done today?" — a clustered, evidence-linked digest of a day's
sessions, grouped into items with a first prompt, a session count, and
(when configured) a linked ticket key.

```
claude-stats recap [options]
```

| Option | Default | Description |
|---|---|---|
| `--date <date>` | Today | `YYYY-MM-DD` |
| `--tz <tz>` | System timezone | IANA timezone |
| `--all` | _(shown by default)_ | Include low-confidence items — shown by default in this version, so this flag is currently a no-op reserved for a future default-hiding change |
| `--json` | _(off)_ | Machine-readable JSON output |
| `--embeddings <mode>` | `auto` | `on`, `off`, or `auto` — local sentence-embedding clustering. `auto` uses the bundled on-device model if cached, otherwise falls back to lexical clustering; `off` always uses lexical clustering. All inference happens on-device — nothing here calls a network endpoint |

**Examples:**

```sh
# Today's recap
claude-stats recap

# Yesterday, JSON output
claude-stats recap --date 2026-08-06 --json

# Force lexical clustering (skip the embedding model)
claude-stats recap --embeddings off
```

### `recap precompute`

Pre-build the daily-recap cache for prior days. Useful before a cold-cache
`cost-per-task --period all` run, or on a schedule.

```
claude-stats recap precompute [--lookback-days <n>] [--date <yyyy-mm-dd>] [--install-cron]
```

| Option | Default | Description |
|---|---|---|
| `--lookback-days <n>` | `7` | Days to pre-build |
| `--date <yyyy-mm-dd>` | — | Build a single date only |
| `--install-cron` | — | Print a crontab/launchd/Task-Scheduler snippet and exit — **does not modify your crontab**; copy the printed line in yourself |

### `recap correct`

Manage user corrections to clustered recap items — the mechanism that lets
you fix what the clustering got wrong, permanently, without it reverting on
the next recap. Every subcommand below resolves `<item>` the same way: an id
prefix from the digest, or a substring of the item's first prompt. An
ambiguous selector lists its candidates and exits non-zero rather than
guessing.

```
claude-stats recap correct <subcommand> [args]
```

| Subcommand | Description |
|---|---|
| `list` | List all stored corrections, with their numeric id |
| `remove <correctionId>` | Remove a correction by the id shown in `list` |
| `hide <item>` | Hide a digest item from future recaps |
| `rename <item> <label>` | Give a digest item a custom label |
| `ticket <item> <key>` | Assign a work-item key to a digest item, and link every session it covers — the recap-level equivalent of running `ticket <session> <key>` on each session in the item |
| `merge <itemA> <itemB>` | Merge two digest items into one for all future recaps |
| `split <item> <segmentId>` | Split a named segment out of a digest item into its own item |

**Examples:**

```sh
# See what corrections are stored
claude-stats recap correct list

# Hide a noisy item
claude-stats recap correct hide a1b2c3

# Rename an item
claude-stats recap correct rename a1b2c3 "Auth refactor"

# Assign a ticket key — links every session the item covers
claude-stats recap correct ticket a1b2c3 PROJ-123

# Merge two items that were really one piece of work
claude-stats recap correct merge a1b2c3 d4e5f6

# Split a mis-clustered segment out on its own
claude-stats recap correct split a1b2c3 seg-2

# Undo a correction
claude-stats recap correct remove 7
```

`recap correct ticket` writes through to `ticket_links` immediately (not just
the recap-corrections store), so the assignment is visible to
`get_cost_per_ticket`, `report --ticket`, and the justification pack right
away — it is the fastest way to bulk-assign a ticket key to everything a
day's recap grouped under one item.

---

## `mcp`

Start a local MCP server over stdio for AI agent access to your usage stats.

```
claude-stats mcp
```

No options. The server is intended to be launched by a Claude Code client (not run manually in a terminal). It reads the local database and exposes read-only tools — no network access or authentication required.

**Available tools** — 18 total, all read-only. Enumerated from
[`packages/cli/src/mcp/index.ts`](../../packages/cli/src/mcp/index.ts); the
exhaustive tool-count assertion in `mcp.test.ts` is what keeps this true.

| Tool | Description |
|---|---|
| `get_stats` | Usage summary for a period — tokens, cost, sessions, cache efficiency |
| `list_sessions` | Recent sessions with token counts and estimated cost |
| `get_session_detail` | Messages and token usage for a specific session |
| `list_projects` | Per-project usage breakdown |
| `get_status` | Database health, session count, last collection time |
| `search_history` | Search prompt history by keyword |
| `summarize_day` | Clustered digest of what you accomplished on a given day |
| `get_cost_per_task` | Cost per successful task — outcome-cost overall and per model (read-only) |
| `get_cost_per_ticket` | Cost attributed to work-item ticket keys from local evidence (git branch, commits, prompt mentions), with a coverage denominator and per-figure confidence tier. Pass `ticket` to drill into one key's evidence |
| `get_calibration` | Whether ticket-attribution and task-outcome confidence tiers have been checked against your corrections — an agreement rate on the reviewed subset (never "accuracy"), `state: "uncalibrated"` below the minimum sample |
| `get_efficiency_hints` | Self-audit: your own wasted spend across six local patterns (cache churn, retry loops, abandoned spend, context bloat, re-entry burn, tier mismatch). Every finding names its rule, threshold, and the specific sessions it fired on |
| `get_cache_ttl_fit` | Is this workload cheaper on the 5-minute or the 1-hour cache TTL? Idle-gap distribution, cache-write origin, per-model net cost, and one verdict always shown beside its margin. Equivalent to `claude-stats ttl-fit`; see [`ttl-fit`](#ttl-fit) above for how to read the verdict |
| `get_context_carry` | How much of the bill is carrying context forward, and where does it concentrate? Size bands, tokens above a set of caps, reset/sawtooth shape, and the session-start prelude — every dollar figure a stated lower bound. Answers the same question as Claude Code's own `/context`, but over time. Equivalent to `claude-stats context`; see [`context`](#context) above. Omits `concentration`, `preludeByProject`, and `turns` (session ids / project paths / message uuids), and strips `sessionId` from `resets`/`cycles` — use the CLI or local dashboard for those. Also carries an allowlisted `autoCompactFit` block — the same `autoCompactWindow` recommendation `context` prints, with raw model ids stripped down to a `uniform`/`unknownModels` summary — see [output-guide.md](output-guide.md#auto-compact-window-fit) |
| `generate_justification_pack` | Write the justification pack (HTML + CSV) for one month to local disk. Equivalent to `claude-stats pack --period <YYYY-MM>` |
| `get_constraint_impact` | What a *declared* policy boundary (`config.policyEvents`) measurably cost or saved, per task class, on both sides |
| `get_account_info` | Current login's seat/billing/org fields, plus every account this machine has observed. Never returns a raw email — only `emailPresent`/`emailHash` |
| `get_plan_mechanics_reference` | Offline reference snapshot of Team/Enterprise seat ranges and pricing, with a staleness warning |
| `size_seats` | Seat-sizing scenario table from headcount + technical fraction — pure arithmetic, never picks a plan |

**Per-account filtering:** `get_stats`, `list_sessions`, `list_projects`,
`get_cost_per_task`, `get_cost_per_ticket`, `get_efficiency_hints`,
`get_cache_ttl_fit`, `get_context_carry`, `get_constraint_impact`, and `generate_justification_pack` all accept an
optional `account` param — a full account UUID or an unambiguous prefix
(e.g. `<uuid-prefix>`). An empty string, a prefix matching no account, or a
prefix matching more than one account returns an error rather than silently
falling back to all accounts. `list_sessions` rows also include an
`accountUuid` field.

**Per-account token breakdown:** `get_stats`'s `planUtilization.byAccount[]`
entries carry `inputTokens`, `outputTokens`, `cacheReadTokens`, and
`cacheCreationTokens`, plus a `byModel` split (mirroring the top-level
`byModel` shape). Every token, prompt and cost figure — `summary`,
`byAccount`, `byModel`, `byDay`, `byHour`, `byProject` — is **in-window**
(bounded to the requested period) and computed from the same per-message data,
so each breakdown sums exactly to the headline.

Only `sessions` counts are session-scoped: a session is counted in the period
it was active, and attributed to the day it *started*. Its tokens are always
attributed to when they were actually sent, so a session spanning several days
contributes one session count but per-day token counts.

**Client configuration** — register via `claude mcp add`:

```sh
# The extension directory carries its version — resolve it rather than hardcoding one:
MCP_JS="$(ls -d "$HOME"/.vscode/extensions/de-otio.claude-stats-vscode-*/dist/mcp.js | sort -V | tail -1)"
claude mcp add -s user claude-stats -- "$(which node)" --experimental-sqlite \
  -e "require('$MCP_JS').startMcpServer().catch(e=>{console.error(e);process.exit(1)})"
```

> **Note:** The `mcpServers` key in `~/.claude/settings.json` is ignored by the Claude Code CLI for server registration. Servers must be registered in `~/.claude.json` via `claude mcp add` or `.mcp.json` for project-scope use.

The VS Code extension auto-registers this in `~/.claude.json` on first activation — no manual setup needed if you use the extension.

**Example queries once connected:**

- "How many tokens have I used this week?"
- "What were my most expensive sessions today?"
- "Which projects am I spending the most on?"
- "What's my cost per successful task, by model?"
- "How many tokens did my work account use this month?" (pass `account: "<uuid-prefix>"`)
- "How much did PROJ-123 cost me this month?"
- "Where am I wasting money in my own usage?"
- "Has this tool's confidence in ticket attribution ever been checked?"
- "Generate a justification pack for last month"

---

## `backfill`

Re-parse all session files from scratch to populate newly added fields (e.g. `prompt_text` added in schema v8). This resets all file checkpoints and runs a full collection.

```
claude-stats backfill [--verbose]
```

| Option | Description |
|---|---|
| `-v, --verbose` | Print one line per file as it is processed |

**Example output:**

```
Reset 44 file checkpoints. Running full re-collection...
Backfill complete. 44 files re-processed, 1876 messages updated.
```

Use this after upgrading `claude-stats` to a version that captures additional data from existing session files.

---

## `repair`

Repair derived data that normal collection cannot fix retroactively. Unlike
[`backfill`](#backfill), which re-reads the source files, `repair` recomputes a
stored field from data already in the database.

```
claude-stats repair <subcommand> [options]
```

### `repair project-paths`

Recompute `project_path` (and `repo_url`) for every session from that session's
own recorded working directory.

```
claude-stats repair project-paths [--dry-run]
```

| Option | Description |
|---|---|
| `--dry-run` | Preview the changes without writing anything and without creating a backup |

Claude Code encodes the project directory into the name of the folder under
`~/.claude/projects/`, and that encoding is lossy: a literal hyphen in a
directory name is indistinguishable from an encoded `/`. Collection now
prefers the session's own recorded working directory, but `project_path` is
written once at first insert and never revisited, so sessions collected before
that fix keep the wrong path — which splits one project's usage across two
rows in every per-project report.

Sessions whose source file has since been deleted have no ground truth left
and are reported as `unfixable` rather than guessed at. A real run backs up the
database first (the path is printed) and applies every change in one
transaction; `--dry-run` writes nothing and makes no backup. It is idempotent,
so a second run on repaired data changes nothing.

---

## `diagnose`

Show quarantine counts and schema health information.

```
claude-stats diagnose
```

Quarantined lines are raw JSONL lines that could not be parsed. They accumulate when Claude Code changes its output format or writes partial lines during a crash. Use this command to detect whether the parser needs updating.

Example output:

```
─── Diagnose ───

Quarantined lines : 2

Use 'status' for database metrics.
```

---

## `purge`

Delete claude-stats data from this machine and unregister the MCP server. **Dry
run by default** — without `--yes` it only prints what *would* be deleted and
exits without changing anything.

```
claude-stats purge [--yes] [--include-db] [--also-cloud] [--backup-cloud]
```

| Option | Description |
|---|---|
| _(none)_ | Dry run: preview what would be deleted; deletes nothing |
| `--yes` | Actually delete claude-stats data (archive/bundle files); also unregisters the MCP server from `~/.claude.json` |
| `--include-db` | Also delete the SQLite database `~/.claude-stats/stats.db` (otherwise the DB is kept) |
| `--also-cloud` | Also remove local cloud-sync configuration and clear auth tokens (the org/team plane) |
| `--backup-cloud` | Also delete **this device's** copy in your personal backup location (Dropbox/iCloud/Drive/OneDrive/local folder). Other enrolled devices keep their own copies until they run this too |

```sh
# Preview only (safe)
claude-stats purge

# Delete local data but keep the database
claude-stats purge --yes

# Delete everything including the database
claude-stats purge --yes --include-db
```

See [backup-and-sync.md](backup-and-sync.md#removing-your-data) for the cloud
scope and the VS Code **Delete All Stored Data…** equivalent.

---

## `setup`

Connect this device to a shared team Claude Stats backend and choose which local
accounts to share (aggregate-only). See [team-sync.md](team-sync.md).

```
claude-stats setup [--backend-url <url>] [--email <email>] [--accounts <csv> | --all-accounts]
```

| Option | Description |
|---|---|
| `--backend-url <url>` | Team backend URL (or set `CLAUDE_STATS_BACKEND_URL`); discovers config from `<url>/.well-known/claude-stats.json` |
| `--email <email>` | Email for the passwordless sign-in (or set `CLAUDE_STATS_EMAIL`) |
| `--accounts <csv>` | Link these accounts (UUIDs or labels, comma-separated) without prompting |
| `--all-accounts` | Link all known local accounts without prompting |

Prompts for the backend URL, email, and (unless a flag is given) which accounts
to share. Generates a per-user salt used to derive one-way account handles — your
raw account UUID never leaves the machine.

## `link`

Re-choose which local accounts to share, after `setup`. Same selection flags.

```
claude-stats link [--accounts <csv> | --all-accounts]
```

Requires a prior `setup` (needs the salt). Without at least one linked account,
`sync` has nothing to send.

## `sync`

Push minimized per-day aggregates for your linked accounts to the team backend.

```
claude-stats sync [--dry-run]
```

| Option | Description |
|---|---|
| `--dry-run` | Print exactly what would be sent (per-day rollups only) without sending |

Sends only aggregate totals — never per-session, prompt, path, or transcript
data. Each `(you, day)` row is an optimistic, idempotent upsert, so re-syncing a
day is safe.

## `disconnect`

Remove team-sync tokens and configuration. Preserves the salt so re-linking later
produces the same account handles.

```
claude-stats disconnect
```

---

## VS Code Extension

The optional VS Code extension embeds the dashboard directly inside the editor. It provides:

- **Automatic collection** — watches `~/.claude/projects/` for file changes and runs incremental collection automatically. No need to run `claude-stats collect` manually.
- **Dashboard panel** — the same interactive Chart.js dashboard as `serve`, displayed in a VS Code webview tab (opened via the Command Palette: **Claude Stats: Open Dashboard**). Updates automatically after each collection.
- **Status bar item** — shows today's token count and estimated cost in the bottom bar; click to open the dashboard. Updates automatically after each collection.
- **Optional backup & sync** — **Claude Stats: Set Up Backup & Sync…** (or the dashboard's **Settings tab → Backup & Sync**, which also shows status and can turn it off again) turns on optional, end-to-end-encrypted backup and cross-device sync via a cloud folder you already use; **Claude Stats: Delete All Stored Data…** removes it. See [backup-and-sync.md](backup-and-sync.md).
- **Optional team sync (aggregate-only)** — **Claude Stats: Connect to Team Sync…** → **Link Accounts to Share…** → **Sync Now** shares minimized per-day usage totals with a shared team backend (never per-session or prompt data); **Disconnect from Team Sync** and **Open Team Dashboard** round it out. Equivalent to the CLI `setup` / `link` / `sync` / `disconnect` commands. See [team-sync.md](team-sync.md).

### Installation

The extension is fully self-contained — all dependencies (including the parser, store, and dashboard renderer) are bundled into a single file via esbuild. You do **not** need to install the `claude-stats` CLI separately.

```sh
# Build and package in one step
npm run package:ext

# Install the .vsix
code --install-extension extension/claude-stats-vscode-*.vsix
```

For development, you can use `npm run build:ext` to rebuild just the extension bundle, or `npm run build:all` to build both the CLI and extension.

### Configuration

The extension contributes these settings (accessible via **Settings > Extensions > Claude Stats**):

| Setting | Default | Description |
|---|---|---|
| `claude-stats.port` | `9120` | Port for the `serve` command (informational; the extension panel uses direct data access) |
| `claude-stats.autoRefreshSeconds` | `30` | How often the dashboard panel refreshes its data (seconds). Set to `0` to disable |
| `claude-stats.recap.embeddings` | `auto` | Semantic clustering for daily-recap. `auto` uses the bundled local embedding model; `off` falls back to lexical clustering. All inference is on-device |
| `claude-stats.backendUrl` | `""` | Base URL of your team's Claude Stats backend, set when you **Connect to Team Sync** (team sync only) |
| `claude-stats.autoSync` | `false` | Push minimized daily aggregates to your team backend automatically after each collection (team sync only) |

### Multiple VS Code instances

Multiple VS Code windows can run the extension simultaneously without data corruption. SQLite WAL mode allows concurrent readers, and a `busy_timeout` lets concurrent writers wait rather than fail. Collection is idempotent (upsert-based), so duplicate work from multiple instances is harmless — at worst, two instances parse the same file and write the same data.

### Requirements

The extension requires Node.js 22.5+ (for `node:sqlite`). If the extension host's Node version is too old, you will see an error when opening the dashboard. In that case, use `claude-stats serve --open` from the terminal instead.
