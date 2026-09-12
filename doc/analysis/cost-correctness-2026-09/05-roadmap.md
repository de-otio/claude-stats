# 05 — Deferred Opportunities

Recorded so they are not re-discovered, and deliberately excluded from the
release scoped in [04](04-scope.md). Each is a feature; none is a correctness
defect. Sources are the Claude Code changelog for 2.1.252–2.1.269 and the
`claude-api` skill bundled with 2.1.269.

## 5.1 Usage and Cost Admin API as a calibration source

`GET /v1/organizations/usage_report/messages` and `GET /v1/organizations/cost_report`
return **billed** dollars and tokens, split by exactly the classes this project
estimates: `uncached_input_tokens`, `cache_read_input_tokens`,
`cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`,
`output_tokens`, grouped by model, API key, workspace and service tier.

That is ground truth of a different kind from `cost-state`: org-wide and
authoritative rather than per-session and client-side. It fits
`packages/core/src/calibration.ts` and the org plane described in
`../data-planes/`, and it would let `verify` (prior §3) check the local estimate
against the bill rather than only against Claude Code's own rollup.

Constraints that make it a separate piece of work: it needs an Admin API key
(`sk-ant-admin...`, not available to individual accounts), it is not in the
SDKs, Claude Enterprise organisations use a different API, and a key shared
across projects blends traffic so per-project reads are unattributable. All of
that is design, not plumbing.

## 5.2 Gateway-supplied rates

Claude Code 2.1.268 added `pricing:` in `gateway.yaml`: signed-in clients
receive their organisation's rates through managed settings so `/cost` and
telemetry match the spend meter.

`resolvePricing` already accepts a `RateOverrides` table. Reading the
gateway-supplied rates into it would make Claude Stats agree with `/cost` for
gateway users instead of quietly using list prices. Small, but it needs a
managed-settings read path this project does not have.

## 5.3 Cache-miss cause

Claude Code 2.1.260 added a likely cause for prompt-cache misses — tool
definitions changed, system prompt changed, idle past the TTL — to `/cost` and
the status line's `prompt_cache` field.

This project diagnoses the same thing from the other side, in
`packages/core/src/ttlFit.ts` and the cache-churn hygiene detector. Worth
comparing vocabulary and verdicts against Claude Code's, and worth checking
whether the cause lands anywhere in the transcript; if it does, it is a free
label on an existing finding.

## 5.4 Skill and MCP context cost, historically

`/skill-doctor` (2.1.261) reports which loaded skills go unused and what they
cost in context — per session, live. The same question asked across all history
("which skills and MCP servers have cost the most context and been used the
least") is a natural fit for the hygiene engine and has no equivalent anywhere.

## 5.5 Repository attribution via OpenTelemetry

2.1.269 added `OTEL_METRICS_INCLUDE_REPOSITORY`, tagging metrics and events with
`vcs.*` repository attributes, and `vcs.ref.head.*` on commit events. The OTel
ingest path in `packages/cli/src/otel/` attributes by project path today; a
repository attribute is a stronger key for the org plane.

## 5.6 Regional-endpoint pricing

Bedrock regional and Google Cloud multi-region/regional endpoints carry a **10%
premium** over global endpoints for Claude 4.5-and-later models **[docs]**.
`messages.inference_geo` is captured; no multiplier is applied. Latent for
partner-platform users only — first-party traffic is global by default — and it
should be built as part of, not before, the §2.3 drift machinery.

## 5.7 Tokenizer discontinuity

Opus 4.7 introduced a tokenizer that produces **~30% more tokens for the same
text** than the one Sonnet 4.6 and earlier use **[docs]**. Any tokens-per-task
trend line that crosses that boundary is comparing two different units.

Not a pricing defect — the rates are per-token and correct on both sides — but
every *trend* surface in this project is affected, and none of them says so. The
cheapest honest fix is a marker on the trend charts at the model boundary rather
than an attempted normalisation.
