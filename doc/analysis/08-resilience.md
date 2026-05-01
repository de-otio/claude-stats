# Resilience to Claude Code Updates

Claude Code ships updates frequently (multiple times per week). The local data format has no stability contract. This document analyzes observed schema changes and defines strategies to prevent missing or corrupted data.

## Observed Schema Evolution

Analysis of session files across versions 2.1.61 through 2.1.71 reveals concrete instability:

**Field additions without deprecation:**
- `requestId` added to assistant message entries (not present in 2.1.61)
- `sourceToolAssistantUUID` added to link tool results back to assistant responses
- `caller` field added inside `tool_use` content blocks
- `agent_id`, `agent_type`, `worktree` added to hook event payloads

**Entry type distribution shifts:**
- `progress` entries dropped from ~36% to ~4% of session lines between 2.1.61 and 2.1.71
- `assistant` entries increased from ~31% to ~55%
- This means parsers tuned to one version's ratios will mischaracterize sessions from another

**Structural reorganizations:**
- Config backups moved from `~/` to `~/.claude/backups/` (v2.1.47)
- Tool results over 50KB persisted to disk instead of inline in JSONL (v2.1.51)
- 5 timestamped `.claude.json.backup` files indicate repeated config format migrations

**Data integrity issues (from changelog):**
- `/stats` crash on entries with missing or malformed timestamps — confirms timestamp field is not guaranteed
- Memory leak fix changed how compacted messages are stored (v2.1.63)
- Progress message payloads stripped during context compaction — data that was once present may disappear mid-session

## Risk Categories

### 1. New fields appear
**Frequency:** Nearly every release
**Impact:** Low if parser is tolerant; high if parser uses strict schemas
**Example:** `requestId` silently appeared — a strict parser would reject the line

### 2. Fields disappear or change type
**Frequency:** Occasional
**Impact:** High — can cause parse errors or silent data loss
**Example:** `content` field can be a string or an array depending on message context

### 3. New message types
**Frequency:** Occasional
**Impact:** Medium — unknown types are skipped, but may contain valuable data
**Example:** `file-history-snapshot` type may not have existed in early versions

### 4. Directory structure changes
**Frequency:** Rare but impactful
**Impact:** High — scanner can't find files
**Example:** Backups directory relocation in v2.1.47

### 5. Data moved out of JSONL
**Frequency:** Rare
**Impact:** High — data that was inline becomes a reference to an external file
**Example:** Large tool results persisted to disk (v2.1.51)

## Defense Strategies

### Defensive Parsing

```
Rule 1: Every field is optional (including `type` and `timestamp`)
Rule 2: Use .get() / optional chaining — never direct key access
Rule 3: Accept unknown values in enum fields (new message types, stop reasons)
Rule 4: Handle `content` as both string and array
Rule 5: Log warnings for unexpected structures, never crash
Rule 6: Discard the last line of a file if it fails JSON parsing (likely a partial write from an active session — see 02-collection-strategy.md concurrent access)
Rule 7: Use message `uuid` as the idempotency key — re-processing the same line produces an upsert, not a duplicate
```

Parse each line independently. A malformed line must not affect processing of subsequent lines. Wrap each line's parsing in error handling and record failures for diagnostics.

### Schema Fingerprinting

On each collection run, compute a fingerprint of the observed schema:
- Set of top-level field names per message type
- Set of `message.usage` field names
- Set of distinct `type` values encountered
- Set of distinct `message.model` values

Store fingerprints per Claude Code version. When a new version introduces changes, the tool can detect and report them automatically:

```
[warn] Version 2.1.72: new field "requestMetadata" in assistant messages
[warn] Version 2.1.72: new message type "checkpoint" encountered
[info] Schema fingerprint changed — review 08-resilience.md
```

### Version-Aware Parsing

Tag every collected record with the Claude Code `version` that produced it. This enables:
- Retroactive reprocessing when parser logic improves
- Version-specific aggregation queries
- Identifying which versions introduced anomalies

### Filesystem Monitoring

Don't hardcode paths. On startup, scan `~/.claude/` and build a dynamic inventory:
- Discover directories by enumeration, not assumption
- Detect new subdirectories (future data sources)
- Track directory structure changes across runs
- Alert when expected directories disappear

### Data Validation Layer

After parsing, validate aggregated data for sanity:
- Token counts must be non-negative integers
- Timestamps must be within reasonable range (not zero, not future)
- Session duration should not exceed 30 days (likely a boundary error)
- Output tokens should generally be less than input tokens (flag anomalies)

Record validation failures per session for diagnostics without discarding data.

### Self-Healing Collection

When the parser encounters unrecognized structures:

1. **Don't skip silently** — log the raw line to a quarantine file with version and timestamp
2. **Extract what you can** — even if a new message type appears, timestamp and sessionId are likely present
3. **Reprocess quarantine** — when parser is updated, re-run quarantined lines through the new logic
4. **Degrade gracefully** — report partial data with confidence indicators rather than nothing

### Update Detection

Detect Claude Code updates proactively:
- Monitor `~/.claude/cache/changelog.md` for modifications
- Compare `version` field in new session data against last known version
- When a new version is detected, run a schema diff against the previous fingerprint
- Optionally fetch release notes to identify data-relevant changes

## Testing Strategy

### Synthetic Version Tests
Maintain sample JSONL fixtures for each observed version. Run the parser against all fixtures on every change to catch regressions.

### Fuzz Testing
Generate JSONL lines with:
- Missing fields at various levels
- Extra unknown fields
- Wrong types (string where number expected, array where string expected)
- Empty objects and null values
- Truncated JSON (simulating interrupted writes)

### Live Monitoring
After each Claude Code update, run a diagnostic mode that:
- Parses the first session under the new version
- Compares schema fingerprint to previous
- Reports any changes before full collection runs

## Upgrade Workflow

When a new Claude Code version is detected:

```
1. Detect version change (from session JSONL or changelog mtime)
2. Run schema fingerprint on new session data
3. Diff against stored fingerprint for previous version
4. If no changes → proceed normally
5. If additive changes → log new fields, proceed, flag for review
6. If breaking changes → quarantine new data, alert user, await parser update
```

This ensures the tool never silently produces incorrect data from an unrecognized format.
