# Privacy and Security Considerations

## Data Sensitivity Classification

| Data | Sensitivity | Reason |
|------|-------------|--------|
| Prompt content | **High** | Contains code, instructions, business logic |
| Ticket-link evidence | **High** | A verbatim fragment of prompt text, branch, or commit subject — inherits prompt sensitivity |
| File paths, project names | **Medium** | Reveals project structure and naming |
| Git branch names | **Medium** | May reveal feature names, ticket IDs |
| Ticket keys (`PROJ-123`) | **Medium** | A project prefix can encode a client or an unreleased codename |
| Token counts | **Low** | Aggregate metrics, no content |
| Model names, timestamps | **Low** | Operational metadata |
| Tool names and counts | **Low** | Usage patterns, no content |
| Task classification labels | **Low** | Closed enum, cannot carry free text |
| API error and retry events | **Low** | Error kind, status, timing — no content |

## Local-Only Principle

All raw data stays on the developer's machine. The tool reads from `~/.claude/` (which is already `drwx------`, owner-only) and writes aggregated stats to a local SQLite database with the same permissions.

**No network access** unless the user explicitly configures server sync.

## What the Tool Stores Locally

- Aggregated token counts per session/project/period
- Session metadata (duration, model, tool counts, timestamps)
- **User prompt text** — stored locally since schema V8 (in the `messages`
  table's `prompt_text` column), sanitized on write (see below), capped in
  length, and used to power features like the daily recap and the MCP tools.
  Prompt *counts* and *lengths* are also stored, but text itself is no longer
  excluded — this corrects an earlier version of this document.
- Project identifiers (paths)
- **Ticket links** — work-item keys extracted from prompt text, branch names,
  and commit subjects, with a fragment of the matching text as evidence (see
  "Derived Ticket Links" below)
- **Per-message git branch** (`messages.git_branch`), in addition to the
  per-session branch already stored
- **A task classification label per session** (`session_task_class`) — a
  closed-enum label plus the rule and classifier version that produced it
- **API error and retry events** (`api_error_events`) — error kind, HTTP
  status, and retry timing per session

## What the Tool Does NOT Store

- Assistant response text or tool-call results (only the user's own prompt
  text is retained, per above)
- File contents (file *paths* touched by a session may be recorded; contents
  are not)
- API keys or authentication tokens
- Device identifiers from telemetry

## Prompt Text: What "Stored" Means

Because this corrects a previous inaccuracy in this document, the current
behavior is spelled out precisely:

- **Where:** the local SQLite DB (`~/.claude-stats/stats.db`) only, in the
  `messages.prompt_text` column. It does not appear in the quarantine table
  path or in any network payload.
- **Sanitized on write:** every prompt is passed through
  [`sanitizePromptText`](../../packages/core/src/sanitize.ts) before storage —
  known system-injected tag blocks are stripped, remaining `<`/`>` characters
  are escaped (a defensive measure against downstream agents or the frontend
  interpreting stored text as markup or function-call syntax), and the result
  is length-capped. This is an escaping/display-safety boundary, not a secret
  redaction pass — pasted credentials or code are not detected or removed.
- **Never sent to the org/team plane.** Prompt text is excluded from every
  aggregate sync payload by construction (see "Server Sync Rules" and
  "Two-Plane Model" below) — the org plane's payload shape cannot carry it.
- **Optionally leaves the machine only via the personal plane** (see below),
  encrypted by default when the target is a third-party/cloud store.
- **Permissions:** the DB file inherits the same `0600`/owner-only posture as
  the rest of `~/.claude-stats/`.

## Derived Ticket Links

Ticket attribution reads `messages.prompt_text` (plus git branch names and
commit subjects) looking for work-item key patterns (`PROJ-123`-shaped
strings) and writes a **derived, structured fact** — "this session touched
this ticket" — into the `ticket_links` table. This is a materially different
practice from "prompt text is stored", and is called out separately because
of it:

- **Derived data outlives its source in practice.** Other features
  (cost-per-ticket reporting, the justification pack, the dashboard) read
  `ticket_links` directly and never go back through `prompt_text`, so the
  privacy posture of the derived table has to stand on its own.
- **`ticket_links.evidence` inherits prompt sensitivity, not a lower one.**
  It can hold a fragment of the matched prompt text, branch name, or commit
  subject, and it is **not** passed through `sanitizePromptText` — the
  escaping boundary described above does not apply to it.
- **A ticket key is itself disclosive.** A Jira project prefix routinely
  encodes a client, a team, or an unreleased product codename.
- **Never synced to the org plane** — the aggregate payload has no field for
  it, by the same structural guarantee described below.
- **`evidence` never leaves via the justification pack**; ticket *keys* do,
  deliberately (see "The Justification Pack" below).

## Quarantine Table

The resilience system (see [08-resilience.md](08-resilience.md)) stores unparseable JSONL lines in a `quarantine` table within the SQLite database for later reprocessing. These raw lines may contain prompt content or code. The quarantine table:
- Inherits the same restrictive permissions as the SQLite database file (`0600`)
- Is never included in server sync
- Entries are marked as reprocessed after successful re-parsing

## Server Sync Rules — Org/Team Plane (Future)

This section describes the **org plane** only (see "Two-Plane Model" below for
how it relates to personal backup/sync). When team sync is enabled, only the
following leave the machine:

**Synced (aggregated):**
- Token counts bucketed by day
- Session counts and average durations
- Model usage distribution
- Tool usage counts
- Project identifier (hashed by default)
- Developer identifier (team-assigned, not device ID)

**Never synced to the org plane:**
- Prompt content or response content (including the locally-stored
  `prompt_text` described above)
- Ticket links, and in particular `ticket_links.evidence`
- File paths or code
- Raw session JSONL data
- The transcript archive (see below), in whole or in part
- Telemetry events
- Git branch names (opt-in only)

This is a **structural** guarantee, not a filter applied to a larger payload:
the aggregate record the client computes and sends is a different, narrower
shape than the local session/message records, and simply has no field capable
of carrying prompt text, file contents, or transcript bytes. There is no code
path by which the org plane receives, stores, or decrypts that data.

## Access Control

- Local DB inherits filesystem permissions from `~/.claude/`
- Server sync requires explicit opt-in configuration
- Team server should implement role-based access:
  - Developers see their own data + project aggregates
  - Project leads see project-level aggregates
  - Management sees organization-level aggregates
  - No role sees individual prompt content — it is collected locally (see
    above) but is never part of what reaches the org plane
- The justification pack has no access control of its own: it is a file the
  user generates and hands to someone directly. Its protection is what it
  omits, not who can open it (see "The Justification Pack" below)

## Retention

- Local aggregated data: follows `~/.claude/` lifecycle (data exists as long as session files do)
- Local prompt text: follows the same lifecycle as the rest of the `messages` row it belongs to
- Ticket links (including `evidence`), per-message branch names, task
  classifications, and API error events: same lifecycle as the session rows
  they hang off; removed by `claude-stats purge --all` along with the rest of
  the DB
- Generated justification packs: **not** managed by claude-stats. They are
  ordinary files the user chose to write, and deleting the DB does not delete
  a pack already sent
- Transcript archive (if enabled): bounded retention keyed on real session activity, not file mtime — see below
- Server-side data: configurable retention (suggested default: 90 days for detailed, 1 year for monthly rollups)
- Export before deletion for compliance needs

## Opt-In Philosophy

Every data-sharing feature defaults to off:
- Server sync (org plane): off by default, requires explicit endpoint configuration
- Project names in sync: hashed by default, opt-in for readable names
- Git branch names: excluded by default, opt-in
- Team identification: requires explicit configuration
- Transcript archive: off by default, requires explicit informed-consent opt-in (see below)
- Personal-plane backup/sync: off by default, requires explicit setup
- Justification pack: nothing is generated unless the user runs the command,
  every section is requested explicitly, and the scope value is withheld
  unless `--disclose-scope` is passed

## The Transcript Archive (Opt-In)

Separate from the aggregated DB, claude-stats offers an **opt-in transcript
archive**: a plaintext mirror of full raw session transcripts, kept so a
session survives Claude Code's own `cleanupPeriodDays` deletion (which keys on
file mtime and can misfire — see the
[transcript-archive plan](../../plans/transcript-archive/plan.md)). This is a
materially different, higher-sensitivity data practice than the aggregated DB
and is treated accordingly:

