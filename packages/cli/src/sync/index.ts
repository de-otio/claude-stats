/**
 * Backend sync module — ORG AGGREGATE PLANE (client side).
 *
 * Syncs MINIMIZED local aggregates to the cloud AppSync API. Uses the built-in
 * `fetch` for GraphQL calls — no external dependencies.
 *
 * ‼️  Plane-separation invariant (non-negotiable): the ONLY payload this client
 *     can build is the {@link AggregateProjection} — per-`(period, cohort)`
 *     counts/totals computed LOCALLY (see `../org/aggregate.ts`). There is NO
 *     per-session path here: no `prompt_text`, `file_paths`, transcript content,
 *     session ids/paths, or key material can reach the org backend. The legacy
 *     `sessionToSyncInput` / `SyncSessionInput` per-session path and the prompt
 *     scan/redact export path were DELETED (not left dormant — reviews S6/F9),
 *     so aggregate-only is STRUCTURAL, not a runtime check.
 *
 * Sync flow:
 *   1. Read local sessions for linked accounts.
 *   2. Project them into minimized aggregates.
 *   3. Batch and send each batch via the aggregate GraphQL mutation.
 *   4. Update local sync state.
 *
 * See doc/analysis/team-app/06-sync-strategy.md and doc/analysis/data-planes/.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { Store } from "../store/index.js";
import type { AggregateProjection } from "@claude-stats/core/types/shard";
import { ensureValidTokens } from "./auth.js";
import { deriveAccountId, generateUserSalt } from "./hmac.js";
import { projectAggregates, AGGREGATE_SCHEMA_VERSION } from "../org/aggregate.js";

// Re-export submodules for convenience
export { deriveAccountId, generateUserSalt } from "./hmac.js";
export {
  type AuthTokens,
  type DeviceAuthResponse,
  loadTokens,
  saveTokens,
  clearTokens,
  initiateAuth,
  respondToChallenge,
  pollForTokens,
  refreshTokens,
  ensureValidTokens,
} from "./auth.js";

// ── Config types ────────────────────────────────────────────────────────────

export interface SyncConfig {
  /** AppSync GraphQL endpoint URL */
  endpoint: string;
  /** Cognito User Pool ID (e.g. us-east-1_XXXXXXXXX) */
  userPoolId: string;
  /** Cognito App Client ID */
  clientId: string;
  /** AWS region (e.g. us-east-1) */
  region: string;
}

export interface SyncResult {
  /** Number of aggregate records written to the backend. */
  aggregatesWritten: number;
  /** Number of aggregate records the backend reported as skipped/unchanged. */
  aggregatesSkipped: number;
  errors: string[];
}

// ── Config persistence ──────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), ".claude-stats");
const SYNC_CONFIG_FILE = path.join(CONFIG_DIR, "sync-config.json");

export interface PersistedSyncConfig {
  endpoint: string;
  userPoolId: string;
  clientId: string;
  region: string;
  userId?: string;
  userSalt?: string;
  enabled?: boolean;
  accountMappings?: Array<{
    accountUuid: string;
    accountId: string;
    label: string;
    shareWithTeams: boolean;
    // NOTE: no `sharePrompts` — the org plane is aggregate-only; there is no
    // prompt-sharing opt-in on the client (reviews S6/F9).
  }>;
  lastPushAt?: number | null;
  lastPullAt?: number | null;
}

/**
 * Load sync config from ~/.claude-stats/sync-config.json.
 * Environment variables take precedence over the file.
 * Returns null if no config is available.
 */
