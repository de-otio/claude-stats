/**
 * Backend sync module — ORG AGGREGATE PLANE (client side).
 *
 * Syncs MINIMIZED local aggregates to the cloud AppSync API. Uses the built-in
 * `fetch` for GraphQL calls — no external dependencies.
 *
 * ‼️  Plane-separation invariant (non-negotiable): the ONLY payload this client
 *     can build is the {@link AggregateSyncInput} — per-`(period)` counts/totals
 *     computed LOCALLY (see `projectUserAggregates` in `../org/aggregate.ts`),
 *     matching the deployed `syncAggregate` mutation (userId is server-forced
 *     from the JWT). There is NO per-session path here: no `prompt_text`,
 *     `file_paths`, transcript content, session ids/paths, or key material can
 *     reach the org backend. The legacy `sessionToSyncInput` / `SyncSessionInput`
 *     per-session path was DELETED (not left dormant — reviews S6/F9), so
 *     aggregate-only is STRUCTURAL, not a runtime check.
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
import type { AggregateSyncInput } from "@claude-stats/core/types/api";
import { ensureValidTokens } from "./auth.js";
import { deriveAccountId, generateUserSalt } from "./hmac.js";
import { projectUserAggregates } from "../org/aggregate.js";

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

/**
 * One linked local account. Selecting accounts to link is what populates the
 * `syncAggregate` payload: `buildAggregatePayload` includes only sessions whose
 * `account_uuid` is in a mapping, and stamps the derived (never-raw) `accountId`.
 * `shareWithTeams` reserves an opt-out flag; today every mapping is shared.
 * NOTE: no `sharePrompts` — the org plane is aggregate-only; there is no
 * prompt-sharing opt-in on the client (reviews S6/F9).
 */
export interface AccountMapping {
  accountUuid: string;
  accountId: string;
  label: string;
  shareWithTeams: boolean;
}

