# 03 — Cost Verification and the Trust Budget

Implements [§4.2](../schema-drift-2026-09/04-feature-opportunities.md).

## 3.0 The finding that reorders everything

Designing this feature *found a live defect with it, during the design phase*.
That is the strongest possible argument for building it, and it is also the
reason `verify` cannot ship first.

> **claude-stats over-reports token volume and cost because it sums `usage` once
> per assistant *transcript entry* instead of once per *API response*.**

Claude Code emits one transcript entry per content block. Every entry belonging
to one response carries a **distinct envelope `uuid`** but the **same
`message.id` and the same `usage` block**. The dedupe at
`packages/core/src/parser/session.ts:291-307` is keyed on `entry.uuid`, which
does not collapse these, and `messages` uses `uuid` as its PRIMARY KEY
(`store/index.ts:168-179`) — so every block is stored and summed.

The comment at `session.ts:296` states exactly the right billing semantics
("one API call was charged once") and picks the wrong identifier.

### Evidence

Two independent measurements, different samples, same conclusion.

**Sub-agent measurement**, 80-file sample:

| Check | Result |
|---|---|
| Assistant entries | 117,346, of which **76.3% repeat an already-seen `message.id`** (75.1% token-weighted); **0** entries lacked a `message.id` |
| Our cost vs `cost-state.totalCostUSD`, 5 sessions | **$124.25 vs $60.52 = 2.05×** (per-session 1.65×–2.34×) |
| Raw vs `message.id`-deduped output tokens, one session | 46,404 → **26,876**; `cost-state` says **26,876** — exact match on all four token classes |
| Deduped vs `cost-state`, other 4 sessions | within **0.3%–5%** (one −15% outlier: a session with subagents in a separate transcript) |

**Independent re-check**, 12 most recent files, 2,213 assistant entries:

| Check | Result |
|---|---|
| Entries repeating a `message.id` | **71.0%**; 0 entries lacked one |
| Repeats carrying an **identical** usage total | 1,408 of 1,571 (90%) |
| Raw token sum ÷ `message.id`-deduped sum | **3.52×** |
| Distinct `message.id` groups | 648, of which **382 have all-distinct envelope uuids** |

That last row is the decisive one: **the existing uuid dedupe cannot catch these
— 59% of multi-entry groups carry no repeated uuid at all.** They are separate
`messages` rows in the database today.

### Which copy to keep

Within a group whose entries differ, the **last is always ≥ the first**: 162
groups where last > first, **0** the other way. That is consistent with
streaming, where the final entry carries the complete usage. Taking `MAX` rather
than `FIRST` changes the total by **0.21%** — small, but free and unambiguously
correct.

**Rule: dedupe assistant usage on `message.id`, keeping the maximum usage in the
group.** Keep the existing `uuid` dedupe as well — it addresses a different
phenomenon (compaction/resume replay of the same envelope) and is still
necessary.

### Consequences

- **Sequence the fix before `verify`.** Shipping `verify` first hands users a
  tool whose first output is "this tool is wrong" — correct, but a bad
  introduction. Ship the dedupe fix first, or both together.
- **The historical repair is an open product question** (§3.9 Q1): `messages` has
  no `message_id` column, so retroactive dedupe is impossible without
  transcripts, and 936 of 1168 sessions no longer have one
  (`store/index.ts:580`).
- Every dollar-producing surface in §3.2 is affected.

## 3.1 Ground truth, as it actually exists

All [live], 2026-09-01, read-only, redacted to shapes.

### `cost-state` — field list confirmed, with corrections

Found in **5 of 927** transcript files; **7 entries** total. All 5 files were
modified on or after 2026-08-26; of the **47** files touched in the last week,
**5 (≈11%)** carry one. Nothing older has one.

Envelope keys (7/7, no others): `type, sessionId, totalCostUSD,
totalAPIDuration, totalAPIDurationWithoutRetries, totalToolDuration,
totalLinesAdded, totalLinesRemoved, totalDuration, startTime, modelUsage,
hasUnknownModelCost`.

`modelUsage[model]` keys (17/17 rows, no others): `inputTokens, outputTokens,
cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD`.

Corrections to
[02 §2.1](../schema-drift-2026-09/02-transcript-schema-changes.md):

- **`startTime` is epoch-milliseconds `int`, not an ISO string.** So are
  `totalDuration` and the three duration fields.
- **There is no `uuid`, no `timestamp`, no `cwd`, no `version`, no
  `parentUuid`.** Unlike `api_error_events` (V22) there is **no idempotency
  key** — `session_id` PK plus last-write-wins is forced, not merely convenient.
- **Emitted at session end**, as the last or near-last line — and **twice in 2 of
  5 files**, the pair differing only in `totalDuration` (by 12 ms and 37 ms). A
  shutdown double-write. The PK absorbs it; **take the row with the larger
  `total_duration_ms`** — a blind `INSERT OR IGNORE` keeps the shorter.
- `totalCostUSD == Σ modelUsage[*].costUSD` **exactly, 7/7**. A free
  internal-consistency assertion.
