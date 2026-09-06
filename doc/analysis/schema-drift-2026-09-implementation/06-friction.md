# 06 — Friction: Hooks, Refusals, Fallbacks, Denials

Implements [§4.6](../schema-drift-2026-09/04-feature-opportunities.md).

Live corpus: **224 surviving session files** against **413,985 messages** and
**3,378 tool errors** in the store — the transcripts are a small recent tail of
the database's history. Every count below is from the surviving tail only, and
that asymmetry drives the sequencing decision in §6.12.

## 6.1 The subtype census

`type === "system"`, 1,820 entries:

| Subtype | Count | Parsed today? |
|---|---|---|
| `compact_boundary` | 903 | no → [07](07-compaction.md) |
| `turn_duration` | 519 | no — **out of scope, see §6.12** |
| `away_summary` | 182 | no — **out of scope, see §6.12** |
| `api_error` | 152 | **yes**, only when `source ∈ {request_retry, connection_retry}` |
| `local_command` | 36 | no |
| `stop_hook_summary` | 13 | no |
| `model_refusal_fallback` | 10 | no |
| `informational` | 5 | no |

> [02 §2.2](../schema-drift-2026-09/02-transcript-schema-changes.md) lists "Hook
> execution", "Model fallback", "API refusal" and "Retraction" as four separate
> signals. **On real data they are two subtypes, not four.**
> `stop_hook_summary` carries the whole hook group, and `model_refusal_fallback`
> carries the fallback fields, the refusal fields *and* `retractedMessageUuids`
> on one entry.

### Field frequency

| Field | Files | Occurrences | Carrier |
|---|---|---|---|
| `hookCount` / `hookInfos` / `hookErrors` / `hookAdditionalContext` / `preventedContinuation` / `stopReason` | 6 | 13 each | `stop_hook_summary` (1:1) |
| `originalModel` / `fallbackModel` / `apiRefusalCategory` / `apiRefusalExplanation` / `refusedUserMessageUuid` | 5 | 10 each | `model_refusal_fallback` (1:1) |
| `retractedMessageUuids` | 4 | 8 | subset of the above |
| `supersedesUuids` | 3 | 6 | assistant |
| `retryInMs` / `retryAttempt` / `maxRetries` | 9 | 152 each | `api_error` (1:1) |
| **`toolDenialKind`** | 54 | **986** | **user entries, top level** |
| `toolUseID` | 224 | 24,974 | many entry types — **not** hook-specific |

### Enum value domains

```
toolDenialKind      automode-blocked 793 | permission-rule 176 | user-rejected 9 | automode-unavailable 8
apiRefusalCategory  cyber 10                       (single observed value)
trigger             manual 903 | refusal 10        (!! "manual" belongs to compact_boundary)
direction           retry 10
scope               session 10
originalModel       claude-fable-5 10
fallbackModel       claude-opus-4-8 9 | claude-opus-5 1
stopReason          "" in 13/13
preventedContinuation  false in 13/13              (true never observed)
hookCount           1 ×8 | 2 ×5
hookErrors          [] in 13/13                    (non-empty shape UNVERIFIED)
hookInfos           [{"command":"callback"}]       (the field is shaped to carry a real command line)
```

## 6.2 Two findings that change the design

### (a) Refusals are not folded into `"unknown"` — they are absent entirely

`api_error_events` holds **74 rows**: `server_error/retry` 47,
`rate_limit/terminal` 22, `server_error/terminal` 3, `unknown` **2** — one
terminal with no status, one retry with `retry_in_ms = 589`, **neither a
refusal**. `classifyApiErrorKind` (`packages/core/src/parser/session.ts:44-53`)
is reached only from the two `api_error` / `isApiErrorMessage` arms; a
`model_refusal_fallback` entry never reaches it.

**Refusals are silently dropped, not misclassified.** [02 §2.2]'s "currently
folded into 'unknown'" is wrong for this corpus.

This *strengthens* the decision to route refusals to `friction_events`: there is
no legacy `"unknown"` population to reinterpret, and `summarizeApiThrottle`'s
denominators (`apiThrottleWait.ts:148-199`) stay untouched.

### (b) 19.7% of all tool errors are permission denials — and they are already corrupting two shipped detectors

Every one of the 986 denial entries carries a `tool_result` block with
`is_error: true` (986/986, all four kinds). The parser's user arm
(`session.ts:229-238`) attributes any `is_error` tool_result to the previous
assistant message as `toolErrorCount`. Across the surviving corpus: **5,007
`is_error` tool_results, 986 of them denials — 19.7%.**

So today:

- **`detectRetryLoop`** (`retryLoop.ts:17`) counts a run of *denied* calls as
  "the environment is broken, escalate the tier" — the wrong remedy.
- **`detectTierMismatch`** and constraint-impact's `toolErrorRate` — the *stated
  rework proxy* — treat "policy said no" as "the model failed".
- Turning on auto-mode with a tight allowlist (793 `automode-blocked` here) reads
  as a rework regression **indistinguishable from a model downgrade**.

