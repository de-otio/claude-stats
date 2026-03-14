/**
 * Backend sync module.
 *
 * Syncs local SQLite sessions to the cloud AppSync API.
 * Uses Node 18+ built-in fetch for GraphQL calls --- no external dependencies.
 *
 * Sync flow:
 *   1. Get sessions from local SQLite newer than last sync timestamp
 *   2. Map to SyncSessionInput format (HMAC-derived accountId, secret-scanned prompts)
 *   3. Batch in groups of 25
 *   4. Send each batch via GraphQL mutation
 *   5. Handle conflicts (re-fetch, merge, retry)
 *   6. Update local sync state
 *
 * See doc/analysis/team-app/06-sync-strategy.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import crypto from "node:crypto";

import type { Store, SessionRow } from "../store/index.js";
import type { SyncSessionInput } from "@claude-stats/core/types/api";
import { estimateCost } from "@claude-stats/core/pricing";
import { ensureValidTokens } from "./auth.js";
import { deriveAccountId, generateUserSalt } from "./hmac.js";
import { scanPrompt, containsSecrets, redactSecrets, addCustomPatterns, resetPatterns } from "./secret-scan.js";

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
export {
  type SecretPattern,
  type ScanResult,
  addCustomPatterns,
  resetPatterns,
  containsSecrets,
  scanPrompt,
  redactSecrets,
} from "./secret-scan.js";

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
  sessionsWritten: number;
  sessionsSkipped: number;
  conflicts: number;
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
    sharePrompts: boolean;
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

const SYNC_SESSIONS_MUTATION = `
  mutation SyncSessions($input: [SyncSessionInput!]!) {
    syncSessions(input: $input) {
      itemsWritten
      itemsSkipped
      conflicts {
        key
        serverVersion
        serverItem
      }
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

// ── Session mapping ─────────────────────────────────────────────────────────

/**
 * Convert a local SessionRow to SyncSessionInput.
 */
function sessionToSyncInput(
  row: SessionRow,
  accountId: string,
  version: number,
): SyncSessionInput {
  let toolUseCounts: Record<string, number> | undefined;
  try {
    const parsed = JSON.parse(row.tool_use_counts) as Array<{ name: string; count: number }>;
    if (parsed.length > 0) {
      toolUseCounts = {};
      for (const { name, count } of parsed) {
        toolUseCounts[name] = count;
      }
    }
  } catch {
    // Malformed tool_use_counts -- skip
  }

  let models: string[] = [];
  try {
    models = JSON.parse(row.models) as string[];
  } catch {
    // Malformed models -- default to empty
  }

  // Compute projectPathHash from project_path (privacy-preserving, not reversible)
  const projectPathHash = crypto
    .createHash("sha256")
    .update(row.project_path)
    .digest("hex");

  // Derive projectId from repo_url if available
  let projectId: string | undefined;
  if (row.repo_url) {
    projectId = parseProjectId(row.repo_url) ?? undefined;
  }

  // Estimate cost from token counts
  const primaryModel = models[0] ?? "claude-sonnet-4-20250514";
  const cost = estimateCost(
    primaryModel,
    row.input_tokens,
    row.output_tokens,
    row.cache_read_tokens,
    row.cache_creation_tokens,
  );

  return {
    sessionId: row.session_id,
    projectId,
    projectPathHash,
    firstTimestamp: row.first_timestamp ?? 0,
    lastTimestamp: row.last_timestamp ?? 0,
    claudeVersion: row.claude_version ?? "unknown",
    entrypoint: row.entrypoint ?? "unknown",
    promptCount: row.prompt_count,
    assistantMessageCount: row.assistant_message_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationTokens: row.cache_creation_tokens || undefined,
    cacheReadTokens: row.cache_read_tokens || undefined,
    toolUseCounts,
    models,
    accountId,
    isSubagent: row.is_subagent === 1,
    parentSessionId: row.parent_session_id ?? undefined,
    thinkingBlocks: row.thinking_blocks || undefined,
    estimatedCost: cost,
    _version: version,
  };
}

/**
 * Extract "owner/repo" from a git remote URL.
 */
function parseProjectId(remoteUrl: string): string | null {
  // SSH: git@github.com:owner/repo.git
  const ssh = remoteUrl.match(/git@github\.com:(.+?)(?:\.git)?$/);
  if (ssh) return ssh[1] ?? null;

  // HTTPS: https://github.com/owner/repo.git
  const https = remoteUrl.match(/github\.com\/(.+?)(?:\.git)?$/);
  if (https) return https[1] ?? null;

  return null;
}

// ── Sync engine ─────────────────────────────────────────────────────────────

const BATCH_SIZE = 25;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 100;