export function loadSyncConfig(): SyncConfig | null {
  // Environment variables take precedence
  const envEndpoint = process.env["CLAUDE_STATS_ENDPOINT"];
  const envPoolId = process.env["CLAUDE_STATS_COGNITO_POOL_ID"];
  const envClientId = process.env["CLAUDE_STATS_COGNITO_CLIENT_ID"];

  if (envEndpoint && envPoolId && envClientId) {
    const region = envPoolId.split("_")[0] ?? "us-east-1";
    return { endpoint: envEndpoint, userPoolId: envPoolId, clientId: envClientId, region };
  }

  try {
    const data = fs.readFileSync(SYNC_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(data) as PersistedSyncConfig;
    if (!parsed.endpoint || !parsed.userPoolId || !parsed.clientId) {
      return null;
    }
    return {
      endpoint: parsed.endpoint,
      userPoolId: parsed.userPoolId,
      clientId: parsed.clientId,
      region: parsed.region || parsed.userPoolId.split("_")[0] || "us-east-1",
    };
  } catch {
    return null;
  }
}

/**
 * Load the full persisted config (including userId, salt, account mappings).
 */
export function loadPersistedConfig(): PersistedSyncConfig | null {
  try {
    const data = fs.readFileSync(SYNC_CONFIG_FILE, "utf-8");
    return JSON.parse(data) as PersistedSyncConfig;
  } catch {
    return null;
  }
}

/**
 * Save sync config to disk. Merges with existing persisted config.
 */
export function saveSyncConfig(config: SyncConfig): void {
  const existing = loadPersistedConfig();
  const merged: PersistedSyncConfig = {
    ...existing,
    endpoint: config.endpoint,
    userPoolId: config.userPoolId,
    clientId: config.clientId,
    region: config.region,
    enabled: true,
  };

  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SYNC_CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Save full persisted config (used during setup to store userId, salt, etc.)
 */
export function savePersistedConfig(config: PersistedSyncConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SYNC_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Remove sync config (disconnect from cloud). Preserves userSalt so
 * re-linking produces the same accountId values.
 */
export function removeSyncConfig(): void {
  const existing = loadPersistedConfig();
  if (!existing) {
    try { fs.unlinkSync(SYNC_CONFIG_FILE); } catch { /* noop */ }
    return;
  }

  // Preserve only the userSalt for future re-link
  const preserved: Partial<PersistedSyncConfig> = {};
  if (existing.userSalt) {
    preserved.userSalt = existing.userSalt;
  }

  if (Object.keys(preserved).length > 0) {
    fs.writeFileSync(SYNC_CONFIG_FILE, JSON.stringify(preserved, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  } else {
    try { fs.unlinkSync(SYNC_CONFIG_FILE); } catch { /* noop */ }
  }
}

/**
 * Fetch backend configuration from the well-known discovery endpoint.
 *
 * @param baseUrl - The team's Claude Stats URL (e.g. https://stats.acme.com)
 * @returns SyncConfig if discovery succeeds, null otherwise
 */
export async function discoverConfig(baseUrl: string): Promise<SyncConfig | null> {
  const url = baseUrl.replace(/\/+$/, "") + "/.well-known/claude-stats.json";
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = (await response.json()) as {
      version?: number;
      appsyncEndpoint?: string;
      cognitoUserPoolId?: string;
      cognitoClientId?: string;
      region?: string;
    };

    if (!data.appsyncEndpoint || !data.cognitoUserPoolId || !data.cognitoClientId) {
      return null;
    }

    return {
      endpoint: data.appsyncEndpoint,
      userPoolId: data.cognitoUserPoolId,
      clientId: data.cognitoClientId,
      region: data.region ?? data.cognitoUserPoolId.split("_")[0] ?? "us-east-1",
    };
  } catch {
    return null;
  }
}

// ── GraphQL helpers ─────────────────────────────────────────────────────────

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{ message: string; errorType?: string }>;
}

/**
 * Execute a GraphQL query/mutation against the AppSync endpoint.
 */
async function graphql<T>(
  config: SyncConfig,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphQLResponse<T>> {
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AppSync request failed (${response.status}): ${body}`);
  }

  return (await response.json()) as GraphQLResponse<T>;
}

// ── GraphQL mutations ───────────────────────────────────────────────────────

/**
 * The ONLY write mutation this client issues for session-derived data. It
 * accepts an array of minimized aggregates — never a per-session payload. The
 * server-side schema (Phase F server task) likewise accepts ONLY this shape and
 * rejects any per-session input (review F9).
 */
const SYNC_AGGREGATES_MUTATION = `
  mutation SyncAggregates($input: [AggregateInput!]!) {
    syncAggregates(input: $input) {
      itemsWritten
      itemsSkipped
    }
  }
`;

const LINK_ACCOUNT_MUTATION = `
  mutation LinkAccount($input: LinkAccountInput!) {
    linkAccount(input: $input) {
      accountId
      label
    }
  }
`;

const UPDATE_PROFILE_MUTATION = `
  mutation UpdateProfile($input: UpdateProfileInput!) {
    updateProfile(input: $input) {
      userId
      displayName
    }
  }
`;

// ── Aggregate sync engine ─────────────────────────────────────────────────────

const BATCH_SIZE = 25;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 100;

/** Cohort id for sessions with no linked account (should not occur — see filter below). */
const UNATTRIBUTED_COHORT = "unattributed";

/**
 * Build the aggregate-only payload for the given sessions.
 *
 * Sessions are filtered to LINKED accounts only (matching the prior privacy
 * posture: data for accounts the user has not linked is never sent), then
 * projected LOCALLY into minimized {@link AggregateProjection} records. This is
 * the whole client→server payload surface for session data — structurally
 * incapable of carrying prompt/transcript/path/key material.
 *
 * Exported so `--dry-run` and tests can inspect EXACTLY what would be sent
 * without hitting the network. Deterministic: bucketing uses each session's own
 * timestamp, never a wall clock.
 */
export function buildAggregatePayload(
  store: Store,
  persisted: PersistedSyncConfig,
  periodKind: AggregateProjection["periodKind"] = "day",
): AggregateProjection[] {
  const userSalt = persisted.userSalt;
  const mappings = persisted.accountMappings ?? [];
  if (!userSalt || mappings.length === 0) return [];

  const linkedUuids = new Set(mappings.map((m) => m.accountUuid));
  const cohortCache = new Map<string, string>();
  for (const m of mappings) cohortCache.set(m.accountUuid, m.accountId);

  const sessions = store
    .getSessions({ includeCI: true, includeDeleted: false })
    // Only sessions whose account the user has explicitly linked.
    .filter((s) => s.account_uuid !== null && s.account_uuid !== undefined && linkedUuids.has(s.account_uuid));

  return projectAggregates(sessions, {
    periodKind,
    cohortIdFor: (accountUuid) => {
      let cohort = cohortCache.get(accountUuid);
      if (!cohort) {
        cohort = deriveAccountId(accountUuid, userSalt);
        cohortCache.set(accountUuid, cohort);
      }
      return cohort;
    },
    unattributedCohortId: UNATTRIBUTED_COHORT,
    schemaVersion: AGGREGATE_SCHEMA_VERSION,
  });
}

/**
 * Sync minimized local aggregates to the cloud.
 *
 * Aggregates are idempotent upserts keyed by `(period, cohort)`, so — unlike the
 * removed per-session path — there is no version/conflict dance: a batch either
 * writes or is retried on transient transport failure. No per-session,
 * prompt, transcript, path, or key material is ever transmitted.
 */
export async function syncAggregates(
  store: Store,
  config: SyncConfig,
): Promise<SyncResult> {
  const tokens = await ensureValidTokens(config);
  if (!tokens) {
    return {
      aggregatesWritten: 0,
      aggregatesSkipped: 0,
      errors: ["Not authenticated. Run 'claude-stats setup' first."],
    };
  }

  const persisted = loadPersistedConfig();
  if (!persisted?.userSalt || !persisted?.accountMappings?.length) {
    return {
      aggregatesWritten: 0,
      aggregatesSkipped: 0,
      errors: ["No linked accounts. Run 'claude-stats setup' first."],
    };
  }

  const aggregates = buildAggregatePayload(store, persisted);
  if (aggregates.length === 0) {
    return { aggregatesWritten: 0, aggregatesSkipped: 0, errors: [] };
  }

  const result: SyncResult = {
    aggregatesWritten: 0,
    aggregatesSkipped: 0,
    errors: [],
  };

  const batches: AggregateProjection[][] = [];
  for (let i = 0; i < aggregates.length; i += BATCH_SIZE) {
    batches.push(aggregates.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    let retries = 0;
    while (retries <= MAX_RETRIES) {
      try {
        const response = await graphql<{
          syncAggregates: { itemsWritten: number; itemsSkipped: number };
        }>(config, tokens.accessToken, SYNC_AGGREGATES_MUTATION, { input: batch });

        if (response.errors?.length) {
          result.errors.push(...response.errors.map((e) => e.message));
          break;
        }

        const synced = response.data?.syncAggregates;
        if (synced) {
          result.aggregatesWritten += synced.itemsWritten;
          result.aggregatesSkipped += synced.itemsSkipped;
        }
        break; // batch done
      } catch (err) {
        retries++;
        if (retries > MAX_RETRIES) {
          result.errors.push(
            `Batch failed after ${MAX_RETRIES} retries: ${(err as Error).message}`,
          );
          break;
        }
        await new Promise((r) =>
          setTimeout(r, BASE_BACKOFF_MS * Math.pow(2, retries - 1)),
        );
      }
    }
  }

  // Update last push timestamp on success.
  if (result.errors.length === 0 && result.aggregatesWritten > 0) {
    const updated = loadPersistedConfig();
    if (updated) {
      updated.lastPushAt = Date.now();
      savePersistedConfig(updated);
    }
  }

  return result;
}

/**
 * Get the current sync status (last sync times, pending item count).
 */
export function getSyncStatus(store: Store): {
  enabled: boolean;
  endpoint: string | null;
  userId: string | null;
  linkedAccounts: number;
  lastPushAt: number | null;
  lastPullAt: number | null;
  pendingSessions: number;
} {
  const persisted = loadPersistedConfig();
  const config = loadSyncConfig();

  if (!persisted || !config) {
    return {
      enabled: false,
      endpoint: null,
      userId: null,
      linkedAccounts: 0,
      lastPushAt: null,
      lastPullAt: null,
      pendingSessions: 0,
    };
  }

  // Count sessions newer than last push
  const lastPushAt = persisted.lastPushAt ?? 0;
  const pendingSessions = lastPushAt > 0
    ? store.getSessions({ since: lastPushAt, includeCI: true, includeDeleted: false }).length
    : store.getSessions({ includeCI: true, includeDeleted: false }).length;

  return {
    enabled: persisted.enabled ?? false,
    endpoint: persisted.endpoint ?? null,
    userId: persisted.userId ?? null,
    linkedAccounts: persisted.accountMappings?.length ?? 0,
    lastPushAt: persisted.lastPushAt ?? null,
    lastPullAt: persisted.lastPullAt ?? null,
    pendingSessions,
  };
}