- `hasUnknownModelCost` was `false` on all 7; no `costUSD: 0` row observed here.
- Model ids seen: `claude-fable-5`, `claude-opus-5`, `claude-opus-5[1m]`,
  `claude-haiku-4-5-20251001`.
- **`claude-haiku-4-5-*` appears in every `cost-state` entry but in *none* of the
  corresponding transcripts** — sub-cent amounts ($0.001–$0.47), presumably
  harness-side calls never written to the transcript. **Our per-session model set
  is structurally incomplete on the low tier.**

### `~/.claude/stats-cache.json` — two surprises

23,470 bytes. Shape matches
[03 §3.1](../schema-drift-2026-09/03-new-sidecar-sources.md) exactly — no
undocumented keys. `version = 4`.

1. **It is stale by nine weeks.** `lastComputedDate = 2026-06-28`, file mtime
   2026-06-29, and Claude Code has been used daily since. The writer was
   removed, gated, or silently stopped. **A `verify` that assumes freshness would
   report catastrophic false divergence.** Freshness is a *precondition*, not a
   caveat.
2. **`costUSD` is `0` for all five models**, as are `contextWindow` and
   `maxOutputTokens`. On this machine the sidecar supplies **no cost ground truth
   at all** — only token counts. The "treat 0 as unknown" caveat is not an edge
   case; it is the whole file.
3. `dailyModelTokens` spans 2026-02-27 → 2026-06-28 (76 rows); `dailyActivity`
   spans 2026-03-11 → 2026-06-28 (65 rows). **Different date domains** — they
   need an outer join, and `dailyModelTokens` reaches ~2 weeks further back. The
   pruned-history backfill value is real, but **for tokens only**.
4. `hourCounts` had 20 of 24 keys — a sparse object with string keys.
5. `dailyActivity.sessionCount` sums to exactly `totalSessions` (466) and
   `messageCount` to exactly `totalMessages` (259,824). Two more free
   assertions.
6. **No per-account dimension anywhere** — see §3.7.

### Repricing ground truth: our rate table is mostly right

Repricing `cost-state`'s **own** `modelUsage` tokens with `DEFAULT_PRICING` —
immune to the `message.id` bug, because it never touches `messages`:

| model | our 5m floor | `cost-state` | our 1h ceiling | verdict |
|---|---|---|---|---|
| `claude-fable-5` | 13.6061 | **15.7276** | 15.7276 | **exact hit on the 1h ceiling** |
| `claude-opus-5` | 14.5211 | 15.9822 | 16.5716 | inside the bracket (mixed TTL) |
| `claude-opus-5[1m]` | 54.3898 | 57.7682 | 58.1998 | inside; rows hit floor (0.00) and ceiling (1.00) **exactly** |
| `claude-haiku-4-5-*` | 0.4033 | 0.4812 | 0.4623 | **above the ceiling by exactly $0.0700** |

Three actionable conclusions:

- **Our rate rows for fable-5, opus-5 and haiku-4-5 are correct** — several land
  on the floor or ceiling to four decimal places.
- **The haiku excess is web search: $0.0700 = 7 × $0.01**, and that row is the
  only one with `webSearchRequests: 7`. **`estimateCost` has no web-search term
  at all** — yet `messages.web_search_requests` is stored
  (`store/index.ts:160`) and rolled up (`:838`). A priced term is missing on data
  we already have; on that row it is 15% of cost.
- **`claude-opus-5[1m]` prices at BASE opus-5 rates in Claude Code's own
  accounting** (exact floor/ceiling hits). This **contradicts
  [01-immediate-fixes §2](../schema-drift-2026-09/01-immediate-fixes.md)**:
  adding premium `[1m]` rows would make us *wrong*. The fix is **normalise the
  suffix away and record it as a flag**, not price it up. Separately:
  `message.model` in assistant entries never carries `[1m]` — our `messages`
  rows say `claude-opus-5` for those same sessions — so the prefix-match bug is
  **unreachable today** and becomes reachable **the moment `cost-state` is
  ingested**. It is a V23 blocker, not a live defect.

## 3.2 Current cost pipeline

**Parse.** `session.ts:330-364` reads `entry.message.usage` per assistant entry;
dedupes on `entry.uuid` at `:291-307` (the wrong key, §3.0); accumulates the six
token counters; per-message record at `:449`, session totals at `:502`.

**Store.** `messages` (`store/index.ts:168-179`, PK `uuid`) plus later columns
`ephemeral_5m_cache_tokens`, `ephemeral_1h_cache_tokens`, `web_search_requests`,
`account_uuid`. `sessions` rollup recomputed from `messages` (`:838`).

