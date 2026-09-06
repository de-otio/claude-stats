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
  discoverConfig,
  saveSyncConfig,
  loadPersistedConfig,
  savePersistedConfig,
  generateUserSalt,
  listLinkableAccounts,
  linkAccounts,
} from "../sync/index.js";
import {
  loadTokens,
  clearTokens,
  ensureValidTokens,
  initiateAuth,
  pollForTokens,
  saveTokens,
} from "../sync/auth.js";
import { onI18nReady, t } from "./i18n.js";

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

    // `activate()` constructs us synchronously, before the async initI18n()
    // promise resolves — so this first paint uses the passthrough `t` and
    // writes the raw key ("extension:sync.status.disconnectedText") into the
    // status bar. Unlike the token/cost item, nothing re-renders us on a timer
    // or on collection, so without this relabel the key stays on screen until
    // the status happens to change. Repaint as soon as translations land.
    const unsubscribeI18n = onI18nReady(() => this.updateStatusBar());
    this.disposables.push({ dispose: unsubscribeI18n });

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

  // Config writes go through the CLI sync helpers (saveSyncConfig /
  // savePersistedConfig) so the salt and linked accounts are always preserved.
  // The old private saveConfig() wrote only the 4 endpoint fields and thus
  // clobbered them — removed.

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
          // Push minimized daily aggregates via the deployed syncAggregate contract.
          await this.uploadSessions();
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
   * Upload minimized daily aggregates to the org backend.
   *
   * Delegates to the CLI's `syncAggregates` engine — the SAME code path as
   * `claude-stats sync`. There is intentionally NO extension-specific payload:
   * the org plane accepts only the aggregate-only `syncAggregate` mutation
   * (per-day totals, structurally incapable of carrying prompt/transcript/path
   * material), and `syncAggregates` owns token refresh, the linked-account
   * projection, batching, and the optimistic `_version` conflict-retry loop.
   *
   * Requires linked accounts + a user salt (from `claude-stats setup`);
   * `syncAggregates` returns descriptive errors if either is missing, which we
   * re-throw so `syncNow` surfaces them to the user.
   */
  private async uploadSessions(): Promise<void> {
    if (!this.config) return;

    const { Store } = await import("../store/index.js");
    const { syncAggregates } = await import("../sync/index.js");

    const store = new Store();
    try {
      const result = await syncAggregates(store, this.config);
      if (result.errors.length > 0) {
        throw new Error(result.errors.join("; "));
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

    commands.push(
      vscode.commands.registerCommand("claude-stats.linkAccounts", () =>
        this.linkAccountsInteractive(),
      ),
    );

    return commands;
  }

  /**
   * Handle the connect command — the extension's full GUI setup flow, the
   * equivalent of `claude-stats setup`. Discovers the backend, runs the
   * passwordless auth, generates the per-user salt, persists the config
   * WITHOUT clobbering any existing salt/linked accounts, then guides the user
   * through picking which local accounts to share. End users never need the CLI.
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

    try {
      // Auth runs inside a progress notification. Account-linking runs AFTER it
      // (a QuickPick can't be shown from inside withProgress). `connected` is
      // true once tokens are saved; linking is a best-effort follow-up step.
      const syncConfig = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t("extension:sync.progress.connecting"),
          cancellable: false,
        },
        async (): Promise<SyncConfig | null> => {
          // Reuse the CLI's discovery — it reads the deployed well-known shape
          // ({appsyncEndpoint, cognitoUserPoolId, cognitoClientId, region}),
          // which the extension's old inline parser did NOT match.
          const discovered = await discoverConfig(backendUrl);
          if (!discovered) {
            throw new Error(t("extension:sync.messages.backendError", { status: "discovery" }));
          }

          const email = await vscode.window.showInputBox({
            prompt: t("extension:sync.dialogs.enterEmail"),
            placeHolder: t("extension:sync.dialogs.emailPlaceholder"),
            ignoreFocusOut: true,
          });
          if (!email) return null;

          const authResponse = await initiateAuth(discovered, email);

          if (authResponse.verificationUri) {
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

          const tokens = await pollForTokens(
            discovered,
            authResponse.deviceCode,
            3000,
            300_000,
          );

          saveTokens(tokens);
          // Persist via the CLI helpers so salt/linked accounts are preserved
          // and a salt is generated on first connect (the extension previously
          // wrote neither, leaving sync permanently un-completable).
          saveSyncConfig(discovered);
          const persisted = loadPersistedConfig();
          if (persisted && !persisted.userSalt) {
            savePersistedConfig({ ...persisted, userSalt: generateUserSalt() });
          }
          this.config = discovered;
          this.setStatus("connected");
          return discovered;
        },
      );

      // User cancelled at the email prompt.
      if (!syncConfig) return;

      void vscode.window.showInformationMessage(
        t("extension:sync.messages.connectedSuccess"),
      );

      // Guide the user through linking accounts — the step that actually
      // enables sync. Skipping it leaves "No linked accounts" on first sync.
      await this.linkAccountsInteractive();
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

  /**
   * GUI account-linking: a multi-select of the local accounts, persisted as the
   * shared set. This is the step `syncAggregate` requires — without it, sync
   * reports "No linked accounts". Runnable standalone (the Link Accounts command)
   * or as the tail of the connect flow. Requires a prior connect (a userSalt);
   * `linkAccounts` throws otherwise and we surface that.
   */
  private async linkAccountsInteractive(): Promise<void> {
    const { Store } = await import("../store/index.js");
    const store = new Store();
    let linkable: ReturnType<typeof listLinkableAccounts>;
    try {
      linkable = listLinkableAccounts(store);
    } finally {
      store.close();
    }

    if (linkable.length === 0) {
      void vscode.window.showWarningMessage(t("extension:sync.link.noAccounts"));
      return;
    }

    interface AccountItem extends vscode.QuickPickItem {
      accountUuid: string;
    }
    const items: AccountItem[] = linkable.map((a) => ({
      label: a.label,
      description: a.detail,
      accountUuid: a.accountUuid,
      picked: true,
    }));

    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: t("extension:sync.link.placeholder"),
      ignoreFocusOut: true,
    });
    if (!chosen || chosen.length === 0) return;

    try {
      const byUuid = new Map(linkable.map((a) => [a.accountUuid, a]));
      const count = linkAccounts(
        chosen.map((c) => {
          const a = byUuid.get(c.accountUuid)!;
          return { accountUuid: a.accountUuid, label: a.label };
        }),
      );
      void vscode.window.showInformationMessage(
        t("extension:sync.link.linked", { count }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(
        t("extension:sync.messages.syncFailed", { message: msg }),
      );
    }
  }

  // ── Disposal ────────────────────────────────────────────────────────────

  dispose(): void {
    this.stopAutoSync();
    for (const d of this.disposables) d.dispose();
  }
}
