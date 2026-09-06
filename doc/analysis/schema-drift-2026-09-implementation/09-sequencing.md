# 09 — Sequencing, Correctness Debt, and Open Decisions

## 9.1 The eleven defects this analysis found

Designing the features surfaced more correctness debt than feature value. Every
item below is a defect in shipped behaviour, independent of whether any feature
in this analysis is built.

| # | Defect | Impact | Chapter |
|---|---|---|---|
| **C1** | **Assistant usage is summed once per transcript *entry*, not per API response.** Blocks of one response share a `message.id` but carry distinct envelope uuids, so the `uuid` dedupe misses them. Measured: 71–76% of assistant entries repeat a `message.id`; **59% of multi-entry groups carry no repeated uuid at all**. Our cost vs `cost-state` ground truth: **$124.25 vs $60.52 = 2.05×**; deduping by `message.id` matched ground truth exactly on all four token classes. | **Every dollar figure the tool publishes is inflated.** | [03 §3.0](03-cost-verification.md) |
| **C2** | **User entries are never deduped.** `seenAssistantUuids` covers assistants only. Measured: **62.5% of user entries are replays**; parser `promptCount` over-reports **~2.3×**. | Parser-level prompt counts; anything reading `ParseResult` before the DB projection. | [04 §4.4](04-attribution-hardening.md) |
| **C3** | **Compaction summaries are counted as human prompts and written into `prompt_text`.** A summary is `!isMeta` with string content, so it hits `promptCount++` *and* `lastPromptText`. Measured: **903 phantom prompts across 73 sessions**, and up to 2,000 chars of model-authored summary flowing into recap headlines and `taskTitle`. | Prompt counts **and** user-visible headlines. | [07 §7.2](07-compaction.md) |
| **C4** | **Permission denials are counted as tool errors.** All 986 denial entries carry `is_error: true`; **19.7% of all tool errors are denials**. `detectRetryLoop` reads them as "the environment is broken, escalate the tier"; `detectTierMismatch` and constraint-impact's `toolErrorRate` read "policy said no" as "the model failed". | Two shipped detectors give the wrong remedy; enabling auto-mode reads as a rework regression. | [06 §6.2](06-friction.md) |
| **C5** | **Pricing:** the `claude-sonnet-5` intro row expired 2026-08-31 (33% under-report); `estimateCost` has **no web-search term** despite `web_search_requests` being stored everywhere ($0.01/req, confirmed to the cent); `<synthetic>` pollutes the unknown-model bucket. | Direct cost error. | [03 §3.6](03-cost-verification.md), [01-immediate-fixes](../schema-drift-2026-09/01-immediate-fixes.md) |
| **C6** | **The schema fingerprinter is dead code.** `checkSchema` is imported at `aggregator/index.ts:10` and never called; `entriesByVersion` is only ever assigned an empty array. **`schema_fingerprints` is empty in every real database.** | The drift-detection mechanism this whole analysis exists because of does not run. | [01 §1.2](01-foundation.md) |
| **C7** | **`HIGH_THINKING` fires on the majority of messages.** The stub predicate is `thinking_blocks > 0`; the real corpus mean is 40.6% thinking share, so the flag carries no information. | A dashboard flag that means nothing. | [05 §5.6](05-request-dimensions.md) |
| **C8** | **`autoCompactFit` may be recommending a setting that does nothing.** It recommends `autoCompactWindow`, which affects only *auto* compaction — and **903/903 observed triggers are `"manual"`**. | Shipped advice may be inapplicable to the observed workload. | [07 §7.4](07-compaction.md) |
| **C9** | **`mergeThresholds` is hand-exhaustive with no compile-time check** (`hygiene/index.ts:139-149`). A forgotten line silently drops a detector's thresholds onto the floor. | Latent; will bite on the next detector. | [06 §6.6](06-friction.md) |
| **C10** | **`api_error_events` declares an FK while the parser can write an empty `session_id`** (`session.ts:281`, `:318`). Under `PRAGMA foreign_keys = ON` that throws inside the collector's whole-file transaction, **aborting every write for that file**. | Latent data loss. | [01 §1.4](01-foundation.md) |
| **C11** | **`ForbiddenPersonalField` does not cover title-shaped names.** A field named `aiTitle` / `title` / `label` compiles cleanly onto every pack and sync row today. | The compile-time privacy boundary has a hole the moment titles are stored. | [08 §8.5](08-session-titles.md) |

