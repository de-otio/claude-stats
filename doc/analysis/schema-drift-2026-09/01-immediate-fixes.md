# 01 — Immediate Fixes

Correctness items that are wrong today, independent of any new feature.

## 1. `claude-sonnet-5` intro pricing expired 2026-08-31

`packages/core/src/pricing.ts:59-61` still carries the introductory rate
($2 / $10 per MTok) with its own comment: *"through 2026-08-31; standard rate
($3/$15) takes effect 2026-09-01 — bump this row then."* Today is 2026-09-01.

Every Sonnet 5 request costed from today onward is under-reported by 33%.

**Fix:** bump the row to $3 / $15 (and the cache-write/read derivatives), update
`PRICING_VERIFIED_DATE`. Note **[docs]**: the changelog research reported that
the planned Sep-1 increase may have been cancelled and $3/$15 declared the
stable rate — the row lands at $3/$15 either way, but re-verify against the
live pricing page (the `pricing-cache.ts` scraper's source) before committing,
since the scrape will otherwise fight a wrong default.

## 2. 1M-context model variants are silently priced at base rates

**[live]** A `cost-state` entry in current data reports usage under the model id
`claude-opus-5[1m]` — the 1M-context tier is a distinct billing tier with
premium rates, and its id is the base id plus a `[1m]` suffix.

The pricing lookup (`packages/core/src/pricing.ts:300-337`) is longest-prefix
`startsWith` over normalized ids: `claude-opus-5[1m]` starts with
`claude-opus-5`, matches the base row, and gets standard pricing with
`known: true` — so the existing `{cost: 0, known: false}` safety net never
fires. This is the worst failure mode the pricing module was designed to avoid:
a confidently wrong number.

**Fix:** either add explicit `[1m]` rows, or strip/flag the suffix in
`normalizeModelId` (`pricing.ts:201-248`) and apply a tier multiplier. Also
check whether assistant-entry `message.model` (not just `cost-state`) ever
carries the suffix — in the 40-file sample it appeared only in `cost-state`,
but the sample is not proof.

## 3. `<synthetic>` model id

**[live]** A handful of assistant entries carry `message.model: "<synthetic>"`
(harness-generated messages, e.g. error placeholders). They carry usage blocks
of zeros in the sample, but the id will hit the unknown-model path and, if such
entries ever carry non-zero usage, would pollute per-model aggregates.

**Fix:** recognize `<synthetic>` explicitly (zero-cost, excluded from
model-distribution stats) rather than letting it land in the generic
unknown-model bucket.

## 4. Duplicate-and-drifting envelope key: `session_id` vs `sessionId`

**[live]** A minority of entries (~7% in the sample, across user/assistant/
attachment types) carry a snake_case `session_id` **in addition to**
`sessionId`. The parser reads only `sessionId` (`session.ts:205-222`), which
still appears on every entry, so nothing breaks today — but it is the first
observed instance of a parallel snake_case envelope, worth a fingerprinter
watch in case a future version migrates.
