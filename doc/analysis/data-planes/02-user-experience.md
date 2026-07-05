# Making it effortless

Goal: a non-expert developer can back up their data, sync a second device, and
have it encrypted so the cloud can't read it — **without understanding
cryptography and without a painful setup**. The whole design is judged on this.

Zero-knowledge encryption + consumer cloud + multi-device is normally
*user-hostile*. Two frictions cause almost all of the pain, and the UX exists to
dissolve both:

1. **Storage setup** — "where does it go, and do I need an account/credentials?"
2. **Key management** — "what is this key, why must I keep it, and how do I get
   my data onto a second device?"

Everything below attacks those two.

## 1. Piggyback the cloud the user already runs — no new accounts, no credentials

The single biggest "effortless" win: **don't ask the user to configure storage.
Detect it.** Most developers already run a consumer cloud client that syncs a
local folder. claude-stats just writes to a subfolder of it; the cloud client
does the network sync. No OAuth, no API keys, no S3, no rclone, no new account.

- **Auto-detect** known cloud roots at setup and offer them as one-click
  choices (verify exact paths per-platform at build time):
  - Dropbox — `~/Dropbox`, `~/Library/CloudStorage/Dropbox`
  - iCloud Drive — `~/Library/Mobile Documents/com~apple~CloudDocs`
  - Google Drive — `~/Library/CloudStorage/GoogleDrive-*`, `~/Google Drive`
  - OneDrive — `~/OneDrive`, `~/Library/CloudStorage/OneDrive-*`
- Present detected ones as buttons: **"Back up to your Dropbox →"**. The user
  picks; done.
- **Fallback** for advanced users: "Choose a folder…" (a network drive, an
  rclone mount, an S3-backed mount). Same code path — it's just a directory.

Because the transport is a plain directory ([01 §4](01-personal-plane.md)), this
"use the cloud you already have" path and a future org blind-storage service are
the same mechanism.

## 2. Key management made human

The hard part. The pattern that works (used by well-designed E2E consumer apps):

- **Generate the key for the user.** Never ask them to invent a passphrase from
  scratch — that yields weak, forgotten secrets. Generate a **recovery key** (a
  word-list or grouped alphanumeric, easy to transcribe) and reduce their job to
  one verb: *save this.*
- **Make saving trivial and multi-modal:** `Copy`, `Download as file`,
  `Reveal QR`, `Print recovery sheet`, and a nudge to store it in a password
  manager. The more one-tap ways to stash it, the fewer users lose it.
- **After setup, the user types nothing.** The working key lives in the OS
  keychain; day-to-day backup/sync is silent. The recovery key resurfaces only
  to **add a device** or **recover after loss**.
- **Second device = one paste.** Device B, on the same cloud, sees the existing
  bundle and prompts: *"Found your backup. Enter your recovery key to sync this
  device."* One paste (or QR scan) and it's enrolled — no live device-to-device
  ceremony, which a dumb cloud folder can't provide anyway.

## 3. The unavoidable truth, said once, kindly

Zero-knowledge means **we cannot recover the user's data for them** ([01
§6](01-personal-plane.md)). Hiding this is a betrayal; hammering it is scary. So:

- Say it **once**, in plain words, at the moment the recovery key is shown:
  *"This key is the only way to recover your encrypted backup. If you lose it and
  all your devices, the backup is gone — we can't get it back."*
- Then **make the failure improbable** rather than repeating the warning: the
  multi-modal save options above, plus a one-time confirmation ("I've saved my
  recovery key"), plus a gentle standing reminder in settings if it was never
  confirmed. Block nothing.

## 4. Plaintext is the ultimate escape hatch — and that's fine

The maximally-effortless path for a user who refuses to manage a key is
**plaintext backup**: no key, no recovery, works instantly, restorable even if
they lose everything. The cost is that the cloud can read it. That is a
legitimate, informed choice ([01 §5](01-personal-plane.md)) — so the encryption
prompt is itself a fork:

- **Encrypted (recommended)** — "Only your devices can read it. You'll save one
  recovery key."
- **Plaintext (simplest)** — "No key to manage. Your cloud provider can read
  your stats." (For the raw *archive* specifically, this warning is louder,
  because transcripts can contain secrets.)

Dummy-proofing isn't forcing encryption; it's making both choices clear and the
consequences legible.

## 5. Ambient, not manual — the user never runs a sync command

Backup/sync must be **invisible after setup**, like the existing collector:

- Piggyback the [`AutoCollector`](../../../packages/cli/src/extension/collector.ts):
  after each local collect, push new encrypted shards to the folder; on a timer
  or file-watch, pull + merge new shards from other devices. The cloud client
  handles the network.
- **No `claude-stats sync` in normal use.** (The CLI verb stays for headless/CI
  and power users.)
- **Glanceable status, never nagging:** a status-bar item like
  `☁ Synced 2m ago · 3 devices`. Passive, not a demand for attention.

## 6. Trust clarity — never blur "private" and "shared with my org"

The personal plane and the org plane ([README](README.md)) have *opposite* trust
models, and the UI must never let a user confuse them:

- Personal backup/sync language: **"Only your devices can read this."**
- Team language: **"Your team's dashboard will see aggregated stats (no prompt
  content)."**
- They are separate settings sections, separate enable flows, separate status
  indicators. A user must never think they're "backing up privately" when they're
  actually sharing with an employer, or vice versa. When both are on, show both
  distinctly.

## 7. Tiered / progressive disclosure — climb without re-architecting

Match complexity to the user, and let them move up tiers without a migration:

| Tier | User | Experience |
|---|---|---|
| 0 | Everyone | Local-only, zero config (today's behavior). |
| 1 | Solo dev who wants safety | Encrypted backup to the cloud they already run — **~3 taps**. The sweet spot. |
| 2 | Multi-device solo dev | Same, plus a second device — **one recovery-key paste**. |
| 3 | Organization | Team plane: admin deploys infra; employees **join via a link** (magic-link auth), only aggregates leave. |

The two-plane + swappable-transport architecture ([01 §4](01-personal-plane.md))
is what makes climbing free: Tier 1→2 adds pull+merge; 1/2→3 is an orthogonal,
separately-consented plane.

## 8. Failure modes made friendly

Most robustness is *designed in*, so there are few dialogs to get wrong:

- **Conflicts can't corrupt** — per-device shards + convergent merge ([01
  §3](01-personal-plane.md)) mean the worst case is brief divergence, silently
  reconciled. No merge-conflict UI exists because merge conflicts can't happen.
- **Cloud paused / not running** — detect stale bundles and surface a plain hint:
  *"Last synced 3 days ago — is Dropbox running?"* Not a crypto error.
- **Wrong/missing key on a new device** — *"Enter your recovery key to unlock
  this backup,"* never `AEAD: decryption failed`.
- **Encryption on but key never saved** — a standing, dismissible reminder; never
  a block.

## 9. The effortless onboarding, end to end

The ideal first-run for Tier 1→2:

1. Install the extension; the collector starts (as today).
2. A gentle, one-time prompt (not modal spam): *"Back up your Claude stats so you
   never lose them? [Set up backup]"*.
3. Click → auto-detect: *"Back up to your Dropbox? [Yes] [Choose location]"*.
4. Encryption fork: *"Encrypt it so only your devices can read it? [Encrypt —
   recommended] [Plaintext — simplest]"*.
5. If encrypted: show the recovery key → `[Copy] [Download] [Save to password
   manager]` → *"I've saved it → Continue"*.
6. **Done.** Backup + sync are now ambient.
7. Second device: install → it finds the bundle in Dropbox → *"Found your backup
   — enter your recovery key to sync this device."*

Three taps for the common case; the crypto reduced to "save this one key."

## 10. Uninstall / removal — one button, honest scope

Extends the [archive plan](../../../plans/transcript-archive/plan.md)'s removal
work. Because VS Code has no reliable uninstall hook, removal is an explicit,
clearly-scoped action:

- **"Delete all stored data"** (command + CLI `purge`) with an honest scope
  picker: *this machine only* vs *also delete the cloud copy*.
- Deleting the **cloud copy** removes this device's shards; note plainly that
  *other devices still hold their copies* until they too are purged (that's how
  a distributed backup works).
- The **org plane cannot be deleted unilaterally** — the org owns that data; the
  UI says so and points to the team admin, rather than pretending a local button
  erases server-side aggregates.

## Why the architecture enables the UX

The effortlessness isn't bolted on — it's *downstream of* the architecture
choices in [01](01-personal-plane.md):

- **Piggyback existing cloud** ⇐ transport is a dumb directory ⇒ no accounts,
  no credentials.
- **No conflict dialogs** ⇐ per-device shards + convergent merge ⇒ conflicts
  can't corrupt.
- **One thing to save** ⇐ one envelope key over the whole personal plane.
- **Org features need no key exchange** ⇐ local aggregation bridges the planes.

The design was factored *to make the UX possible*, not in spite of it.