**C1, C2 and C3 are the same root cause**: the parser's dedupe model is
incomplete on both sides and keyed on the wrong identifier on the assistant side.
Three chapters found it independently, on three different samples.

## 9.2 Sequencing

### Phase 0 — correctness, before any feature

Ship these on their own, in this order, each with its own CHANGELOG entry so a
user who sees a number move has an explanation.

| Step | Work | Why first |
|---|---|---|
| 0.1 | **C5** — pricing row, web-search term, `<synthetic>`, `[1m]` normalisation | Smallest, purely additive, and [03](03-cost-verification.md)'s Layer B cannot be trusted until the table is right |
| 0.2 | **C10** — remove the `api_error_events` FK, guard empty `session_id` at the writer | Prevents whole-file write loss; blocks every new table in V23 |
| 0.3 | **C2 + C3** — user-entry uuid dedupe and `isCompactSummary` suppression (count **and** `prompt_text`) | One coherent "prompt counting was wrong" release. Landing them together makes the −2.3× shift attributable to one cause |
| 0.4 | **C1** — dedupe assistant usage on `message.id`, keeping the **maximum** usage in the group (last ≥ first in 162/162 differing groups; MAX vs FIRST differs by 0.21%). Keep the `uuid` dedupe — it covers a different phenomenon | The largest single correction. **Must precede `verify`**, or `verify`'s first output is "this tool is wrong" |
| 0.5 | **C6** — wire `checkSchema` into `collect()`, persist fingerprints, render in `diagnose`/`status` | Cheap, and it is the mechanism that would have caught all of this |
| 0.6 | **C7** — the `HIGH_THINKING` predicate | XS; depends on `thinking_tokens` from Phase 1, so it may slip to 1.x |
| 0.7 | **C9** — rewrite `mergeThresholds` as a `keyof`-mapped fold | Do it before adding detectors, not after |

> **C1's historical repair is an open decision, not a step** — see §9.5 Q1. The
> forward fix is unambiguous; what to do about the existing database is not.

### Phase 1 — foundation

[01](01-foundation.md) in full: the `switch (type)` refactor (with the golden
`ParseResult` comparison), migration V23, the drift instrumentation, and the
three registration points every new `packages/core` module needs.

The refactor is behaviour-identical **by intent**, which is exactly the kind of
change that needs a behaviour comparison rather than a code review. Four silent
traps are enumerated at [06 §6.4](06-friction.md); pin each with a fixture.

### Phase 2 — features, in value-per-effort order

| Order | Chapter | Effort | Rationale |
|---|---|---|---|
| 1 | **[08](08-session-titles.md) Session titles** | 2 d | Best value-per-effort. 95% coverage on interactive sessions, four surfaces that currently show a file path. **C11 must land in the same PR.** |
| 2 | **[06](06-friction.md) Friction, release 1** (parser + tables + privacy test) | 1.5 d | `friction_events` is zero-backfill, so **collection must start early or the metric is unbuildable for any past boundary**. Ships no user-visible feature |
| 3 | **[05](05-request-dimensions.md) Thinking share** (analytic b) | S–M | Depends only on one nullable column; closes a documented gap in [09-token-spending-analysis](../09-token-spending-analysis.md); makes C7 meaningful |
| 4 | **[03](03-cost-verification.md) Verify** | 8 d | The instrument that finds the next C1. Blocked on 0.4 |
| 5 | **[04](04-attribution-hardening.md) Attribution** | 5–6 d | `bridge` is the first non-CLI-surface account signal; `session_turns` unlocks human-vs-agent turn segmentation |
| 6 | **[07](07-compaction.md) Compaction** | 4–5 d | High correction value, but threads through the two most carefully-reasoned modules in the repo |
| 7 | **[06](06-friction.md) Friction, release 2** (detectors + constraint-impact) | 2 d | Needs a collection window behind it |
| 8 | **[05](05-request-dimensions.md) Effort + MCP-carry cards** | M + M | MCP carry attribution is the most novel item in §4.5, but wants the `verify`-corrected cost basis under it |
| 9 | **[02](02-pr-and-work-items.md) PR and work items** | 6–7 d | Highest effort, and **blocked on an org-plane decision** (§9.5 Q2) |

**Total ≈ 36–41 days** of feature work, plus ~3–4 days of Phase 0 and ~3 days of
Phase 1.

### Deliberately excluded

