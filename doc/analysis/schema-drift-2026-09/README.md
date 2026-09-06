# Schema Drift 2026-09 — What Claude Code Emits Now vs. What We Parse

claude-stats was designed against direct inspection of Claude Code **v2.1.61–2.1.71**
data (see [../07-schema-reference.md](../07-schema-reference.md) and
[../08-resilience.md](../08-resilience.md)). This sub-analysis re-runs that
inspection as of **2026-09-01** against Claude Code **v2.1.181–2.1.252** and diffs
the result against what the parser, pricing table, and scanner actually consume.

## Method and evidence grades

Three sources, in decreasing order of confidence:

1. **Live-data sample (primary, verified).** Field/type aggregation over the 40
   most recently modified session files under `~/.claude/projects/`, ~42k JSONL
   entries, Claude Code versions 2.1.181–2.1.252, plus direct inspection of the
   sidecar files under `~/.claude/`. Everything below marked **[live]** was
   observed in real data on this date.
2. **Codebase inventory (primary, verified).** What the parser recognizes, with
   `file:line` refs into `packages/core` and `packages/cli`.
3. **Docs/changelog research (secondary).** Official docs, changelog, and API
   references. Marked **[docs]**; a few of these claims could not be verified
   locally and are flagged as such. Treat them as leads, not facts.

## Headline findings

- The transcript format has grown from the ~5 entry types we modeled to
  **17 observed entry types** [live]. The parser dispatches on exactly four
  (`packages/core/src/parser/session.ts:224-291`); the other 13 fall through
  silently — including two that carry data we currently derive expensively or
  can't get at all (`cost-state`, `pr-link`).
- Claude Code now writes **its own cost and stats rollups**: a per-session
  `cost-state` entry (total USD, per-model tokens+cost, lines added/removed,
  API/tool durations) [live] and a global `~/.claude/stats-cache.json`
  aggregate [live]. Free ground truth to validate — or backfill — our derived
  numbers.
- Several new fields land directly on the analyses in this directory:
  `pr-link` → [business-value-visibility](../business-value-visibility/),
  lines-added/removed + durations → [human-time-saved](../human-time-saved/),
  `bridge-session` owner UUIDs + per-entry `promptId` →
  [account-attribution](../account-attribution/) and
  [project-hours-attribution](../project-hours-attribution/).
- Two pricing defects are live **today**: the `claude-sonnet-5` intro-price row
  expired 2026-08-31 per its own comment, and 1M-context model variants
  (`claude-opus-5[1m]`, observed [live]) prefix-match to base-rate rows.
- Thinking tokens — listed in [../06-limitations.md](../06-limitations.md) as
  "possibly uncounted" — are now reported per response as
  `usage.output_tokens_details.thinking_tokens` [live].

## Documents

| # | File | Purpose |
|---|------|---------|
| 01 | [01-immediate-fixes.md](01-immediate-fixes.md) | Correctness items to fix regardless of any feature work |
| 02 | [02-transcript-schema-changes.md](02-transcript-schema-changes.md) | New entry types and fields vs. what the parser reads, with evidence |
| 03 | [03-new-sidecar-sources.md](03-new-sidecar-sources.md) | New files under `~/.claude/` and new org-side surfaces (Analytics API, OTel) |
| 04 | [04-feature-opportunities.md](04-feature-opportunities.md) | What the new data enables, mapped to existing sub-analyses |

## Relationship to 07/08

This document does **not** replace [../07-schema-reference.md](../07-schema-reference.md);
it is the drift report the resilience design in
[../08-resilience.md](../08-resilience.md) anticipated. Once the parser is
updated, the confirmed shapes here should be folded into 07 and this folder
kept as the point-in-time decision record.
