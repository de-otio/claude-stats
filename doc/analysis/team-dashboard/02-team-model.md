# 02 — Team Model

How teams are created, joined, and managed. Fully dynamic — no admin portal required.

---

## Identity

Each user is identified by a **stable anonymous ID** derived from their Claude account:

```
userId = SHA-256(account_uuid + team_salt).slice(0, 16)
```

- Not reversible to account_uuid without the salt
- Consistent across syncs (same user always gets same ID within a team)
- Different ID per team (team_salt differs), preventing cross-team tracking

Users set a **display name** stored locally and included in sync manifests:

```bash
claude-stats team config --name "Alice"
```

---

## Team Lifecycle

### Creating a Team

```bash
claude-stats team create "Backend Crew"
# → Team created: backend-crew (ID: team-a1b2c3)
# → Share this join code with teammates: a1b2c3-x9y8z7
```

Generates:
- `teamId`: random UUID
- `teamSlug`: slugified name
- `joinCode`: short code for easy sharing (expires after 30 days, regeneratable)
- `teamSalt`: random bytes for anonymous ID derivation

Stored in local config (`~/.claude-stats/teams.json`).

### Joining a Team

```bash
claude-stats team join a1b2c3-x9y8z7
# → Joined "Backend Crew" as Alice
# → Run `claude-stats team sync --push` to share your stats
```

The join code encodes:
- teamId
- Sync location (if pre-configured by creator)
- Team salt (for anonymous ID generation)

Join codes can be shared via Slack, email, or any channel. No central server validates them — the code contains everything needed to participate.

### Leaving a Team

```bash
claude-stats team leave backend-crew
# → Left "Backend Crew". Your synced data will remain until the team removes it.
```

Removes local team config. Previously synced manifests remain in the shared location until another member cleans up or they expire.

### Listing Teams

```bash
claude-stats team list
# → backend-crew    (3 members, last sync: 2h ago)
# → side-project    (2 members, last sync: 1d ago)
```

---

## Team Membership

There is no central member list. Membership is implicit — if you have the join code and push a manifest, you're a member. The set of known members is derived from the manifests present in the shared location.

**Member discovery:**
```bash
claude-stats team members backend-crew
# → Alice     last sync: 2h ago    streak: 5 days
# → Bob       last sync: 1d ago    streak: 12 days
# → Charlie   last sync: 3h ago    streak: 3 days
```

---

## Privacy Controls

### Per-Team Visibility

Each user controls what they share per team:

```bash
claude-stats team config --team backend-crew --share-level full|summary|minimal
```

| Level | What's shared |
|-------|---------------|
| **full** | Sessions, prompts, tokens, cost, models, tools, streaks, achievements |
| **summary** | Sessions, prompts, tokens, cost (no model/tool breakdown) |
| **minimal** | Sessions and prompts only (enough for leaderboards) |

Default: `summary`.

### Global Opt-Out

```bash
claude-stats team config --sharing off
# → All team sync disabled. No data will be pushed.
```

### Minimum Team Size for Aggregates

Team-level aggregate views (averages, distributions) require **3+ active members** to prevent individual re-identification. With fewer members, only individual cards are shown (each person sees their own stats alongside teammates who opted in).

---

## Data Model Addition

```sql
-- Local-only: tracks which teams this user belongs to
CREATE TABLE IF NOT EXISTS teams (
  team_id       TEXT PRIMARY KEY,
  team_slug     TEXT NOT NULL,
  team_name     TEXT NOT NULL,
  join_code     TEXT,
  team_salt     TEXT NOT NULL,
  sync_location TEXT,          -- e.g., "github:owner/repo" or "s3://bucket/path"
  share_level   TEXT NOT NULL DEFAULT 'summary',
  display_name  TEXT,
  joined_at     INTEGER NOT NULL,
  last_sync_at  INTEGER
);

-- Cached team member stats (from pull)
CREATE TABLE IF NOT EXISTS team_members (
  team_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,  -- anonymous hash
  display_name  TEXT,
  synced_at     INTEGER NOT NULL,
  period        TEXT NOT NULL,  -- e.g., "2026-W11"
  stats_json    TEXT NOT NULL,  -- full manifest summary
  PRIMARY KEY (team_id, user_id, period)
);
```