- **§4.3** (engaged time, lines-changed floors) — implemented separately.
- **§4.9** — all three exclusions stand and are not revisited: no reading
  `~/.claude/sessions/*.key`; no mining `attachment` entries; no replacing local
  parsing with the org-only Analytics API.
- **Fast-mode analytics** ([05 §5.6c](05-request-dimensions.md)) — zero
  observations, no pricing dimension, and a "limit impact" would require
  inventing a consumption model that does not exist. Only the 2-line
  `PolicyEvent.kind` addition ships.
- **`gh pr view` PR enrichment** ([02 §2.4 D3](02-pr-and-work-items.md)) — behind
  a default-off flag at most, pending Q3.

## 9.3 What the parent analysis got wrong

Recorded so [02](../schema-drift-2026-09/02-transcript-schema-changes.md) and
[03](../schema-drift-2026-09/03-new-sidecar-sources.md) can be corrected when
they are folded into [07-schema-reference](../07-schema-reference.md).

| Claim | Reality |
|---|---|
| The fingerprinter "already sees all of this" | It never runs (C6) |
| "the V22 pattern" = a JSON side-column | V22 is a **side table**; the JSON-column pattern is V10 |
| `packages/cli/src/paths.ts` centralises paths | The file is `packages/core/src/paths.ts` |
| `cost-state.startTime` is an ISO string | Epoch **milliseconds** int |
| `compactMetadata.messageCount` | **Does not exist.** The nearest is `preservedMessages.uuids.length` |
| Compaction is its own entry type | It is `type: "system"`, `subtype: "compact_boundary"` |
| Hook / fallback / refusal / retraction are four signals | **Two subtypes**: `stop_hook_summary` and `model_refusal_fallback` (the latter carries fallback, refusal *and* retraction) |
| Refusals are "folded into `unknown`" | They are **dropped entirely** — no refusal reaches `api_error_events` |
| `iterations` is an unconfirmed usage scalar | An **array of per-attempt usage records**; the top-level block copies the **last** element, never a sum |
| `[1m]` variants need premium pricing rows | Claude Code prices `claude-opus-5[1m]` at **base** rates (exact floor/ceiling hits). Normalise the suffix and flag it; **do not** add premium rows |
| `pr-link` gives session→PR, "one table, one join" | A **per-turn ambient stamp** — 7,926 entries for 460 facts (17.3×), no PR title, no branch, and 54% name a repo other than the session's |
| §4.1 is "most of the attribution work business-value-visibility planned" | That folder's own diagnosis is *"credibility and grain are largely solved; surface and cadence are the gap"*. This belongs to [ticket-attribution](../ticket-attribution/) |
| "Jira-only" ticket regex | `TICKET_KEY_RE` already matches **Linear** identically |

## 9.4 Cross-cutting budgets

### i18n

Ten locales. `npm run locales:check` enforces identical key sets, placeholders
and codicon tokens, **and rejects any value byte-identical to `en`** — so
copying the English string into all ten **fails the build**. Translations are
generated locally with `npm run locales:fill`; CI auto-fill was removed
2026-06-23.

| Chapter | New keys | × 10 locales |
|---|---|---|
| [02](02-pr-and-work-items.md) PR / work items | ~14 (+2 rewordings) | ~140 |
| [03](03-cost-verification.md) Verify | ~10 | ~100 |
| [04](04-attribution-hardening.md) Attribution | ~8 | ~80 |
| [05](05-request-dimensions.md) Request dimensions | ~13 | ~130 |
| [06](06-friction.md) Friction | ~13 | ~130 |
| [07](07-compaction.md) Compaction | ~12 | ~120 |
| [08](08-session-titles.md) Titles | ~6 | ~60 |
| **Total** | **~76** | **~760 strings** |

Two conventions worth restating because they are easy to get wrong:

- **Machine discriminants stay unlocalised** — `measures`, `verdict`, `kind`,
  `cause`, `titleSource`, enum *values* like `automode-blocked` or `cyber`.
  Consumers branch on them. Only labels are translated. Precedent:
  `CALIBRATION_MEASURES` (`cli/src/calibration/index.ts:157`).
- **Caveat strings are the ones that matter.** `effort.caveat`,
  `mcp.attributionCaveat`, `thinking.notMeasured`,
  `autoCompactFit.manualOnlyWarning` are the difference between a correct feature
  and a misleading one. They must be translated, not left English-only.

