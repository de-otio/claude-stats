# 05 — Implementation Plan

Phased rollout from solo-fun to full team sync.

---

## Phase 0: Local Gamification (No Sync Required)

Streaks, achievements, and personality types that work for a single user. This validates the gamification UX before adding team complexity.

### Scope
- Streak tracking: compute from sessions table, store in metadata
- Achievement engine: check conditions after each `collect`, store unlocked badges
- Personality type: compute from usage patterns, display in `report` and dashboard
- Fun superlatives: compute per-period, display in report
- VS Code achievement toasts

### New Tables
```sql
CREATE TABLE IF NOT EXISTS achievements (
  achievement_id  TEXT PRIMARY KEY,
  unlocked_at     INTEGER NOT NULL,
  context_json    TEXT  -- e.g., {"prompts": 100, "date": "2026-03-12"}
);

CREATE TABLE IF NOT EXISTS streaks (
  streak_type     TEXT PRIMARY KEY,  -- 'daily', 'weekly'
  current_count   INTEGER NOT NULL DEFAULT 0,
  longest_count   INTEGER NOT NULL DEFAULT 0,
  last_active_date TEXT,  -- ISO date, e.g., "2026-03-12"
  freeze_tokens   INTEGER NOT NULL DEFAULT 0
);
```

### CLI Additions
```bash
claude-stats achievements        # List all, show unlocked vs locked
claude-stats streak              # Show current streak status
```

### Effort
~2-3 days for core engine + ~1 day for VS Code integration.

**Ship this first.** It's fun, it's useful solo, and it validates whether users engage with gamification before building team sync.

---

## Phase 1: Team Model + Shared File Sync

Basic team creation, joining, and file-based sync (Option A from [01-sync-options.md](01-sync-options.md)).

### Scope
- Team CRUD: create, join (via code), leave, list, members
- Manifest generation: aggregate local stats into sync-ready JSON
- Push/pull to local filesystem path (shared folder, mounted drive)
- Team dashboard: member cards, basic leaderboard
- Privacy controls: share levels (full/summary/minimal)

### New Tables
```sql
-- See 02-team-model.md for schema
CREATE TABLE IF NOT EXISTS teams (...);
CREATE TABLE IF NOT EXISTS team_members (...);
```

### CLI Additions
```bash
claude-stats team create <name>
claude-stats team join <code>
claude-stats team leave <slug>
claude-stats team list
claude-stats team members <slug>
claude-stats team sync --push [--location <path>]
claude-stats team sync --pull [--location <path>]
claude-stats team dashboard <slug>
claude-stats team config [--name|--share-level|--sharing]
```

### Effort
~3-4 days for team model + sync + ~2 days for dashboard views.

---

## Phase 2: GitHub-Based Sync

Replace manual file paths with GitHub repository sync (Option C).

### Scope
- `claude-stats team sync --github owner/repo`
- Auto-commit manifests to `stats/<userId>.json`
- Pull all manifests via GitHub API (no full clone needed)
- Optional: GitHub Action that generates a static team dashboard page

### Dependencies
- GitHub personal access token (stored in local config, not synced)
- `gh` CLI or direct GitHub API via fetch

### Effort
~2-3 days (mostly GitHub API integration + auth flow).

---

## Phase 3: Challenges + Advanced Gamification

### Scope
- Challenge creation and tracking
- Custom challenge metrics
- Challenge results computed from manifests
- Team Chemistry score
- Enhanced VS Code sidebar: challenges panel, progress bars

### Effort
~2-3 days.

---

## Phase 4: CRDT Sync (If Demand Warrants)

### Scope
- Integrate cr-sqlite or equivalent
- Enable real-time P2P sync of team_members table
- Remove need for manual push/pull

### Dependencies
- cr-sqlite native module (adds to install complexity)
- Transport layer (WebSocket, WebRTC, or relay server)

### Effort
~5-7 days (significant complexity jump).

### Decision Gate
Only pursue if Phase 1-2 show strong adoption (>50 users using team features).

---

## Summary

| Phase | What | Effort | Prerequisite |
|-------|------|--------|-------------|
| **0** | Local achievements + streaks | 3-4 days | None |
| **1** | Teams + file sync | 5-6 days | Phase 0 |
| **2** | GitHub sync | 2-3 days | Phase 1 |
| **3** | Challenges + advanced gamification | 2-3 days | Phase 1 |
| **4** | CRDT sync | 5-7 days | Phase 2 + adoption signal |

Phases 2 and 3 are independent and can be built in parallel.

Total to full team features (Phases 0-3): ~12-16 days.