**This is a correctness bug this feature fixes, not just a new metric.**

## 6.3 "Friction per session", defined

### Components, per session, over a window

| Component | Unit | Source |
|---|---|---|
| `denials.automodeBlocked` / `.permissionRule` / `.userRejected` / `.automodeUnavailable` | counts | `toolDenialKind` |
| `hookEvents` / `hookErrorCount` / `preventedContinuations` | counts | `stop_hook_summary` |
| `refusals` (by `apiRefusalCategory`) | count | `model_refusal_fallback` |
| `retractedMessages` | count | `retractedMessageUuids.length` |
| `fallbacks` (by `originalModel → fallbackModel`) | count | `model_refusal_fallback` |
| `turns` | count | **denominator — always shipped alongside** |

### Position: an unweighted vector, not a weighted score

Four arguments, in descending strength.

1. **A weight is an uncalibrated outcome model, and this repo has already ruled
   on that.** `beforeAfter.ts`'s header rejects an attempts metric because
   building a policy verdict on an uncalibrated outcome model is not allowed;
   `classifyDirection` returns `"unknown"` rather than inferring;
   `toolErrorRateTrend` abstains rather than `?? 0`. A scalar
   `frictionScore = 3·refusals + 1·denials + …` is exactly the invented constant
   those three sites refuse — and there is no ground truth here to fit it against
   (13 hook events, 10 refusals).
2. **The components have different owners, and the owner *is* the remediation.**
   `automode-blocked` is the harness's policy; `permission-rule` is the user's
   own settings; `user-rejected` is the human steering correctly; `api_refusal`
   is the safety layer; `model_fallback` is capacity. A scalar destroys the only
   field that determines which behaviour changes.
3. **The distribution makes the scalar degenerate.** 80% of all friction events
   are one kind. Per affected session: p50 = 4, p90 = 57, max = 153. A scalar
   would be the `automode-blocked` count with extra arithmetic and a false claim
   of generality.
4. **`user-rejected` has negative weight, or none.** A human declining a proposed
   tool call is the tool *working*. Any scalar that adds it accuses the user of
   using the product correctly. Excluding it from a vector is one filter;
   excluding it from a score requires a sign convention the score cannot justify.

**What *is* scalar, deliberately:** each finding's `estimatedWaste`, which the
hygiene framework already requires and which `buildHygieneDigest`
(`hygiene/index.ts:217-226`) already uses as its sole ranking axis. Money is
*measured*, not weighted — and for refusals it is **exact**, because
`retractedMessageUuids` names precisely which billed messages were thrown away.
That is the strongest waste figure in the entire hygiene suite; nothing else in
it names its own discarded work.

**Rates, not only counts:** surface `denialRate = denials / turns` (with `turns`
always beside it) for thresholds and trend. A rate is not a score — it has a
stated denominator.

## 6.4 Parser design

Replace the `if / else if` chain at `session.ts:224-291`.
`allTimestamps.push(ts)` at `:222` stays **above** the switch, untouched
([01 §1.3](01-foundation.md)).

```ts
if (ts !== null) allTimestamps.push(ts);          // :222 — UNCHANGED

switch (type) {
  case "queue-operation":
    hasQueueOperation = true;
    break;

  case "user": {
    // ...existing body verbatim...
    // NEW, additive — closed enum only, nothing else off this entry:
    if (entry.uuid && isToolDenialKind(entry.toolDenialKind)) {
      frictionEvents.push({
        uuid: entry.uuid,
        sessionId: entry.sessionId ?? sessionId ?? "",
        timestamp: ts,
        kind: "tool_denial",
        category: entry.toolDenialKind,
        refUuid: entry.sourceToolAssistantUUID ?? null,   // a messages.uuid
        toolUseId: null,
        count: 1, errorCount: 0, retractedCount: 0,
        preventedContinuation: false,
      });
    }
    break;
  }

  case "system":
    switch (entry.subtype) {
      case "api_error":
        // BYTE-IDENTICAL to today — the source guard MOVES INSIDE, it does not vanish
        if (entry.source === "request_retry" || entry.source === "connection_retry") {
          if (entry.uuid && typeof entry.retryInMs === "number") { /* ...unchanged... */ }
        }
        break;

      case "stop_hook_summary":
        if (entry.uuid) frictionEvents.push({
          uuid: entry.uuid, sessionId: ..., timestamp: ts,
          kind: "hook",
          category: "stop",                       // derived from the SUBTYPE, not from data
          refUuid: entry.parentUuid ?? null,      // a messages.uuid
          toolUseId: entry.toolUseID ?? null,     // DIFFERENT namespace
          count: intOr(entry.hookCount, 0),
          errorCount: Array.isArray(entry.hookErrors) ? entry.hookErrors.length : 0,
          retractedCount: 0,
          preventedContinuation: entry.preventedContinuation === true,
        });
        break;

      case "model_refusal_fallback": {
        // ONE entry → TWO rows, sharing the uuid across the two tables
        const retracted = Array.isArray(entry.retractedMessageUuids)
          ? entry.retractedMessageUuids.filter((u): u is string => typeof u === "string") : [];
        if (entry.uuid) {
          frictionEvents.push({
            uuid: entry.uuid, sessionId: ..., timestamp: ts,
            kind: "api_refusal", category: strOrNull(entry.apiRefusalCategory),
            refUuid: entry.refusedUserMessageUuid ?? null,
            toolUseId: null, count: 1, errorCount: 0,
            retractedCount: retracted.length, preventedContinuation: false,
          });
          retractions.push(...retracted.map(m => ({ frictionUuid: entry.uuid!, messageUuid: m })));
          if (entry.originalModel && entry.fallbackModel) modelFallbackEvents.push({
            uuid: entry.uuid, sessionId: ..., timestamp: ts,
            originalModel: entry.originalModel, fallbackModel: entry.fallbackModel,
            trigger: strOrNull(entry.trigger),    // ONLY read inside this case — trap 3
            direction: strOrNull(entry.direction), scope: strOrNull(entry.scope),
          });
        }
        break;
      }

      default: break;   // compact_boundary, turn_duration, away_summary, local_command, informational
    }
    break;

  case "assistant":
    // ...existing body verbatim, INCLUDING the `continue` statements...
    break;
}
```