**Price.** `packages/core/src/pricing.ts` — table `DEFAULT_PRICING:47-68`
(sonnet-5 intro row `:59-61`, **expired**), live `PRICING:74`,
`PRICING_VERIFIED_DATE:77`; `withTtlRates:89-124`, `isCoherentPricing:139-153`,
`applyPricingCache:159-181`; `normalizeModelId:225-248` (Bedrock region/version,
Vertex `@date` — **no `[1m]` handling**), `modelTier:259-266`;
`resolvePricing:317-337` longest-prefix `startsWith`; `estimateCost:387-451`
(unknown → `{cost:0, known:false}` at `:401-408`; TTL rules at `:420-450`; **no
web-search term**); `PLAN_FEES:458-466`. Fetch/refresh in
`packages/cli/src/pricing-cache.ts` (`PRICING_URL:15`, 7-day `CACHE_TTL_MS:17`,
`parsePricingTable:136`).

**Every non-test `estimateCost` call site:**

| `file:line` | produces |
|---|---|
| `cli/src/aggregator/index.ts:451` | `UsageWindow.totalCostEquivalent` |
| `cli/src/store/index.ts:1757` | in-store window recompute (duplicated logic) |
| `cli/src/store/index.ts:4066` | per-session/period cost read |
| `cli/src/reporter/index.ts:541, 737, 758, 810, 1143` | CLI report totals, per-model, per-project, trend |
| `cli/src/spending.ts:53, 202` | `spending` command |
| `cli/src/recap/index.ts:1047` | daily recap |
| `cli/src/alerts.ts:35` | alert thresholds |
| `cli/src/hygiene/index.ts:111`, `core/src/hygiene/util.ts:54`, `core/src/hygiene/cacheChurn.ts:47` | hygiene waste dollars |
| `cli/src/ticketing/index.ts:302` | per-ticket cost |
| `cli/src/org/aggregate.ts:168, 306` | org-plane aggregates |
| `cli/src/mcp/index.ts:380` | `get_session_detail.estimatedCost` |

Derived surfaces: dashboard `planUtilization` (`dashboard/index.ts:235-249`) and
the pack headline `buildPackHeadline` (`core/src/pack.ts:137-200`).

**Every one of these is inflated by the `message.id` factor.**

## 3.3 `verify` is a third mechanism, not an extension

The most important scoping question, answered definitively: **neither
`reconciliation.ts` nor `calibration.ts` can host this.**

**`reconciliation.ts` reconciles a bottom-up total against a *user-supplied
invoice*** (`core/src/reconciliation.ts:36-56`, wired at
`cli/src/pack/index.ts:232-243`). Three blockers:

1. **Metered-only by design.** `core/src/pack.ts:144-158` gates it on
   `mode === "metered"` with an explicit argument that comparing a plan account's
   equivalent-API-value against invoice dollars is a category error. §4.2's whole
   audience is Pro/Max plan users. `verify` compares equivalent-API-value against
   **Anthropic's own equivalent-API-value** — the same unit — so it is valid
   exactly where reconciliation is forbidden.
2. **Wrong grain.** One scalar `bottomUp` for one period. `verify` operates per
   session × model, which is what isolates a bad rate row from a bad parse.
3. **Requires manual external input.** `verify` requires nothing.

**`calibration.ts` calibrates *confidence labels* against *the user's explicit
corrections*** (`core/src/calibration.ts:305-338`). Its subject union is closed
(`"attribution" | "outcome"`, `:88`) with the stated rule that each member needs
its own ground truth and its own honest reading of "agreement". Cost
verification fails that twice: the ground truth is a machine-published number,
not a human ruling, and the output is a *signed relative error*, not a binomial
proportion — `wilsonInterval` and `MIN_CALIBRATION_N = 30` are meaningless on it.
Adding `"cost"` would break the module's own contract and put a dollar residual
behind a caveat written for correction bias.

**Verdict: a new pure `packages/core/src/verify.ts` plus a
`packages/cli/src/verify/` shell**, following the identical core/CLI split.

**Reuse, verbatim:** `computeReconciliation`'s result *shape*
(`{bottomUp, invoiceTotal, ratio, withinTolerance, residual, residualRatio,
candidateCauses, scopeNote}`) and its `BAND_EDGE_EPSILON` currency-space band
comparison (`:99`), which solves a real float-edge bug; extend
`ReconciliationCause` rather than inventing a parallel vocabulary. And
`calibration.ts`'s *discipline*: a machine-token `measures` field, a
null-when-insufficient state, scope travelling with the figure, and
non-localised discriminants (`cli/src/calibration/index.ts:157-183`).

## 3.4 Design: four layers

A single end-to-end comparison is useless — it conflates parse error with
pricing error, and here the two point in **opposite directions** (our tokens are
2–3.5× too high; our per-token rates are ~5% too *low*). Verify must decompose.

| Layer | Question | Inputs | Immune to |
|---|---|---|---|
| **A — coverage** | do our tokens match theirs? | `messages` ⋈ `session_cost_state_model` | pricing errors entirely |
| **B — pricing** | does our rate table reprice *their* tokens to *their* dollars? | `session_cost_state_model` only, **no join to `messages`** | parse/coverage errors entirely |
| **C — end-to-end** | does our dollar figure match theirs? | our cost vs `totalCostUSD` | nothing — diagnostic only, report A and B first |
| **D — sidecar daily** | do our daily per-model tokens match the sidecar? | `messages` ⋈ `stats_cache_daily_model_tokens` | pricing; reaches pre-archive history |

