# Data planes: backup, sync, and team features

This note reconciles three requirements that arrived as separate ideas but are
one design problem:

1. **Team features** — share data upward so an enterprise can make licensing,
   seat-sizing, and cost-management decisions (and have some fun with
   leaderboards/streaks). Feeds the [license-advisor](../license-advisor/) work.
2. **Cross-device sync** — efficient, secure, robust, best-practice; ideally the
   server **cannot decrypt** the user's data. For orgs that can deploy and
   operate infrastructure.
3. **Backup** — a dead-simple way for a solo developer to back up their data,
   e.g. by pointing at a consumer cloud-storage service — and, if possible, to
   reuse that same mechanism as a *low-tech* cross-device sync.

Plus the pre-existing [transcript-archive plan](../../../plans/transcript-archive/plan.md),
which keeps full raw transcripts on-box to survive Claude Code's cleanup bug.

The claim of this note: these are **not four features**. They are points in one
design space, and factoring them correctly makes them compose instead of fight.

## The unifying model: two planes on two axes

Everything lives on two axes:

- **What data** — aggregates (token counts, session metadata) ↔ full raw
  transcripts.
- **Who can read the plaintext** — only me ↔ my org's server ↔ a dumb cloud
  blob store.

That collapses into **two data planes with fundamentally different trust
models**:

```
                    who can read the plaintext?
 ┌──────────────────────────────────────────────────────────────┐
 │ PERSONAL PLANE — "my eyes only", server/cloud is BLIND         │
 │ topics #2 (sync), #3 (backup), + the transcript archive        │
 │   • client-side (end-to-end) encryption — optional, default-on │
 │     for third-party targets; one envelope key                  │
 │   • unit = local SQLite (+ optional raw archive)               │
 │   • backup = push encrypted blobs                              │
 │   • sync   = push + pull + merge blobs (backup, grown up)      │
 │   • transport is SWAPPABLE, the bundle format is not:          │
 │       consumer cloud folder   → low-tech backup & sync (#3→#2) │
 │       org blind-storage service → high-tech sync (#2)          │
 └──────────────────────────────────────────────────────────────┘
 ┌──────────────────────────────────────────────────────────────┐
 │ ORG PLANE — the org CAN read; the server IS the consumer       │
 │ topic #1 (team features)                                       │
 │   • plaintext aggregates, minimized + k-anonymized             │
 │   • server-side encryption at rest (KMS), one-way-hashed ids   │
 │   • feeds license-advisor / cost management / gamification     │
 │   • transport: AppSync + DynamoDB (the existing team-app work)  │
 └──────────────────────────────────────────────────────────────┘
```

The two planes never share plaintext. They share only the **source** (the local
DB) and one bridge principle (below).

## The three topics, located

- **#3 Backup** is the *floor* of the personal plane: push the encrypted bundle
  somewhere off-box. Simplest, highest solo value, needs no server.
- **#2 Cross-device sync** is *the same personal plane with a smarter
  transport*. Backup and sync are **one mechanism**: a backup you can restore
  onto a second device *is* a sync — just eventually-consistent. Point two
  installs at the same store, add merge-on-pull, and low-tech sync falls out of
  backup almost for free.
- **#1 Team features** is a *separate plane entirely*. The org is a semi-trusted
  **consumer** of aggregates — being readable by the org is the whole point, so
  this plane is deliberately **not** end-to-end encrypted.

See [01-personal-plane.md](01-personal-plane.md) for #2/#3 mechanics and the
encryption keystone; [02-user-experience.md](02-user-experience.md) for the
effortless/dummy-proof design.

## The bridge principle: aggregate locally

The apparent contradiction — "#2 wants the server blind, but #1 wants the server
to read my data" — dissolves once you see that these are **different payloads,
not the same data at two encryption levels**:

> The client computes aggregates **on-device** and pushes only those to the org
> plane (plaintext). The personal bundle goes **end-to-end encrypted** to the
> storage plane (opaque). The org never decrypts personal data to derive
> aggregates — it receives aggregates already reduced and minimized.