`ParseResult` gains `frictionEvents`, `frictionRetractions`,
`modelFallbackEvents`, mirroring `apiErrorEvents`.

### Four traps this refactor creates, all silent

1. **The `api_error` source guard must move *inside* the case, not vanish.**
   Today a `system`/`api_error` entry with any other `source` falls through the
   chain and matches nothing. Under `switch(type)` it now *lands* in the
   `api_error` case and must still do nothing. Pin with a fixture using
   `source: "other"` asserting zero events.
2. **`continue` vs `break` in the assistant arm.** The dedupe at `:295-299` uses
   `continue`, which still targets the enclosing `for` inside a `switch` — but a
   tidy-up converting it to `break` silently disables dedupe (a real file was
   measured at 2.9× duplication). Pin with the existing duplicate-uuid fixture.
3. **`trigger` is namespace-shared.** `compact_boundary` emits
   `trigger: "manual"` **903** times; `model_refusal_fallback` emits
   `trigger: "refusal"` 10 times. Reading `entry.trigger` outside the subtype
   case would record 903 phantom model fallbacks. **This is the single best
   argument for the nested switch over any flat field sniff.**
4. **`toolUseID` is not a message uuid.** It appears on 24,974 entries of many
   types. Never store it in `ref_uuid`.

### Compile-time enforcement of the drop rule

**Do not add `hookInfos`, `hookAdditionalContext`, `apiRefusalExplanation`, or
`toolUseResult` to `RawSessionEntry`** (`packages/core/src/types.ts:66-125`). *A
field absent from the type cannot be read.* Same posture as the pack's
`HasNoForbiddenPackFields` check — the guarantee is structural, enforced by the
compiler, not by a reviewer noticing.

## 6.5 Schema

```sql
CREATE TABLE IF NOT EXISTS friction_events (
  uuid                   TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,       -- NO FK, deliberately
  timestamp              INTEGER,
  kind                   TEXT NOT NULL,       -- 'hook' | 'api_refusal' | 'tool_denial'
  category               TEXT,                -- closed enum PER KIND, nullable
  ref_uuid               TEXT,                -- ALWAYS a messages.uuid-namespace value
  tool_use_id            TEXT,                -- separate namespace, hooks only
  count                  INTEGER NOT NULL DEFAULT 1,  -- hookCount for hooks, 1 otherwise
  error_count            INTEGER NOT NULL DEFAULT 0,  -- hookErrors.length
  retracted_count        INTEGER NOT NULL DEFAULT 0,
  prevented_continuation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_friction_events_session ON friction_events (session_id, kind);
CREATE INDEX IF NOT EXISTS idx_friction_events_ts      ON friction_events (timestamp);

-- The refusal waste figure's evidence: exactly which billed messages were discarded.
CREATE TABLE IF NOT EXISTS friction_retractions (
  friction_uuid TEXT NOT NULL,
  message_uuid  TEXT NOT NULL,
  PRIMARY KEY (friction_uuid, message_uuid)
);

CREATE TABLE IF NOT EXISTS model_fallback_events (
  uuid           TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  timestamp      INTEGER,
  original_model TEXT NOT NULL,
  fallback_model TEXT NOT NULL,
  trigger        TEXT,
  direction      TEXT,
  scope          TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_fallback_session ON model_fallback_events (session_id);
CREATE INDEX IF NOT EXISTS idx_model_fallback_ts      ON model_fallback_events (timestamp);
```

Refinements over the sketch in [01 §1.4](01-foundation.md), and why:

- **`ref_uuid` made namespace-pure, `tool_use_id` split out.** The sketch had one
  `ref_uuid`; on real data it would hold a `messages.uuid` for denials and
  refusals but a *tool-use id* for hooks. **A join written against a polymorphic
  key returns nothing, silently.** Hooks point at `parentUuid` (a real message
  uuid) and keep `toolUseID` in its own column.
