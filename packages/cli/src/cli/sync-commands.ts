/**
 * CLI commands for cross-device sync: setup, sync, and disconnect.
 *
 * See doc/analysis/team-app/17-client-setup.md
 */
import { Command } from "commander";
import * as readline from "node:readline/promises";
import { Store } from "../store/index.js";
import {
  type SyncConfig,
  type PersistedSyncConfig,
  loadPersistedConfig,
  savePersistedConfig,
  removeSyncConfig,
  discoverConfig,
  initiateAuth,
  pollForTokens,
  ensureValidTokens,
  saveTokens,
  clearTokens,
  generateUserSalt,
  buildAggregatePayload,
  syncAggregates,
} from "../sync/index.js";

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

      // 3. Fetch backend configuration via well-known discovery
      const discoveredConfig = await discoverConfig(backendUrl);
      if (!discoveredConfig) {
        console.error("Failed to discover backend configuration from " + backendUrl);
        process.exitCode = 1;
        return;
      }

      // 4. Build a SyncConfig for the auth flow
      const tempConfig: SyncConfig = discoveredConfig;

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

        // 8. Generate user salt and save persisted config
        const userSalt = generateUserSalt();
        const persistedConfig: PersistedSyncConfig = {
          ...tempConfig,
          userSalt,
          enabled: true,
        };
        savePersistedConfig(persistedConfig);

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
    .description("Sync minimized local aggregates to the cloud backend")
    .option("--dry-run", "Show what would be synced without sending")
    .action(async (opts: { dryRun?: boolean }) => {
      // 1. Load persisted config (has userSalt + linked-account mappings).
      const persistedConfig = loadPersistedConfig();
      if (!persistedConfig) {
        console.error("Not configured. Run 'claude-stats setup' first.");
        process.exitCode = 1;
        return;
      }
      const syncConfig: SyncConfig = {
        endpoint: persistedConfig.endpoint,
        userPoolId: persistedConfig.userPoolId,
        clientId: persistedConfig.clientId,
        region: persistedConfig.region,
      };

      // 2. Ensure valid tokens.
      const tokens = await ensureValidTokens(syncConfig);
      if (!tokens) {
        console.error("Authentication expired. Run 'claude-stats setup' to re-authenticate.");
        process.exitCode = 1;
        return;
      }

      // 3. Dry-run: project locally and report EXACTLY what would leave the
      //    device — minimized aggregates only, never per-session/prompt data.
      if (opts.dryRun) {
        const store = new Store();
        let aggregates;
        try {
          aggregates = buildAggregatePayload(store, persistedConfig);
        } finally {
          store.close();
        }
        if (aggregates.length === 0) {
          console.log("Nothing to sync (no sessions for linked accounts).");
          return;
        }
        console.log(
          `Would sync ${aggregates.length} aggregate record(s) (per-day rollups; no per-session or prompt data).`,
        );
        return;
      }

      // 4. Sync minimized aggregates (the ONLY payload the client can build).
      const store = new Store();
      let result;
      try {
        result = await syncAggregates(store, syncConfig);
      } finally {
        store.close();
      }

      if (result.errors.length > 0) {
        for (const msg of result.errors) console.error(`Sync error: ${msg}`);
        process.exitCode = 1;
        return;
      }

      console.log(
        `Synced ${result.aggregatesWritten} aggregate record(s).` +
          (result.aggregatesSkipped > 0 ? ` ${result.aggregatesSkipped} unchanged.` : ""),
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
