# 01 — Sync Options

How team members share aggregated stats without a dedicated backend server.

---

## Option A: Shared File Sync (Simplest MVP)

Each team member exports a small JSON manifest to a shared location. A merge step combines them.

**Shared locations:**
- Git repository (private repo, one branch per team)
- S3 / GCS bucket with IAM
- Shared NAS / Dropbox / Google Drive folder
- GitHub Gist (private, team members have access)

**Flow:**
```
claude-stats team sync --push   →  write my-stats.json to shared location
claude-stats team sync --pull   →  read all *.json, merge into local team view
```

**Manifest format** (per-user, per-sync):
```json
{
  "schemaVersion": 1,
  "userId": "anon-hash-of-account-uuid",
  "displayName": "Alice",
  "teamId": "team-abc123",
  "syncedAt": "2026-03-12T10:00:00Z",
  "period": "2026-W11",
  "summary": {
    "sessions": 47,
    "prompts": 312,
    "inputTokens": 1_200_000,
    "outputTokens": 480_000,
    "estimatedCost": 18.42,
    "activeMinutes": 840,
    "modelsUsed": { "claude-sonnet-4-6": 280, "claude-opus-4-6": 32 },
    "topTools": ["Edit", "Read", "Bash"],
    "streakDays": 5,
    "achievements": ["early-bird", "10k-club"]
  }
}
```

**Pros:** Dead simple, works today, no new dependencies, user controls the transport.
**Cons:** Manual push/pull, no real-time updates, merge conflicts possible if same user pushes from multiple machines.

---

## Option B: CRDT-Based SQLite Sync (Best Long-Term)

Use a CRDT layer (like [cr-sqlite](https://github.com/vlcn-io/cr-sqlite) or [SQLite Sync](https://www.sqlite.ai/sqlite-sync)) to enable peer-to-peer database merging without conflicts.

**How it works:**
- Each column change is tracked as a CRDT event
- Peers exchange change sets over any transport (file, HTTP, WebSocket)
- Merges are conflict-free by construction — last-writer-wins per column, counters use max()
- Works offline; syncs converge when peers reconnect

**Architecture:**
```
User A (SQLite + CRDT)  ←──→  Shared transport  ←──→  User B (SQLite + CRDT)
                                    ↕
                              User C (SQLite + CRDT)
```

**Applicable to claude-stats because:**
- Already uses SQLite (better-sqlite3)
- Aggregate counters (tokens, prompts) are monotonically increasing — ideal for CRDT max-wins
- Session records are append-only with UUID primary keys — no conflicts

**Pros:** Automatic conflict resolution, offline-first, no server, scales to many peers.
**Cons:** Adds a native dependency (cr-sqlite), requires schema changes to CRDT-enable tables, more complex than Option A.

---

## Option C: GitHub-Based Sync

Use a private GitHub repository as the sync backend. Each team member pushes stats via GitHub API.

**Flow:**
```
claude-stats team sync --github owner/repo
```

1. Push: commit `stats/<userId>.json` to the repo
2. Pull: read all files in `stats/`, merge locally
3. Optionally use GitHub Actions to generate a team dashboard page (GitHub Pages)

**Pros:** Free for private repos, familiar to developers, built-in access control, audit trail via git history.
**Cons:** Requires GitHub token, rate limits apply, slightly awkward for real-time use.

---

## Option D: Shared SQLite via Cloud Storage

A single shared SQLite file on S3/GCS with advisory locking.

**Flow:**
1. Download team.db from S3
2. Merge local stats into it (INSERT OR REPLACE with aggregate max)
3. Upload back to S3

**Pros:** Single source of truth, simple mental model.
**Cons:** Write contention with concurrent users, requires careful locking, S3 eventual consistency can cause lost writes. **Not recommended** for teams > 3.

---

## Recommendation

| Phase | Approach | Why |
|-------|----------|-----|
| MVP | **Option A** (shared file sync) | Ship fast, validate demand, zero dependencies |
| V2 | **Option C** (GitHub-based) | Better UX, automatic via Actions, free |
| V3 | **Option B** (CRDT sync) | Best architecture if teams feature gains traction |

Option D is not recommended due to write contention.