- **`retracted_count` + `friction_retractions`** — added because it converts the
  refusal detector's `estimatedWaste` from an estimate into a *measurement*: the
  transcript enumerates the discarded messages, and every one is already a row in
  `messages` with a cost. Cost: one two-column table of uuids, no free text.
- **`count NOT NULL DEFAULT 1`**, documented as "events folded into this row" — a
  nullable count would reintroduce the `?? 0` reads-as-zero failure the hygiene
  module bans.
- **`category` is a per-kind closed enum, never free text**, and **allowlisted on
  READ, not on write.** `apiRefusalCategory` has exactly one observed value; a
  write-time allowlist would silently drop every future category.
- **No FK to `sessions`** on either table — an empty `session_id` under a
  declared FK aborts the whole-file transaction, the latent bug
  `api_error_events` already carries (`store/index.ts:763-780`). Do not copy it
  forward.

### One generic table vs per-kind

**Generic for the three friction kinds; separate for model fallback.**

*Generic for friction:* the three kinds share seven of eleven columns, and every
read is the same shape —
`SELECT kind, category, COUNT(*) … WHERE session_id IN (…) GROUP BY kind, category`.
Three tables means three near-identical queries, three store mappers, and three
chances to diverge on `includeCI`/`includeDeleted` narrowing — precisely the
divergence `getMessagesForHygiene` (`store/index.ts:3290-3316`) was routed
through `buildMessageFilter` to prevent.

*Separate for fallback:* it shares almost no columns (two model ids and three
enums, none of which map onto `category`), and its consumer is constraint-impact,
not hygiene. Folding `originalModel → fallbackModel` into `category` would make
"which model did I actually get" a string-parse. The two tables' `uuid` values
**overlap by construction** when a fallback was refusal-triggered (10/10 here),
giving a free `JOIN … USING (uuid)` — worth a schema comment.

### Per-session denormalised counters: no, not in v1

Every consumer read is window-scoped with project/account filters, i.e. a
`GROUP BY` on an indexed `(session_id, kind)` — the same access pattern
`api_error_events` already serves acceptably. A session-level counter would have
to be a projection in `recomputeSessionAggregatesSql` (`store/index.ts:820-849`),
which today projects only from `messages`; adding a cross-table correlated
subquery widens the single UPDATE that must stay atomic and cheap, for no
measured read problem.

Revisit only if `get_session_detail` or a dashboard session list needs a per-row
badge — and then **as a projection there, never as an additive column**
(`upsertSessionIncremental`, `:1065-1149`, adds deltas and is not idempotent).

## 6.6 The hygiene framework

| Concern | Where |
|---|---|
| Detector id union | `packages/core/src/hygiene/types.ts:24-30` |
| Per-message input row | `types.ts:38-81` (`HygieneMessageRow`) — the **only** row type detectors see |
| Finding shape | `types.ts:89-107` — `{detectorId, sessionIds, estimatedWaste, rule, threshold, remedy, detail}` |
| Result shape | `types.ts:111-135` — `+ {title, suppressed, computed, enablementPath?}` |
| Thresholds | `types.ts:159-225`, defaults `:229-236` |
| Detector signature | `(rows, thresholds, overrides?) => HygieneFinding[]` — pure, no clock, no I/O |
| Registration (**3 sites**) | `hygiene/index.ts:56-63` (`TITLES`), `:139-149` (`mergeThresholds`, hand-exhaustive), `:173-185` (`byDetector`) |
| Non-message side input | `index.ts:65-81` `RunHygieneDetectorsOptions.taskClassBySession`, `computed` gate at `:171` |
| Scoring / ranking | **none** — `buildHygieneDigest` (`:217-226`) sorts by Σ `estimatedWaste` |
| Suppression | `config.hygiene.suppressions[]`, keyed on `detectorId` |
| Store glue | `packages/cli/src/hygiene/index.ts:77-98`, `:136-156`, `:173` |
| Surface | `packages/cli/src/mcp/index.ts:797+` (`get_efficiency_hints`) |

Existing detectors: `cache-churn` (`cacheChurn.ts:21`), `retry-loop`
(`retryLoop.ts:17`), `abandoned-spend` (`abandonedSpend.ts:26`), `context-bloat`
(`contextBloat.ts:129`), `re-entry-burn` (`reEntryBurn.ts:43`), `tier-mismatch`
(`tierMismatch.ts:261`).

### Verdict: the framework can express these, via one seam and with four caveats

**It can**, via the existing `taskClassBySession` seam: add
`frictionBySession?: ReadonlyMap<string, SessionFriction>` to
`RunHygieneDetectorsOptions`, built in `cli/hygiene/index.ts` alongside
`buildTaskClassMap`. `undefined` = the store has no `friction_events` rows at all
(pre-V23 or never re-collected) → `computed: false` + `enablementPath`; a
defined-but-empty map = ran, found nothing. **Zero-backfill data and the
`computed: false` honesty mechanism are made for each other.**

