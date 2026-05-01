# 02 — Data Integration

## Zero-Collection-Change Architecture

The energy dashboard requires **no changes** to:
- JSONL parsing (`packages/core/src/parser/`)
- Data collection (`packages/cli/src/aggregator/`)
- SQLite schema (`packages/cli/src/store/`)
- Session file watching (`packages/cli/src/extension/collector.ts`)

All needed data is already in the `messages` and `sessions` tables (see `SessionRow` and `MessageRow` in `packages/cli/src/store/index.ts`):

```sql
-- messages table (per-message granularity — PRIMARY source for energy calc):
--   model              TEXT     -- e.g. "claude-opus-4-6" (nullable)
--   input_tokens       INTEGER
--   output_tokens      INTEGER  -- includes thinking tokens
--   cache_creation_tokens INTEGER
--   cache_read_tokens  INTEGER
--   ephemeral_5m_cache_tokens INTEGER
--   ephemeral_1h_cache_tokens INTEGER
--   thinking_blocks    INTEGER  -- count, not token volume
--   inference_geo      TEXT     -- data center region (nullable)

-- sessions table (aggregated — useful for quick summaries):
--   models             TEXT     -- JSON array, e.g. '["claude-opus-4-6","claude-sonnet-4-5"]'
--   input_tokens       INTEGER
--   output_tokens      INTEGER
--   cache_creation_tokens INTEGER
--   cache_read_tokens  INTEGER
--   thinking_blocks    INTEGER
--   project_path       TEXT
--   first_timestamp    INTEGER  -- epoch ms
--   last_timestamp     INTEGER  -- epoch ms
--   active_duration_ms INTEGER  -- nullable, excludes idle > 30 min
```

**Important:** Sessions store `models` as a JSON array, not a single model field. A session can use multiple models (e.g., Opus for planning, Sonnet for execution). Energy must be calculated at the **message level** (where `model` is a single string) and aggregated up — not at the session level with a single model assumption.

## Integration Points

### 1. Core Package: Energy Calculator (`packages/core/src/energy.ts`)

New pure-function module — no dependencies on storage or I/O:

```typescript
// Input: maps directly to MessageRow columns
interface TokenUsage {
  model: string;                   // MessageRow.model
  inputTokens: number;             // MessageRow.input_tokens
  outputTokens: number;            // MessageRow.output_tokens (includes thinking)
  cacheCreationTokens: number;     // MessageRow.cache_creation_tokens
  cacheReadTokens: number;         // MessageRow.cache_read_tokens
  ephemeral5mCacheTokens: number;  // MessageRow.ephemeral_5m_cache_tokens
  ephemeral1hCacheTokens: number;  // MessageRow.ephemeral_1h_cache_tokens
  thinkingBlocks?: number;         // For reporting context, not calculation
  inferenceGeo?: string | null;    // For auto-detecting grid region
}

// Output: derived energy metrics
interface EnergyEstimate {
  energyWh: number;          // Raw inference energy
  totalEnergyWh: number;     // With PUE
  co2Grams: number;          // With grid intensity
  equivalents: EnvironmentalEquivalents;
  detectedRegion?: string;   // From inference_geo, if available
}

function estimateEnergy(usage: TokenUsage, config?: EnergyConfig): EnergyEstimate;
function aggregateEnergy(estimates: EnergyEstimate[]): EnergyEstimate;
```

**No `estimateSessionEnergy` function** — sessions contain multiple models in a JSON array (`models` column), so there's no single model to look up. Always estimate at the message level and aggregate. The dashboard aggregator already iterates messages; we piggyback on that loop.

Place this in `packages/core/` so it's available to CLI, frontend, and extension without duplication.

### 2. Dashboard Aggregator (`packages/cli/src/dashboard/index.ts`)

Add energy fields to the existing `DashboardData` interface:

```typescript
// Add to existing DashboardData
interface DashboardData {
  // ... existing fields ...
  energy: {
    summary: {
      totalEnergyWh: number;
      totalCO2Grams: number;
      equivalents: EnvironmentalEquivalents;
      config: { pue: number; gridIntensity: number; region: string };
    };
    byDay: Array<{ date: string; energyWh: number; co2Grams: number }>;
    byModel: Array<{ model: string; energyWh: number; co2Grams: number; pct: number }>;
    byProject: Array<{ project: string; energyWh: number; co2Grams: number }>;
    cacheImpact: {
      energySavedWh: number;       // Energy avoided by cache hits
      co2SavedGrams: number;
      cacheEfficiencyPct: number;  // % of tokens served from cache
    };
    thinkingImpact: {
      sessionsWithThinking: number;    // Count of sessions with thinking_blocks > 0
      pctEnergyFromThinking: number;   // Approximate — based on output token share
    };
    inferenceGeo: {
      detected: Record<string, number>;  // region → message count
      coveragePct: number;               // % of messages with inference_geo
    };
  };
}
```

This piggybacks on the existing aggregation pass — the dashboard builder already iterates over all sessions/messages for the selected period. Adding energy calculation to that loop is O(1) additional work per message.

### 3. CLI Reporter (`packages/cli/src/reporter/index.ts`)

Add an energy section to the terminal summary output:

```
Energy Impact (estimated, ±55%)
───────────────────────────────
  Total energy:     12.4 Wh  (6.2–19.2 Wh)
  CO₂ equivalent:   2.9 g   (1.4–4.4 g)
  Cache savings:     3.1 Wh  (20% reduction)
  ≈ 52 Google searches equivalent
  ≈ 1.2 smartphone charges
  Region: EU Average (230 gCO₂/kWh) [auto-detected]
```

### 4. Extension Status Bar

Add optional energy display alongside existing token count:

```
  🌿 4.6g CO₂  |  📊 125K tokens
```

Configurable via `claude-stats.showEnergyInStatusBar` setting.

### 5. Frontend Dashboard Page

New page component — see [03-dashboard-design.md](03-dashboard-design.md).

## Data Flow

```
Existing data (no changes)                    New computation layer
━━━━━━━━━━━━━━━━━━━━━━━━━                    ━━━━━━━━━━━━━━━━━━━━

~/.claude/projects/*.jsonl
        ↓
  Parser → messages table ──→ estimateEnergy() ──→ EnergyEstimate (per message)
        ↓                                              ↓
  Aggregator → sessions                    aggregateEnergy() (sum)
        ↓                                              ↓
  Dashboard builder ────────→ energy aggregation ──→ DashboardData.energy
        ↓                                              ↓
  Reporter / Frontend / Extension ← ← ← ← ← ← ← ← ←┘
```

## Configuration Storage

Energy config stored in the existing SQLite database as a JSON blob in a new `config` table, or simpler: as VS Code extension settings + CLI flags.

```typescript
// CLI: claude-stats report --region "US West" --pue 1.15
// Extension: claude-stats.energyRegion, claude-stats.energyPue
// Frontend: settings page with region dropdown
```

Default config should work with zero configuration. Power users can tune it.