Two collisions to plan around: `cli:account.sourceBridge` and
`dashboard:attribution.bridge` both want the literal word "Bridge" in several
locales ([04 §4.11](04-attribution-hardening.md)); and detector prose
deliberately stays English source text per `hygiene/types.ts:13-18`
([06 §6.11](06-friction.md)).

**A pre-existing gap, not created here:** the Spending tab's headings and table
columns are hardcoded English literals (`server/template.ts:1585-1700`), unlike
the Efficiency tab. A new translated card sitting among untranslated neighbours
looks like a bug in the nine non-English locales — Q6.

### Testing

Conventions: all tests under `packages/cli/src/__tests__/**/*.test.ts`
(`vitest.config.ts:64-67`); `packages/core` has none — core modules are tested
through path aliases. Parser tests write **inline JSONL to a temp file**; there
are no fixture files for this. `fast-check` is already used in ≥8 suites.

Six tests are load-bearing across chapters:

1. **Golden `ParseResult` comparison** across the `switch` refactor — the only
   thing protecting `allTimestamps` / `activeDurationMs` from an accidental
   reorder.
2. **Split-parse invariant** (fast-check): `parse(0..n) ≡ parse(0..k) ⊕
   parse(k..n)` at any line boundary, for every `ParseResult` channel. The whole
   checkpoint design rests on this and it is **currently untested**.
3. **Replay invariance** (fast-check): inserting arbitrary duplicate-uuid copies
   changes no count. **This property alone would have caught C1, C2 and C3.**