*Rejected alternative:* widening `HygieneMessageRow` with friction counts.
Friction events are not billed messages — a hook summary attaches to no message,
a denial attaches to a *user* entry. Folding them in would require attributing to
a positional neighbour: the exact heuristic
[02 §2.2](../schema-drift-2026-09/02-transcript-schema-changes.md) tells us to
stop using.

**What it lacks:**

1. **No `severity` field.** *Do not add one.* Ranking is already a measured
   dollar figure; a second uncalibrated axis beside it is the
   uncalibrated-confidence-score the design defaults ban. Severity for each
   detector below **is** its `estimatedWaste` basis.
2. **`estimatedWaste: number` is required and non-nullable** — a detector whose
   cost is genuinely unmeasurable must write `0`, which reads as "clean",
   contradicting the module's own rule. **A real gap.** The principled fix
   (`number | null` + `wasteBasis`) touches six existing detectors,
   `buildHygieneDigest`, `hygieneRatio`, and the justification pack. For v1,
   dodge it — every new detector below has a *measurable* waste basis. **Flag the
   gap; don't pay for it here.**
3. **`mergeThresholds` (`index.ts:139-149`) is hand-exhaustive with no
   compile-time check** — a forgotten line silently drops a new detector's
   thresholds onto the floor. **Rewrite it as a `keyof`-mapped fold while adding
   the three, or the bug ships.**
4. `HygieneFinding` has no per-event timestamps or ids beyond `sessionIds`. Fine
   — and privacy-load-bearing, since `sessionIds` is already on the pack's
   forbidden list.

### What this actually unlocks

[efficiency-hygiene/README.md](../efficiency-hygiene/) lists exactly six
detectors, and **all six are implemented.** There is no backlog here. What §4.6
delivers is:

- **a correction to two shipped detectors** (`retry-loop`, `tier-mismatch`) that
  today count 19.7% policy denials as tool failures, and
- **three genuinely new detectors**, which *extend* that README's table rather
  than filling it in. The README needs a new row per detector and a note that
  `tool_error_count` now excludes denials.

## 6.7 Detectors

### `permission-friction`

- **Trigger:** per session, over `tool_denial` events **excluding
  `user-rejected`** — fires when `qualifyingDenials ≥ 8` **and**
  `qualifyingDenials / turns ≥ 0.10`. Two-sided: a 200-turn session with 8
  denials does not fire; a 5-turn session with 3 does not either.
- **Precision guard (the false-positive fixture):** a session with 3
  `user-rejected` denials and nothing else must **not** fire. A human declining a
  proposal is the tool working; accusing them of waste is the failure mode this
  module says costs more than a miss.
- **`estimatedWaste`:** Σ cost of the *distinct* `messages` rows named by
  `ref_uuid` for qualifying denials — the assistant turns that produced work
  never allowed to run. Deduped by `ref_uuid` (one message can issue several
  denied calls). Conservative; never the whole session.
- **`rule`:** "Tool calls were denied by a permission rule or by auto-mode often
  enough that a measurable share of turns proposed work that was never allowed to
  run."
- **`threshold`:** `≥8 blocked tool calls and ≥10% of turns`
- **`remedy`:** "Widen the allowlist for the tools you keep approving, or scope
  the task so the model stops proposing them."
- **`detail`:** counts per `category`, the rate, and `turns`. **Never a command
  line, never a tool argument.**

### `hook-interference`

- **Trigger:** any session with `Σ error_count > 0` **or** any
  `prevented_continuation = 1`. Threshold **1** — a hook that errors is an
  unambiguous defect, not a heuristic, so no percentile guard is needed (contrast
  `context-bloat`, which needed one because a large context is ordinary).
- **`estimatedWaste`:** cost of the `messages` row at `ref_uuid` — the turn the
  hook blocked from completing. `detail` states plainly that the *re-run* cost is
  not measured, naming the gap per the `NOT_MEASURED` convention.
- **`rule`:** "A Stop hook reported an error, or blocked the turn from
  completing."
- **`threshold`:** `≥1 hook error or blocked continuation`
- **`remedy`:** "Fix or remove the failing hook — a Stop hook that errors or
  blocks continuation costs a full turn every time it fires."
- **Caveat:** `preventedContinuation: true` was **never observed** (0/13) and
  `hookErrors` was empty 13/13. **This detector is built against a shape we have
  not seen fire.** Mark UNVERIFIED; parse defensively.

### `refusal-retry`

- **Trigger:** ≥1 `api_refusal` event. No threshold — a refusal is discrete,
  unambiguous and self-costing.
- **`estimatedWaste`:** Σ cost of the `messages` rows joined through
  `friction_retractions`. **Exact, not estimated** — the transcript names the
  discarded messages. `detail` should say so; it is the only finding in the suite
  whose figure is a measurement.
- **`rule`:** "A request was flagged by the model's safety classifier; the turn
  was discarded and re-run on a fallback model."