Layer B is the **pricing-drift detector**; Layer A is the
**collector-correctness detector**. Reporting C without A and B is what makes
divergence uninterpretable — and is exactly how the `message.id` bug hid.

### Tolerance is an interval, not a percentage

Our estimate is not a point. Where the TTL split is unknown, `estimateCost`
prices all cache creation at the 5-minute rate (`pricing.ts:420-428`) — a
**floor**; all-1h is a **ceiling**:

```
floor   = base + unattributed_writes × cacheWritePerMillion   + attributed_split + web
ceiling = base + unattributed_writes × cacheWrite1hPerMillion + attributed_split + web
```

`consistent` iff `theirs ∈ [floor·(1−ε), ceiling·(1+ε)]`, `ε = 1e-9` (reuse
`BAND_EDGE_EPSILON`). This is derived from a *known unmodelled degree of
freedom*, not from taste — and the live data confirms it: rows land exactly on
the floor (0.00) or exactly on the ceiling (1.00). Where `ephemeral_5m/1h` cover
the whole write volume, the bracket collapses to a point and a tight ±0.5% band
applies.

Layer A uses a plain relative band, default **±1%**, per token class — token
counts have no legitimate ambiguity. Layer D uses ±2% for day-boundary slop.
`config.verify.tolerancePercent` mirrors `config.reconciliation.tolerancePercent`
and clamps identically.

### Result interface

```ts
// packages/core/src/verify.ts — pure, no I/O, no clock.

export type VerifyLayer = "coverage" | "pricing" | "endToEnd" | "sidecarDaily";

export type VerifyVerdict =
  | "consistent"        // inside the band / bracket
  | "divergent"         // outside; sign carried in residualRatio
  | "unpriced"          // their costUSD === 0 → UNKNOWN, never compared
  | "no-ground-truth";  // no cost-state / stale sidecar for this unit

/** Non-localised discriminant, mirroring CALIBRATION_MEASURES. */
export const VERIFY_MEASURES = "divergence-vs-claude-code-published" as const;

export interface CostBracket {
  readonly floor: number;    // all unattributed cache writes at the 5-minute rate
  readonly ceiling: number;  // …at the 1-hour rate
  readonly point: number;    // the figure our surfaces publish today (== floor)
  readonly unattributedWriteTokens: number;  // the bracket's width driver
}

export interface TokenDelta {
  readonly ours: number;
  readonly theirs: number;
  readonly ratio: number | null;   // null when theirs === 0
  readonly withinTolerance: boolean;
}

export interface ModelVerification {
  readonly sessionId: string;
  readonly model: string;            // canonical, after normalizeModelId
  readonly longContextTier: boolean; // the ground-truth id carried `[1m]`
  readonly verdict: VerifyVerdict;
  readonly tokens: {
    readonly input: TokenDelta; readonly output: TokenDelta;
    readonly cacheRead: TokenDelta; readonly cacheCreation: TokenDelta;
    readonly webSearchRequests: TokenDelta;
  };
  readonly repriced: CostBracket;    // Layer B: OUR rates on THEIR tokens
  readonly theirCost: number;        // 0 means UNKNOWN — see verdict "unpriced"
  readonly residual: number;
  readonly residualRatio: number;
  readonly rateBasis: RateBasis;
  readonly pricingKnown: boolean;
}

export interface SessionVerification {
  readonly sessionId: string;
  readonly startTime: number;        // epoch ms
  readonly hasUnknownModelCost: boolean;
  readonly selfConsistent: boolean;  // totalCostUSD === Σ modelUsage.costUSD
  readonly models: readonly ModelVerification[];
  readonly ourCost: CostBracket;     // Layer C
  readonly theirTotalCost: number;
  readonly verdict: VerifyVerdict;
  readonly residualRatio: number;
  /** In cost-state but with no `messages` rows at all (observed: haiku). */
  readonly modelsMissingLocally: readonly string[];
}

export interface PricingDriftFinding {
  readonly model: string;
  readonly kind:
    | "rate-row-understates"     // ground truth above our ceiling
    | "rate-row-overstates"      // ground truth below our floor
    | "expired-effective-date"
    | "unknown-model"            // known:false with real volume
    | "tier-suffix-unmodelled"   // `[1m]` etc. reached the prefix matcher
    | "synthetic-model"
    | "missing-cost-term";       // e.g. webSearchRequests unpriced
  readonly observedRatio: number | null;
  readonly evidenceSessions: number;
  readonly evidenceDollars: number;
  readonly detail: string;       // non-localised; the CLI renders prose from it
}

export type VerifyCause =
  | ReconciliationCause          // unpriced-usage | fallback-rates | scope-mismatch | unexplained
  | "duplicate-message-accounting"
  | "missing-local-model"
  | "ttl-split-unattributed"
  | "unpriced-web-search"
  | "tier-suffix"
  | "pruned-transcript"
  | "stale-sidecar";

export interface VerifyReport {
  readonly measures: typeof VERIFY_MEASURES;
  readonly scope: { readonly since: number; readonly until: number;
                    readonly accountUuid: string | null; readonly projectPath: string | null };
  readonly tolerancePercent: number;
  readonly groundTruth: {
    readonly costStateSessions: number;
    readonly totalSessionsInScope: number;   // the denominator — expect a tiny ratio
    readonly sidecar: {
      readonly present: boolean;
      readonly version: number | null;
      readonly lastComputedDate: string | null;
      readonly stalenessDays: number | null;
      readonly costsAllZero: boolean;
    };
  };
  readonly sessions: readonly SessionVerification[];
  readonly daily: readonly DailyVerification[];
  readonly pricingDrift: readonly PricingDriftFinding[];
  readonly trust: CostTrustBudget;
  readonly causes: readonly VerifyCause[];
}
```

