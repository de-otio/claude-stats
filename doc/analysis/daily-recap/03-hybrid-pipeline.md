# 03 — Hybrid Pipeline

The pipeline is a strict three-tier pyramid. Each tier produces a smaller,
denser representation and only the top tier touches an LLM.

```
Tier 1: Raw signals (DB rows + git plumbing)        ~50–500 KB
            │
            ▼  deterministic extraction
Tier 2: Structured digest (JSON facts)              ~3–10 KB / 1–3k tokens
            │
            ▼  optional LLM synthesis
Tier 3: Natural-language recap (markdown)           ~1–2 KB / 200–500 tokens
```

Tier 2 is the contract between server and agent. Tier 3 is optional and
runs in the calling agent — never on the claude-stats process.

## Tier 1 → Tier 2: deterministic extraction

This runs entirely in `packages/cli/src/recap/` (new). It is a pure function
of inputs.

### Step 1 — Topic segmentation (within each session)

A session is rarely a single task; long sessions routinely contain several
unrelated efforts. Before clustering across sessions we must split each
session into **topic segments**. The segmenter walks messages in
chronological order and opens a new segment whenever the cumulative
*shift score* across recent messages exceeds a threshold:

```
shift_score(message_i) =
    w_gap     * (1 if gap_minutes(i-1, i) > 20 else 0)
  + w_path    * jaccard_distance(file_paths(window before), file_paths(window after))
  + w_vocab   * jaccard_distance(tokens(prev user prompt), tokens(this user prompt))
  + w_marker  * (1 if user prompt starts with imperative-shift marker else 0)
  + w_commit  * (1 if a git commit landed between messages i-1 and i else 0)
```

Default weights (tunable): `w_gap=0.4, w_path=0.25, w_vocab=0.15, w_marker=0.15, w_commit=0.30`.
Threshold: `0.5`.

Output of Step 1: each session becomes a list of `Segment` objects, each
with its own first-prompt, tool histogram, time range, and a stable
`segmentId = hash(sessionId, segment_index, opening_message_uuid)`.

LLM is **not** invoked here. Empirical accuracy on a small hand-labelled
sample is the right way to tune the weights; the algorithm degrades
gracefully — wrong splits just produce extra small items, which the
clustering step in Step 2 can re-merge if their first prompts and file
sets overlap.

### Step 2 — Cross-session clustering of segments

This was previously described as "session clustering" but operates on
segments. The Tier-2 digest produced looks like:

```jsonc
{
  "date": "2026-04-26",
  "tz": "Europe/Berlin",
  "totals": { "sessions": 4, "activeMs": 7920000, "estimatedCost": 1.84 },
  "items": [
    {
      "id": "claude-stats-russian",   // stable hash of segment_ids + commit shas
      "project": "/Users/rmyers/repos/dot/claude-stats",
      "repoUrl": "github.com/.../claude-stats",
      "sessionIds": ["abc123", "def456"],
      "segmentIds": ["abc123#0", "def456#2"],   // session-id#segment-index
      "firstPrompt": "<UNTRUSTED-WRAPPED>i want to add russian</…>",
      "characterVerb": "Shipped",     // from tool histogram + git state
      "git": {
        "commitsToday": 4,
        "filesChanged": 3,
        "linesAdded": 287,
        "linesRemoved": 12,
        "subjects": [
          "Add Russian locale and fix silent fallback bug (0.2.3)",
          "..."
        ],
        "pushed": true,
        "prMerged": null
      },
      "duration": { "wallMs": 6480000, "activeMs": 4320000 },
      "score": 14.6                   // for ranking
    },
    /* … */
  ]
}
```

This object is what the MCP tool returns. Every field is reproducible from
the inputs; nothing is invented.

Key choices that keep this layer cheap and correct:

1. **Local-day boundary in user TZ.** `Intl.DateTimeFormat().resolvedOptions()`
   gives the TZ; we already use this pattern in `mcp/index.ts`. Compute
   midnight-to-midnight in that TZ; do not use UTC.
