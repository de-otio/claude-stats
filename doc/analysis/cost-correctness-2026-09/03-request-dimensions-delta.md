# 03 — Request Dimensions: What Eleven Days Changed

Short answer: **almost nothing.** This chapter exists to record that the prior
design survives contact with new data, and to stop a second analysis
re-deriving it.

`../schema-drift-2026-09-implementation/05-request-dimensions.md` is the design
of record for `effort`, `speed` and `thinking_tokens`. It is thorough, it is
measured, and two of its three conclusions are confirmed below on a fresh
sample. Implement from that chapter, not from this one.

## 3.1 `effort` — confirmed, including the reason not to build the analytic

Measured here on the 150 most recent session files, deduped per API response
**[live]**:

| Model | Effort | Responses | Output MTok | Thinking MTok | Thinking share |
|---|---|---:|---:|---:|---:|
| `claude-opus-5` | high | 52,348 | 37.23 | 10.48 | 28.1% |
| `claude-fable-5` | high | 7,403 | 6.53 | 2.33 | 35.7% |
| `claude-fable-5-1` | high | 1,806 | 3.01 | 1.02 | 33.9% |
| `claude-sonnet-5` | high | 1,307 | 0.85 | 0.40 | 47.5% |
| `claude-opus-5` | **xhigh** | 781 | 0.62 | 0.24 | 38.7% |
| `claude-opus-4-8` | high | 633 | 0.68 | 0.29 | 42.2% |

Confirmations of the prior chapter:

- `effort` sits at the **entry root**, not under `message` — as
  `05-request-dimensions.md:20-24` states and the parent doc got wrong.
- Only `high` and `xhigh` are ever observed. `low` and `medium` remain
  hypothetical, so `EffortTier` is still wrong in both directions
  (`:49-53`).
- `xhigh` still shows a higher thinking share than `high` on the same model
  (38.7% vs 28.1% here; 46.8% vs 38.9% there).

And the part that matters for scope: the corpus is **98.6% `high`**. The prior
chapter's own suppression rule — hide the analytic unless at least two levels
each carry ≥100 messages (`:414-420`) — would *pass* on this sample (`xhigh` has
781), but only just, and into a two-cell table whose difference is confounded
with task difficulty. Their standing caveat holds: **never present
`xhigh`→`high` as a 28% saving.** It is a difficulty signal at least as much as
a cost lever.

The cheap, honest half is the **column**, not the card. Recording
`messages.effort` costs one nullable column and makes a real comparison possible
later, when Claude Code's newer effort controls (`/effort`, `maxEffortLevel`,
`effort:` frontmatter on commands and subagents) have actually produced
variation. The card can wait for data that earns it.

## 3.2 `thinking_tokens` — confirmed, and the nullable lesson is load-bearing

Thinking is **28–47% of output tokens** across every model/effort cell above —
a large, entirely unrecorded component of the only token class billed at the
output rate. `messages` stores `thinking_blocks` (a count of blocks) and not
`thinking_tokens`.

The prior chapter's single most important refinement stands and must not be
lost in re-implementation:

> `thinking_tokens` **must be NULLABLE**, not `NOT NULL DEFAULT 0` — absent on
> 32% of corpus (pre-mid-August); `NOT NULL DEFAULT 0` fabricates 0% thinking
> share for historical messages
> — `01-foundation.md:251-258`, `05-request-dimensions.md:255-265`

That bug was actually produced during their research (23.7% reported instead of
38.9%). It is the same class of defect as everything in [01](01-measured-defects.md):
a fabricated value that reads as data. Any implementation of this column that
uses `NOT NULL DEFAULT 0` should be rejected in review on sight.

## 3.3 `speed` — confirmed zero, one narrow change

489,970 occurrences in current data, **all `"standard"`**. Zero `"fast"`. The
prior conclusion — build no fast-mode analytic — is unchanged and is not
reopened.

What changed is that the premium rate is now published, which makes it a
*pricing* fact rather than an analytic. See
[02 §2.4](02-pricing-drift.md#24-fast-mode-price-the-rate-build-nothing-else)
for the proportionate response: price it, refuse when unpriced, build nothing.

## 3.4 `service_tier` — the sweep's open question, closed

The sweep of the prior docs flagged `service_tier` as **unverified**: the parent
document asserts it is parsed, and the implementation set never re-checked that
claim while correcting fourteen others.

Checked here: it is parsed and stored. `usage.service_tier` is read at
`packages/core/src/parser/session.ts:442` and persisted as `messages.service_tier`
(column present, added in the V7 migration alongside `inference_geo`,
`packages/cli/src/store/index.ts:275-276`).

No action. Recorded so the question is not asked a third time.