### Queries

**Layer A / C — our side, per session × model:**

```sql
SELECT m.session_id, m.model,
       SUM(m.input_tokens)              AS input_tokens,
       SUM(m.output_tokens)             AS output_tokens,
       SUM(m.cache_read_tokens)         AS cache_read_tokens,
       SUM(m.cache_creation_tokens)     AS cache_creation_tokens,
       SUM(m.ephemeral_5m_cache_tokens) AS e5,
       SUM(m.ephemeral_1h_cache_tokens) AS e1,
       SUM(m.web_search_requests)       AS web_search_requests,
       COUNT(*)                         AS message_rows
  FROM messages m
 WHERE m.session_id IN (SELECT session_id FROM session_cost_state)
 GROUP BY m.session_id, m.model;
```

Joined **in TypeScript, not SQL** — the join key needs `normalizeModelId` on the
ground-truth side (`claude-opus-5[1m]` → `claude-opus-5`), which SQLite cannot
do.

**Layer B — pricing only, deliberately no `messages` join:**

```sql
SELECT csm.model, csm.input_tokens, csm.output_tokens,
       csm.cache_read_tokens, csm.cache_creation_tokens,
       csm.web_search_requests, csm.cost_usd, cs.session_id, cs.start_time
  FROM session_cost_state_model csm
  JOIN session_cost_state cs USING (session_id)
 WHERE csm.cost_usd > 0            -- 0 means UNKNOWN, never free
   AND cs.start_time BETWEEN ? AND ?;
```

**Session self-consistency — free assertion, no join.** Any row returned means
*our ingester* is broken, not Claude Code (held 7/7 live):

```sql
SELECT cs.session_id, cs.total_cost_usd, SUM(csm.cost_usd) AS model_sum
  FROM session_cost_state cs JOIN session_cost_state_model csm USING (session_id)
 GROUP BY cs.session_id
HAVING ABS(cs.total_cost_usd - model_sum) > 1e-6;
```

## 3.5 Storage

```sql
-- V23
CREATE TABLE IF NOT EXISTS session_cost_state (
  session_id                       TEXT PRIMARY KEY,   -- no FK, per 01 §1.4
  total_cost_usd                   REAL NOT NULL,
  total_api_duration_ms            INTEGER,
  total_api_duration_no_retries_ms INTEGER,
  total_tool_duration_ms           INTEGER,
  total_duration_ms                INTEGER,
  total_lines_added                INTEGER,
  total_lines_removed              INTEGER,
  start_time                       INTEGER,            -- epoch ms, NOT ISO
  has_unknown_model_cost           INTEGER NOT NULL DEFAULT 0,
  observed_at                      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_cost_state_model (
  session_id            TEXT NOT NULL,
  model                 TEXT NOT NULL,   -- RAW id, `[1m]` preserved
  model_canonical       TEXT NOT NULL,   -- normalizeModelId() output
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  web_search_requests   INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL NOT NULL,   -- 0 == UNKNOWN
  PRIMARY KEY (session_id, model)
);
```

- **Store the raw `model` and the canonical separately.** Collapsing at ingest
  destroys the only evidence that a `[1m]` tier was served.
- **Upsert `DO UPDATE`** on the shutdown double-write, keeping the larger
  `total_duration_ms`.
- Fix the latent `api_error_events` FK bug (`store/index.ts:775`) in the same
  migration — an empty `session_id` there aborts the whole-file transaction
  ([01 §1.4](01-foundation.md)).

**V24 — the sidecar**, exactly as scoped in [01 §1.10](01-foundation.md):
separate migration, own `source` / `imported_at`, a **content-hash checkpoint**
(SHA-256 of the file) in a `sidecar_state` table. It cannot reuse
`collection_state`, whose model is `(file_size, last_offset, last_mtime,
first_kb_hash)`. Add `last_computed_date` to the checkpoint so re-importing an
unchanged-but-stale file is both a no-op *and* a staleness signal.

**Paths.** Add `statsCacheFile` to `packages/core/src/paths.ts:10-55` (the single
declaration site) and one assertion in
`packages/cli/src/__tests__/paths.test.ts:7-18` — which currently omits
`changelogFile`, `sessionsDir`, `configFile`, and `claudeConfigFile`, worth
completing while there.

