# 02 — Transcript Schema Changes

All observations in this document are **[live]** (a sample of the most recent
session files, Claude Code 2.1.181–2.1.252) unless marked otherwise. Coverage
statements are qualitative, from that sample, and are indicative, not
exhaustive.

## 2.1 Entry types: 17 observed, 4 parsed

The parser dispatches on `queue-operation`, `user`, `system`, `assistant`
(`packages/core/src/parser/session.ts:224-291`). Everything else falls through
silently — no counter, no warning (the schema fingerprinter at
`packages/cli/src/schema/monitor.ts` does record them, but nothing surfaces it).

Observed types, by value to us:

### High value — carry data we currently derive or can't get

| Type | Fields | Why it matters |
|------|--------|----------------|
| `cost-state` | `totalCostUSD`, `modelUsage` (per model: `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`, `webSearchRequests`, `costUSD`), `totalAPIDuration`, `totalAPIDurationWithoutRetries`, `totalToolDuration`, `totalDuration`, `totalLinesAdded`, `totalLinesRemoved`, `startTime`, `hasUnknownModelCost` | Claude Code's **own per-session cost rollup**. Ground truth to validate our derived cost pipeline; lines added/removed and durations are raw material for activity and time estimates. Appears rarely — likely written on session end/checkpoint; do not rely on it being present for live sessions. |
| `pr-link` | `prNumber`, `prUrl`, `prRepository`, `timestamp`, `sessionId` | Session→PR linkage recorded natively, per session. Native work-item linkage that would otherwise have to be inferred. Complements the Jira-regex-only ticket detection (`packages/core/src/tickets.ts:22-25`). |
| `bridge-session` | `bridgeSessionId`, `ownerAccountUuid`, `ownerOrganizationUuid`, `lastSequenceNum` | Account/org UUIDs **inside the transcript**. A far stronger attribution signal than the `GrowthbookExperimentEvent` telemetry parse (`packages/cli/src/parser/telemetry.ts:155-170`) the [account-attribution](../account-attribution/) chain leans on. Present on bridge-connected (remote/desktop-linked) sessions only. |
| `ai-title` / `custom-title` | `aiTitle` / `customTitle`, `sessionId` | Human-readable session titles. Immediate UX win for `list_sessions`, the dashboard, and recaps (which currently synthesize titles from prompts). |
| `agent-name` | `agentName`, `sessionId` | Named-agent identity for team/multi-agent sessions. |
| `file-history-snapshot` / `file-history-delta` | `messageId`, `snapshot` / `snapshotMessageId`, `trackingPath`, `backup`, `timestamp` | Per-edit file tracking with backup pointers — an edit/rework signal at message granularity. |

### Metadata / state markers

| Type | Fields | Notes |
|------|--------|-------|
| `mode` / `permission-mode` | `mode` / `permissionMode`, `sessionId` | Mode transitions (incl. plan mode) as first-class events. |
| `last-prompt` | `leafUuid`, `lastPrompt`, `sessionId` | Last user prompt marker (typed in `RawSessionEntry` already, never consumed). |
| `attachment` | full envelope + `attachment` | A large share of all entries in the sample. System-injected context (file reads, reminders). Correctly ignorable for token accounting (no `usage`), but note the volume when reasoning about file sizes/offsets. |
| `atis-latch` | `atis`, `sessionId` | Internal latch state; no known analytical value yet. |

## 2.2 New fields on entry types we already parse

### Assistant entries

| Field | Coverage in sample | Value |
|-------|--------------------|-------|
| `effort` | nearly all | **Reasoning-effort level per request.** Enables effort-vs-cost/outcome analytics. |
| `requestId` | essentially all | Stable API request id — joins to OTel/API-side records. |
| `attributionMcpServer` / `attributionMcpTool` / `attributionSkill` | sparse | "Which MCP server / skill caused this request" — direct spend attribution for skills and MCP servers. |
| `supersedesUuids` | rare | Message retraction/replacement — affects dedupe logic (`session.ts:291-307`). |

### User entries

| Field | Coverage | Value |
|-------|----------|-------|
| `promptId` | every user entry | Exact turn identity. Replaces the "real prompt" heuristic (`session.ts:243-256`) and the inexact `prompt_text IS NOT NULL` backfill proxy (`packages/cli/src/store/index.ts:579-586`) for all new data. |
| `toolUseResult` + `sourceToolAssistantUUID` | most user entries | Tool results now carry an explicit pointer to the assistant message that issued the call — replaces the "attribute error to previous assistant message" positional heuristic (`session.ts:232-242`). |
| `isCompactSummary` + `isVisibleInTranscriptOnly` | sparse | **Compaction is now explicit.** We currently handle compaction only implicitly via duplicate-uuid dedupe. |
| `origin`, `promptSource`, `permissionMode` | sparse | Where the prompt came from (user-typed vs injected) and the mode it ran under. |
| `toolDenialKind` | sparse | Permission denials as data — friction metric. |
| `queueSkipAttachments`, `classifierMetaLines`, `turnCompanion`, `mcpMeta` | sparse | Not yet analytically interesting; fingerprint-watch only. |

### System entries (subtypes greatly expanded)

The parser handles only `subtype === "api_error"` with retry sources
(`session.ts:44-53`). Now also observed:

| Signal | Fields | Value |
|--------|--------|-------|
| Compaction record | `compactMetadata`, `logicalParentUuid`, `durationMs`, `messageCount` | When/why compaction ran, how much it collapsed — pairs with [context-carry-cost](../context-carry-cost/) and the "oversized-context cache re-reads dominate spend" finding. |
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
| **`output_tokens_details.thinking_tokens`** | **no** | Present on most entries. Closes the "thinking tokens possibly uncounted" gap in [../06-limitations.md](../06-limitations.md). Thinking tokens are billed as output tokens, so cost math is already right — the value is the *breakdown* (thinking share per model/effort). |
| **`speed`** | **no** | Fast-mode dimension (`standard` / `fast`). Fast mode is a real product surface now (a billing/limits dimension per **[docs]**); we should at minimum record the distribution. |
| **`iterations`** | **no** | New; semantics unconfirmed (speculation/retry iterations?). Fingerprint-watch and record raw. |

## 2.4 Assumptions that survived

Worth stating what did **not** break:

- **Subagent layout:** separate files under `subagents/` still exist and the
  scanner's directory-based detection (`packages/cli/src/scanner/index.ts:54-67`)
  still matches reality. `isSidechain` remains emitted-but-redundant for us.
- **Session identity:** `sessionId` on every entry; filename still not load-bearing.
- **Envelope basics:** `uuid`/`parentUuid`/`timestamp`/`version`/`gitBranch`/
  `cwd`/`entrypoint` all intact; `slug` now on most entries.
- **Usage location:** `message.usage` on every assistant entry — the core
  accounting path is unbroken.
- **Duplicate-uuid replay** on resume/compaction still occurs; the dedupe at
  `session.ts:291-307` is still necessary and correct.