This is what lets a *single* org-operated backend safely play both roles at once
(blind-storage for employees' personal sync **and** analytics sink for
licensing) without the two trust models colliding. Local aggregation is the
bridge.

## The org plane (topic #1) in brief

The org plane is already substantially designed — see [team-app/](../team-app/)
(AppSync + DynamoDB + Cognito magic-link auth, KMS-at-rest, one-way-hashed
account ids) and [team-dashboard/](../team-dashboard/) (team model, shared
metrics, gamification). That design's deliberately **non**-zero-knowledge posture
(the org reads the aggregates; [team-app/11 removed per-user encryption
keys](../team-app/11-account-separation.md) on purpose) is *correct for this
plane*. Reuse it as-is for topic #1, wired to:

- **license-advisor / cost management** — the aggregates are exactly the inputs
  the [license-advisor](../license-advisor/) needs to recommend a plan and seat
  count from real usage, but at org scale instead of one machine.
- **gamification** — leaderboards/streaks/achievements ride the same aggregate
  stream ([team-dashboard/04](../team-dashboard/04-gamification.md)).

The one hard rule: the **raw transcript archive and the personal bundle are
never eligible for the org plane.** Only locally-computed aggregates cross into
it.

## What this supersedes / reframes in existing docs

- [cross-device-sync/recommendation.md](../cross-device-sync/recommendation.md)
  ("start with S3, upgrade to AppSync") is **reframed**: AppSync belongs to the
  **org plane**. The **personal plane** uses encrypted per-device shards over a
  *swappable dumb store*, starting with the consumer cloud client the user
  already runs. The S3 instinct (a dumb blob store, upsert-by-session_id) is
  right in spirit and is generalized here.
- [team-dashboard/01 Option B (cr-sqlite CRDT)](../team-dashboard/01-sync-options.md)
  is the **eventual upgrade** for personal-plane merge. Per-device append-only
  shards are the MVP that needs no native dependency; cr-sqlite is the
  finer-grained successor.
- [team-app/](../team-app/) is **adopted unchanged** as the org plane. Its
  non-E2E, KMS-at-rest, hashed-id posture is explicitly *not* what the personal
  plane uses — that difference is the whole point of separating the planes.
- [05-privacy-security.md](../05-privacy-security.md)'s "Server Sync Rules
  (Future)" section describes the **org plane** only. The personal plane is new
  and needs its own section (see the personal-plane doc).

## Sequencing / roadmap

The planes are independent; within the personal plane, backup seeds sync.

1. **Keystone — the encrypted personal bundle.** Shard format + envelope key
   management + merge-by-id. Both #3 and #2 stand on it.
2. **Ship #3 (backup) first**, to a configurable target (an already-syncing
   consumer cloud folder, or a plain dir). Fewest moving parts, no server; forces
   the crypto and format to be right.
3. **Low-tech sync (#3 → #2)**: point a second install at the same target,
   enable pull + merge. Nearly free once backup exists.
4. **High-tech sync (#2)**: swap transport for an org-run *blind-storage*
   service (auth, quotas, audit, maybe realtime) — same bundle, still
   zero-knowledge. Only for orgs that need it.
5. **#1 team features**: build the aggregate plane on the existing team-app
   design; wire to license-advisor + gamification. Repurpose the coded-but-
   unwired [`sync/`](../../../packages/cli/src/sync/) module here, explicitly as
   **aggregate-only** — *not* the personal E2E path.

Net: **#3 is the seed, #2 is #3 grown up, and #1 is a separate plane that shares
nothing but the source DB — bridged safely by local aggregation.**

## Index

| File | Purpose |
|------|---------|
| [01-personal-plane.md](01-personal-plane.md) | Backup = sync; per-device shards; conflict-free merge; swappable transports; the encryption keystone (envelope keys, per-file AEAD, per-class optional encryption, recovery). |
| [02-user-experience.md](02-user-experience.md) | Making it effortless / dummy-proof: auto-detect the cloud the user already runs; humane key management; ambient sync; trust clarity; tiered disclosure; friendly failure modes; the 3-tap onboarding. |