2. **Author-scoped git log.** Filter by `git config user.email` so we don't
   credit the user with a teammate's commits on the same branch. The
   email value is attacker-controlled in any cloned repo — see the
   subprocess-invocation requirements in
   [02-data-sources.md](02-data-sources.md#subprocess-invocation-requirements-mandatory)
   for the validation, `execFile`, and `--` separator rules that any
   implementation MUST follow.
3. **Sanitised first prompts only.** `prompt_text` was sanitised at parse
   time; we wrap with `wrapUntrusted` before emitting. Never include
   anything beyond the *first* user prompt — that is sufficient for intent
   and avoids leaking conversation contents.
4. **Truncate aggressively.** First prompt capped at ~280 chars, commit
   subjects at ~120 chars, max 5 commit subjects per item with a "+N more"
   counter. This bounds the digest size predictably.

### Clustering (deterministic first, LLM only as fallback)

Clustering operates on **segments**, not whole sessions. Most of it is
solvable without an LLM:

- **Same `project_path`** → candidate cluster.
- **Overlapping file-path sets** between segments (Jaccard ≥ 0.3 over
  files touched by tool calls) → strong cluster signal.
- **Same first-prompt prefix (≥40% normalised match)** → likely the same
  task continued in another segment or session.
- **Adjacent segments within one session** are *not* automatically
  re-merged — the segmenter just split them — but the file-path and
  prompt-prefix rules above will re-merge them if they really were the
  same topic (graceful recovery from over-segmentation).

These rules cover the common case (one feature spread across multiple
sessions, or multiple unrelated efforts within one long session). The
LLM is only invoked when:

- Multiple distinct first-prompt themes exist within one project for the
  same day with no file-path overlap, *and*
- The user explicitly asked for narrative output (Tier 3).

### Scoring for ranking

Highlight ranking uses a simple deterministic score:

```
score = (commits_landed * 3)
      + (lines_changed / 100)
      + (active_minutes / 30)
      + (pr_merged ? 5 : 0)
      + (pushed ? 1 : 0)
```

This is "good enough" for top-3 highlight ordering. We do **not** ask an
LLM to rank items; LLM ranking is non-deterministic and expensive.

## Tier 2 → Tier 3: optional LLM synthesis

The agent calls the MCP tool and receives the Tier-2 digest. From there it
has two paths:

### Path A — Template render (zero LLM cost)

The agent renders the digest with a deterministic markdown template (the
example shown in [01-feature-vision.md](01-feature-vision.md)). All fields
exist in the digest; no synthesis required. This is the recommended default.

### Path B — One-paragraph narrative (small LLM cost)

When the user asks for prose ("write me a paragraph for my standup"), the
agent passes the *digest only* (not raw sessions) to its current model with
a prompt like:

> Given this structured day-digest, write a single paragraph (≤80 words)
> for a standup update. Use only facts present. Do not invent. Quote first
> prompts verbatim where useful.

Input is ~1–3k tokens. Output is ~150–250 tokens. This is the *only* place
in the pipeline where generative LLM tokens are spent.

### Path C — Aggressive narrative (Sonnet/Opus)

For a polished retrospective ("write my weekly review"), the agent can
escalate to a larger model with multiple days of digests. Even at 7 daily
digests ≈ 7–21k input tokens, this is still **an order of magnitude cheaper**
than synthesizing from raw session data.

## Caching

The digest is cached in `~/.claude-stats/recap-cache/` keyed by a
snapshot hash whose inputs are:

```
hash(
    date                                                   // YYYY-MM-DD
  + tz                                                     // IANA, from Intl
  + sorted_project_paths                                   // membership
  + max(message.uuid for messages on date)
  + per-project-tuple: (project_path, last_commit_sha)     // sorted
)
```

**Required inputs (security):**

- `tz` MUST come from `Intl.DateTimeFormat().resolvedOptions().timeZone`,
  not from the `TZ` environment variable. This prevents trivial cache
  manipulation by setting `$TZ` to shift the day boundary and serve a
  stale or wrong-day cache.
- `sorted_project_paths` is the sorted set of project paths considered
  by this digest (i.e. all projects with sessions on this date or with
  recent activity in the lookback window). Without this input, adding a
  new project — which may have pre-existing commits and therefore not
  shift `max(message.uuid)` — would silently serve a stale cache that
  omits the new project.
- `per-project-tuple` is sorted to ensure determinism regardless of
  filesystem enumeration order.

Re-asking "what did I get done today" zero seconds later returns the cached
JSON with **zero recomputation and zero LLM tokens**. The hash invalidates
the moment new work appears, the project list changes, or the TZ changes.

The Tier-3 narrative can also be cached by `(digest_hash, model, prompt)`,
so re-asking for the same paragraph in the same session costs nothing.

**File permission requirements:** the cache directory MUST be created
with mode `0o700` and cache files written with mode `0o600`. See
[05-implementation-plan.md](05-implementation-plan.md#privacy--safety)
for the helper utilities that enforce this.

## What is *not* in the pipeline (deliberately)

- **Embedding-based clustering.** Overkill for the volume; the rule-based
  clusterer above suffices.
- **LLM-based ranking.** Replaceable by a cheap heuristic.
- **Per-message prompt summaries.** Only the *first* prompt of each session
  is consulted. The rest add cost without proportional value, and they're
  privacy-sensitive.
- **Inline tool-result inspection.** Recap reads metadata about tool calls
  (`tools` column), never tool *outputs* — those are large and not stored.