export interface PersistedSyncConfig {
  endpoint: string;
  userPoolId: string;
  clientId: string;
  region: string;
  userId?: string;
  userSalt?: string;
  enabled?: boolean;
  accountMappings?: AccountMapping[];
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
const SYNC_AGGREGATE_MUTATION = `
  mutation SyncAggregate($input: [AggregateSyncInput!]!) {
    syncAggregate(input: $input) {
      itemsWritten
      itemsSkipped
      conflicts { key serverVersion }
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

/**
 * Build the aggregate-only payload for the given sessions.
 *
 * Sessions are filtered to LINKED accounts only (matching the prior privacy
 * posture: data for accounts the user has not linked is never sent), then
 * projected LOCALLY into minimized {@link AggregateSyncInput} records (per-day
 * totals). This is the whole client→server payload surface for session data —
 * structurally incapable of carrying prompt/transcript/path/key material.
 *
 * Exported so `--dry-run` and tests can inspect EXACTLY what would be sent
 * without hitting the network. Deterministic: bucketing uses each session's own
 * timestamp, never a wall clock.
 */
export function buildAggregatePayload(
  store: Store,
  persisted: PersistedSyncConfig,
  periodKind: "day" | "week" | "month" = "day",
): AggregateSyncInput[] {
  const userSalt = persisted.userSalt;
  const mappings = persisted.accountMappings ?? [];
  if (!userSalt || mappings.length === 0) return [];

  const linkedUuids = new Set(mappings.map((m) => m.accountUuid));

  const sessions = store
    .getSessions({ includeCI: true, includeDeleted: false })
    // Only sessions whose account the user has explicitly linked.
    .filter((s) => s.account_uuid !== null && s.account_uuid !== undefined && linkedUuids.has(s.account_uuid));

  // The deployed key is (userId, period) — one row per day — so we roll the
  // day up across all linked accounts. Stamp the primary linked account's
  // derived accountId (a stable HMAC handle, never the raw uuid); the server
  // key ignores it, it only populates the AggregatesByAccount GSI.
  const primary = mappings[0];
  if (!primary) return [];
  const accountId =
    primary.accountId || deriveAccountId(primary.accountUuid, userSalt);

  return projectUserAggregates(sessions, { accountId, periodKind });
}

// ── Account linking ────────────────────────────────────────────────────────

/** A local account offered for linking (a projection of the store's row). */
export interface LinkableAccount {
  accountUuid: string;
  /** Human label (email or, failing that, the uuid). */
  label: string;
  /** Secondary detail for pickers (subscription/seat), may be empty. */
  detail: string;
}

/**
 * List the local accounts a user can choose to share, newest-observed first.
 * Pure projection of `store.listAccountsFull()` — no derivation, no I/O beyond
 * the read — so the CLI prompt and the extension QuickPick render the same set.
 */
export function listLinkableAccounts(store: Store): LinkableAccount[] {
  return store.listAccountsFull().map((a) => ({
    accountUuid: a.accountUuid,
    label: a.emailLabel ?? a.accountUuid,
    detail: a.subscriptionType ?? a.seatTier ?? "",
  }));
}

/**
 * Build {@link AccountMapping} rows from the user's selection, deriving each
 * privacy-preserving `accountId` via HMAC(userSalt). Pure and deterministic
 * (same uuid + salt → same accountId), so it is fully unit-testable without
 * touching disk. The raw `accountUuid` is kept locally only — it never appears
 * in the sync payload; only the derived `accountId` does.
 */
export function buildAccountMappings(
  selected: Array<{ accountUuid: string; label: string; shareWithTeams?: boolean }>,
  userSalt: string,
): AccountMapping[] {
  return selected.map((a) => ({
    accountUuid: a.accountUuid,
    accountId: deriveAccountId(a.accountUuid, userSalt),
    label: a.label,
    shareWithTeams: a.shareWithTeams ?? true,
  }));
}

/**
 * Persist the chosen accounts as the linked set. Requires a prior connect/setup
 * (which writes `userSalt`); throws otherwise so callers surface a clear
 * "connect first" message. Merges into the existing persisted config — endpoint,
 * tokens-adjacent fields, and salt are preserved. Returns the count linked.
 *
 * This is the step that was missing entirely: without it `accountMappings` is
 * never written, so `syncAggregates` always reported "No linked accounts".
 */
export function linkAccounts(
  selected: Array<{ accountUuid: string; label: string; shareWithTeams?: boolean }>,
): number {
  const persisted = loadPersistedConfig();
  if (!persisted?.userSalt) {
    throw new Error(
      "Not connected. Run 'claude-stats setup' (or Connect in the extension) first.",
    );
  }
  const accountMappings = buildAccountMappings(selected, persisted.userSalt);
  savePersistedConfig({ ...persisted, accountMappings });
  return accountMappings.length;
}

/** Max rounds to re-send a batch bumping `_version` after a conflict. */
const MAX_CONFLICT_ROUNDS = 3;

interface SyncAggregateResponse {
  itemsWritten: number;
  itemsSkipped: number;
  conflicts: Array<{ key: string; serverVersion: number }>;
}

/**
 * Send one batch via `syncAggregate` with transport-level retry/backoff.
 * Returns the server result, or null if it errored (message pushed to
 * `result.errors`). A GraphQL-level error (e.g. validation) is terminal — no
 * retry; only transport/network throws are retried.
 */
async function sendBatch(
  config: SyncConfig,
  accessToken: string,
  batch: AggregateSyncInput[],
  result: SyncResult,
): Promise<SyncAggregateResponse | null> {
  let retries = 0;
  while (retries <= MAX_RETRIES) {
    try {
      const response = await graphql<{ syncAggregate: SyncAggregateResponse }>(
        config,
        accessToken,
        SYNC_AGGREGATE_MUTATION,
        { input: batch },
      );
      if (response.errors?.length) {
        result.errors.push(...response.errors.map((e) => e.message));
        return null;
      }
      return (
        response.data?.syncAggregate ?? {
          itemsWritten: 0,
          itemsSkipped: 0,
          conflicts: [],
        }
      );
    } catch (err) {
      retries++;
      if (retries > MAX_RETRIES) {
        result.errors.push(
          `Batch failed after ${MAX_RETRIES} retries: ${(err as Error).message}`,
        );
        return null;
      }
      await new Promise((r) =>
        setTimeout(r, BASE_BACKOFF_MS * Math.pow(2, retries - 1)),
      );
    }
  }
  return null;
}

/**
 * Sync minimized local aggregates to the cloud via the deployed `syncAggregate`
 * mutation. Rows are per-`(userId, period)` upserts guarded by an optimistic
 * `_version` (server condition `attribute_not_exists OR _version == expected`).
 *
 * Because `syncAggregate` uses an ATOMIC TransactWriteItems, any single stale
 * `_version` cancels the whole batch and the server returns each stale row's
 * current `serverVersion`. We then bump those rows' `_version` and re-send the
 * batch (up to {@link MAX_CONFLICT_ROUNDS}); new rows keep `_version=0` and pass
 * the `attribute_not_exists` arm. No per-session, prompt, transcript, path, or
 * key material is ever transmitted — the payload is aggregate-only by type.
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

  const batches: AggregateSyncInput[][] = [];
  for (let i = 0; i < aggregates.length; i += BATCH_SIZE) {
    batches.push(aggregates.slice(i, i + BATCH_SIZE));
  }

  for (const batch of batches) {
    // Mutable copies so we can bump `_version` across conflict rounds.
    const current = batch.map((x) => ({ ...x }));
    let done = false;

    for (let round = 0; round <= MAX_CONFLICT_ROUNDS && !done; round++) {
      const response = await sendBatch(config, tokens.accessToken, current, result);
      if (response === null) {
        done = true; // transport/GraphQL error already recorded
        break;
      }

      if (!response.conflicts || response.conflicts.length === 0) {
        // Full success — every item in the batch was written this round.
        result.aggregatesWritten += current.length;
        done = true;
        break;
      }

      // Conflicts: bump the stale rows to the server's version and re-send.
      const byPeriod = new Map(current.map((x) => [x.period, x]));
      for (const c of response.conflicts) {
        const item = byPeriod.get(c.key);
        if (item) item._version = c.serverVersion;
      }
    }

    if (!done) {
      result.errors.push(
        `Batch did not converge after ${MAX_CONFLICT_ROUNDS} conflict rounds ` +
          `(${current.length} rows starting ${current[0]?.period}).`,
      );
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