## 3.6 Pricing-drift detection

### The check that would have caught the expired Sonnet-5 row

Layer B, per model, over the trailing N days: reprice ground truth's own tokens
with our table. If `theirCost > ceiling` by more than ε across ≥2 sessions →
`rate-row-understates`, with `observedRatio = theirCost / ceiling` as the implied
multiplier. `2/3 → 1.5×` — exactly the 33% under-report
[01-immediate-fixes §1](../schema-drift-2026-09/01-immediate-fixes.md) predicts,
reported as a finding naming `claude-sonnet-5`.

It needs no invoice, no config, no user action, and no per-token attribution —
only a session in which the model was used. The live data proves the
sensitivity: several models sit on the bracket edge to **four decimal places**,
so a wrong rate row cannot hide inside the bracket.

### The cheaper, complementary check: declared expiry

The Sonnet-5 row encodes its expiry **in a code comment**
(`pricing.ts:59-61`), which nothing can read. Add to `ModelPricing`:

```ts
/** ISO date after which this row is known to be wrong. Null = no known expiry. */
effectiveUntil?: string | null;
```

plus a pure `pricingRowsExpiringBy(today): PricingDriftFinding[]` returning
`kind: "expired-effective-date"`. `verify` reports it; `collect` and `status`
warn.

**This is the true day-one catch.** Layer B needs a session on the affected model
*after* the expiry; `effectiveUntil` fires the moment the clock passes, on any
machine, with no usage at all. Ship both — they cover different failure shapes: a
*scheduled* change versus an *unannounced* one.

### `[1m]`, `<synthetic>`, and web search

**`[1m]`** — fix in `normalizeModelId:225-248`, not the table:

```ts
const TIER_SUFFIX = /\[(\d+m)\]$/;   // `[1m]`, and whatever comes next
```

Strip it into `NormalizedModel.contextTier: string | null`, so
`claude-opus-5[1m]` resolves the base row *deliberately* rather than by accident,
and the suffix survives into `session_cost_state_model.model` and into a
`tier-suffix-unmodelled` finding. **Do not add premium rows** — live evidence
says base rates are currently correct. But flagging every `[1m]` row means that
the day a premium *does* appear, Layer B reports `rate-row-understates` instead
of confidently under-billing. Add a fast-check property: for all ids,
`resolvePricing(id).canonical` never contains `[`.

**`<synthetic>`** — an explicit early return in `estimateCost` / `resolvePricing`
giving `{cost: 0, known: true, synthetic: true}`. `known: true` because zero *is*
the right answer; leaving it in the unknown bucket pollutes `unknownTokens`,
which `buildPackHeadline:130-134` feeds into `computeReconciliation`'s
`unpriced-usage` cause. Exclude from model-distribution stats and from `verify`'s
per-model layer.

**Web search** — `estimateCost` needs a `webSearchRequests` parameter at
**$0.01/request** (confirmed to the cent, §3.1). All call sites in §3.2 must pass
it; the column already exists everywhere (`messages`, `sessions`,
`sync-merge/merge.ts:72`). Until then `verify` reports `missing-cost-term` on
every row with `webSearchRequests > 0` — honest, but not a substitute for the
fix. **UNVERIFIED:** `web_fetch_requests` is also stored and may carry its own
rate; no ground-truth row in this sample had one.

**Fetch-path drift.** `parsePricingTable` (`pricing-cache.ts:136`) heuristically
scrapes HTML columns, guarded only by `isCoherentPricing` (`pricing.ts:139-153`).
Layer B is an *empirical* second guard and should run after
`refreshPricingCache` succeeds — a scrape that moves a rate outside the observed
bracket becomes a `rate-row-*` finding rather than a silent adoption.

## 3.7 Multi-account

`sessions.account_uuid` is assigned by the precedence chain in
[04 §4.1](04-attribution-hardening.md); `messages.account_uuid` is denormalised
per row; MCP tools scope via `resolveAccountFilter` (`mcp/index.ts:1188`).

- **`cost-state` is per-session, so it inherits the session's attributed account
  for free.** Layers A/B/C are account-scopable and account-safe. The
  `account_uuid` is not in the entry; join through `sessions`.
- **`stats-cache.json` has no account dimension at all.** It is scoped to the
  *config dir*, so on a machine where two accounts share `~/.claude` it is a
  **merged** aggregate. **Layer D must not run under an account filter** —
  comparing a per-account subset of `messages` against a merged sidecar
  manufactures a divergence equal to the other account's entire volume. Enforce
  in code: `verify --account <uuid>` **skips Layer D** and says so
  (`VerifyCause: "scope-mismatch"`), rather than silently producing a wrong
  number.
- The `bridge-session.ownerAccountUuid` signal
  ([04](04-attribution-hardening.md)) would let a `cost-state` entry be
  account-attributed independently — sequence 4.4 before any team-plane use of
  `verify`.
- `CLAUDE_CONFIG_DIR` is not consulted by `paths.ts` at all; the sidecar path
  inherits that limitation. Note it; do not fix it here.

## 3.8 Trust budget