- **`threshold`:** `≥1 refusal`
- **`remedy`:** "Rephrase the request so its purpose is explicit — the discarded
  turn is billed even though it produced nothing."
- **Framing constraint:** neutral. This must not read as an accusation of misuse;
  on this machine every observed refusal was `category: cyber` on ordinary
  defensive and analytical work.

### Not a hygiene detector: model fallback

Fallback is **not the developer's waste** — it is capacity or safety policy
imposed on them, the same "partly the org's cost, not the dev's" carve-out the
hygiene README already makes for `re-entry-burn`. It belongs in constraint-impact
(§6.8).

## 6.8 Constraint-impact integration

### Does it infer model downgrades today? **No — it does not infer at all; it annotates.**

`distinctModels` (`beforeAfter.ts:318-322`) builds a deduped, unordered `Set` of
`messages.model` strings per side, surfaced as `modelsBefore`/`modelsAfter`
(`:183-185`, `:402-403`, `:518-519`, CSV `:657-658`/`:694-695`). `CONFOUND_NOTE`
(`:68-73`) explicitly hands the reader the job: model version changes "are
visible in modelsBefore/modelsAfter" and "should be checked by hand".

**How wrong the annotation is:**

1. **No counts, no weights.** A model that served one message and one that served
   4,000 are the same set element. A 5% silent fallback and a total tier removal
   are indistinguishable.
2. **Served, not requested.** `messages.model` records what the API *answered*
   with. A silent fallback writes the *fallback* model into that column, so a
   downgrade forced on you looks identical to one you chose. All 29 fallbacks
   observed ([05 §5.2](05-request-dimensions.md)) would appear in `modelsAfter`
   as an ordinary extra model id.
3. **No attribution.** `scope: "session"` means the rest of that session ran
   degraded. The set cannot say which sessions, or for what share of turns.
4. **It can swallow the very event being measured.** For `kind: "model-removal"`
   — the one policy kind this report exists for — the removed model reappearing
   in `modelsAfter` because a fallback re-served it is presented as a confound to
   eyeball, in a report whose thesis is "measure, don't infer".

Net: the inference is not wrong, it is **absent**, and its absence is delegated
to the reader as manual work.

### What changes, across seven sites

Two new metric pairs plus one semantics change:

- **A — `denialRateBefore/After` + `denialRateTrend`**, and `toolErrorRate`
  **redefined to exclude denials**. This is the §6.2(b) bug fix.
- **B — `fallbackSessionShareBefore/After` + `fallbackShareTrend`** — the share
  of the side's sessions with ≥1 `model_fallback_events` row. **Session-share,
  not event-count**: an event count is dominated by session length; the question
  is "how often did I not get the model I paid for".

| # | Site | Change |
|---|---|---|
| 0a | `ConstraintImpactSessionRow` (`beforeAfter.ts:86-108`) | `+ readonly denials: number; + readonly fallbacks: number` |
| 0b | `buildSideRows` (`cli/constraintImpact/index.ts:118-170`) | a second store read `getFrictionForSessions(sessionIds)` accumulated per session — **not** via `toHygieneMessageRow` (`:91-110`), since message rows carry no friction and widening them would fabricate a carrier. Also subtract denials from `toolErrors`. |
| 1 | `ClassImpactComparison` (`:135-224`) | +6 readonly fields |
| 2 | `insufficientDataRow` (`:366-410`) | +6, all `null` / `"unknown"` — never a fabricated zero |
| 3 | `compareOneClass` (`:412-526`) | compute both; **abstain to `"unknown"` when either side is null**, following the `toolErrorRateTrend` precedent at `:501-505` — a missing after-side denominator must not read as "friction fell to zero" |
| 4 | `CSV_HEADER` (`:634-659`) | **append** 6 columns at the end, never insert — existing column positions in anyone's spreadsheet must not shift |
| 5 | CSV row (`:671-696`) | same 6, same order |
| 6 | `NOT_MEASURED` (`:53-57`) | + "hook-blocked turn re-run cost" — name the gap rather than omit it |
| 7 | `get_constraint_impact` description (`mcp/index.ts:1152-1173`) | a paragraph stating that **`toolErrorRate` changed meaning** (denials now split out, so historical numbers are not comparable) — the same posture as the TTL-pricing note already in `get_efficiency_hints`' description |

**`PolicyEvent.kind` stays inert.** Do **not** branch on `"model-removal"` to
enable the fallback metric. Compute it for every event kind; a model-removal
event simply makes that column the interesting one. Branching would reintroduce
exactly the coupling that is deliberately absent (the only current read of `kind`
remains the tie-break at `:293`).

## 6.9 Privacy: store / hash / drop

The store's guarantee is structural (`store/index.ts:643-648`): free text is
dropped **at the parser**, never filtered later.

