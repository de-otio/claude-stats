# Privacy and Security Considerations

## Data Sensitivity Classification

| Data | Sensitivity | Reason |
|------|-------------|--------|
| Prompt content | **High** | Contains code, instructions, business logic |
| File paths, project names | **Medium** | Reveals project structure and naming |
| Git branch names | **Medium** | May reveal feature names, ticket IDs |
| Token counts | **Low** | Aggregate metrics, no content |
| Model names, timestamps | **Low** | Operational metadata |
| Tool names and counts | **Low** | Usage patterns, no content |

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

## Retention

- Local aggregated data: follows `~/.claude/` lifecycle (data exists as long as session files do)
- Local prompt text: follows the same lifecycle as the rest of the `messages` row it belongs to
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
