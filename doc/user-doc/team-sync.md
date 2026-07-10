# Team Sync

Team sync is an **optional, opt-in** way to share your Claude Code usage with a
team that runs a shared Claude Stats backend, so a team dashboard can compare
usage across members.

It shares **aggregate-only** data: minimized **per-day totals** (sessions,
prompts, tokens, estimated cost) for the accounts you choose. It is
*structurally* incapable of sending per-session records, prompt text, file
paths, or transcript content — the only payload the client can build is the
minimized daily aggregate.

> **Team sync is not personal backup.** They are two independent features:
>
> - **[Backup & sync](backup-and-sync.md)** — a *personal*, end-to-end-encrypted
>   copy of your full stats to a cloud folder *you* control. No server, no
>   account. For restoring your own data and syncing your own machines.
> - **Team sync** (this page) — shares *aggregate-only* per-day totals to a
>   *shared team backend* so others can see team-level usage. Requires that
>   backend and a sign-in.
>
> Turning one on does not turn on the other.

---

## What is shared

For each account you link, per day:

- session and sub-agent counts, prompt count
- input / output / cache-read / cache-creation tokens
- active minutes, tool-use counts, model names
- estimated cost

Each account is sent under a **one-way, salted handle** (`HMAC-SHA-256` of the
account UUID with a per-user salt generated on first connect). Your raw account
UUID never leaves the machine, and two users who share an account produce
different handles.

Not shared, ever: individual sessions, prompt or response text, file paths, repo
URLs, or transcript content. There is no per-session or per-message write path in
the backend schema at all.

---

## Setup — VS Code extension (no CLI required)

1. **Claude Stats: Connect to Team Sync…** (Command Palette). Enter your team's
   backend URL (e.g. `https://stats.example.com`) and your email, then complete
   the passwordless sign-in link that arrives in your browser / inbox.
2. **Pick which accounts to share.** A multi-select appears immediately after
   sign-in. Only the accounts you tick are linked. Re-run anytime with
   **Claude Stats: Link Accounts to Share…**.
3. **Claude Stats: Sync Now.** Pushes the aggregates. A cloud item in the status
   bar shows the connection state and is click-to-sync.

Enable the `claude-stats.autoSync` setting to push automatically after each
collection.

**Other commands:** **Disconnect from Team Sync** (clears tokens and config,
preserving your salt so re-linking is stable) and **Open Team Dashboard**.

---

## Setup — CLI

The CLI offers the same flow:

```sh
# Connect + pick accounts in one flow (prompts interactively)
claude-stats setup --backend-url https://stats.example.com --email you@example.com

# Non-interactive account selection
claude-stats setup --backend-url https://stats.example.com --email you@example.com --all-accounts

# Re-choose which accounts to share later
claude-stats link                     # interactive
claude-stats link --accounts <uuid-or-label>,<uuid-or-label>
claude-stats link --all-accounts

# Push aggregates
claude-stats sync                     # add --dry-run to see exactly what would be sent

# Remove tokens + config (keeps the salt for stable re-linking)
claude-stats disconnect
```

The extension and CLI share the same `~/.claude-stats/sync-config.json`, so
connecting or linking from one is visible to the other.

---

## Requirements & notes

- **A team backend.** Team sync targets a Claude Stats backend your team
  operates; it discovers its configuration from
  `<backend>/.well-known/claude-stats.json`. Without a backend URL there is
  nothing to connect to.
- **You must link at least one account.** With no linked accounts, `sync` has
  nothing to send and reports *"No linked accounts"*. Connect (or `setup`) walks
  you through linking; re-run **Link Accounts** / `claude-stats link` anytime.
- **Aggregate writes are optimistic and idempotent.** Each `(you, day)` row is an
  upsert guarded by a version; re-syncing the same day is safe.
- **Disconnecting keeps your salt** so that if you reconnect later, your account
  handles stay the same.
