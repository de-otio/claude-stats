# 02 — Signal Inventory

Every signal this metric needs, mapped to the code that already produces it,
with the gaps and one real bug called out. File:line references are to the
state of the tree at the time of writing — verify before relying on them.

## 2.1 Numerator: cost — exists, but the per-task roll-up is wrong

`estimateCost(model, input, output, cacheRead, cacheCreation)`
([`pricing.ts:72`](../../../packages/core/src/pricing.ts#L72)) is correct and
already used everywhere. Per-message cost is exact.

The problem is the **per-task** roll-up in `buildDigestItem`
([`recap/index.ts:973-989`](../../../packages/cli/src/recap/index.ts#L973-L989)):

```ts
// estimatedCost: sum per-message cost for contributing sessions
let estimatedCost = 0;
for (const sessionId of sessionIds) {
  const msgs = store.getSessionMessages(sessionId);   // ALL messages in the session
  for (const msg of msgs) {
    if (msg.model !== null) { estimatedCost += estimateCost(msg.model, ...).cost; }
  }
}
```

It sums **every message in each contributing session**, not the messages that
belong to this task's segments. Consequences:

1. **Double-counting.** If one session is split into two clusters (two tasks),
   the session's *entire* cost is counted in *both*. `Σ task.estimatedCost` then
   exceeds the true window spend. For a "cost per task" metric this is
   first-order: it inflates the numerator non-uniformly (more for sessions with
   more topic shifts).
2. **No per-model split.** The model is read per message but discarded; the item
   keeps only a scalar `estimatedCost`. The article's per-model view is
   impossible from this.

**The fix** (Phase 0 of the plan): attribute cost from the task's
`segmentIds → Segment.messageUuids` only. Each `Segment` already carries its
`messageUuids` ([`recap/types.ts:113`](../../../packages/cli/src/recap/types.ts#L113)).
Compute cost over exactly those UUIDs and bucket by `msg.model` in the same
pass. This produces both the corrected scalar and the per-model breakdown, and
it benefits the recap feature too (its `totals.estimatedCost` becomes accurate).

A new store method is the clean way to get there:

```ts
getMessageCostInputsByUuids(uuids: string[]):
  Array<{ model: string|null; input_tokens; output_tokens; cache_read_tokens; cache_creation_tokens }>
```

(batched ≤500 per `IN (...)` like `getMessageTotalsBySession`).

## 2.2 Task unit: exists — `DailyDigestItem`

The pipeline is `segmentSession()` → `clusterSegments()` → `buildDigestItem()`
→ `DailyDigestItem` ([`recap/types.ts:60`](../../../packages/cli/src/recap/types.ts#L60)).

- **`segmentSession()`** ([`recap/segment.ts`](../../../packages/cli/src/recap/segment.ts))
  splits a session into `Segment`s on a weighted shift-score over five signals —
  idle gap (0.4), file-path Jaccard (0.25), prompt-vocab Jaccard (0.15), an
  explicit-marker regex like *"okay/now/next/let's/new task"* (0.15), and a git
  commit landing in the interval (0.30), threshold 0.5
  (`DEFAULT_SHIFT_WEIGHTS`, [`recap/types.ts:127`](../../../packages/cli/src/recap/types.ts#L127)).
  The commit signal means a *landed commit tends to end a segment* — which is
  convenient, because it aligns task boundaries with the success signal.
- **`clusterSegments()`** ([`recap/cluster.ts`](../../../packages/cli/src/recap/cluster.ts))
  merges related segments across sessions by file-path Jaccard, prompt
  similarity (embeddings or lexical), and time-window overlap.
- **`DailyDigestItem`** is the merged unit, carrying `sessionIds`, `segmentIds`,
  `estimatedCost`, `toolHistogram`, `filePathsTouched`, `git`, `score`,
  `confidence`, `hidden`, and a stable `id` (sha256 of sorted `segmentIds`,
  first 16 hex chars — [`recap/index.ts:1029-1042`](../../../packages/cli/src/recap/index.ts#L1029)).

**Why a `DailyDigestItem` and not a raw `Segment` or a whole session:** a session
is too coarse (many tasks); a raw segment is too fine and double-counts shared
context; the clustered item is the unit a human would call "a task," and it is
the unit git activity is already joined onto.

**Alternative unit offered in the plan:** for users who want a finer view, the
same machinery runs at `Segment` granularity (skip clustering). The metric code
should be unit-agnostic — take a list of `{cost, model-mix, outcome}` records and
not care whether each came from a segment or a cluster.

## 2.3 Outcome proxy: exists — `confidence`

`computeConfidence({git, duration, filePathsTouched})`
([`recap/index.ts:241`](../../../packages/cli/src/recap/index.ts#L241)) returns:

- **`high`** — `git.commitsToday>0 && git.pushed`, **or** `git.prMerged>0`.
  (Shipped.)
- **`medium`** — local commits not pushed; or `activeMs≥30min` with
  `linesChanged≥50`; or `activeMs≥30min` with `≥5` files. (Substantial,
  in-flight.)
- **`low`** — none of the above. (Thin, or **unobservable**.)

This is a strong starting point but **`low` overloads two very different
states**: "we could see git and there was no commit" (a real negative) versus
"there was no git signal at all" (unknown). The metric must split these; see
[03](03-outcome-model.md). `computeConfidence` itself need not change — the
outcome classifier wraps it and consults `git` for observability.

## 2.4 Git success signal: exists — `ProjectGitActivity`

`getProjectGitActivity(projectPath, startMs, endMs, authorEmail)`
([`recap/git.ts`](../../../packages/cli/src/recap/git.ts)) returns
`{commitsToday, filesChanged, linesAdded, linesRemoved, subjects, pushed,
prMerged}` ([`recap/types.ts:48`](../../../packages/cli/src/recap/types.ts#L48)).
`pushed` is the strongest cheap signal (HEAD has no unpushed commits vs
upstream); `prMerged` (via `gh`) is stronger still but `null` when `gh` is
absent. Author scoping uses `git config user.email`.

**This is also the metric's biggest bias source.** `git` is `null` whenever: the
project isn't a git repo; there's no upstream (so `pushed` is meaningless); the
commit author email doesn't match; or `gh` isn't installed (so `prMerged` is
null). Each of those makes a *genuinely successful* task look unobservable or
thin. The metric must **measure and report this coverage**, never silently
absorb it. (Quantify it empirically during Phase 1 against the author's own
history before trusting any headline rate.)

## 2.5 Explicit user override: partially exists — `hide`

The corrections store ([`recap/corrections.ts`](../../../packages/cli/src/recap/corrections.ts),
DB at `~/.claude-stats/recap-corrections.db`) supports `merge | split | rename |
hide` actions keyed by a `CorrectionSignature` = `{projectPath, sorted
filePaths, 80-char normalised promptPrefix}`. `hide` already surfaces as
`DailyDigestItem.hidden`.

- **Reuse `hidden` now** as a negative label: a hidden item is user-asserted
  "not real / aborted work" → counts as a **failed** observable attempt (its
  cost stays in the numerator).
- **Extend** the `CorrectionAction` union with `{kind:'outcome', value:
  'success'|'partial'|'fail'}` for true ground-truth labels. Signature-keyed
  (not item-id-keyed) so a label survives re-segmentation — the same reason the
  existing corrections are signature-keyed. This is the graduation from proxy to
  eval that the article calls for.

## 2.6 Per-model attribution: derivable, not stored

No stored field carries a task's model mix. Derive it in the same per-UUID cost
pass (2.1): bucket cost and output tokens by `msg.model`. Dominant model =
max output-token share. Both numbers (exact cost split, dominant assignment)
fall out of one loop.

## 2.7 Cross-day window: the real structural gap

`buildDailyDigest(store, {date}, deps)`
([`recap/index.ts:393`](../../../packages/cli/src/recap/index.ts#L393)) is
**per-day** and cached per-day. The metric wants 7 / 30 / all days. Two options:

- **A — iterate days (recommended for v1).** Loop each day in the window, call
  `buildDailyDigest`, pool the items, dedupe on `computeSignature(item)` (see
  below). Reuses the per-day cache and the snapshot-hash incrementality for free;
  isolated from the clustering internals. **Residual limitation:** a task
  spanning local midnight is two items in two daily digests whose segment sets
  (and thus content) differ — signature-dedupe collapses *re-emitted identical*
  items but not these two genuinely different halves, so a midnight-spanning task
  still counts twice. Acceptable for v1 if documented.
- **B — window-native pipeline.** Refactor segmentation/clustering to run over an
  arbitrary `[start,end)`. Removes the midnight artifact; larger change, defers
  the cache story. Out of scope for v1; note as future work.

Pick A; document the midnight edge in [04](04-limitations-and-privacy.md). For
the dedupe key, use `computeSignature(item)`
([`recap/corrections.ts:313`](../../../packages/cli/src/recap/corrections.ts#L313))
— the same stable key the labels use — not `item.id`, which is a hash of
`segmentIds` and so is unstable across re-segmentation and useless for matching
the two midnight halves anyway.

## 2.8 Subagent sessions — a counting hazard

claude-stats ingests subagent transcripts as **their own session rows**
(`is_subagent=1`, linked by `parent_session_id`; scanner reads `subagents/*.jsonl`).
`buildDailyDigest` calls `getSessions({since, until, includeCI:false})`
([`recap/index.ts:422`](../../../packages/cli/src/recap/index.ts#L422)) with
**no subagent filter**, so every subagent session is fed into segmentation and:

1. becomes **its own task**, inflating `|T|` (the denominator), and
2. has its cost attributed to itself — and possibly *also* to the parent if
   clustering merges them by file/time overlap, which is nondeterministic.

This corrupts both halves of the metric. The existing `spending` feature already
treats subagent cost as a **separate additive line** (`SubagentCostRow`,
[`store/index.ts:1190`](../../../packages/cli/src/store/index.ts#L1190))
precisely because of this hazard; the recap pipeline never inherited that care.

**Fix (Phase 0):** exclude `is_subagent=1` from the task set (an
`includeSubagents:false` filter on `getSessions`), and fold each contributing
session's child-subagent cost into the **parent** task via
`getChildSessions(parentSessionId)`
([`store/index.ts:1080`](../../../packages/cli/src/store/index.ts#L1080)) — so a
delegated task's true cost stays with the human-initiated task and is counted
exactly once. A parent+subagent fixture asserts the subagent is not a standalone
task and its cost appears once, in the parent.

## 2.9 Summary table

| Signal | Status | Source | Action needed |
|---|---|---|---|
| Per-message cost | ✅ exact | `estimateCost` | none |
| Per-task cost | ⚠️ double-counts, no model split | `buildDigestItem` | **fix** (Phase 0) |
| Task unit | ✅ | `DailyDigestItem` / `Segment` | make metric unit-agnostic |
| Outcome proxy | ✅ but `low` is overloaded | `computeConfidence` | wrap into 3-state classifier |
| Git success | ✅ (biased by coverage) | `getProjectGitActivity` | report coverage |
| Negative label | ◑ `hide` only | `corrections.ts` | reuse `hidden`; add `outcome` action |
| Per-model mix | ◯ derivable | per-UUID cost pass | compute |
| Window > 1 day | ◯ per-day only | `buildDailyDigest` | iterate days + signature-dedupe |
| Subagents | ⚠️ counted as own task | unfiltered `getSessions` | exclude + fold into parent (Phase 0) |
| Project/account filter | ⚠️ not threaded | `buildDailyDigest` hardcodes filters | add passthrough + cache-key (Phase 1) |