/**
 * Sync local sessions to the cloud.
 *
 * Pushes sessions updated since the last sync timestamp. Each session
 * is mapped to a SyncSessionInput with an HMAC-derived accountId.
 * Batches are sent in groups of 25. Conflicts are retried with
 * exponential backoff up to MAX_RETRIES times.
 */
export async function syncSessions(
  store: Store,
  config: SyncConfig,
): Promise<SyncResult> {
  // Ensure we have valid auth tokens
  const tokens = await ensureValidTokens(config);
  if (!tokens) {
    return {
      sessionsWritten: 0,
      sessionsSkipped: 0,
      conflicts: 0,
      errors: ["Not authenticated. Run 'claude-stats setup' first."],
    };
  }

  // Load persisted config for userId/salt/account mappings
  const persisted = loadPersistedConfig();
  if (!persisted?.userSalt || !persisted?.accountMappings?.length) {
    return {
      sessionsWritten: 0,
      sessionsSkipped: 0,
      conflicts: 0,
      errors: ["No linked accounts. Run 'claude-stats setup' first."],
    };
  }

  // Build accountUuid -> accountId lookup
  const accountIdMap = new Map<string, string>();
  for (const mapping of persisted.accountMappings) {
    accountIdMap.set(mapping.accountUuid, mapping.accountId);
  }

  // Get sessions updated since last sync
  const lastPushAt = persisted.lastPushAt ?? 0;
  const sessions = store.getSessions({
    since: lastPushAt > 0 ? lastPushAt : undefined,
    includeCI: true,
    includeDeleted: false,
  });

  if (sessions.length === 0) {
    return { sessionsWritten: 0, sessionsSkipped: 0, conflicts: 0, errors: [] };
  }

  // Map sessions to sync inputs, skipping those without a linked account
  const syncInputs: SyncSessionInput[] = [];
  let skipped = 0;

  for (const session of sessions) {
    const accountUuid = session.account_uuid;
    if (!accountUuid) {
      skipped++;
      continue;
    }

    // Derive accountId (use cached mapping or compute on the fly)
    let accountId = accountIdMap.get(accountUuid);
    if (!accountId) {
      accountId = deriveAccountId(accountUuid, persisted.userSalt);
      accountIdMap.set(accountUuid, accountId);
    }

    syncInputs.push(sessionToSyncInput(session, accountId, 1));
  }

  if (syncInputs.length === 0) {
    return { sessionsWritten: 0, sessionsSkipped: skipped, conflicts: 0, errors: [] };
  }

  // Split into batches of BATCH_SIZE
  const result: SyncResult = {
    sessionsWritten: 0,
    sessionsSkipped: skipped,
    conflicts: 0,
    errors: [],
  };

  const batches: SyncSessionInput[][] = [];
  for (let i = 0; i < syncInputs.length; i += BATCH_SIZE) {
    batches.push(syncInputs.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    let retries = 0;
    let currentBatch = batch;

    while (retries <= MAX_RETRIES && currentBatch.length > 0) {
      try {
        const response = await graphql<{
          syncSessions: {
            itemsWritten: number;
            itemsSkipped: number;
            conflicts: Array<{
              key: string;
              serverVersion: number;
              serverItem: unknown;
            }>;
          };
        }>(config, tokens.accessToken, SYNC_SESSIONS_MUTATION, {
          input: currentBatch,
        });

        if (response.errors?.length) {
          result.errors.push(...response.errors.map((e) => e.message));
          break;
        }

        const syncResult = response.data?.syncSessions;
        if (syncResult) {
          result.sessionsWritten += syncResult.itemsWritten;
          result.sessionsSkipped += syncResult.itemsSkipped;

          if (syncResult.conflicts.length > 0) {
            result.conflicts += syncResult.conflicts.length;

            // Merge conflicts: bump _version to server's version + 1 and retry
            currentBatch = syncResult.conflicts
              .map((conflict) => {
                const original = currentBatch.find((s) => s.sessionId === conflict.key);
                if (!original) return null;
                return { ...original, _version: conflict.serverVersion + 1 };
              })
              .filter((s): s is SyncSessionInput => s !== null);

            retries++;
            if (retries <= MAX_RETRIES) {
              await new Promise((r) =>
                setTimeout(r, BASE_BACKOFF_MS * Math.pow(2, retries - 1)),
              );
              continue;
            }
          }
        }

        break; // Success or no remaining conflicts
      } catch (err) {
        retries++;
        if (retries > MAX_RETRIES) {
          result.errors.push(
            `Batch failed after ${MAX_RETRIES} retries: ${(err as Error).message}`,
          );
          break;
        }
        // Exponential backoff on transient failures
        await new Promise((r) =>
          setTimeout(r, BASE_BACKOFF_MS * Math.pow(2, retries - 1)),
        );
      }
    }
  }

  // Update last push timestamp on success
  if (result.errors.length === 0 && result.sessionsWritten > 0) {
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