```ts
export interface CostTrustBudget {
  readonly measures: typeof VERIFY_MEASURES;
  readonly state: "verified" | "partially-verified" | "unverified";
  readonly verifiedCostShare: number;     // share of in-scope cost with a cost-state row
  readonly verifiedSessionShare: number;
  /** Signed relative error of our published figure vs ground truth,
   *  cost-weighted over verified sessions. Null when unverified. */
  readonly costBias: number | null;
  readonly costBiasRange: readonly [number, number] | null;
  readonly n: number;
  readonly minN: number;
  readonly causes: readonly VerifyCause[];
}
```

**Gating, borrowed from `calibration.ts`:** `state: "unverified"` ⇒ `costBias`
and `costBiasRange` are **both null** — the type makes "render a number from
n = 2" unrepresentable.

Set `minN = 5` and **say why**: unlike a binomial agreement rate, a systematic 2×
accounting error is unambiguous at n = 1, so the rule-of-three argument behind
`MIN_CALIBRATION_N = 30` does not transfer. Divergence is **one-directional
evidence**: a *clean* result at n = 5 proves little; a *divergent* result at
n = 5 proves a lot. That asymmetry must be in the caveat prose, or the trust
budget becomes exactly the uncalibrated-confidence artifact the project's own
practice rules forbid.

**Storage.** A `verify_runs(run_at, scope_hash, report_json)` append-only table,
plus the latest `CostTrustBudget` denormalised for cheap reads. **Surfaces must
never recompute a trust budget implicitly** — an expensive re-verify inside a
dashboard render is how this feature becomes something people turn off.

**Rendering in `generate_justification_pack`:**

- New optional section id `"verification"` in `ALL_PACK_SECTIONS`
  (`core/src/pack.ts:77-84`); **not** in `DEFAULT_PACK_SECTIONS` (`:89-93`)
  initially.
