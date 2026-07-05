# Backup, Sync & Privacy

By default `claude-stats` is **fully local** — it reads Claude Code's session
files, writes to `~/.claude-stats/`, and makes no network requests. Backup and
sync are **optional and opt-in**: you turn them on explicitly, and when you do,
only an **end-to-end-encrypted** copy of your stats leaves your machine — to a
cloud folder *you* already control. Nothing is ever sent to a claude-stats
server, and there is no account to create.

This page covers the personal backup/sync feature, the recovery key, moving to a
second device, removing your data, and — for organization admins — exactly what
a team/organization dashboard can and cannot see.

---

## What it is

- **Backup** — a copy of your collected stats, kept in a folder your existing
  cloud app (Dropbox, iCloud Drive, Google Drive, OneDrive, …) already
  synchronizes. If your laptop dies, you can restore from it.
- **Sync** — the *same* mechanism across machines: each device writes only its
  own append-only shards into the shared folder, and every device merges the
  others' shards. There is no server in the middle and no lock to contend on, so
  two machines can back up at the same time without conflicts.

You do **not** create a new account or point at a claude-stats server. The
"store" is just a folder; your own cloud client moves the bytes.

## Turning it on

In VS Code, run **Command Palette → Claude Stats: Set Up Backup & Sync…**
(the extension also shows a one-time, dismissible nudge on activation). The
wizard:

1. **Detects** cloud folders you already have (or lets you choose any folder).
2. Lets you pick **encrypted (recommended)** or **plaintext**.
3. For encrypted, **generates a recovery key** and asks you to save it.

After that, backup and sync are **ambient** — they happen in the background and
you don't need to think about them again.

## The recovery key

When you choose encryption, claude-stats generates a **recovery key** (a short
grouped string like `ABCD-EFGH-IJKL-…`). This key — together with your enrolled
devices — is the *only* way to decrypt the backup.

- **Save it** in your password manager. Copy it from the setup dialog.
- It is **zero-knowledge**: the recovery key never leaves your machine and is
  not recoverable by anyone, including the project maintainers.
- **If you lose the recovery key *and* all your enrolled devices, the encrypted
  backup is unrecoverable.** That is the deliberate trade-off for an
  end-to-end-encrypted design — stated plainly so it isn't a surprise.

## Adding a second device ("one paste")

On a new machine that can see the same cloud folder, claude-stats notices the
existing backup and offers **Enter recovery key**. Paste your recovery key once:
the device derives the decryption key, enrolls itself into the backup, and joins
the sync group. From then on both machines back up and merge automatically.

A wrong or mistyped key fails cleanly ("enter your recovery key to unlock this
backup") — it never silently produces the wrong result.

## Encrypted vs plaintext

- **Encrypted (default for third-party cloud folders).** Your stats — including
  prompt text captured in your history — are sealed before they leave the
  machine. Your cloud provider stores opaque bytes; even project and session
  names in the file index are encrypted.
- **Plaintext (informed opt-out).** Faster to set up and needs no key to manage,
  but your cloud provider can read your stats. The wizard warns you before you
  choose this.

You can switch an existing target between modes later; the switch rewrites your
shards to new filenames and removes the old ones, so no cleartext is left behind
in the folder (see the note on provider version history below).

## Removing your data

**CLI:** `claude-stats purge` deletes local claude-stats data and unregisters
the MCP server. It is a **dry run by default** — it shows what *would* be deleted
and exits without touching anything. Pass `--yes` to actually delete.

```sh
claude-stats purge                 # dry run — preview only, deletes nothing
claude-stats purge --yes           # delete local data (keeps the SQLite DB)
claude-stats purge --yes --include-db   # also delete ~/.claude-stats/stats.db
claude-stats purge --backup-cloud       # (dry run) also describe the cloud copy
```

**VS Code:** **Command Palette → Claude Stats: Delete All Stored Data…** offers
a scope picker: *this machine only* or *also delete the cloud copy*.

> **Other devices keep their copies.** Deleting the cloud copy removes *this*
> device's subtree; other enrolled devices still hold their own shards and can
> re-populate the folder on their next sync. claude-stats never claims to erase
> every copy everywhere — you control the other machines and the cloud
> provider's own version history.

> **Provider version history.** A cloud client may retain deleted or overwritten
> bytes in its server-side version history. claude-stats cannot erase those
> remotely; purge your provider's file history if that matters to you.

---

## Your data & privacy — the two planes

claude-stats separates data into two strictly independent "planes". This
distinction is what an **organization admin** needs to understand before
enabling any team features.

### Personal plane (backup + sync) — end-to-end encrypted

Everything above is the **personal plane**. It is yours alone:

- Encrypted on your device before upload; the key is derived from your recovery
  key and never leaves your machines.
- The cloud folder holds **opaque ciphertext** — the provider (and anyone with
  access to the folder) cannot read your prompts, transcripts, token counts, or
  even the project/session names.
- There is **no claude-stats server** in this path.

### Organization / team plane — aggregates only

Separately, an organization may run a **team dashboard** that shows *aggregate*
usage across a team (for capacity planning and license sizing). This plane is
**structurally incapable** of carrying personal-plane content:

- A client only ever sends **aggregate counts** for a time bucket — session
  counts, token totals, estimated cost, and model labels.
- It **cannot** carry prompt text, transcripts, file paths, session or source
  IDs, or any key material. This is enforced by the data *type*, not by a
  runtime filter that could be bypassed — the aggregate payload has no field in
  which such data could travel, and a build-time check fails if one is ever
  added.
- The personal (encrypted) plane and the org (aggregate) plane never share keys
  or storage. Aggregation happens **locally** before anything is sent.

In short: **an organization dashboard sees totals, never your prompts or
transcripts.** Your personal backup stays end-to-end encrypted and is never
visible to your organization.

> **Availability.** The team/organization backend is not a generally-available,
> self-service product yet — the org-plane wiring exists but standing up a team
> deployment is an operator task, not something an end user enables from the
> extension. The personal backup/sync described above is what you can turn on
> today.

---

## See also

- [getting-started.md](getting-started.md) — install and first run
- [commands.md](commands.md) — full command reference (including `purge`)
- [faq.md](faq.md) — common questions
