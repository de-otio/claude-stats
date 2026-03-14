/**
 * CLI commands for cross-device sync: setup, sync, and disconnect.
 *
 * See doc/analysis/team-app/17-client-setup.md
 */
import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline/promises";
import { Store } from "../store/index.js";
import {
  type SyncConfig,
  type AuthTokens,
  initiateAuth,
  pollForTokens,
  ensureValidTokens,
  saveTokens,
  clearTokens,
  generateUserSalt,
  deriveAccountId,
  redactSecrets,
} from "../sync/index.js";

// ── Sync config persistence ─────────────────────────────────────────────────

const SYNC_CONFIG_DIR = path.join(os.homedir(), ".claude-stats");
const SYNC_CONFIG_FILE = path.join(SYNC_CONFIG_DIR, "sync-config.json");

export function loadSyncConfig(): SyncConfig | null {
  try {
    const data = fs.readFileSync(SYNC_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(data) as Partial<SyncConfig>;
    if (
      typeof parsed.region === "string" &&
      typeof parsed.clientId === "string" &&
      typeof parsed.graphqlEndpoint === "string" &&
      typeof parsed.userSalt === "string" &&
      typeof parsed.autoSync === "boolean"
    ) {
      return parsed as SyncConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveSyncConfig(config: SyncConfig): void {
  fs.mkdirSync(SYNC_CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SYNC_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function removeSyncConfig(): void {
  try {
    fs.unlinkSync(SYNC_CONFIG_FILE);
  } catch {
    // File may not exist -- that's fine.
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Prompt the user for a line of input on stdin. */
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** Maximum sessions per sync batch (per API spec). */
const BATCH_SIZE = 25;

// ── Commands ────────────────────────────────────────────────────────────────

/**
 * Register sync-related subcommands on the given Commander program.
 */
export function registerSyncCommands(program: Command): void {
  // ── setup ───────────────────────────────────────────────────────────────────

  program
    .command("setup")
    .description("Connect this device to the claude-stats cloud backend")
    .option("--backend-url <url>", "Backend URL (or set CLAUDE_STATS_BACKEND_URL)")
    .option("--email <email>", "Email address for authentication")
    .action(async (opts: { backendUrl?: string; email?: string }) => {
      // 1. Resolve backend URL
      const backendUrl =
        opts.backendUrl ||
        process.env.CLAUDE_STATS_BACKEND_URL ||
        (await prompt("Backend URL: "));

      if (!backendUrl) {
        console.error("Backend URL is required. Pass --backend-url or set CLAUDE_STATS_BACKEND_URL.");
        process.exitCode = 1;
        return;
      }

      // 2. Resolve email
      const email =
        opts.email ||
        process.env.CLAUDE_STATS_EMAIL ||
        (await prompt("Email address: "));

      if (!email) {
        console.error("Email address is required.");
        process.exitCode = 1;
        return;
      }

      // 3. Fetch backend configuration
      let backendConfig: {
        region: string;
        clientId: string;
        graphqlEndpoint: string;
      };
      try {
        const configUrl = backendUrl.replace(/\/+$/, "") + "/config";
        const resp = await fetch(configUrl);
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        }
        backendConfig = (await resp.json()) as typeof backendConfig;
      } catch (err) {
        console.error(`Failed to fetch backend configuration: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }

      // 4. Build a temporary SyncConfig for the auth flow
      const tempConfig: SyncConfig = {
        region: backendConfig.region,
        clientId: backendConfig.clientId,
        graphqlEndpoint: backendConfig.graphqlEndpoint,
        userSalt: "", // will be generated after auth
        autoSync: false,
      };

      // 5. Initiate auth (magic link)
      try {
        console.log(`Initiating authentication for ${email}...`);
        const authResp = await initiateAuth(tempConfig, email);

        if (authResp.verificationUri) {
          console.log(`\nVerification URL: ${authResp.verificationUri}`);
        }
        if (authResp.userCode) {
          console.log(`Code: ${authResp.userCode}`);
        }
        console.log("\nCheck your email for the magic link...");

        // 6. Poll for tokens
        const tokens = await pollForTokens(tempConfig, authResp.deviceCode);

        // 7. Save tokens
        saveTokens(tokens);

        // 8. Generate user salt and save sync config
        const userSalt = generateUserSalt();
        const syncConfig: SyncConfig = {
          region: backendConfig.region,
          clientId: backendConfig.clientId,
          graphqlEndpoint: backendConfig.graphqlEndpoint,
          userSalt,
          autoSync: true,
        };
        saveSyncConfig(syncConfig);

        console.log(`\nSetup complete. Linked to ${email}.`);
        console.log("Run 'claude-stats sync' to sync your sessions.");
      } catch (err) {
        console.error(`Authentication failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  // ── sync ────────────────────────────────────────────────────────────────────

  program
    .command("sync")
    .description("Sync local sessions to the cloud backend")
    .option("--dry-run", "Show what would be synced without sending")
    .action(async (opts: { dryRun?: boolean }) => {
      // 1. Load sync config
      const syncConfig = loadSyncConfig();
      if (!syncConfig) {
        console.error("Not configured. Run 'claude-stats setup' first.");
        process.exitCode = 1;
        return;
      }

      // 2. Ensure valid tokens
      const tokens = await ensureValidTokens(syncConfig);
      if (!tokens) {
        console.error("Authentication expired. Run 'claude-stats setup' to re-authenticate.");
        process.exitCode = 1;
        return;
      }

      // 3. Read local sessions
      const store = new Store();
      let sessions;
      try {
        sessions = store.getSessions({ includeCI: true });
      } finally {
        store.close();
      }

      if (sessions.length === 0) {
        console.log("No sessions to sync.");
        return;
      }

      if (opts.dryRun) {
        console.log(`Would sync ${sessions.length} session(s).`);
        return;
      }

      // 4. Batch and sync
      let totalSynced = 0;
      let totalConflicts = 0;

      for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
        const batch = sessions.slice(i, i + BATCH_SIZE);

        // Transform sessions for the API
        const syncPayload = batch.map((s) => ({
          sessionId: s.session_id,
          accountId: s.account_uuid
            ? deriveAccountId(s.account_uuid, syncConfig.userSalt)
            : null,
          projectPath: redactSecrets(s.project_path),
          firstTimestamp: s.first_timestamp,
          lastTimestamp: s.last_timestamp,
          claudeVersion: s.claude_version,
          entrypoint: s.entrypoint,
          promptCount: s.prompt_count,
          inputTokens: s.input_tokens,
          outputTokens: s.output_tokens,
          cacheCreationTokens: s.cache_creation_tokens,
          cacheReadTokens: s.cache_read_tokens,
        }));

        // 5. POST to AppSync graphqlEndpoint
        try {
          const response = await fetch(syncConfig.graphqlEndpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${tokens.accessToken}`,
            },
            body: JSON.stringify({
              query: `mutation SyncSessions($input: SyncSessionsInput!) {
                syncSessions(input: $input) {
                  synced
                  conflicts
                }
              }`,
              variables: {
                input: {
                  sessions: syncPayload,
                },
              },
            }),
          });

          if (!response.ok) {
            const body = await response.text();
            throw new Error(`Sync request failed (${response.status}): ${body}`);
          }

          const result = (await response.json()) as {
            data?: {
              syncSessions?: {
                synced: number;
                conflicts: number;
              };
            };
            errors?: Array<{ message: string }>;
          };

          if (result.errors && result.errors.length > 0) {
            const messages = result.errors.map((e) => e.message).join("; ");
            throw new Error(`GraphQL errors: ${messages}`);
          }

          const syncResult = result.data?.syncSessions;
          if (syncResult) {
            totalSynced += syncResult.synced;
            totalConflicts += syncResult.conflicts;
          }
        } catch (err) {
          console.error(
            `Failed to sync batch ${Math.floor(i / BATCH_SIZE) + 1}: ${(err as Error).message}`
          );
          process.exitCode = 1;
          return;
        }
      }

      // 6. Print summary
      const batchCount = Math.ceil(sessions.length / BATCH_SIZE);
      console.log(
        `Synced ${totalSynced} session(s) in ${batchCount} batch(es).` +
          (totalConflicts > 0 ? ` ${totalConflicts} conflict(s).` : "")
      );
    });

  // ── disconnect ──────────────────────────────────────────────────────────────

  program
    .command("disconnect")
    .description("Remove cloud sync configuration and clear auth tokens")
    .action(() => {
      clearTokens();
      removeSyncConfig();
      console.log("Disconnected. Cloud sync configuration and auth tokens removed.");
    });
}