- `BuildHeadlineInput` (`:114-135`) gains `trust?: CostTrustBudget | null`;
  `PackHeadline` gains `trust`. This sits *beside* `reconciliation` — a metered
  account can have both, and they answer different questions ("does our number
  match your invoice" vs "does our number match Anthropic's own number").
- `costCaveat` (`core/src/insight.ts`) gains a `verifiedBias` input alongside its
  existing `reconciledRatio` / `reconciledWithinTolerance` / `anyFallbackRates`
  (`pack.ts:187-191`). **This is the right place** — `costCaveat` is already the
  single chokepoint where every pack's cost-honesty sentence is produced.
- HTML render in `renderJustificationPackHtml` (`pack.ts:856`); a `trust` block
  in `renderSummaryCsv` (`:1106`).
- **value-per-cost:** any $/outcome figure divides by a cost carrying a known
  bias. `costBias` is the multiplier that makes it honest, and the pack must
  *state* it rather than silently applying it.

## 3.9 Caveats to encode as typed fields

Each is a field, not prose.

1. **`cost_usd = 0` means UNKNOWN, never free.** Verdict `"unpriced"`, excluded
   from every ratio's numerator *and* denominator. On this machine **all five**
   sidecar `costUSD` values are 0 — the common case.
2. **`hasUnknownModelCost`** — when true, `totalCostUSD` is itself a floor; Layer
   C reports `no-ground-truth` for that session rather than a residual.
3. **Merged multi-account sidecar scope** — hard-skip Layer D under an account
   filter (§3.7).
4. **`cost-state` rarity: ~11% of recent sessions, 0.5% of all files, 0% before
   2026-08-26.** Present the trust budget as "verified on N of M sessions
   covering X% of cost", never as a whole-store guarantee.
5. **Sidecar staleness** — nine weeks here. `stalenessDays` is first-class;
   beyond 14 days Layer D reports `no-ground-truth` + `stale-sidecar`.
6. **Shutdown double-write** — dedupe on `session_id`, keep the larger
   `total_duration_ms`.
7. **Models present in ground truth but absent locally** (`claude-haiku-4-5-*`,
   every entry) — `modelsMissingLocally`; Layer C must not read their absence as
   an under-count of a model we track.
8. **TTL bracket, not point** — a residual inside `[floor, ceiling]` is
   `consistent` with cause `ttl-split-unattributed`, never `divergent`.
9. **Pruned transcripts** — 936/1168 sessions (`store/index.ts:580`) can never be
   re-verified. Cause `pruned-transcript`.
10. **`rateBasis: "first_party_fallback"`** (Bedrock/Vertex,
    `pricing.ts:279-283`) — Layer B is invalid for those rows; report
    `no-ground-truth` and reuse the existing `fallback-rates` cause.
11. **Ground truth is Anthropic's *equivalent-API-cost*, not a plan invoice.**
    Perfect agreement says nothing about what a Pro/Max user paid. This must be
    in the pack prose.

## 3.10 Surfaces, i18n, tests, effort, risks

**Surfaces.** A new top-level `claude-stats verify` with `--json`,
`--since/--until/--period`, `--project`, `--account`, `--layer <a|b|c|d>`,
`--tolerance <pct>`. **Not a mode of `diagnose`**: `diagnose`
(`cli/src/cli/index.ts:869-882`) is a three-line vestigial stub printing a
quarantine count and "use status", and `verify` is a period-scoped analytical
command with an entirely different option surface — bolting it on makes the
smaller command the entry point for the larger one. `diagnose` and `status` each
gain **one summary line** delegating to `verify`. MCP: a new `verify_costs`,
plus `trust` on `generate_justification_pack` and a `costVerification` line on
`get_status`. Dashboard: a trust line beside `planUtilization`, read from the
stored `verify_runs` row and **never recomputed inline**. No extension surface in
v1.

**i18n.** New `cli.json` keys under a `verify` namespace (`commands.verify`,
`verify.title`, `verify.verdict.*`, `verify.cause.*`, `verify.trust.*`,
`verify.noGroundTruth`, `verify.staleSidecar`, `verify.unpricedZero`), plus
`insight.json` additions for `costCaveat`'s verified-bias branch. Machine tokens
(`measures`, `verdict`, `kind`, `cause`) stay **unlocalised** — consumers branch
on them (the `CALIBRATION_MEASURES` precedent,
`cli/src/calibration/index.ts:157`).

**Tests** (`packages/cli/src/__tests__/`):

- `verify-pricing.test.ts` — Layer B against a **frozen fixture derived from the
  real `cost-state` rows** (tokens + costUSD only; no ids, no paths). Assert
  fable-5 lands exactly on the 1h ceiling and haiku's excess equals
  `webSearchRequests × 0.01`. **This fixture is the regression test for the whole
  rate table.**
- `pricing-expiry.test.ts` — a row with a past `effectiveUntil` produces
  `expired-effective-date` under a **frozen clock**; add
  `effectiveUntil: "2026-08-31"` to the Sonnet-5 row and assert it fires today.
- Properties (fast-check): `resolvePricing(id).canonical` never contains `[`;
  `floor <= point <= ceiling` for all non-negative token vectors;
  `verdict === "consistent"` ⟺ `theirs ∈ [floor·(1−ε), ceiling·(1+ε)]`; a scaled
  token vector scales the bracket linearly.
- `verify-gating.test.ts` — `state: "unverified"` ⇒
  `costBias === null && costBiasRange === null`.
- `cost-state-ingest.test.ts` — double-write dedupe keeps the larger
  `total_duration_ms`; an empty `session_id` does not abort the transaction (the
  `api_error_events` latent bug, tested here so it cannot recur).
- `verify-account-scope.test.ts` — `--account` skips Layer D and emits
  `scope-mismatch`.
- **Behaviour comparison for the `message.id` fix** — golden token totals for a
  fixture transcript with block-split assistant entries, before and after.

**Effort.** V23 ingest + parser + paths **1.5 d**; verify engine (four layers,
pure core + CLI shell) **2 d**; pricing-drift checks incl. `effectiveUntil`,
`[1m]`, `<synthetic>`, web-search term **1 d**; trust budget + pack/MCP wiring
**1 d**; i18n ×10 **0.5 d**; tests **1 d**; V24 sidecar **1 d**. ≈ **8 days** —
matching §4.2's "small–medium", and every part is read-only and additive.

**Risks.**

- **`verify` will report large divergence on day one** because of §3.0.
  Sequence the dedupe fix first, or ship both together.
- **The ground-truth sample is tiny** — 7 entries, 5 sessions, one machine, one
  week. Every quantitative claim here rests on it: the $0.01 web-search rate,
  `[1m]` at base rates, the exact-bracket behaviour. `verify` is itself the
  instrument that widens the sample.
- **The `[1m]` premium may exist above an input threshold** these sessions never
  crossed. Guessing a premium is worse than the current base-rate match;
  `tier-suffix-unmodelled` is the honest interim.
- **Claude Code may stop writing `cost-state`**, as it apparently stopped writing
  `stats-cache.json`. Handle absence as `no-ground-truth`, never as agreement.

**Open questions** — [09 §9.5](09-sequencing.md):

1. **How is the historical over-report repaired?** `messages` has no `message_id`
   column, so retroactive dedupe is impossible without transcripts, and 936/1168
   sessions have none. Options: (a) add `message_id`, re-parse what survives,
   flag the rest with a `cost_basis` marker; (b) store a per-session
   `inflation_factor` estimated from surviving sessions; (c) accept and disclose.
   **A product decision, and it must be made before `verify` publishes a trust
   budget over that history.**
2. Does the sidecar's `tokensByModel` include cache tokens? UNVERIFIED —
   determines whether Layer D is usable at all.
3. Why is `stats-cache.json` nine weeks stale — removed, gated, or silently
   failing? Determines whether V24 is worth building now.
4. Does `cost-state.totalCostUSD` include subagent sessions? The −15% outlier
   suggests not, or not fully. UNVERIFIED.
5. Is `web_fetch_requests` separately billed? UNVERIFIED.
6. Is a `verify` result safe to sync to the org plane, or is a per-session dollar
   residual itself sensitive under the two-plane rules?
