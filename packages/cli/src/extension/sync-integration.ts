/**
 * Backend sync integration for the VS Code extension.
 *
 * Provides the SyncManager class which handles cross-device sync:
 * - Loading sync configuration from ~/.claude-stats/sync-config.json
 * - Checking connection status and token validity
 * - Manual and automatic sync of session data
 * - Status bar integration with cloud connectivity indicator
 * - Commands for connect, disconnect, sync, and team dashboard
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { SyncConfig } from "../sync/index.js";
import {
  loadTokens,
  clearTokens,
  ensureValidTokens,
  initiateAuth,
  pollForTokens,
  saveTokens,
} from "../sync/auth.js";
import { t } from "./i18n.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type SyncStatus = "connected" | "disconnected" | "syncing" | "error";

// ── Config paths ────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), ".claude-stats");
const SYNC_CONFIG_FILE = path.join(CONFIG_DIR, "sync-config.json");

// ── SyncManager ─────────────────────────────────────────────────────────────

export class SyncManager implements vscode.Disposable {
  private status: SyncStatus = "disconnected";
  private config: SyncConfig | null = null;
  private autoSyncDisposable: vscode.Disposable | undefined;
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidChangeStatus = new vscode.EventEmitter<SyncStatus>();
  /** Fires whenever the sync status changes. */
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Create a dedicated status bar item for sync status (lower priority = more to the right)
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99,
    );
    this.statusBarItem.command = "claude-stats.syncNow";
    this.disposables.push(this.statusBarItem);
    this.disposables.push(this._onDidChangeStatus);

    // Initial load
    this.config = this.loadConfig();
    void this.refreshStatus();
  }

  // ── Configuration ───────────────────────────────────────────────────────

  /**
   * Load SyncConfig from ~/.claude-stats/sync-config.json.
   * Returns null if the file does not exist or is invalid.
   */
  loadConfig(): SyncConfig | null {
    try {
      const data = fs.readFileSync(SYNC_CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(data) as Partial<SyncConfig>;
      if (
        typeof parsed.region === "string" &&
        typeof parsed.clientId === "string" &&
        typeof parsed.endpoint === "string"
      ) {
        return parsed as SyncConfig;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Save SyncConfig to disk.
   */
  private saveConfig(config: SyncConfig): void {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      SYNC_CONFIG_FILE,
      JSON.stringify(config, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
  }

  // ── Status ──────────────────────────────────────────────────────────────

  /**
   * Check if sync is configured and tokens are valid.
   */
  async isConnected(): Promise<boolean> {
    if (!this.config) return false;
    const tokens = await ensureValidTokens(this.config);
    return tokens !== null;
  }

  /**
   * Return current sync status.
   */
  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * Re-evaluate connection status and update the status bar.
   */
  private async refreshStatus(): Promise<void> {
    if (!this.config) {
      this.setStatus("disconnected");
      return;
    }

    try {
      const connected = await this.isConnected();
      this.setStatus(connected ? "connected" : "disconnected");
    } catch {
      this.setStatus("error");
    }
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.updateStatusBar();
    this._onDidChangeStatus.fire(status);
  }

  private updateStatusBar(): void {
    switch (this.status) {
      case "connected":
        this.statusBarItem.text = t("extension:sync.status.connectedText");
        this.statusBarItem.tooltip = t("extension:sync.status.connectedTooltip");
        this.statusBarItem.backgroundColor = undefined;
        break;
      case "disconnected":
        this.statusBarItem.text = t("extension:sync.status.disconnectedText");
        this.statusBarItem.tooltip = t("extension:sync.status.disconnectedTooltip");
        this.statusBarItem.backgroundColor = undefined;
        break;
      case "syncing":
        this.statusBarItem.text = t("extension:sync.status.syncingText");
        this.statusBarItem.tooltip = t("extension:sync.status.syncingTooltip");
        this.statusBarItem.backgroundColor = undefined;
        break;
      case "error":
        this.statusBarItem.text = t("extension:sync.status.errorText");
        this.statusBarItem.tooltip = t("extension:sync.status.errorTooltip");
        this.statusBarItem.backgroundColor = new vscode.ThemeColor(
          "statusBarItem.errorBackground",
        );
        break;
    }
    this.statusBarItem.show();
  }

  // ── Sync operations ─────────────────────────────────────────────────────

  /**
   * Manually trigger sync of recent sessions.
   * Shows progress notification while syncing.
   */
  async syncNow(): Promise<void> {
    if (!this.config) {
      const action = await vscode.window.showInformationMessage(
        t("extension:sync.dialogs.notConfigured"),
        t("common:actions.connect"),
        t("common:actions.cancel"),
      );
      if (action === t("common:actions.connect")) {
        void vscode.commands.executeCommand("claude-stats.connect");
      }
      return;
    }

    const tokens = await ensureValidTokens(this.config);
    if (!tokens) {
      const action = await vscode.window.showWarningMessage(
        t("extension:sync.dialogs.authExpired"),
        t("common:actions.connect"),
        t("common:actions.cancel"),
      );
      if (action === t("common:actions.connect")) {
        void vscode.commands.executeCommand("claude-stats.connect");
      }
      return;
    }

    this.setStatus("syncing");

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t("extension:sync.progress.syncing"),
          cancellable: false,
        },
        async () => {
          // POST session data to the GraphQL endpoint
          await this.uploadSessions(tokens.accessToken);
        },
      );

      this.setStatus("connected");
      void vscode.window.showInformationMessage(t("extension:sync.messages.syncComplete"));
    } catch (err) {
      this.setStatus("error");
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(t("extension:sync.messages.syncFailed", { message: msg }));
    }
  }

  /**
   * Upload recent session summaries to the backend.
   */
  private async uploadSessions(accessToken: string): Promise<void> {
    if (!this.config) return;

    // Dynamically import Store and buildDashboard to gather session data
    const { Store } = await import("../store/index.js");
    const { buildDashboard } = await import("../dashboard/index.js");

    const store = new Store();
    try {
      const data = buildDashboard(store, { period: "week" }) as unknown as Record<string, unknown>;

      const payload = {
        query: `mutation SyncSessions($input: SyncInput!) {
          syncSessions(input: $input) { syncedCount lastSyncAt }
        }`,
        variables: {
          input: {
            sessions: ((data.sessions ?? []) as Array<Record<string, unknown>>).map((s) => ({
              sessionId: s.sessionId,
              project: s.project,
              timestamp: s.timestamp,
              totalInput: s.totalInput,
              totalOutput: s.totalOutput,
              estimatedCost: s.estimatedCost,
              messageCount: s.messageCount,
              durationMinutes: s.durationMinutes,
              model: s.model,
            })),
            deviceId: os.hostname(),
            syncedAt: new Date().toISOString(),
          },
        },
      };

      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Sync request failed (${response.status}): ${body}`);
      }
    } finally {
      store.close();
    }
  }

  // ── Auto-sync ───────────────────────────────────────────────────────────

  /**
   * Start watching for session completions and auto-sync.
   * Hooks into the AutoCollector's onDidCollect event.
   */
  startAutoSync(collector: { onDidCollect: (cb: () => void) => vscode.Disposable }): void {
    this.stopAutoSync();

    this.autoSyncDisposable = collector.onDidCollect(() => {
      const vsConfig = vscode.workspace.getConfiguration("claude-stats");
      const autoSync = vsConfig.get<boolean>("autoSync", false);
      if (autoSync && this.config && this.status !== "syncing") {
        void this.syncNow();
      }
    });

    this.disposables.push(this.autoSyncDisposable);
  }

  /**
   * Stop watching for session completions.
   */
  stopAutoSync(): void {
    if (this.autoSyncDisposable) {
      this.autoSyncDisposable.dispose();
      this.autoSyncDisposable = undefined;
    }
  }

  // ── Commands ────────────────────────────────────────────────────────────

  /**
   * Register all sync-related commands.
   * Returns disposables to be added to the extension context.
   */
  registerCommands(): vscode.Disposable[] {
    const commands: vscode.Disposable[] = [];

    commands.push(
      vscode.commands.registerCommand("claude-stats.connect", () =>
        this.handleConnect(),
      ),
    );

    commands.push(
      vscode.commands.registerCommand("claude-stats.disconnect", () =>
        this.handleDisconnect(),
      ),
    );

    commands.push(
      vscode.commands.registerCommand("claude-stats.syncNow", () =>
        this.syncNow(),
      ),
    );

    commands.push(
      vscode.commands.registerCommand("claude-stats.showTeamDashboard", () =>
        this.handleShowTeamDashboard(),
      ),
    );

    return commands;
  }

  /**
   * Handle the connect command.
   * If a backend URL is configured in VS Code settings, use it.
   * Otherwise prompt the user to enter one.
   */
  private async handleConnect(): Promise<void> {
    const vsConfig = vscode.workspace.getConfiguration("claude-stats");
    let backendUrl = vsConfig.get<string>("backendUrl", "");

    if (!backendUrl) {
      const input = await vscode.window.showInputBox({
        prompt: t("extension:sync.dialogs.enterBackendUrl"),
        placeHolder: t("extension:sync.dialogs.backendUrlPlaceholder"),
        ignoreFocusOut: true,
      });
      if (!input) return;
      backendUrl = input;
      await vsConfig.update("backendUrl", backendUrl, vscode.ConfigurationTarget.Global);
    }

    // Fetch the backend's discovery endpoint to get Cognito config
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t("extension:sync.progress.connecting"),
          cancellable: false,
        },
        async () => {
          const discoveryUrl = `${backendUrl.replace(/\/$/, "")}/.well-known/claude-stats.json`;
          const response = await fetch(discoveryUrl);
          if (!response.ok) {
            throw new Error(t("extension:sync.messages.backendError", { status: String(response.status) }));
          }

          const discovery = (await response.json()) as {
            region: string;
            userPoolId: string;
            clientId: string;
            endpoint: string;
          };

          const syncConfig: SyncConfig = {
            region: discovery.region,
            userPoolId: discovery.userPoolId,
            clientId: discovery.clientId,
            endpoint: discovery.endpoint,
          };

          // Prompt for email to initiate auth
          const email = await vscode.window.showInputBox({
            prompt: t("extension:sync.dialogs.enterEmail"),
            placeHolder: t("extension:sync.dialogs.emailPlaceholder"),
            ignoreFocusOut: true,
          });
          if (!email) return;

          // Initiate device auth flow
          const authResponse = await initiateAuth(syncConfig, email);

          if (authResponse.verificationUri) {
            // Open the verification URL in the browser
            void vscode.env.openExternal(
              vscode.Uri.parse(authResponse.verificationUri),
            );
            void vscode.window.showInformationMessage(
              t("extension:sync.dialogs.checkEmailOrBrowser", { code: authResponse.userCode }),
            );
          } else {
            void vscode.window.showInformationMessage(
              t("extension:sync.dialogs.checkEmail"),
            );
          }

          // Poll for tokens
          const tokens = await pollForTokens(
            syncConfig,
            authResponse.deviceCode,
            3000,
            300_000,
          );

          saveTokens(tokens);
          this.saveConfig(syncConfig);
          this.config = syncConfig;
          this.setStatus("connected");
        },
      );

      void vscode.window.showInformationMessage(
        t("extension:sync.messages.connectedSuccess"),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(
        t("extension:sync.messages.connectionFailed", { message: msg }),
      );
    }
  }

  /**
   * Handle the disconnect command.
   * Clears tokens and sync config.
   */
  private async handleDisconnect(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      t("extension:sync.dialogs.disconnectConfirm"),
      { modal: true },
      t("common:actions.disconnect"),
    );
    if (confirm !== t("common:actions.disconnect")) return;

    clearTokens();
    try {
      fs.unlinkSync(SYNC_CONFIG_FILE);
    } catch {
      // File may not exist
    }

    this.config = null;
    this.stopAutoSync();
    this.setStatus("disconnected");

    const vsConfig = vscode.workspace.getConfiguration("claude-stats");
    await vsConfig.update("backendUrl", undefined, vscode.ConfigurationTarget.Global);

    void vscode.window.showInformationMessage(t("extension:sync.messages.disconnected"));
  }

  /**
   * Open the team dashboard URL in the default browser.
   */
  private handleShowTeamDashboard(): void {
    const vsConfig = vscode.workspace.getConfiguration("claude-stats");
    const backendUrl = vsConfig.get<string>("backendUrl", "");

    if (!backendUrl) {
      void vscode.window.showWarningMessage(
        t("extension:sync.messages.noBackendUrl"),
      );
      return;
    }

    const dashboardUrl = `${backendUrl.replace(/\/$/, "")}/dashboard`;
    void vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
  }

  // ── Disposal ────────────────────────────────────────────────────────────

  dispose(): void {
    this.stopAutoSync();
    for (const d of this.disposables) d.dispose();
  }
}
