# 04 — Feature Opportunities

What the new data enables, mapped to the existing sub-analyses. Ordered by
(value ÷ effort), highest first.

## 4.1 Session→PR linkage from `pr-link` → business-value-visibility

[business-value-visibility](../business-value-visibility/) needs cost tied to
business-legible outcomes. `pr-link` entries give session→PR (number, URL,
repository) natively — no git archaeology, no regex. Combined with
`cost-state.totalCostUSD` (or our derived cost), "this PR cost $X across N
sessions" becomes a join, not an inference. Also upgrades
[ticket-attribution](../ticket-attribution/): PR URL → ticket via PR title/
branch is a stronger evidence grade than prompt-text regex, and it covers
non-Jira shops (the Jira-only regex at `packages/core/src/tickets.ts:22-25` is
a known gap).

**Effort:** small. Parse the entry, one table, one join.

## 4.2 Cost validation / "trust budget" from `cost-state` + `stats-cache.json`

We derive every dollar figure; Claude Code now publishes its own numbers at two
grains (per-session `cost-state`, lifetime/daily `stats-cache.json`). A
`claude-stats verify` mode that diffs our aggregates against both and reports
divergence would (a) catch our pricing drift automatically — the Sonnet-5 row
in [01-immediate-fixes.md](01-immediate-fixes.md) would have been flagged the
day it expired, (b) quantify the confidence we ask users to place in
justification packs ([value-per-cost](../value-per-cost/),
`generate_justification_pack`).

**Effort:** small–medium. Read-only, additive.

## 4.3 Engaged-time and lines-changed floors → human-time-saved / project-hours

[human-time-saved](../human-time-saved/) was shelved partly for lack of honest
inputs; [project-hours-attribution](../project-hours-attribution/) reports
engaged-hour floors. New native inputs: `cost-state.totalLinesAdded/Removed`,
`totalToolDuration`, `totalAPIDurationWithoutRetries`, `file-history-delta`
edit events, and (via OTel) `claude_code.active_time.total`. None of these
justify FTE claims — the human-time-saved verdict stands — but they replace
several proxies in the hours-attribution metric with measured values.

**Effort:** small for cost-state fields; OTel active-time medium (needs the
setup command from [03](03-new-sidecar-sources.md)).

## 4.4 Attribution hardening from `bridge-session` + `promptId`

[account-attribution](../account-attribution/)'s precedence chain tops out at
weak proxies (single-account `~/.claude.json`, growthbook telemetry, PID
anchors). `bridge-session.ownerAccountUuid/ownerOrganizationUuid` is an
in-transcript account signal — where present it should slot in at the top of
the precedence order (below explicit override). `promptId` gives exact turn
identity, retiring the turn-start heuristics for new data.

**Effort:** small parser change; precedence rework medium.

## 4.5 Effort/thinking/speed analytics — genuinely novel

Per-request `effort`, `output_tokens_details.thinking_tokens`, and
`usage.speed` enable analyses no comparable tool offers:

- Effort-level distribution and cost per effort level, per project/task class
  (extends [cost-per-successful-task](../cost-per-successful-task/) with a new
  controllable input — effort is user-steerable, so it is *actionable*).
- Thinking-token share per model/effort — where reasoning spend actually goes
  (extends [../09-token-spending-analysis.md](../09-token-spending-analysis.md)).
- Fast-mode share and its cost/limit impact
  ([constraint-impact](../constraint-impact/) gains a new policy axis).

**Effort:** medium (parse + store + one dashboard card each).

## 4.6 Friction metrics: hooks, refusals, fallbacks, denials

System-entry expansion (hook errors, `preventedContinuation`, model fallback
records, API refusal categories) plus user-entry `toolDenialKind` make
"friction per session" measurable: how often work was blocked by permissions,
hooks, refusals, or silent model downgrades. Natural fit for
[efficiency-hygiene](../efficiency-hygiene/) as new deterministic detectors,
and model-fallback events matter to [constraint-impact](../constraint-impact/)
(you didn't get the model you paid for).

**Effort:** medium.

## 4.7 Compaction analytics → context-carry-cost

Explicit compaction records (`compactMetadata`, `durationMs`, `messageCount`,
`isCompactSummary`) let [context-carry-cost](../context-carry-cost/) and
[autocompact-window-fit](../autocompact-window-fit/) replace inference with
measurement: compaction frequency, size collapsed, and cost-before/after per
session.

**Effort:** small–medium.

## 4.8 UX: real session titles

`ai-title`/`custom-title`/`agent-name` — replace synthesized titles in
`list_sessions`, the dashboard session list, and daily recaps. Trivial win.

## 4.9 Deliberately not pursued

- **Reading `~/.claude/sessions/*.key` material** — never; encryption keys.
- **Mining `attachment` entries** (~23% of volume) — content is user file data;
  privacy cost exceeds analytical value, and the two-plane rules
  ([../05-privacy-security.md](../05-privacy-security.md)) would forbid it
  leaving the machine anyway.
- **Replacing local parsing with the Analytics API** — org-only; our core
  audience (Pro/Max, no admin API) keeps the local pipeline as the product.
  Revisit for the team plane only.