- **What it stores:** the full raw `.jsonl` bytes for a session — user
  prompts, assistant responses, tool calls and results, file contents that
  passed through the conversation. This is strictly more than the DB's
  `prompt_text` column (which holds only the user's own prompt text).
- **Where:** `~/.claude-stats/archive/<encoded-project>/<session-id>.jsonl`,
  local only.
- **Permissions:** archive directory created `0700`; each archive file
  `0600` — the same owner-only posture as the rest of `~/.claude-stats/`.
- **Off by default.** Nothing is written until the user explicitly enables it
  through an informed-consent prompt that states plainly what is copied,
  where, that it is plaintext, and how to delete it.
- **Bounded retention:** a finite default window (365 days), pruned by each
  session's **real last-activity timestamp** — never by file mtime, since
  mtime is exactly the signal that caused Claude Code's own cleanup bug.
  `retentionDays: 0` is an explicit, deliberately-chosen "keep forever"
  opt-out, not the default.
- **Removal:** `claude-stats purge --archive` deletes the archive tree
  on demand; `claude-stats purge --all` (and the VS Code "Delete All Stored
  Data" command) removes it along with the rest of `~/.claude-stats/` and
  deregisters the MCP server. This is also the uninstall step, since VS Code
  has no reliable uninstall hook.
- **Never eligible for the org plane** — the archive is excluded from every
  aggregate sync payload by the same structural guarantee described above.
- **May leave the machine only via the personal plane** (next section),
  where encryption is offered and defaulted-on for third-party/cloud targets.

## The Personal Plane: Optional End-to-End Encrypted Backup and Sync

Independent of the transcript archive, claude-stats offers an **optional**
personal backup/sync feature for the local DB and, if enabled, the archive.
Full design: [`doc/analysis/data-planes/`](data-planes/).

- **Purpose:** let a developer back up their own stats (and, if they choose,
  their archive) to a cloud folder they already use (Dropbox, iCloud Drive,
  Google Drive, OneDrive) or a plain directory/bucket, and optionally sync a
  second device.
- **Encryption is optional, but end-to-end when on:** keys are generated on
  the user's device and never leave it except as a recovery secret the user
  is asked to safeguard (passphrase or generated recovery key). The server or
  cloud storing the encrypted bundle **cannot decrypt it** — it is a blind
  blob store.
- **Default-on for third-party/cloud targets.** Sync data and the archive
  both default to encrypted when the destination is a third-party cloud
  service; plaintext remains available as an explicit, informed choice for
  users who prioritize disaster-recoverability or interop over
  confidentiality.
- **Keys live only on-device (OS keychain) plus the user's recovery secret.**
  No copy of the data key or the recovery secret is ever held by
  claude-stats' own infrastructure. If a user loses every device and the
  recovery secret, the encrypted backup is unrecoverable by design — there is
  no backdoor.
- **This is a genuinely different plane from the org/team plane** (next
  section) — a user backing up privately must never be confused with a user
  sharing data with their employer, and the product keeps the two visually
  and functionally distinct.

## Two-Plane Model: Personal Plane vs Org Plane

claude-stats separates data leaving the machine into two planes with
different trust models, and the two **never share plaintext**:

| | Personal plane | Org (team) plane |
|---|---|---|
| Who can read it | Only the user's own devices (encryption on) | The org, by design |
| What crosses | The full local bundle (DB rows, optionally the archive) | Only locally-computed aggregates |
| Server/cloud role | Blind blob store (opaque bytes) when encrypted | Active consumer of plaintext aggregates |
| Default | Off; encryption default-on for third-party targets when enabled | Off; requires explicit endpoint configuration |

The bridge between them is **local aggregation**: the org plane is never fed
from personal-plane ciphertext or from the transcript archive. The client
computes the aggregate payload entirely on-device from the local DB, and only
that already-reduced, structurally-narrower payload is sent. There is no code
path in either direction by which the org plane could obtain, store, or
decrypt personal-plane ciphertext, raw transcripts, or `prompt_text` — the
aggregate payload type simply has no field shaped to carry any of them.

The two planes describe everything the *tool* transmits. They do not describe
everything that leaves the machine: the justification pack is a plaintext
document the tool writes to disk for the user to hand onward themselves, and
it is governed by neither plane's protections. It gets its own section next.

## The Justification Pack: A Third Egress Path

The stored-data features (the SQLite DB, the transcript archive) are
local-only by default, and the two planes above are the only ways the tool
itself transmits anything: (a) the org/team-sync aggregate payload
(day-bucketed totals only, no prompt content) and (b) the personal-plane
encrypted backup (a blind ciphertext blob). **The
justification pack is a third kind of thing: a plaintext document the
tool generates specifically so a human can hand it to another human who does
not run claude-stats** — typically a manager, typically over email, typically
outside any encryption or sync channel this document has previously
described. The tool itself does not transmit the pack over a network; it
writes an HTML file and a CSV bundle to local disk (`claude-stats pack` /
`generate_justification_pack`), and the user is the one who moves it from
there. That the *distribution* step is manual does not change the privacy
analysis — the document is built to leave, and does.

**Redaction: what does NOT appear in the pack.** The pack runs the same
redaction the org-sync plane uses, enforced at compile time (a TypeScript
type-level check fails the build if a pack row type ever grows one of these
fields) — never prompt text, file contents, transcript bytes, session ids,
or per-session evidence text (`ticket_links.evidence`). A policy event's
`detail` field (marked local-only in the source, e.g. `"opus"` or
`"usd:1500/mo"`) is also structurally excluded from the pack even when the
`constraint` section is requested.

**What DOES appear in the pack, and is worth stating plainly:**

- **Ticket keys** (e.g. `PROJ-123`) themselves — the whole point of the
  `tickets` section — along with their cost, token counts, session count, and
  confidence tier. A ticket key that itself encodes something sensitive (an
  unreleased product codename used as a Jira project prefix, for instance)
  leaves the machine in this document.
- **The FACT that a pack was scoped, but not the scope's literal value.** The
  pack always states its own scope as a line of text ("no filter" is treated as
  a fact the reader needs, not an omission). When `--project` or `--account`
  was used, that line — and the `projectPath`/`accountUuid` column on every CSV
  row — renders a stable marker (`[withheld:a1b2c3d4]`) rather than the value.
  This was **not** the pack's original behavior: the raw absolute path was
  embedded in the scope line and in every row of two CSVs, and was found and
  fixed during review before the feature shipped. A
  local path like `/Users/alice/repos/<client>/<codename>` is Medium
  sensitivity per the classification table at the top of this document, and
  this is the one artifact built to leave the machine, so shipping it by
  default inverted the pack's own rule that every section is opt-in and the
  default is the minimum. The marker is deterministic (two packs scoped alike
  compare; a series stays readable) and non-reversible, though it is **not** a
  security boundary — an eight-hex digest of a guessable path is guessable. It
  defeats disclosure *by accident*, which is the actual failure mode: a path
  pasted into a document nobody reread before sending. `--disclose-scope` opts
  back into the literal values for the case where the recipient is entitled to
  them.
- **Cost figures, coverage ratios, confidence-tier mixes, and (in `mode:
  "plan"`) the configured monthly plan fee** — all of this is the intended
  content of the document.

**Sections not yet wired.** `hygiene`, `constraint`, and `calibration` can be
requested but currently render an honest "not available in this build" block
— those engines exist and are reachable through their own commands, but the
pack renderer does not yet pull from them. No number is fabricated in their
place; nothing from those subsystems currently leaves via the pack at all.

**How this plane differs from the other two.** The org plane is protected by
the *shape* of its payload, and the personal plane by encryption. The pack has
neither: it is plaintext, it has no recipient model, and once sent it is
outside the tool's reach — retention, access control, and deletion all stop
at the moment the user attaches it to an email. Its only protection is what it
refuses to contain, which is why the forbidden-field check is enforced at
compile time rather than as a runtime filter, and why the scope value is
withheld by default. When adding a section or a column to the pack, the
question to ask is not "is this sensitive?" but "is a manager entitled to see
this about a named developer, forever, with no way to take it back?"