| Field | Decision | Why |
|---|---|---|
| `toolDenialKind` | **STORE** (`category`) | closed enum, 4 observed values |
| `sourceToolAssistantUUID` | **STORE** (`ref_uuid`) | a uuid already in `messages` |
| **`toolUseResult`** (denial entry) | **DROP** | **verified to contain the literal denied command line — the sharpest leak risk in the feature** |
| **`message.content[].content`** (denial entry) | **DROP** | the same text, second copy |
| `hookCount` | STORE | int |
| `hookErrors` | **STORE COUNT ONLY** | array elements are error strings → stderr |
| **`hookInfos`** | **DROP — not hashed** | hook command lines. A hash is still a stable fingerprint of the developer's toolchain, and no query needs it. |
| **`hookAdditionalContext`** | **DROP** | free text injected into the model's context — the highest-sensitivity field in the set |
| `preventedContinuation` | STORE | bool |
| `stopReason` | **DROP as text** | `""` in 13/13; promote to `category` only if it becomes a closed enum |
| `toolUseID` | STORE (`tool_use_id`) | opaque id, local-only, distinct namespace |
| `originalModel` / `fallbackModel` | STORE | model ids are already stored per-message |
| `trigger` / `direction` / `scope` | STORE | closed enums, allowlist-on-read |
| `apiRefusalCategory` | STORE | closed enum |
| **`apiRefusalExplanation`** | **DROP** | free prose from the safety classifier |
| **`content`** (fallback entry) | **DROP** | user-facing prose on the same entry |
| `refusedUserMessageUuid` | STORE (`ref_uuid`) | a `messages.uuid` |
| `retractedMessageUuids` | STORE (`friction_retractions`) | uuids already in the DB |
| `retryInMs` / `retryAttempt` | unchanged | already stored |
| `maxRetries` | **decide** | typed at `types.ts:99`, never read. Either populate `api_error_events` with it (a bounded int, giving "how close to giving up") **or delete the field**. A typed-but-unread field is a maintenance trap. |

**`sanitize.ts` is not involved.** `sanitizePromptText` is an escape-based filter
for text we have *decided to keep*; reaching for it here would be the
"filter applied to a larger payload" posture the structural guarantee rejects.

**Doc updates required:** add a friction-events bullet to
[05-privacy-security.md](../05-privacy-security.md) §"What the Tool Stores
Locally"; add "hook command lines, hook output, and refusal explanations"
explicitly to §"What the Tool Does NOT Store".

**Friction stays out of the justification pack in v1** — per-kind denial counts
are behaviour-shaped (they reveal how often a developer's own permissions blocked
them), consistent with `sessionIds` already being on the forbidden list.

## 6.10 Surfaces

