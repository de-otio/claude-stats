# The personal plane: backup, sync, encryption

The personal plane is "my data, my eyes only." It covers backup (#3),
cross-device sync (#2), and off-box storage of the transcript archive. Its
defining property: **the server/cloud is a blind blob store — it holds opaque
data and can never read plaintext** (when encryption is on, which is the default
for third-party targets).

## 1. Backup and sync are one mechanism

A backup you can restore onto a second device *is* a sync — just
eventually-consistent and manual. So we build **one** thing:

- **Backup** = push the local bundle to a store.
- **Sync** = push, then also pull other devices' bundles and merge.

The only added logic sync needs over backup is *pull + merge*, and merge is
trivial here (below). This is why #3 is the seed and #2 is #3 grown up.

## 2. The bundle: per-device, append-only, encrypted shards

A dumb cloud folder (Dropbox/iCloud/Drive/OneDrive/S3) has **no compute**: no
server-side merge, no atomic transactions, no locking. So the format must be
conflict-free *by construction*.

**Never a single shared mutable file** (`stats.db`): two devices writing it
clobber each other and last-write-wins silently drops data.

**Instead — per-device append-only shards:**

```
bundle/
  manifest.json                     # device list, format version, per-file encryption state
  <device-id>/
    sessions-<seq>.jsonl[.age]      # session/message records, append-only
    archive/<project>/<session>.jsonl[.age]   # optional raw transcripts
```

- Each device writes **only its own** `<device-id>/` subtree. No two writers
  ever touch the same file ⇒ no write conflicts, ever.
- `<seq>` is a monotonic counter per device; new data appends a new shard.
- Old shards are periodically **compacted** into one — but *only by the owning
  device*, so compaction is also conflict-free.
- The `.age` suffix is present when the shard is encrypted (§5); the manifest
  records per-file state so a reader knows whether to decrypt.

This is a poor-man's CRDT: writers partitioned by device, records keyed by id.

## 3. Merge: conflict-free by construction

On pull, a device reads every device's shards (decrypting as needed) and merges
into its local SQLite by the rules the data already supports:

- **Sessions / messages** — upsert by `session_id` / message `uuid`. Data is
  append-mostly; a record written once rarely changes.
- **Mutable fields** (tags, account attribution) — last-writer-wins via
  `updated_at`.
- **Monotonic counters** (token totals, prompt counts) — `max()`.

These are exactly the CRDT semantics [team-dashboard/01 Option
B](../team-dashboard/01-sync-options.md) identified as "best long-term" with
cr-sqlite. Per-device shards get us there with **no native dependency**;
cr-sqlite is the finer-grained (per-column) upgrade if/when wanted.

Because merge is convergent, a partial sync, a paused cloud client, or two
devices editing at once cannot corrupt state — they briefly diverge and
re-converge on the next pull. The dummy-proof property is *designed in*, not
handled by conflict dialogs.

## 4. Transports are swappable; the bundle is invariant

The same shard bundle works over any store; only auth/robustness differ:

| Transport | Tier | Notes |
|---|---|---|
| Consumer cloud folder (Dropbox/iCloud/Drive/OneDrive) | Low-tech backup & sync (#3 → #2) | Piggybacks the cloud client the user already runs. Zero new accounts/credentials. The cloud does the network sync; claude-stats just reads/writes a subfolder. |
| Plain local/network dir, S3-compatible bucket, rclone remote | Backup (#3) | For users who prefer explicit control. |
| Org-run **blind-storage** service | High-tech sync (#2) | Adds auth, quotas, audit, maybe realtime — still zero-knowledge (stores ciphertext, lists blobs, never reads them). |

The invariance is the key architectural payoff: a consumer cloud folder and a
real zero-knowledge service store the **exact same opaque shards**. Swap
transport, keep format — so #3 and #2 are the same code with a different sink.

## 5. The encryption keystone

Encryption is **optional** but, when on, is **end-to-end**: keys live with the
user, never the server. One envelope covers the whole personal plane (sync data
*and* archive) under a single key.

### Envelope key management

```
recovery secret (passphrase OR generated recovery key)
      │  Argon2id (memory-hard KDF)
      ▼
  master key ──wraps──► data key (random, 256-bit)
                            │
                            ├─ encrypts every shard (sync data)
                            └─ encrypts every archive file
```

- **Data key** is a random symmetric key; it encrypts content. Wrapping it
  (rather than encrypting content directly with the passphrase) means the
  passphrase/recovery key can be **rotated without re-encrypting all data**.
- **Content encryption**: a modern AEAD — `age` / XChaCha20-Poly1305 /
  libsodium `secretstream` — **per file**, not one big bundle, so a new session
  adds one blob and never re-encrypts the world (keeps cloud sync incremental).
- **Day-to-day the data key lives in the OS keychain** (Keychain / libsecret /
  DPAPI) so the user types nothing after setup. The recovery secret is needed
  only to **enroll a new device** or **recover after total device loss**.

### Optional, per-class encryption policy

Because it is one key, letting the user choose *which classes* get wrapped costs
almost nothing and serves a real case ("encrypt my transcripts, but leave my
aggregate stats greppable by a script"):

| Data class | Sensitivity | Local dir (FDE machine) | Third-party cloud |
|---|---|---|---|
| Sync data (shards; incl. `prompt_text`) | Medium-High | plaintext ok | **encrypt (opt-out)** |
| Archive (full raw transcripts) | **Highest** — assistant output, tool results, code, pasted secrets | encrypt-leaning | **encrypt (opt-out)** |

Defaults track *sensitivity × who-holds-it*. The interop argument for plaintext
is real for the **archive** (native `.jsonl`, greppable, tool-readable) but
**weak for sync data** (an internal format carrying `prompt_text`), so sync data
leans toward encrypt harder. A single global on/off toggle is the acceptable MVP
if per-class is too many knobs at first.

### The plaintext-vs-encrypted tradeoff (both are legitimate)

| | Plaintext on cloud | Encrypted on cloud |
|---|---|---|
| Confidentiality | ❌ cloud (and anyone it shares/scans/breaches to) reads it | ✅ cloud is blind |
| Recoverability | ✅ trivially restorable | ⚠️ **key-loss = data-loss** |
| Interop / future-proofing | ✅ any tool can read it | ❌ opaque without key + tooling |

Plaintext optimizes for disaster-recovery + interop; encrypted optimizes for
confidentiality. The user's threat model decides — the design offers the choice
and defaults sensibly, but never silently ships raw transcripts to a third party.

## 6. Recovery and the key-loss tension

Zero-knowledge has an unavoidable consequence: **"the server can't read it" and
"the server can recover it if I lose my key" are mutually exclusive.** So if
encryption is on, the recovery secret *must* survive whatever kills the
device — otherwise a *backup* becomes unrecoverable exactly when it's needed.

Design answer: make the recovery secret trivially easy to safeguard, and say the
truth once, kindly (see [02-user-experience.md](02-user-experience.md) §3–4):

- Generate a **recovery key** for the user (don't make them invent a
  passphrase); offer copy / download / print / "save to password manager".
- Nag until they confirm it's saved. Block nothing; keep reminding.
- State plainly: *if you lose this and all your devices, the encrypted backup is
  gone. We cannot recover it.*

The plaintext option is the escape hatch for users who won't manage a key.

## 7. Governance: solo (archive) vs sync-group (sync data)

Same mechanism, different blast radius for the *decision*:

- **Archive backup is single-writer** — encryption is a purely *local* choice.
- **Sync data is multi-device** — every device in a sync group reads and writes
  the same store, so they must share the key (via enrollment) **and agree on the
  on/off state**. You cannot have device A writing plaintext shards while device
  B expects ciphertext. So sync-data encryption is a **per-sync-group policy set
  at enrollment**, not a per-device toggle.

## 8. The archive in the personal plane

This refines the [transcript-archive plan](../../../plans/transcript-archive/plan.md)'s
Phase-2 rule. The archive is the most sensitive class, so:

- It **may** leave the machine — but **only via the personal plane**, where
  encryption is offered and defaulted-on for third-party targets. Backing up the
  archive (encrypted, or knowingly plaintext) is a supported feature: it lets
  the user survive disk loss, not just Claude Code's cleanup.
- It is **never** eligible for the **org aggregate plane**. The org never sees a
  transcript.

The accurate rule is therefore *"archive rides the E2E personal plane
exclusively; org plane excluded"* — not the plan's original blanket
"sync-exclusion."

## 9. Mode-switch hygiene

Switching a target from plaintext to encrypted (or back) leaves mixed state in
the store. The manifest tracks per-file encryption state, and a switch **must
re-encrypt/replace the plaintext leftovers** — otherwise the user has
"encrypted" while readable originals sit in the cloud, a classic false sense of
security. Report exactly what was converted.
