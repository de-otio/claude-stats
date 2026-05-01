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
- Prompt *counts* and *lengths* — never prompt content
- Project identifiers (paths)

## What the Tool Does NOT Store

- Full prompt text or assistant responses
- Code content or file contents
- API keys or authentication tokens
- Device identifiers from telemetry

## Quarantine Table

The resilience system (see [08-resilience.md](08-resilience.md)) stores unparseable JSONL lines in a `quarantine` table within the SQLite database for later reprocessing. These raw lines may contain prompt content or code. The quarantine table:
- Inherits the same restrictive permissions as the SQLite database file (`0600`)
- Is never included in server sync
- Entries are marked as reprocessed after successful re-parsing

## Server Sync Rules (Future)

When sync is enabled, only the following leave the machine:

**Synced (aggregated):**
- Token counts bucketed by day
- Session counts and average durations
- Model usage distribution
- Tool usage counts
- Project identifier (hashed by default)
- Developer identifier (team-assigned, not device ID)

**Never synced:**
- Prompt content or response content
- File paths or code
- Raw session JSONL data
- Telemetry events
- Git branch names (opt-in only)

## Access Control

- Local DB inherits filesystem permissions from `~/.claude/`
- Server sync requires explicit opt-in configuration
- Team server should implement role-based access:
  - Developers see their own data + project aggregates
  - Project leads see project-level aggregates
  - Management sees organization-level aggregates
  - No role sees individual prompt content (it's never collected)

## Retention

- Local aggregated data: follows `~/.claude/` lifecycle (data exists as long as session files do)
- Server-side data: configurable retention (suggested default: 90 days for detailed, 1 year for monthly rollups)
- Export before deletion for compliance needs

## Opt-In Philosophy

Every data-sharing feature defaults to off:
- Server sync: off by default, requires explicit endpoint configuration
- Project names in sync: hashed by default, opt-in for readable names
- Git branch names: excluded by default, opt-in
- Team identification: requires explicit configuration
