# 04 - ClaudeMeter API Analysis

Technical analysis of how [ClaudeMeter](https://github.com/eddmann/ClaudeMeter) (macOS menu bar app) obtains real-time usage percentages and reset countdowns.

## Architecture

ClaudeMeter is a native macOS SwiftUI menu bar app (macOS 14+). It does NOT read local JSONL files and does NOT use the official Anthropic API (api.anthropic.com). It calls **claude.ai's internal web API** directly.

## Authentication

Browser session cookie extraction. The user manually copies their `sessionKey` cookie from claude.ai using browser DevTools. The token starts with `sk-ant-` and is stored in the **macOS Keychain**.

Every HTTP request includes:
```
Cookie: sessionKey=sk-ant-...
```

Plus browser-mimicking headers to avoid Cloudflare bot detection:
```
Accept: application/json
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ...
Referer: https://claude.ai
Origin: claude.ai
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
```

## API Endpoints

### 1. Get Organizations

```
GET https://claude.ai/api/organizations
```

Returns an array of organization objects. The app takes the first org's UUID.

### 2. Get Usage Data (the key endpoint)

```
GET https://claude.ai/api/organizations/{organizationUUID}/usage
```

Response:
```json
{
  "five_hour": {
    "utilization": 45.2,
    "resets_at": "2025-11-14T18:30:00.000Z"
  },
  "seven_day": {
    "utilization": 12.8,
    "resets_at": "2025-11-21T00:00:00.000Z"
  },
  "seven_day_sonnet": {
    "utilization": 8.5,
    "resets_at": "2025-11-21T00:00:00.000Z"
  }
}
```

Three usage categories:
- `five_hour` -- 5-hour rolling session limit
- `seven_day` -- 7-day weekly allocation (all models)
- `seven_day_sonnet` -- Sonnet-specific 7-day limit (can be null)

## How Percentages Work

**The server returns them directly.** The `utilization` field is a float 0-100. ClaudeMeter does NOT calculate usage percentages -- it displays what the API returns.

## How Reset Countdowns Work

**The server returns the exact reset timestamp** as ISO 8601 in `resets_at`. ClaudeMeter uses Swift's `RelativeDateTimeFormatter` to compute human-readable relative time (e.g., "in 3 hours").

## At-Risk Calculation

The one thing ClaudeMeter calculates locally: it divides usage percentage by elapsed-time percentage within the window. If the ratio exceeds 1.2x, you're consuming faster than sustainable and get flagged "at risk."

## Polling

Configurable intervals: 1, 5, or 10 minutes (minimum 60s). Exponential backoff retry on failure (max 3 attempts, 2s base delay for network errors, 3s for rate limits).

## Risks and Considerations

| Risk | Detail |
|------|--------|
| **Undocumented API** | `claude.ai/api/organizations/{id}/usage` is internal. No stability guarantee. |
| **ToS compliance** | Scraping session cookies and calling internal APIs may violate Anthropic's Terms of Service. |
| **Cookie expiry** | Session keys expire; users must re-extract periodically. |
| **Cloudflare blocking** | Bot detection headers required; could be blocked at any time. |
| **Single-platform** | macOS Keychain dependency; pattern doesn't port to Linux/Windows. |

## Implications for claude-stats

### Could claude-stats use this API?

Technically yes. The endpoint returns exactly the data users want: real-time utilization percentage and reset countdown. This would fill the biggest gap in claude-stats relative to rate-limit-aware extensions.

### Implementation considerations

1. **Authentication:** Would need to read the sessionKey from the user's browser cookies or ask them to provide it. Cross-platform cookie extraction is fragile.
2. **Risk:** Relying on an undocumented API for a core feature is brittle. Should be opt-in.
3. **Alternative:** Claude Code's `/usage` command already surfaces this data. A hook or wrapper could capture it periodically without calling the web API.
4. **Hybrid approach:** Use JSONL-based analysis for historical data (reliable) and optionally poll the web API for live rate limit status (best-effort, clearly labeled as unofficial).

### Recommended approach

If implementing, offer as an **opt-in** feature with clear warnings:
- Require explicit user action to enable (provide session key)
- Label the data as "live estimate" vs. the JSONL-derived "historical" data
- Gracefully degrade if the API changes or becomes unavailable
- Store the session key securely (OS keychain on macOS, secret-service on Linux)
