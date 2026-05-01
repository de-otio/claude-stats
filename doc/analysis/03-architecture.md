# Architecture

Tool components, CLI interface, and future sync design.

## Components

```
┌───────────────────────────────────────────────────────────┐
│                      claude-stats                          │
│                                                            │
│  ┌──────────┐  ┌────────┐  ┌────────────────┐            │
│  │ Scanner  │→ │ Parser │→ │ Schema Monitor │            │
│  └──────────┘  └────────┘  └────────────────┘            │
│       ↑              ↓              ↓                     │
│  ~/.claude/    ┌────────────┐  ┌───────────┐             │
│                │ Aggregator │  │ Quarantine │             │
│                └────────────┘  └───────────┘             │
│                      ↓                                    │
│                ┌─────────────┐                            │
│                │   Store     │                            │
│                │  (SQLite)   │                            │
│                └─────────────┘                            │
│                      ↓                                    │
│           ┌──────────────────┐                            │
│           │    Reporter      │                            │
│           └──────────────────┘                            │
│                      ↓                                    │
│           ┌──────────────────┐                            │
│           │  Sync Agent      │  (future)                  │
│           └──────────────────┘                            │
└───────────────────────────────────────────────────────────┘
```

**Scanner** — Discovers and watches `~/.claude/` for new/modified session files. Builds a dynamic filesystem inventory rather than hardcoding paths (directories may be added or reorganized between versions). Detects Claude Code version changes.

**Parser** — Reads JSONL line-by-line, extracts structured records by message type. Treats all fields as optional except `type` and `timestamp`. Logs warnings for unrecognized structures instead of failing. See [08-resilience.md](08-resilience.md) for defensive parsing rules.

**Schema Monitor** — Computes schema fingerprints per Claude Code version (field sets, message types, usage fields). Detects and reports changes when a new version appears. Maintains quarantine for unparseable records.

**Aggregator** — Computes per-session, per-project, per-period statistics from parsed records. Tags all records with the source Claude Code version for version-aware queries.

**Store** — SQLite database for aggregated stats, collection checkpoints, and schema fingerprints. Single file, portable, queryable. All writes wrapped in transactions for crash recovery. See storage section below.

**Reporter** — Generates summaries, trend reports, and exports. Terminal output for CLI, JSON/CSV for integrations. Includes data confidence indicators when partial parsing occurred. Applies timezone conversion at report time (data stored as UTC).

**Sync Agent** (future) — Pushes anonymized aggregated data to a team server. See sync section below.

## Storage Location and Configuration

The tool stores its own data separately from `~/.claude/` (which is owned by Claude Code and may be reorganized):

```
~/.claude-stats/
  stats.db           # SQLite database (aggregated data, checkpoints, fingerprints, quarantine table)
  config.json        # Tool configuration (cost thresholds, plan type)
```

**Database migrations:** The SQLite schema will evolve as the tool gains features. Store a `schema_version` in a metadata table. On startup, check and apply migrations sequentially. Never delete columns — only add (keeps old data accessible).

**Data growth:** Over months of use, the database will grow. Mitigation:
- `claude-stats status` shows DB size and row counts
- Delete `stats.db` and re-run `collect` to rebuild from scratch (source data in `~/.claude/` is never modified)
- Future: automatic rollup of old per-message detail into daily aggregates

## Technology Choice

**TypeScript/Node**
- Matches Claude Code's own stack (same runtime, familiar tooling)
- Strong typing catches schema mismatches at compile time — critical given frequent Claude Code format changes
- `node:sqlite` (built-in since Node 22.5) for synchronous SQLite access (zero external dependencies)
- `commander` for CLI argument parsing
- `zod` for runtime schema validation with graceful fallback on unknown fields
- Native `fs` and `path` for file operations; `os.homedir()` for cross-platform path resolution

## CLI Interface

```
claude-stats collect                    # Run incremental collection
claude-stats report                     # Show summary for all projects
claude-stats report --project X         # Filter to one project
claude-stats report --period week       # Time-bucketed view
claude-stats report --timezone US/Eastern  # Override timezone for day bucketing
claude-stats report --include-ci        # Include CI/automated sessions
claude-stats report --html              # Export a self-contained HTML dashboard
claude-stats export --format csv        # Export for spreadsheets
claude-stats export --format json       # Export for programmatic use
claude-stats serve                      # Start local web dashboard
claude-stats search "refactor"          # Search prompt history
claude-stats tag abc123 important       # Tag a session
claude-stats backfill                   # Re-parse all files to populate new fields
claude-stats diagnose                   # Schema fingerprint diff, quarantined lines, version changes
claude-stats status                     # DB size, row counts, last collection time
```

## Data Flow

```
~/.claude/projects/*/*.jsonl  ──→  Parser  ──→  session records
~/.claude/history.jsonl       ──→  Parser  ──→  prompt index
                                       ↓
                                  Aggregator  ──→  aggregated stats
                                       ↓
                                  SQLite DB   ──→  Reporter / Export
                                       ↓
                                  Sync Agent  ──→  Team Server (future)
```

## Future: Server Sync Architecture

**Principle:** Raw data never leaves the machine. Only aggregated metrics sync.

**What syncs:**
- Token counts (daily aggregates per project)
- Session count and duration
- Model usage distribution
- Tool usage counts
- Project identifier (hashed by default, opt-in readable names)

**What never syncs:**
- Prompt content
- File paths or code
- Git branch names (unless opted in)
- Device identifiers

**Sync mechanism:**
- HTTP POST to configured server endpoint
- Authentication via project-level API key or OAuth
- Conflict-free: each developer pushes their own aggregates, server merges by user+project+date
- Offline-tolerant: queue pushes locally, retry on connectivity

**Team server responsibilities:**
- Aggregate across developers
- Dashboard for project leads and management
- Trend analysis and cost forecasting
- No access to individual prompt content