4. **The privacy sentinel test** ([06 §6.12](06-friction.md) #7): a fixture whose
   dropped fields all contain a distinctive sentinel; assert it appears in zero
   columns of every table.
5. **The compile-time pack negative test** ([08 §8.9](08-session-titles.md) #9):
   a `@ts-expect-error` asserting `HasNoForbiddenPackFields<{aiTitle: string}>`
   does not compile. Without it, C11's fix is decorative.
6. **Behaviour comparison for every changed number** — `simulateSlice`'s dollar
   figures, `HIGH_THINKING`'s flag count, the `message.id` token totals. Design
   default 14: behaviour comparisons over code comparisons.

### New `packages/core` modules

Each needs **three** registrations, not one: a `packages/core/package.json`
`exports` entry, a `vitest.config.ts` alias (subpath aliases must precede any
bare alias that is a prefix of them — see the comments at
`vitest.config.ts:47-62`), and usually a re-export from
`packages/core/src/index.ts`.

This analysis proposes four: `verify.ts`, `sessionTitle.ts`, `repoSlug.ts`, and
`measuredResets` (which extends the existing `hygiene/util.ts` rather than adding
a module).

### Schema

**One additive migration, V23**, with no migration-time backfill (the V20
precedent; V18's docstring records the ~0.7 GB re-parse that stalled the
collector). `claude-stats backfill` is the opt-in recovery, and its ceiling is
transcripts still on disk — **936 of 1168 sessions have none**, and the archive
mirror is not wired into `collect`, so there is nothing archived to re-parse.

`message_hourly` does not change in V23 ([01 §1.6](01-foundation.md)).

**Sidecar ingestion is a separate V24** — `stats-cache.json` needs a content-hash
checkpoint, not a byte offset, and its own provenance columns.

## 9.5 Open decisions

These need the maintainer, not the implementer. Each blocks specific work.

**Q1 — How is C1's historical over-report repaired?** *(blocks: `verify`
publishing a trust budget over existing history)*
`messages` has no `message_id` column, so retroactive dedupe is impossible
without transcripts, and 936/1168 sessions have none. Options: (a) add
`message_id`, re-parse what survives, flag the rest with a `cost_basis` marker;
(b) store a per-session `inflation_factor` estimated from surviving sessions;
(c) accept and disclose. **Recommendation: (a) + (c)** — repair what is
repairable, mark the rest, and never silently apply an estimated correction
factor to a number the tool presents as measured.

**Q2 — Do PR keys and repo slugs enter the justification pack or any sync
shape?** *(blocks: all of [02](02-pr-and-work-items.md))*
A repo slug is at least as disclosive as a Jira project prefix, and a
repo-qualified key would sail past `HasNoForbiddenPackFields`, which checks field
*names*. Either keep PR keys strictly local, or build an alias/hash mapping
first. **Recommendation: strictly local for v1**, matching `ticket_links.evidence`.

**Q3 — Ship `gh pr view` PR enrichment at all?** *(blocks: PR→ticket for
non-GitHub-native shops)*
It conflicts in spirit with the "no ticket-system API, deterministic and
auditable" non-goal in [ticket-attribution](../ticket-attribution/), even though
the API is GitHub's. **Recommendation: no for v1** — the offline merge-commit
bridge (D2) covers the common case deterministically.

**Q4 — Is a permanently three-grade prompt count acceptable in the UI?**
*(blocks: [04 §4.6](04-attribution-hardening.md)'s surfacing)*
Cohort A (~936 sessions, no transcript) can never gain `promptId` and is stuck on
a 68%-accurate proxy. Report it as graded, or as "unknown"? **A product call.**

**Q5 — How is C8 communicated?** *(blocks: [07](07-compaction.md) shipping)*
If `autoCompactFit` has been recommending `autoCompactWindow` to users whose
compactions are all manual, that is a correction to shipped *advice*, not a
feature. It needs a CHANGELOG entry and an in-product note, not a silent
behaviour change. **Also note `trigger: "auto"` was never observed** — the
`autoOnly` filter should not ship until a second corpus or a deliberate
auto-compact run confirms the value domain.

**Q6 — i18n the Spending tab as part of this work, or track it separately?**
*(blocks: nothing; affects [05](05-request-dimensions.md)'s card)*
**Recommendation: separately**, and i18n the new card properly regardless.

**Q7 — Should `list_sessions` return titles by default, or behind
`includeTitles`?** *(blocks: [08](08-session-titles.md)'s MCP surface)*
The existing precedent (`CostPerTaskOptions.includeTasks`, set by the VS Code
webview and deliberately not by the MCP server or LAN `serve`) says the read-only
MCP path stays prompt-text-free. **Recommendation: default off, opt in.**

**Q8 — Resolve the `"title"` field-name collision** before extending
`ForbiddenPersonalField`. `PackHygieneDetectorRow` carries a detector title.
**Recommendation: rename it to `detectorTitleKey`** — it should be an i18n key,
not English prose, which fixes an existing defect at the same time.

## 9.6 Standing UNVERIFIED items

Everything here rests on **one operator, one machine, and a corpus whose oldest
transcripts are weeks old** — 224 surviving session files against 413,985
messages in the store. Distributions are existence proofs of shape, not
population estimates.

| Item | Chapter | Why it matters |
|---|---|---|
| Are non-final-attempt (`iterations`) tokens billed? 9.52M cache-read + 338K cache-creation sit outside the top-level block | [05](05-request-dimensions.md) | Decides whether `message_attempts` is a correctness fix or a diagnostic |
| Does `ownerAccountUuid` equal the billed account? | [04](04-attribution-hardening.md) | Separates `high` from `authoritative` for the bridge rank |
| Does `trigger: "auto"` exist? 903/903 are `"manual"` | [07](07-compaction.md) | Gates the `autoOnly` filter and Q5 |
| Do `low` / `medium` effort levels exist? Never observed at 100% coverage | [05](05-request-dimensions.md) | Decides whether `'default_effort_down'` has anywhere to point |
| Is fast mode billed at a different rate? | [05](05-request-dimensions.md) | Without it the fast-mode story is "fewer tokens, same rate" |
| Does the compaction call itself appear as a billable assistant message? | [07](07-compaction.md) | Decides whether compaction's own cost is attributable |
| Does `cost-state.totalCostUSD` include subagent sessions? One −15% outlier suggests not | [03](03-cost-verification.md) | Affects Layer C interpretation |
| Why is `stats-cache.json` nine weeks stale? | [03](03-cost-verification.md) | Decides whether V24 is worth building now |
| What is `pr-link`'s emission trigger — PR creation, or an ambient stamp? | [02](02-pr-and-work-items.md) | Affects the run-collapse rule |
| Does a title entry's `sessionId` ever differ from its file's? | [08](08-session-titles.md) | Handled defensively regardless |
| **Do `turn_duration` (519) and `away_summary` (182) belong to the engaged-time story?** Both unparsed, both far more frequent than anything in [06](06-friction.md)'s scope | [06](06-friction.md) | **Likely relevant to the separately-tracked §4.3 work** |
| The two model-fallback sources disagree: 29 events in `usage.iterations` vs 10 system-entry records | [05](05-request-dimensions.md), [06](06-friction.md) | Reconcile before either is presented as *the* fallback count |
