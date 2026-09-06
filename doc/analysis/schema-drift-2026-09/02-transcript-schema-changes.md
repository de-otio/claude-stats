# 02 — Transcript Schema Changes

All observations in this document are **[live]** (sampled 2026-09-01, 40 most
recent session files, ~42k entries, Claude Code 2.1.181–2.1.252) unless marked
otherwise. Counts are from that sample and are indicative, not exhaustive.

## 2.1 Entry types: 17 observed, 4 parsed

The parser dispatches on `queue-operation`, `user`, `system`, `assistant`
(`packages/core/src/parser/session.ts:224-291`). Everything else falls through
silently — no counter, no warning (the schema fingerprinter at
`packages/cli/src/schema/monitor.ts` does record them, but nothing surfaces it).

Observed types, by value to us:

### High value — carry data we currently derive or can't get

| Type | Fields | Why it matters |
|------|--------|----------------|
| `cost-state` | `totalCostUSD`, `modelUsage` (per model: `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `webSearchRequests`, `costUSD`), `totalAPIDuration`, `totalAPIDurationWithoutRetries`, `totalToolDuration`, `totalDuration`, `totalLinesAdded`, `totalLinesRemoved`, `startTime`, `hasUnknownModelCost` | Claude Code's **own per-session cost rollup**. Ground truth to validate our derived cost pipeline; lines added/removed and durations are the raw material [human-time-saved](../human-time-saved/) lacked. Appears rarely (3 entries in sample) — likely written on session end/checkpoint; do not rely on it being present for live sessions. |
| `pr-link` | `prNumber`, `prUrl`, `prRepository`, `timestamp`, `sessionId` | Session→PR linkage recorded natively, per session. Most of the attribution work [business-value-visibility](../business-value-visibility/) planned to build, handed to us. Complements the Jira-regex-only ticket detection (`packages/core/src/tickets.ts:22-25`). |
| `bridge-session` | `bridgeSessionId`, `ownerAccountUuid`, `ownerOrganizationUuid`, `lastSequenceNum` | Account/org UUIDs **inside the transcript**. A far stronger attribution signal than the `GrowthbookExperimentEvent` telemetry parse (`packages/cli/src/parser/telemetry.ts:155-170`) the [account-attribution](../account-attribution/) chain leans on. Present on bridge-connected (remote/desktop-linked) sessions only. |
| `ai-title` / `custom-title` | `aiTitle` / `customTitle`, `sessionId` | Human-readable session titles. Immediate UX win for `list_sessions`, the dashboard, and recaps (which currently synthesize titles from prompts). |
| `agent-name` | `agentName`, `sessionId` | Named-agent identity for team/multi-agent sessions. |
| `file-history-snapshot` / `file-history-delta` | `messageId`, `snapshot` / `snapshotMessageId`, `trackingPath`, `backup`, `timestamp` | Per-edit file tracking with backup pointers — an edit/rework signal at message granularity. |

### Metadata / state markers

| Type | Fields | Notes |
|------|--------|-------|
| `mode` / `permission-mode` | `mode` / `permissionMode`, `sessionId` | Mode transitions (incl. plan mode) as first-class events. |
| `last-prompt` | `leafUuid`, `lastPrompt`, `sessionId` | Last user prompt marker (typed in `RawSessionEntry` already, never consumed). |
| `attachment` | full envelope + `attachment` | ~23% of all entries in the sample. System-injected context (file reads, reminders). Correctly ignorable for token accounting (no `usage`), but note the volume when reasoning about file sizes/offsets. |
| `atis-latch` | `atis`, `sessionId` | Internal latch state; no known analytical value yet. |

## 2.2 New fields on entry types we already parse

### Assistant entries

| Field | Coverage in sample | Value |
|-------|--------------------|-------|
| `effort` | 16,127 / 16,229 | **Reasoning-effort level per request.** Enables effort-vs-cost/outcome analytics; no other tool surfaces this. |
| `requestId` | ~100% | Stable API request id — joins to OTel/API-side records. |
| `attributionMcpServer` / `attributionMcpTool` / `attributionSkill` | sparse (~2%) | "Which MCP server / skill caused this request" — direct spend attribution for skills and MCP servers. |
| `supersedesUuids` | rare | Message retraction/replacement — affects dedupe logic (`session.ts:291-307`). |

### User entries

| Field | Coverage | Value |
|-------|----------|-------|
| `promptId` | **100%** | Exact turn identity. Replaces the "real prompt" heuristic (`session.ts:243-256`) and the 68%-accurate `prompt_text IS NOT NULL` backfill proxy (`packages/cli/src/store/index.ts:579-586`) for all new data. |
| `toolUseResult` + `sourceToolAssistantUUID` | ~90% of user entries | Tool results now carry an explicit pointer to the assistant message that issued the call — replaces the "attribute error to previous assistant message" positional heuristic (`session.ts:232-242`). |
| `isCompactSummary` + `isVisibleInTranscriptOnly` | sparse | **Compaction is now explicit.** We currently handle compaction only implicitly via duplicate-uuid dedupe. |
| `origin`, `promptSource`, `permissionMode` | sparse | Where the prompt came from (user-typed vs injected) and the mode it ran under. |
| `toolDenialKind` | sparse | Permission denials as data — friction metric. |
| `queueSkipAttachments`, `classifierMetaLines`, `turnCompanion`, `mcpMeta` | sparse | Not yet analytically interesting; fingerprint-watch only. |

### System entries (subtypes greatly expanded)

The parser handles only `subtype === "api_error"` with retry sources
(`session.ts:44-53`). Now also observed:

| Signal | Fields | Value |
|--------|--------|-------|
| Compaction record | `compactMetadata`, `logicalParentUuid`, `durationMs`, `messageCount` | When/why compaction ran, how much it collapsed — pairs with [context-carry-cost](../context-carry-cost/) and the measured "oversized-context cache re-reads dominate spend" finding. |
| Hook execution | `hookCount`, `hookInfos`, `hookErrors`, `hookAdditionalContext`, `preventedContinuation`, `stopReason`, `toolUseID` | Hook failure/interference rates. |
| Model fallback | `originalModel`, `fallbackModel`, `trigger`, `direction`, `scope` | Requested-vs-served model — affects cost attribution and plan-limit analysis. |
| API refusal | `apiRefusalCategory`, `apiRefusalExplanation`, `refusedUserMessageUuid` | Refusals as a distinct outcome class (currently folded into "unknown" errors). |
| Retry detail | `retryInMs`, `retryAttempt`, `maxRetries`, `source` | Already partially parsed; `maxRetries` is typed but unread. |
| Retraction | `retractedMessageUuids` | Pairs with `supersedesUuids`. |

## 2.3 Usage block: new sub-fields

Present on **every** assistant usage block in the sample:

| Field | Parsed today? | Notes |
|-------|---------------|-------|
| `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | yes | unchanged |
| `cache_creation.ephemeral_5m_input_tokens` / `.ephemeral_1h_input_tokens` | yes | unchanged |
| `server_tool_use.web_search_requests` / `.web_fetch_requests` | yes | unchanged |
| `service_tier`, `inference_geo` | yes | unchanged |
| **`output_tokens_details.thinking_tokens`** | **no** | 15,190 / 16,229 entries. Closes the "thinking tokens possibly uncounted" gap in [../06-limitations.md](../06-limitations.md). Thinking tokens are billed as output tokens, so cost math is already right — the value is the *breakdown* (thinking share per model/effort). |
| **`speed`** | **no** | Fast-mode dimension (`standard` / `fast`). Fast mode is a real product surface now (a billing/limits dimension per **[docs]**); we should at minimum record the distribution. |
| **`iterations`** | **no** | New; semantics unconfirmed (speculation/retry iterations?). Fingerprint-watch and record raw. |

## 2.4 Assumptions that survived

Worth stating what did **not** break:

- **Subagent layout:** separate files under `subagents/` still exist and the
  scanner's directory-based detection (`packages/cli/src/scanner/index.ts:54-67`)
  still matches reality. `isSidechain` remains emitted-but-redundant for us.
- **Session identity:** `sessionId` on every entry; filename still not load-bearing.
- **Envelope basics:** `uuid`/`parentUuid`/`timestamp`/`version`/`gitBranch`/
  `cwd`/`entrypoint` all intact; `slug` now on ~60% of entries.
- **Usage location:** `message.usage` on every assistant entry — the core
  accounting path is unbroken.
- **Duplicate-uuid replay** on resume/compaction still occurs; the dedupe at
  `session.ts:291-307` is still necessary and correct.

## 2.5 Parser recommendations

1. Add first-class branches for `cost-state`, `pr-link`, `bridge-session`,
   `ai-title`/`custom-title`/`agent-name` (cheap: all small, all top-level fields).
2. Capture `effort`, `promptId`, `output_tokens_details.thinking_tokens`,
   `speed`, and the attribution trio on existing branches; new DB columns or a
   JSON side-column per the V22 pattern.
3. Model compaction explicitly (`isCompactSummary`, `compactMetadata`) instead
   of relying on dedupe side effects.
4. Extend the system-subtype classifier for fallback/refusal/hook records; stop
   folding refusals into `"unknown"`.
5. Surface the schema fingerprinter's diff (it already sees all of this) in the
   dashboard/doctor output so the next drift is noticed without a manual audit.
