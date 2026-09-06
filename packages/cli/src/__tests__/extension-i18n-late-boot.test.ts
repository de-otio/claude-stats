/**
 * Regression guard: status-bar items must not be left showing raw i18n keys.
 *
 * `activate()` kicks off `initI18n()` (async) and then, in the SAME synchronous
 * tick, constructs `StatusBarManager` and `SyncManager`. Both paint their
 * status-bar item in their constructor, so both paint through the passthrough
 * `t` that returns the key verbatim — the user saw a literal
 * "extension:sync.status.disconnectedText" in the VS Code status bar.
 *
 * The token/cost item recovers on the collector's first run. The sync item has
 * no such refresh: it repaints only when the sync status changes, so the raw
 * key stayed on screen indefinitely. `onI18nReady()` is the fix; these tests
 * pin that a late `setT()` repaints both items.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

interface FakeStatusBarItem {
  text: string;
  tooltip: string | undefined;
  command: string;
  backgroundColor: unknown;
  show: () => void;
  dispose: () => void;
}

const createdItems: FakeStatusBarItem[] = [];

vi.mock("vscode", () => ({
  window: {
    createStatusBarItem: () => {
      const item: FakeStatusBarItem = {
        text: "",
        tooltip: undefined,
        command: "",
        backgroundColor: undefined,
        show: vi.fn(),
        dispose: vi.fn(),
      };
      createdItems.push(item);
      return item;
    },
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultVal: unknown) => defaultVal,
      update: vi.fn(),
    }),
  },
  commands: { registerCommand: vi.fn(), executeCommand: vi.fn() },
  EventEmitter: class {
    event = () => ({ dispose: vi.fn() });
    fire = vi.fn();
    dispose = vi.fn();
  },
  ThemeColor: class {
    constructor(public readonly id: string) {}
  },
  StatusBarAlignment: { Right: 2 },
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Notification: 15 },
}));

import { setT, __resetI18nForTests } from "../extension/i18n.js";
import { StatusBarManager } from "../extension/statusBar.js";
import { SyncManager } from "../extension/sync-integration.js";
import { initI18n } from "@claude-stats/core/i18n";

const _req = createRequire(import.meta.url);
const enExt = _req("../../../core/src/locales/en/extension.json") as Record<string, unknown>;

/** Bind a real i18next `t`, the way activate()'s initI18n().then() does. */
async function bootI18n(): Promise<void> {
  const instance = await initI18n({
    lng: "en",
    ns: ["extension"],
    resources: { en: { extension: enExt } },
  });
  setT(instance.t.bind(instance));
}

beforeEach(() => {
  createdItems.length = 0;
  // Undo the global setup's seeding so we start in activate()'s real
  // pre-i18n state rather than a state no user ever sees.
  __resetI18nForTests();
});

afterEach(async () => {
  // Leave the module in the state the rest of the suite expects.
  await bootI18n();
});

describe("status bar items constructed before i18n is ready", () => {
  it("SyncManager relabels its item once setT() lands", async () => {
    const mgr = new SyncManager({} as never);
    const item = createdItems[0]!;

    // Precondition: this is exactly the bug the user reported.
    expect(item.text).toBe("extension:sync.status.disconnectedText");

    await bootI18n();

    expect(item.text).not.toContain("extension:");
    expect(item.text).toBe("$(cloud-upload) Sync Off");
    expect(item.tooltip).toBe("Claude Stats: Not connected - Click to sync");

    mgr.dispose();
  });

  it("StatusBarManager relabels its idle item once setT() lands", async () => {
    const bar = new StatusBarManager();
    const item = createdItems[0]!;

    expect(item.text).toBe("extension:statusBar.idle");

    await bootI18n();

    expect(item.text).not.toContain("extension:");
    expect(item.tooltip).not.toContain("extension:");

    bar.dispose();
  });

  it("a disposed manager is not relabelled by a later setT()", async () => {
    const mgr = new SyncManager({} as never);
    const item = createdItems[0]!;
    mgr.dispose();
    item.text = "sentinel";

    await bootI18n();

    expect(item.text).toBe("sentinel");
  });
});

describe("status bar items constructed after i18n is ready", () => {
  it("SyncManager paints real strings on its first render", async () => {
    await bootI18n();

    const mgr = new SyncManager({} as never);
    expect(createdItems[0]!.text).toBe("$(cloud-upload) Sync Off");
    mgr.dispose();
  });
});