- **`get_efficiency_hints`** (`mcp/index.ts:797+`) — the three detectors appear
  in `detectors[]` automatically. Needs one sentence in the tool description and
  the `computed: false` + `enablementPath` path wired ("friction events are
  zero-backfill; re-collect to populate").
- **`get_constraint_impact`** — 6 new class fields + the `toolErrorRate`
  semantics warning.
- **`get_session_detail`** — the natural home for the per-session friction
  *vector* (counts by kind + `turns`). The one read pattern that would eventually
  justify a denormalised counter.
- **Dashboard "Efficiency & Hygiene" tab** — renders from the same digest; no new
  plumbing beyond card titles.
- **`diagnose` / schema fingerprinter** — surface the subtype diff
  ([01 §1.11](01-foundation.md)) so the next drift is noticed without a manual
  audit.
- **Justification pack** — explicitly excluded in v1.

## 6.11 i18n

**Position: detector `rule` / `threshold` / `remedy` / `detail` stay English
source strings**, per the documented deferral at `hygiene/types.ts:13-18`.
Localising three new detectors while the six shipped ones are English would
create exactly the drift `locales:check` exists to prevent, in the wrong
direction. Localisation is a single later change across all nine.

What does need keys (10 locales):

```
dashboard:hygiene.detector.permission-friction.title   "Permission friction"
dashboard:hygiene.detector.hook-interference.title     "Hook interference"
dashboard:hygiene.detector.refusal-retry.title         "Refusal retries"
dashboard:friction.section                             "Friction"
dashboard:friction.denialKind.automodeBlocked          "Blocked by auto-mode"
dashboard:friction.denialKind.permissionRule           "Blocked by a permission rule"
dashboard:friction.denialKind.userRejected             "You declined"
dashboard:friction.denialKind.automodeUnavailable      "Auto-mode unavailable"
common:insight.friction.none        "No blocked calls, refusals or model fallbacks in this window."
common:insight.friction.summary     "{{denials}} blocked tool calls, {{refusals}} refusals, {{fallbacks}} model fallbacks."
common:insight.friction.fallback    "{{count}} sessions were served by {{fallbackModel}} instead of {{originalModel}}."
cli:constraint.column.denialRate    "Denial rate"
cli:constraint.column.fallbackShare "Fallback share"
```

The enum **values** (`automode-blocked`, `cyber`, `retry`) are data and are never
translated — only their labels. Mirror `common.json:191-193`
(`insight.efficiency.hygiene*`) for phrasing style.

## 6.12 Tests

**Parser — the refactor is the risk, not the new fields:**

1. **Golden behaviour test** — parse the existing `api_error` fixtures before and
   after the switch refactor; assert `apiErrorEvents` deep-equal.
2. `system` / `api_error` / `source: "other"` → **zero** events (trap 1).
3. `compact_boundary` with `trigger: "manual"` → **zero** `model_fallback_events`
   (trap 3).
4. Duplicate-uuid assistant fixture still dedupes (trap 2).
5. `allTimestamps` / `activeDurationMs` byte-identical across the refactor.
6. One fixture per new subtype; a `model_refusal_fallback` fixture asserting
   **one** `friction_events` row **and** **one** `model_fallback_events` row
   sharing the uuid, plus N `friction_retractions` rows.

**Privacy — the one test that makes the guarantee executable:**

7. A fixture whose `toolUseResult`, `hookInfos[].command`,
   `hookAdditionalContext`, `apiRefusalExplanation` and `content` all contain a
   distinctive sentinel. Parse → write to a temp DB → assert the sentinel appears
   in **zero** columns of **every** table (or scan the DB file bytes). Model it
   on `filter-symmetry.test.ts`'s exhaustive posture.

**Property (fast-check):**

8. Re-parsing the same byte range twice leaves row counts unchanged.
9. `denialRate ∈ [0,1]`; all counts ≥ 0;
   `retracted_count === COUNT(friction_retractions)`.

**Detectors — one true-positive AND one false-positive fixture each:**

10. `permission-friction`: fires on 12 `permission-rule` denials over 40 turns;
    **does not fire** on 3 `user-rejected`; **does not fire** at 8 denials over
    200 turns (rate guard).
11. `hook-interference`: fires on one `hookErrors.length = 1`; does not fire on
    13 clean hook summaries.
12. `refusal-retry`: `estimatedWaste` equals the exact sum of the three retracted
    messages' costs.
13. `computed: false` + `enablementPath` when the store has zero
    `friction_events`; `computed: true` with `findings: []` when it has rows but
    none in the window.

**Constraint-impact:**

14. A class differing only in denial volume moves `denialRate` and leaves
    `toolErrorRate` flat — the §6.2(b) fix, asserted.
15. `insufficientDataRow` returns `null` / `"unknown"` for all 6 new fields.
16. CSV header/row arity stays in lockstep.

**Store:** V22→V23 migration on a populated DB; an event with `session_id = ""`
does not abort the file transaction.

## 6.13 Effort, risks, open questions

**Effort — medium, ~3–4 days, best shipped in two releases:**

- **Release 1 (S–M, ~1.5 d):** parser switch, `RawSessionEntry` additions, V23
  migration, store writers, the privacy test. Ships collection so a window starts
  accumulating.
- **Release 2 (M, ~2 d):** the three detectors, the hygiene seam, the seven
  constraint-impact sites, docs and i18n.

**Risks**

1. **The data is thin, and the constraint-impact metric may be unbuildable for
   any past boundary.** Only 224 session files survive locally against 413,985 DB
   messages. `friction_events` is zero-backfill, so for any policy boundary in
   the past the "before" side is **structurally empty** and the class abstains
   forever. **This is the strongest argument for the two-release split: collect
   first, measure later.**
2. **Thresholds cannot be fitted on this corpus** (13 hook events, 10 refusals).
   Set them at the "unambiguous event" level (≥1) rather than a percentile, and
   mark every number UNVERIFIED-on-real-data.
3. **`toolErrorRate` changes meaning**, breaking comparability with previously
   exported constraint-impact CSVs. Needs an explicit note in the tool
   description and the CHANGELOG.
4. **Single-value enum risk:** `apiRefusalCategory` has one observed value.
   Allowlist-on-read only.
5. **`automode-blocked` dominance (80%)** means `permission-friction` fires
   almost exclusively on auto-mode users. Verify the remedy sentence is right for
   that population before shipping.
6. **`mergeThresholds` silent-drop** (framework gap 3) will bite during
   implementation if not fixed first.

**Open questions / UNVERIFIED**

- Are there `*_hook_summary` subtypes other than `stop_hook_summary`?
- `hookErrors` element shape when non-empty — never observed (13/13 empty).
- `stopReason` value domain — `""` in 13/13.
- `direction` domain — only `"retry"`. Is there `"downgrade"` / `"upgrade"`?
- `scope` domain — only `"session"`. Is there `"request"` / `"org"`?
- Does a fallback ever occur **without** a refusal (pure capacity)? 10/10 here
  were refusal-triggered. **Note that [05 §5.2](05-request-dimensions.md) found
  29 fallbacks in `usage.iterations` against 10 system-entry records** — the two
  sources disagree on volume, and reconciling them is worth doing before either
  is presented as the fallback count.
- Populate or delete `maxRetries` (`types.ts:99`)?
- **`turn_duration` (519) and `away_summary` (182) are unparsed and far more
  frequent than anything in this scope.** Out of §4.6's remit, but they dominate
  the subtype census and plainly belong to an engaged-time story — worth a
  separate look, and likely relevant to the separately-tracked §4.3 work.
