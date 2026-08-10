# Changelog

All notable changes to the Claude Stats VS Code extension are documented here.

## 0.20.0 — 2026-08-10

### Added

- **The justification pack's `hygiene`, `constraint` and `calibration`
  sections now carry real figures.** All three were accepted by `--sections`
  but rendered an "engine not wired" block. Each is minimized before it enters
  the document: hygiene reports a per-detector count and cost and never the
  findings themselves (the session ids behind them are structurally incapable
  of reaching the pack), constraint drops the local-only detail on a policy
  event, and calibration quotes the same caveat sentence the dashboard shows.
  Two of the three deliberately span a wider window than the pack's month and
  say so where they render — a month either side of a policy boundary rarely
  clears the per-class session floor.
- **The cost card's trend arrow.** It compares against the window of equal
  length immediately preceding, under your current filters. See
  [output-guide.md](../doc/user-doc/output-guide.md#insights-tab) for why not
  the same calendar period.

### Changed

- **The dashboard's recommendation panel is localized** in all ten languages,
  including its two section headings. It was the last hardcoded English on the
  default view.
- **Dependency majors:** commander 12 → 15, vite 6 → 8 (with
  `@vitejs/plugin-react` 4 → 6, which requires it), and
  `@testing-library/jest-dom` 6 → 7. The frontend stays on React 18 and
  Tailwind 3 for now — `@tremor/react` v3 peer-requires React 18 and its class
  names are scanned by a Tailwind 3 config, so those two majors move together
  with a Tremor migration or not at all.

### Fixed

- **Four MCP tools answered `i18n not initialized` instead of answering.**
  `get_calibration` failed on every call; `get_cost_per_ticket`,
  `get_efficiency_hints` and `generate_justification_pack` failed whenever they
  took a zero-cost branch. Translation was only ever initialized by the CLI
  builder, and neither route into the MCP server passes through it:
  `claude-stats mcp` short-circuits before the CLI is built precisely so
  nothing writes to stdout ahead of the JSON-RPC channel, and the VS Code
  extension launches a bundle whose entry point *is* the server. The server now
  initializes translation itself, and leaves an already-initialized one alone so
  an explicit `--locale` survives. Covered by a test that drives the real
  binary over stdio — the defect lives in process startup, so nothing running
  in-process could observe it.
- **`claude-stats dashboard` emitted invalid JSON.** i18next 26 prints a
  promotional banner through `console.info` on startup, and `console.info`
  writes to stdout — which this CLI uses as a protocol channel: `dashboard`
  and `export` emit JSON/CSV there and `mcp` speaks JSON-RPC over it. Anything
  piping `dashboard` into `jq` got a parse error. The banner is now off, and a
  test runs the real binary and parses its stdout so the class of bug cannot
  come back unnoticed.
- Durations under 30 seconds rendered as "0 dev-minutes", and 0.999 hours
  rendered as "60 dev-minutes" one rounding step away from "1.0 dev-hours".
- The tokens-per-call figure in the MCP-server recommendation followed the
  *machine's* locale for its thousands separators, so the same report could
  not be compared across two machines.

## 0.19.0 — 2026-08-08

### Added — The Insight Suite: ticket attribution, self-audit, calibration, and the justification pack

The dashboard's **Insights tab is now the default landing tab.** It answers
five questions in plain sentences — what did AI cost, what did it buy, was it
efficient, is the setup right, what should change — instead of opening on raw
token mechanics. See [output-guide.md](../doc/user-doc/output-guide.md#insights-tab).

- **Ticket attribution** (`claude-stats ticket`, `report --ticket`,
  `get_cost_per_ticket`). Cost attributed to work-item keys (e.g. `PROJ-123`)
  from locally observed evidence — git branch names, commit subjects, and
  prompt-text mentions. No tracker API is called. Every figure carries a
  confidence tier and a coverage denominator; nothing claims 100%
  attribution without checking it. Configure `tickets.projectKeys` to raise
  precision to `high` confidence.
- **Six efficiency-hygiene detectors** (`get_efficiency_hints`): cache churn,
  retry loops, abandoned spend, context bloat, re-entry burn, and a
  tier-mismatch check. Self-audit only — nothing here ranks developers, and
  nothing leaves the machine.
- **A task classifier** (`claude-stats task-class`) labels sessions into fine
  and coarse task classes, versioned so a rule change reclassifies only the
  affected sessions.
- **A constraint-impact engine** (`claude-stats constraint-impact`,
  `get_constraint_impact`) measures what a *declared* policy boundary
  (`config.policyEvents`) — a budget cap, a model-tier removal, a quota
  change — actually cost or saved, per task class, on both sides. Never
  infers a boundary from the data.
- **Outcome calibration** (`get_calibration`) reports whether ticket
  attribution's and task-outcome's confidence tiers have ever agreed with
  your own corrections — an agreement rate on the reviewed subset, explicitly
  not accuracy, and "uncalibrated" below a minimum sample of 30.
- **Invoice reconciliation** (`config.reconciliation`, `pack --invoice-csv`)
  compares the local estimate against an imported invoice total and can
  conclude the estimate is wrong — that's the point.
- **The justification pack** (`claude-stats pack`,
  `generate_justification_pack`) writes a self-contained HTML + CSV bundle
  for one month — the first artifact in this project designed to leave the
  machine. It runs the stricter org-plane redaction (no prompt text, file
  paths, or session ids), not the looser local rules. See "The Justification
  Pack: A Third Egress Path" in
  [05-privacy-security.md](../doc/analysis/05-privacy-security.md).
- **`claude-stats recap correct ticket`** assigns a ticket key to a whole
  clustered recap item at once, linking every session it covers.

### Changed — What's now stored locally

Ticket keys extracted from prompt text are persisted in a new `ticket_links`
table; a per-message git branch is now stored (`messages.git_branch`,
alongside the existing session-level branch); sessions carry a task
classification (`session_task_class`); and structured API-error/retry events
are persisted (`api_error_events`). All of this stays local-only, same as the
rest of the database, with the single exception of the justification pack
above. See [05-privacy-security.md](../doc/analysis/05-privacy-security.md)
for the full accounting.

## 0.18.1 — 2026-07-25

### Fixed — Token, prompt and cost figures are now correct per period

Several defects made the dashboard's numbers wrong, in some cases by orders of magnitude. If your figures move sharply after this upgrade, they were wrong before.

- **A dashboard could show "0 sessions" beside a non-zero cost.** Both session upserts overwrote a session's `last_timestamp` with `NULL` whenever a parse chunk contained no timestamped entry (SQLite's scalar `max()` returns `NULL` if any argument is `NULL`). 45% of stored sessions were affected. Those sessions then dropped out of every period view while their messages still counted toward the headline cost. The stored values are repaired on upgrade, and period membership no longer depends on that cached column.

- **Session token counters were inflated up to 14x.** Counters were *added* on each incremental parse with nothing making that idempotent, so two collectors (the extension, the MCP server, the CLI — which can run at once) each added the same work, permanently. They are now recomputed from the per-message data, which is keyed by message id and therefore immune. One real session had 73.5M output tokens recorded against 5.1M actually sent.

- **A session's whole history was charged to one day.** Period token totals summed session *lifetime* columns, and the per-day/per-hour charts attributed a session's entire total to the day and hour it *started*. A week-long session put 7.1 billion cache-read tokens into a single day. Every token, prompt and cost figure is now attributed to when the work was actually sent, so `byDay`, `byHour`, `byProject` and `byAccount` each sum exactly to the headline.

- **"Prompts" counted tool results.** Tool results arrive as user messages, so every tool call counted as a prompt — one session reported 227 prompts for about 4 real ones. Prompts now count genuine user turns, within the selected period. Sessions whose transcripts Claude Code has already deleted keep an approximate historical count (recovered from stored prompt text, ~68% accurate); ongoing sessions are exact.

- **Replayed messages could zero out real usage.** Transcripts replay earlier turns verbatim on resume and compaction, and the replayed copies carry an empty usage block. Last-write-wins let those overwrite genuinely billed usage; an empty usage block is now treated as carrying no information.

- **`includeCI=false` now applies to cost too.** It narrowed the session list but not the per-message totals, so cost kept including CI work that the session count had already excluded.

## 0.18.0 — 2026-07-22

### Added — Per-account token-level breakdown in MCP tools

The MCP tools `get_stats`, `list_projects`, `list_sessions`, and `get_cost_per_task` now accept an optional `account` filter (UUID, full or prefix-matched) for querying usage by account.

- `planUtilization.byAccount[]` now carries the full token breakdown: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, plus a `byModel` split matching the top-level model breakdown.
- `list_sessions` rows now include `accountUuid` for each session, allowing filtering and grouping by account programmatically.

### Fixed — Session aggregates now reconcile with headline totals

Session-scoped aggregates (`byAccount`, `byProject`, `byDay`, session counts, and velocity) now align with the headline cost. **You may see higher session counts and cost-per-project figures; here's why:**

- **Sessions now include CI/non-interactive and source-deleted** — they were silently excluded before, but they are real API usage and the headline cost already counted them. Restoring them brings the session-scoped view into agreement with the cost bottom line.
- **Per-account cost and tokens are computed the same way as the headline total** — grouped from the per-message data over your date range — so the per-account and per-model breakdowns sum exactly to the headline, even for sessions with incomplete timestamp metadata that the old session-based grouping under-counted.
- **`period:"all"` may shift ~1%** due to orphan messages in the hourly rollup that session aggregates cannot address.

See the MCP tool descriptions for the reconciliation guarantee.

## 0.17.2 — 2026-07-10

### Added — Account linking for team sync

Team sync is now completable end-to-end. **Connect to Team Sync** guides you
through picking which local accounts to share (a multi-select, re-runnable via
the new **Claude Stats: Link Accounts to Share…** command). Only the accounts
you pick are shared, each under a one-way salted handle — raw account IDs never
leave your machine. Previously there was no way to link accounts, so every sync
reported "No linked accounts".

### Fixed

- **Connect** now completes the full setup: it generates the per-user salt and
  preserves it (and your linked accounts) across reconnects. It previously wrote
  neither, and its config write clobbered anything the CLI had set up — leaving
  sync permanently un-completable.
- **Connect** now reads the backend's discovery document with the correct keys
  (`appsyncEndpoint` / `cognitoUserPoolId` / `cognitoClientId`); the old inline
  parser used the wrong field names and would fail against a real backend.

## 0.17.1 — 2026-07-10

### Added — Team sync commands

The optional **team sync** feature (aggregate-only usage sharing to a shared
Claude Stats backend) is now reachable from the Command Palette: **Connect to
Team Sync…**, **Sync Now**, **Disconnect from Team Sync**, and **Open Team
Dashboard**, plus a click-to-sync cloud item in the status bar and the
`claude-stats.backendUrl` / `claude-stats.autoSync` settings. The feature
existed in the codebase but was never wired into the extension.

### Fixed

- The extension's cloud sync issued a `syncSessions` mutation that no longer
  exists in the backend schema and built a per-session payload the aggregate-only
  org plane rejects. Sync now goes through the same minimized-aggregate path as
  the CLI (`claude-stats sync`) — per-day totals only, never per-session or
  prompt data.

## 0.17.0 — 2026-07-07

### Added — Backup & Sync on the dashboard Settings tab

Backup and cross-device sync can now be set up, inspected, and turned off from
the dashboard itself — in the VS Code panel *and* the locally served dashboard
(`claude-stats serve`). Previously the Command Palette wizard was the only way
to configure it.

- **Guided setup in the Settings tab.** Detected cloud folders (Dropbox, iCloud
  Drive, Google Drive, OneDrive) are offered one-click, or point it at any
  folder. The encrypted-vs-plaintext choice carries the same plain-spoken
  warning copy as the wizard; encrypted setup shows the recovery key once, with
  copy-to-clipboard and an explicit "I've saved my recovery key" confirmation.
- **One-paste second device, now in the GUI.** A folder that already contains a
  backup is flagged, and pasting the recovery key connects the device — a wrong
  key fails cleanly, never silently.
- **Status at a glance.** Folder, encryption mode, and last backup write; a
  standing reminder appears until the recovery key is confirmed as saved.
  Turning backup off leaves the backup folder and your other devices untouched.

### Fixed

- A recovery-key confirmation no longer survives turning backup off or a fresh
  encrypted setup — a stale confirmation could suppress the save-your-key
  reminder for a brand-new key.
- The Marketplace description and README now correctly say **local by
  default** with opt-in, end-to-end-encrypted backup — the previous blanket
  "nothing leaves your machine" wording predated the backup feature.

## 0.16.0 — 2026-07-05

### Added — Optional end-to-end-encrypted backup & cross-device sync

claude-stats can now back up your stats and sync them across machines — **opt-in,
and end-to-end encrypted by default.** Run **Claude Stats: Set Up Backup & Sync…**
from the Command Palette (or take the one-time nudge on activation).

- **No new account, no server.** Your stats are written as per-device shards into
  a folder your existing cloud app (Dropbox, iCloud Drive, Google Drive,
  OneDrive, …) already syncs. Backup and sync are the same mechanism; every device
  merges the others' shards, conflict-free.
- **Encrypted by default for third-party folders.** Data is sealed on your device
  before it leaves; your cloud provider only ever stores opaque bytes — even
  project and session names in the file index are encrypted. Plaintext is offered
  as an explicit, warned opt-out.
- **Recovery key.** Encrypted setup generates a recovery key that is the only way
  back into your backup — zero-knowledge, never uploaded. Losing it *and* all your
  devices means the backup is unrecoverable; the UX states this plainly.
- **Second device in one paste.** A new machine that sees the same folder offers
  "Enter recovery key"; paste it once and the device enrolls itself and joins the
  sync group. A wrong key fails cleanly, never silently.
- **Delete All Stored Data.** A new command removes local data (and, optionally,
  this device's cloud copy), honestly noting that your other devices keep their
  own copies. The CLI gains `claude-stats purge` (a dry run by default).

Your personal backup is separate from any team/organization dashboard, which only
ever sees aggregate totals — never your prompts or transcripts. See the new
[Backup, Sync & Privacy guide](https://github.com/de-otio/claude-stats/blob/master/doc/user-doc/backup-and-sync.md).

### Added — Per-subscription fee-share charts (Projects tab)

In addition to the overall "subscription fee by project" chart, the Projects tab
now shows one chart per subscription, breaking down what share of *that*
subscription's monthly fee each project accounts for.

### Fixed — Dashboard display glitches

- Task labels in the overuse chart no longer show raw HTML entities
  (`&lt;`/`&gt;`) — they render as the intended `<…>` text.
- Accounts other than the currently-signed-in one now show their email address
  instead of a truncated internal UUID.
- Harness `<task-notification>` system blocks are stripped from captured prompt
  text, so they no longer inflate cost-per-task counts.

## 0.15.0 — 2026-07-04

### Added — License advisor: plan recommendations grounded in real usage

The dashboard and MCP tools can now answer "which Claude plan should we buy?"
— Team vs. Enterprise, seat-tier mix, how many seats — from measured usage
instead of guesswork.

- **Enterprise-aware plan classification.** The dashboard's Plan tab gains a
  usage-intensity card (light / typical / power, against Anthropic's published
  benchmarks), and the recommended-plan logic now recognizes usage beyond the
  top consumer tier as Enterprise-scale rather than silently capping out.
- **New MCP tools.** `get_account_info` (current seat/billing/org fields —
  never a raw email), `get_plan_mechanics_reference` (a dated, sourced snapshot
  of how Claude plans are sold, with a staleness warning and a nudge to verify
  live pricing), and `size_seats` (pure seat-and-cost scenario projection that
  surfaces the decision, never makes it). `get_stats` now also returns the
  plan-advice block it already computed.
- **New `plan-advisor` CLI command.** `claude-stats plan-advisor --headcount N
  --technical-fraction P` prints a seat-sizing scenario table with cost
  projections, Team-ceiling checks, and the compliance / spend-limit / timing
  questions a buyer must decide — localized across all supported languages.
- A `license-advisor` skill ties these together into a guided, sourced
  recommendation workflow.

## 0.14.0 — 2026-07-04

### Removed — The "Models" tab

The dashboard's "Models" tab (tokens-by-model and stop-reasons charts) has
been removed — it wasn't earning its place. The same per-model breakdown is
still available through the `dashboard` command's JSON output and the MCP
tools, and the tab can come back if it turns out to be missed.

### Changed — Auto-refresh interval is now configurable, with a 60-second floor

0.12.1 bumped the dashboard's fixed auto-refresh interval from 30 seconds to
2 minutes, with no way to change it. It's now a Settings tab field, and every
path that sets it — the Settings form and a hand-edited `?refresh=` URL
parameter alike — is floored to 60 seconds, so the dashboard can no longer be
made to refresh more than once a minute.

## 0.13.1 — 2026-07-03

### Fixed — Project paths and costs could be silently wrong for hyphenated directory names

Any project whose folder name contains a hyphen (e.g. `claude-stats`,
`dot-atrium`) could have its sessions and cost split across a real project
and one or more phantom sub-paths, and lose its git remote attribution
entirely. Project paths are now read from each session's own recorded
working directory instead of being guessed from the encoded folder name.
A new `claude-stats repair project-paths` command (supports `--dry-run`)
fixes already-collected sessions; it backs up the database before making
any change.

### Fixed — Claude Sonnet 5 and Opus 4.8 costs could be missing or inconsistent

`list_sessions` and `get_session_detail` could disagree on a session's
cost, and Sonnet 5 sessions could show as `$0 / unknown` depending on which
MCP tool was called. Both now price consistently from the same per-message
model data, and the MCP server now loads pricing correctly at startup.

### Fixed — A few smaller MCP reporting-accuracy issues

`get_status`'s session count no longer includes sessions whose source file
has been deleted, matching every other reporting query. `get_cost_per_task`
no longer surfaces an empty placeholder row for Claude Code's internal
"synthetic" message marker.

## 0.13.0 — 2026-07-03

### Added — Custom date ranges everywhere, not just day/week/month/all

Every surface — the CLI, the MCP tools, the web dashboard, and this
extension — now accepts an arbitrary start/end date range alongside the
existing presets. Pass `--since`/`--until` on the CLI, `since`/`until` to
any MCP tool that takes a `period`, or pick two dates in the dashboard
toolbar; a custom range takes precedence over a simultaneously-set preset,
and every existing view (summary, trend, cost-per-task, energy/CO2)
respects it.

### Fixed — Wrong calendar day at month/year boundaries in local time

A date-boundary calculation shared by daily recap, cost-per-task, and (now)
custom date ranges could land on the wrong calendar day for the 1st or
last day of a month in some timezones, and produced a negative-length
window for December 31 and February 28. Corrected for every caller.

### Improved — More UI strings translated across all 9 supported languages

A batch of previously English-only strings (in the CLI, the dashboard,
and this extension) now has real translations in German, Spanish, French,
Japanese, Polish, Brazilian Portuguese, Russian, Ukrainian, and Simplified
Chinese.

## 0.12.2 — 2026-07-02

### Fixed — Dashboard could fail to load entirely in some languages

A translated string embedded in the dashboard's script was not escaped
before being inserted into a JavaScript string literal. Any translation
containing an apostrophe broke the whole script, silently disabling every
chart and every interactive feature on the page. This is now fixed for all
languages.

### Changed — Subscription Fee by Project is now a pie chart

Each currency's fee breakdown now renders as a pie chart, with unattributed
("idle") subscription pools folded into a single slice, alongside the
existing per-project dollar and percentage breakdown.

### Added — Guidance for accounts missing an email or plan

The Settings and Classify tabs now explain, inline, why an account might
show without its email or plan, and how logging in as that account once
resolves it. Settings also now notes that new accounts appear automatically
once used with Claude Code — there's no need to add one manually.

### Changed — Monthly fee pre-fills with the plan's default price

Selecting a plan type in Settings now pre-fills the monthly fee with that
plan's default price, converted to whichever currency is selected — still
fully editable.

## 0.12.1 — 2026-07-01

### Fixed — Non-active accounts showed a truncated ID instead of an email

On the **Settings** and **Classify** tabs, only the currently logged-in account
showed its email address — every other known account fell back to a truncated
account ID, even after you'd been logged in with it before. The dashboard now
remembers the email of any account it has previously seen locally, so
switching accounts no longer blanks out a label you already had.

### Changed — Auto-refresh interval increased

The dashboard's auto-refresh (browser mode) reloaded every 30 seconds by
default, which was more often than needed for a stats view. It now defaults
to every 2 minutes.

## 0.12.0 — 2026-07-01

### Added — Attribute a project's cost to the subscription that owns it

Building on per-account attribution, you can now bill each **project** to the
subscription that should pay for it — regardless of which account actually ran a
given session. Use two accounts in one repo, or run a session an IDE couldn't
attribute automatically, and the cost still lands on the right subscription.

- New **Classify** tab in the dashboard: your projects, grouped and **ranked by
  cost**, each with a picker to assign it to a subscription — or **Split across
  usage** for a project shared between subscriptions (e.g. when one plan's limit
  isn't enough). Classifying the few highest-cost projects covers most of your
  spend; one **Apply** re-bills everything and refreshes the dashboard.
- New CLI: `claude-stats account classify` lists your projects ranked by cost
  with the total still unassigned; `claude-stats account own` sets a rule by
  project path or git remote (`--path`, `--remote`, `--account <uuid|split>`,
  plus `--list`, `--clear <id>`, `--dry-run`).
- Ownership rules take precedence over automatic attribution. A **split** project
  keeps each session on the account that actually ran it, so its cost divides by
  real usage.

Everything is computed **locally**.

## 0.11.0 — 2026-07-01

### Added — Per-account usage attribution

Claude Stats now works out **which Claude account each session belonged to**, so
your stats split cleanly when you use more than one account (for example a
personal Max plan alongside a work Team plan) on the same machine.

- The dashboard groups usage, cost, and plan value **by account**, with a
  selector to filter to one account at a time.
- Attribution is layered strongest-to-weakest: an OpenTelemetry export (if you
  enable it) → Claude's own telemetry → live-session pins → an observed
  account-switch timeline → a single-account backfill for older history. Each
  session records the source and confidence behind its account.
- New commands: `claude-stats account` shows the current account and the
  accounts known from your history; `account reattribute` recomputes attribution
  across all stored sessions (with `--dry-run`); `account otel ingest` loads an
  OTLP export for exact, no-inference attribution.

Everything is computed **locally**, and email addresses are stored only as a hash.

### Fixed — Overview no longer looks empty at the start of a day or month

In the first hours of a new day or month, the **Day**/**Month** view could show
"0 sessions / 0 tokens" next to a non-zero cost — a session still running across
midnight was counted for cost but not for sessions. Sessions active in the
selected period are now counted consistently, and a genuinely empty period shows
a short hint to switch to **Week** or **All** instead of a wall of zeros.

## 0.10.0 — 2026-06-29

### Fixed — Switching the dashboard to "Month" no longer takes ~a minute

Selecting the **Month** period could hang the dashboard for close to a minute on
a cold cache. The cost-per-task metric was shelling out to `git` and `gh` once
per day per project across the whole window (~30 days), and most of that work —
the author email, the push state, the merged-PR lookup — was identical every
day. It now fetches each project's git/PR data **once over the whole window** and
reuses it per day. Cold "Month" drops from ~57 s to a few seconds; repeated views
stay fast (the digest cache also holds more days now).

### Changed — Per-account subscription *plan type* (different plans per account)

The Settings tab assumed all your subscriptions were the same plan. You can now
set a **plan type per account** — e.g. a personal **Max 20x** alongside a work
**Team Premium** — and selecting a type fills in its standard monthly fee
(still editable).

- Each account row in **Settings → Subscriptions** has its own plan-type picker;
  the single global plan-type/fee fields are gone.
- The Plan tab's headline fee is now the **sum of your accounts' plans**
  (e.g. $200 + $125 = $325), and each account is judged against its own plan
  rather than one shared number.

## 0.9.0 — 2026-06-27

### Added — Subscription fee attribution (per-account fees → per-project shares)

You can now record what each of your Claude subscriptions actually costs and see
that flat monthly fee distributed across the projects it paid for.

- **Settings tab:** set a monthly fee, currency, and label for **each Claude
  account** you use (the accounts are listed automatically from your history).
  This replaces the single global fee for multi-account users while staying
  backward-compatible for single-account ones.
- **Projects tab:** a new **Subscription Fee by Project** card shows each
  account's fee, pro-rated to the selected period, spread across that account's
  projects in proportion to API-equivalent usage. Switch Day/Week/Month/All and
  the attribution recomputes.
- **Per-account pooling, not a global pool:** a work fee only flows to work
  usage and a personal fee only to personal usage — no cross-account leakage.
  Currencies are never mixed; each gets its own subtotal.
- **Honest by design:** a configured account with no usage in the period shows
  as an explicit *idle subscription* line rather than silently inflating active
  projects, and usage that can't be attributed to an account is never invented.
  The configured fees also feed the Plan tab's value verdicts.

## 0.8.0 — 2026-06-27

### Added — Cost-efficiency frontier (value per cost)

A new **Cost-efficiency** panel sits beside the cost-per-successful-task metric
in the dashboard, answering "was AI used as efficiently as possible, and could
the same result have come cheaper?"

- For each kind of work (archetype — mechanical edit, multi-file refactor,
  debugging, research, greenfield), it finds the **frontier model**: the
  cheapest model that has historically cleared the completion proxy on your own
  history at a high success rate, over enough tasks to be meaningful.
- It estimates **recoverable waste** — spend that ran on a pricier model than
  the proven-cheaper alternative — and surfaces concrete **routing levers**.
- **Honest by design:** the estimate is strictly cross-model. On a single-model
  workload (e.g. everything on one model) there is no cheaper alternative to
  route to, so the panel says *"not enough model diversity yet to compute a
  frontier"* rather than inventing a saving. The numbers reconcile
  (`realised − frontier = recoverable`), small samples abstain, and the metric
  rests on the completion proxy, not on survival.
- Fully local and read-only: the panel shows numbers and model names only — no
  prompt text, file paths, or project names leave your machine, and the
  read-only MCP tool carries the same prompt-text-free payload.

## 0.7.1 — 2026-06-26

### Changed — Startup performance

The dashboard now paints fast regardless of how much Claude Code history you
have accumulated. Before, first open re-scanned the entire message history on
every refresh, so load time grew without bound as history piled up ("Crunching
your Claude Code history…" lingering for seconds).

- **Opens on the Day period by default** (was All). `buildDashboard` cost is
  O(messages in the period), so Day keeps first paint sub-300ms no matter the
  total history; widen to Week/Month/All on demand from the period dropdown.
  The CLI `report`/`serve` defaults are unchanged.
- **Faster wide periods too.** Measured on a 214k-message history (warm):
  Day **~3.3s → ~0.14s**, Month **~1.9s → ~0.92s**, All **~3.7s → ~1.3s**.

### Fixed — under the hood (no output change)

Every change below was verified output-preserving against the live database.

- Message-level reads now seek by `timestamp` through a session-membership
  subquery instead of scanning, and adopt message-timestamp period semantics.
- The energy section is aggregated in SQL (`GROUP BY`) rather than looping every
  in-period message in JS.
- A persisted hourly rollup (`message_hourly`, schema V12) serves unbounded
  energy/totals reads — those reads dropped from ~725ms to ~44ms on All — and is
  maintained incrementally by the collector.
- The recap pipeline no longer recomputes its per-day snapshot hash from every
  message before the cache lookup; the warm month floor fell from ~967ms to
  ~242ms.

## 0.7.0 — 2026-06-24

### Added — Outcome accuracy + in-dashboard calibration

Builds on 0.6.0's cost-per-successful-task metric with automatic accuracy
signals and an in-dashboard way to calibrate and turn them on.

- **Calibration view** on the Spending tab, beside the ✓/~/✗ labelling
  controls: how well the proxy and the accuracy signals agree with your labels
  (failed-precision, accuracy, Brier), with a floor verdict that tells you when
  the signals are trustworthy enough to enable.
- **Signal-activation toggle**: turn the experimental accuracy signals on for
  the live rate straight from the dashboard — no config editing.
- **Accuracy signals** (default-off, calibration-gated): conversational
  repair/acceptance, output truncation, rework, failed tool calls (a new
  per-message capture of `is_error` tool results), and revert/fixup commits —
  combined through an evidence scorer with an abstain band so weak or
  contradictory evidence never fabricates a verdict.
- **Opt-in LLM-judge tier** (`cost-per-task --llm-judge`): an independent,
  blinded model rules on ambiguous tasks. Local-first — configure an Ollama (or
  any OpenAI-compatible) endpoint to keep data on the machine.
- **Calibration CLI**: `cost-per-task --calibrate` reports proxy/signal
  agreement against your labels as JSON.

### Fixed

- A committed-but-unpushed task is now classified as success, not in-flight.
- The dashboard shows a loading screen on first open instead of a blank panel
  while it computes.
- The "Cost per Successful Task" detail moved to the Spending tab (the overview
  keeps a compact summary box); the sidebar gained a Spending tab explanation.

## 0.6.0 — 2026-06-23

### Added — Cost per successful task

A new outcome-cost metric: equivalent-API dollars spent per *shipped /
confirmed* task, overall and per model — not per token. It answers "what does
a correct result actually cost?", the question that matters once model
subsidies end.

Outcome is four-state (success / failed / in-flight / unobservable). The
success rate is computed over the *observable* slice (success ∪ failed) only,
never over all tasks, with coverage and the labelled share reported beside it —
so the number never pretends to know more than it does. Below a coverage
floor the dashboard and CLI lead with the exact half (mean cost per attempt)
and warn.

- **Dashboard:** a read-only card on the Overview tab — headline, the
  mean ÷ rate decomposition, coverage/labelled badges, the four-state outcome
  breakdown, and a per-model table.
- **In-dashboard labelling (VS Code only):** per-task success / partial / fail /
  clear controls. Explicit labels override the git/confidence proxy, turning the
  metric from a hypothesis into an eval. This write path is gated to the VS Code
  webview; the read-only `serve` HTTP surface never renders the controls and
  carries no per-task prompt text.
- **CLI:** `claude-stats cost-per-task` (with `--period / --by-model / --json`
  and the usual project/account/repo filters) and `claude-stats task-outcome
  <item> success|partial|fail [--clear]` for labelling.
- **MCP:** a read-only `get_cost_per_task` tool. It reports the metric and how
  much of it is labelled, but cannot set a label — keeping the producer of the
  number separate from the judge of success.

### Changed — Corrected per-task cost attribution

Cost is now summed over each task's own messages (with sub-agent cost folded
into the parent task and counted once), fixing a double-count in the previous
roll-up. **Cost figures for already-recorded days will shift** when the cache
is recomputed — the new numbers are the corrected ones. Per-task cost is also
now broken down by model.

### Fixed — Localized HTML export

`claude-stats report --html` rendered every label as a raw translation key
because it never passed a translator to the dashboard renderer. The exported
HTML is now fully localized.

## 0.5.3 — 2026-05-23

### Fixed — Energy tab now respects the account selector

Selecting an account from the dashboard's account dropdown updated every
panel (Overview, Plan, Spending, byDay, byHour, …) except the Energy
tab, which kept showing aggregate energy/CO₂ across every account in the
store. The dashboard data builder threaded the `accountUuid` filter into
every section's store query — except the energy section, whose
`getMessagesForEnergy` helper did not even accept an account filter.

The energy section now filters by `accountUuid` end-to-end, so totals,
per-day / per-model / per-project breakdowns, cache-impact savings, and
the lifestyle equivalents (natural gas, solar area, wind rotations,
hydro turbine, nuclear waste, transit km, train km) all narrow to the
selected account.

No data-model, locale, or UI-string changes — purely a filtering fix in
the dashboard builder and the message-store query.

## 0.5.2 — 2026-05-23

### Changed — Input-tokens summary card now distinguishes uncached vs. cached

The "Input Tokens" tile on the Overview tab showed only **uncached** input
tokens — the slice of input the model received fresh, billed at the full
input rate. For typical Claude Code sessions cache-read tokens dominate
the actual input volume by 4–5 orders of magnitude (97 %+ cache-hit
rates are normal), so the headline figure could read e.g. 1.6 M while
the model actually consumed 35 B input-side tokens that period. The
label invited a reasonable misread.

The Overview now shows three input tiles instead of one:

- **Total Input** — uncached + cache reads + cache writes. This is the
  number users intuitively expect when they see "input".
- **Input (uncached)** — fresh input tokens billed at the full rate.
  Same number as the old card, just unambiguously labelled now, with
  a hint line ("fresh tokens, billed at full rate").
- **Cache Reads** — separated out so the order-of-magnitude gap is
  visible at a glance.

All three labels translated in the 10 shipped locales (en, de, es, fr,
ja, pl, pt-BR, ru, uk, zh-CN). No change to the underlying data model,
parser, or pricing — only how the existing summary fields are
surfaced.

## 0.5.1 — 2026-05-23

### Added — Per-account / all-accounts toggle in the webview

The dashboard already aggregates sessions across every Claude Code account
whose JSONL has been collected. The CLI `serve` dashboard gained an account
selector in 0.5.0's follow-up commit; this release wires the same selector
through the VS Code extension's webview so users with multiple accounts can
narrow the view to a single one (useful when switching between a personal
account and a team account, or auditing usage on one of them without the
other inflating the totals).

The selector appears next to the Period dropdown and only renders when
**two or more** accounts are present in the local store — single-account
users see the same toolbar they had before. Selecting an account refreshes
the dashboard in place via postMessage; selecting "All accounts combined"
restores the aggregate view.

### Fixed — Dashboard i18n labels in the standalone `serve` HTTP server

The `claude-stats serve` HTTP dashboard was rendering every label as a raw
`dashboard:…` key because the CLI bootstrap only loaded the `cli` i18n
namespace. The VS Code extension was unaffected (it loads `dashboard` via
its own path). `serve` now loads the same locale resources as the
extension, so all 10 shipped languages render translated labels on the
standalone HTTP dashboard as well.

## 0.5.0 — 2026-05-22

### Changed — Energy equivalents: natural gas replaces gasoline

The "liters of gasoline" tile on the Energy tab is gone. It divided period
CO₂ emissions by gasoline's tailpipe emission factor (2.31 kgCO₂/L) — a
confusing framing that mashed together grid emissions and a transport fuel
to produce a number with no clear physical meaning.

Replaced with the volume of natural gas a modern combined-cycle gas
turbine (CCGT, ~55 % electrical efficiency, lower heating value
≈ 9.94 kWh/m³) would burn to deliver the period's electrical energy at
the data-center wall — about 0.183 m³ per kWh of electricity. This is a
direct fuel-input equivalent against a real generation technology, not a
CO₂-equivalence trick.

The new tile auto-formats by magnitude — mL for light users, L for typical
sessions, m³ for heavy use — so the number is always readable. Translated
label, footnote, calculation breakdown, and data-sources entry in all 10
shipped locales (en, de, es, fr, ja, pl, pt-BR, ru, uk, zh-CN). No other
runtime behaviour change.

## 0.4.2 — 2026-04-30

### Added

- **`get_status` MCP tool now reports the running version.** Response gains a
  `version` field (e.g. `"0.4.2"`) so calling agents and the user can verify
  which release of claude-stats is actually serving requests. The MCP server's
  own initialize handshake (`server.serverInfo.version`) also tracks the real
  package version instead of the previously hardcoded `"1.0.0"`. Version is
  resolved at load time from the closest claude-stats `package.json` — works
  for both bundled VSIX and standalone CLI installs.

### Fixed

VSIX size fix. The 0.4.1 `linux-x64` VSIX shipped at 273 MB because
`onnxruntime-node` 1.21 includes a 343 MB CUDA execution provider on
linux-x64 only. transformers.js's Node backend runs CPU-only by default,
so the GPU provider never loaded at runtime — pure dead weight. Same
issue at smaller scale on Windows (DirectML, ~18 MB per `win32-*` leg).

`scripts/prepare-vsix.mjs` now drops known GPU/accelerator providers
after the platform prune:

- `libonnxruntime_providers_cuda.so` (linux-x64, ~343 MB)
- `libonnxruntime_providers_tensorrt.so` (linux-x64, <1 MB)
- `DirectML.dll` (win32-x64 / win32-arm64, ~18 MB each)

`libonnxruntime_providers_shared.so` is kept — it's the shared
infrastructure the CPU provider depends on, not a GPU provider.

Expected per-target VSIX sizes after this release: ~30–55 MB (down from
54 MB on win32, 273 MB on linux-x64). No other runtime behaviour change.

## 0.4.1 — 2026-04-30

CI fixes for the per-target VSIX matrix introduced in 0.4.0 (which never
shipped — the matrix's first run failed on every non-Linux-x64 leg). No
runtime behaviour changes.

- Publish workflow now builds `@claude-stats/core` before each per-target
  package step. Previously this build only ran via the typecheck step,
  which is gated to the `linux-x64` leg, so `darwin-arm64`, Linux ARM64,
  and both Windows legs failed esbuild with `Could not resolve
  @claude-stats/core/...` errors.
- `packages/core` build script no longer uses POSIX `mkdir -p` / `cp -r`
  (those don't exist on Windows runners' default shell). Replaced with
  `node packages/core/scripts/copy-locales.mjs`.

## 0.4.0 — 2026-04-30

### Added — Bundled local embeddings for daily-recap

- **The `Xenova/all-MiniLM-L6-v2` int8 ONNX model now ships inside the extension** (~23 MB, Apache-2.0). The 0.3.0 release ran clustering through Jaccard from the VS Code surface because the `--embeddings=on` flag only worked from the standalone CLI. With the model bundled, `summarize_day` defaults to local semantic clustering — no first-run download, no network access, nothing leaves your machine.
- **Per-target VSIXes** for `darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`. The marketplace serves the right binary to each user. Per-target VSIX size: ~45 MB.
- **`summarize_day` MCP tool** now accepts an `embeddings: 'on'|'off'|'auto'` argument and surfaces a `clusteringMethod: 'embeddings' | 'jaccard'` field on the digest response so the calling agent can verify which path ran.
- **New setting `claude-stats.recap.embeddings`** (`auto` | `off`, default `auto`). Propagates through the env field of the registered MCP entry; restart Claude Code to apply changes.
- **Activation-time SHA-256 integrity check** on the bundled model. A mismatch surfaces a `vscode.window.showWarningMessage` and the recap falls back to lexical clustering — defence in depth on top of the marketplace's own VSIX signature.
- The standalone CLI's `--embeddings` flag continues to work unchanged. CLI users keep their `~/.claude-stats/embed-models/` cache; the extension uses the bundled copy.

### Added — Apple Silicon Mac support note

`onnxruntime-node` 1.21 does not ship Intel-Mac (`darwin-x64`) prebuilts. Intel-Mac users see lexical clustering for now; a WASM-backend variant for Intel-Mac is a future follow-up.

## 0.3.0 — 2026-04-29

### Added — Daily-recap feature

- **`claude-stats recap [--date | --tz | --json | --all]` CLI command** and a **`summarize_day` MCP tool** that return a structured digest of the user's day — clusters of topic segments across sessions joined to author-scoped git activity, ranked by outcome impact, with first prompts quoted verbatim. The pipeline is fully deterministic at the service layer (segment → cluster → git enrichment → cache); LLM synthesis is optional and lives in the calling agent.
- **Confidence scores per item** (`high`/`medium`/`low`) drive default rendering: high+medium shown by default, low items collapsed into "+N brief items (use --all to show)". Computed deterministically — no LLM.
- **Phrase-template bank** at `recap/templates.ts` selects rendering by confidence. Untrusted slots are mandatorily backtick-delimited; backticks in source values are escaped.
- **Self-consistency guard** (`recap/guard.ts`) catches LLM hallucinations against the source digest — flags missing entities, count mismatches, unknown file paths, verb/confidence mismatches.
- **Background pre-computation** via `claude-stats recap precompute --lookback-days N`; `--install-cron` prints a crontab snippet (does NOT modify crontab).
- **User-correctable digests** via `claude-stats recap correct {merge,split,rename,hide,list,remove}`. Persists in `~/.claude-stats/recap-corrections.db` (mode `0o600`) keyed by signature so the same correction applies to recurring tasks across days.
- **Optional local sentence embeddings** for semantic clustering. Pinned `Xenova/all-MiniLM-L6-v2` (int8, 23MB, Apache-2.0); SHA-256 verified before first use; mismatched models deleted, fallback to Jaccard. Opt-in via `--embeddings=on|off|auto`.
- **Incremental digest patcher** (feature flag `--patch-cache`, default off) that splices new messages/commits into the prior digest. Determinism verified — byte-identical to full rebuild.
- **MCP tool description guidance** for calling agents: prompt-caching pattern (`cache_control: ephemeral`), tier-routing (Haiku for classifiers, Sonnet for prose), `max_tokens` caps, and entity-presence post-check.
- **Offline LLM-as-judge tuning script** (`packages/cli/src/recap/tune-segmenter.ts`, maintainer tool). Strict opt-in: `--dry-run` default, sample preview, typed `yes` confirmation, no automatic invocation, redacted auth headers.
- **Parser enrichment** captures `tool_use.input.file_path` (`Edit`/`Write`/`Read`/`MultiEdit`), dirname of `Glob.pattern`, and `Bash.cwd` into the new `messages.file_paths` column. Schema migration v9 → v10, additive and idempotent.

### Security

23+ dedicated negative tests verify every recap-feature gate:

- **Subprocess argument injection (SR-1):** `execFile` with `--` separators and validated email regex; malicious `user.email` (`--output=…`, newlines, leading `-`) cannot inject arguments.
- **Untrusted-slot rendering (SR-2):** every templating path wraps in single backticks and escapes embedded backticks. Markdown injection (`# OWNED`) and envelope-escape attempts blocked.
- **File permissions (SR-3):** all writes under `~/.claude-stats/` go through a shared `fs-secure` helper (`0o700` dirs, `0o600` files, `chmod`-after-write). Pre-existing loose perms tightened.
- **Cache-key correctness (SR-4):** snapshot hash includes sorted project paths and `Intl`-derived TZ. New-project-on-empty-day invalidates correctly.
- **Embedding model integrity (SR-5):** SHA-256 pinned in source; tampered files deleted; no user-supplied model paths.
- **Corrections SQL injection (SR-6):** parameterised queries exclusively; SQL-injection labels stored verbatim, control characters rejected, 200-char cap.
- **LLM-as-judge privacy (SR-7):** tuning script makes 0 API calls without explicit consent; `Authorization` header redacted from error output.
- **Wrap-untrusted preservation (SR-8):** envelope preserved through builder, MCP, JSON CLI, cache, and patcher.

### Internal

- 14 new files under `packages/cli/src/recap/`, 9 new test files. **1,111 project-wide tests passing** (+194 from prior baseline).
- Three-release implementation plan documented under `plans/daily-recap/` (gitignored); full design + security review under `doc/analysis/daily-recap/`.
- New optional dependency: `@huggingface/transformers@^3.0.0` — only loaded when embeddings are enabled and a hash-verified model is on disk.

## 0.2.2 — 2026-04-21

### Security hardening

- **Local dashboard now binds to `127.0.0.1` only** (previously bound to `0.0.0.0`/all interfaces due to a silently-failing double-`listen` call). The dashboard is no longer reachable from the LAN, and a `Host` header allowlist rejects requests that don't claim `localhost` / `127.0.0.1` / `[::1]` — blocking DNS-rebinding attacks from webpages.
- **`POST /api/config` now requires a bearer token.** A fresh token is generated each time the server starts and delivered to the same-origin dashboard SPA via a `SameSite=Strict` cookie. Any webpage attempting to CSRF the local config endpoint is rejected with 401. The token is compared with `crypto.timingSafeEqual`. Read-only `/api/dashboard` / `/api/status` endpoints remain unauthenticated for backward compatibility.
- **MCP tools (`search_history`, `get_session_detail`) now wrap stored prompt text in explicit untrusted-content markers** and updated tool descriptions tell the caller agent to treat the returned text as data, not instructions. Prevents second-order prompt injection where an adversarial string pasted into Claude Code once could later be surfaced to a future agent as a tool result that reinterpreted it as system-level instructions.
- **Prompt sanitization is now escape-based, deny-by-default.** The previous allow-list-based `extractPromptText` has been replaced with a sanitizer that strips known system-injected tag blocks for display cleanliness but then escapes *all* remaining `<` / `>` / `&`. This neutralizes Claude's own function-call vocabulary (`<function_calls>`, `<invoke>`, `<parameter>`), text-completions control tokens (`<|im_start|>`, `[INST]`, etc.), and any invented XML-ish tags — without needing an exhaustive block-list. Sanitization happens BEFORE the 2000-char truncation so a malicious tag cannot survive by splitting its close-tag past the cap.
- **Dashboard HTML template now escapes every user-controlled interpolation** (project paths, prompt previews, model names, MCP server/tool names, account display names, energy regions). A separate fix escapes `<` inside the inline JSON bootstrap block so a value containing literal `</script>` cannot break out of the script tag. This closes an XSS vector that would have fired in both the browser dashboard and the VS Code webview panel.
- **Scanner no longer follows symbolic links** inside `~/.claude/projects/`. Uses `fs.lstatSync` + `isFile()` checks so symlinks and other non-regular entries are skipped.
- Added an invariant comment on the `-e` inline script in `mcp-register.ts` documenting that only `__dirname`-derived paths may be interpolated there — guarding against future code-execution regressions.

### Internal

- New shared sanitizer at `packages/core/src/sanitize.ts`, exported as `@claude-stats/core/sanitize`.
- 44 new security-focused test cases across `parser.test.ts`, `history.test.ts`, `mcp.test.ts`, `template.test.ts`, `scanner.test.ts`, and `server.test.ts`.
- VSIX no longer accidentally bundles `.claude-flow/data/` (added to `.vscodeignore`).

## 0.2.1 — 2026-04-21

- Prompt to reload the window after extension upgrades, so already-open dashboards reconnect to the new extension host. Without reloading, the Refresh button and Period dropdown in an open dashboard silently stop working — VS Code keeps the old extension host attached to existing webviews after an in-place update. The prompt appears once on the activation after any version bump; "Later" dismisses it without reloading.

## 0.2.0 — 2026-04-21

### Added

- **Seven new languages.** Japanese (`ja`), Simplified Chinese (`zh-CN`), French (`fr`), Spanish (`es`), Brazilian Portuguese (`pt-BR`), Polish (`pl`), and Ukrainian (`uk`) — all VS Code surfaces (status bar, welcome state, sidebar help, dashboard, tab descriptions, MCP toasts) follow your VS Code display language. Technical terms (token, cache, MCP, API, Claude Code, Opus/Sonnet/Haiku) are kept in English where native-speaker developers use the English term; UI chrome matches VS Code's own localized terminology per locale.
- **Welcome state** shown when no Claude Code sessions have been collected yet — clear step-by-step instructions instead of an empty dashboard full of zeroed-out charts. Distinguishes the "Claude Code not installed" case from "no sessions recorded yet" and offers different instructions for each.
- **MCP-registration failures are now surfaced as warning toasts** with actionable guidance — no more silent `console.warn` when the extension can't install its MCP server. Distinguishes "no Node.js on PATH" (install Node 22.5+) from write failures (check `~/.claude.json` permissions) from generic errors, so you know what to fix. The dashboard and collector keep working; only the MCP integration is disabled until resolved.
- **Status bar tooltip** is now empty-state-aware, pointing first-time users to setup instructions instead of showing "0 tokens · ~$0.00".

### Internal

- Locale parity CI script (`npm run locales:check`) enforces structural key parity across all locales — missing/extra keys, mismatched `{{placeholders}}`, and mismatched `$(codicons)` all fail the build.
- Opus-driven auto-translation (`npm run locales:fill`) fills missing translation keys in every non-en locale using `claude-opus-4-7`, and a `.github/workflows/locales-fill.yml` workflow runs it automatically on PRs that touch English strings.

## 0.1.4 — 2026-04-20

- Fix stale MCP server path in `~/.claude.json` after extension upgrades (previously caused `MCP error -32000: Connection closed` until the Claude Stats sidebar was manually opened)
- Activate on VS Code startup (`onStartupFinished`) so the MCP registration is refreshed without waiting for the sidebar to be opened
- Notify on every MCP path update — not just first install — so users know to restart Claude Code after upgrading the extension

## 0.1.2 — 2026-04-20

- Fix broken dashboard screenshot on marketplace listing (GitHub org URL was `deotio`, correct is `de-otio`)
- Correct repository, bugs, and homepage URLs in `package.json`

## 0.1.1 — 2026-04-20

- Marketplace metadata: icon, README, CHANGELOG, keywords, bugs URL
- Publisher set to `de-otio`; display name changed to "Claude Stats by de-otio" to resolve marketplace name collision
- No runtime code changes

## 0.1.0 — 2026-04-16

Initial release.

- Dashboard webview with tokens, cost, sessions, cache efficiency, and streaks
- Per-project breakdown and top-conversations chart
- Spending view with model, session, tool, and MCP-server attribution
- Environmental context panel (energy, CO₂, and comparable everyday figures)
- Work profile chart showing the nature of work distribution by project
- Auto-registration of a bundled local MCP server in `~/.claude.json`
- Configurable dashboard auto-refresh interval
