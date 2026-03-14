import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("vscode", () => ({
  window: { createStatusBarItem: vi.fn() },
  workspace: { getConfiguration: () => ({ get: vi.fn() }) },
  StatusBarAlignment: { Right: 2 },
}));

// Track collect() calls with a controllable promise
let collectResolve: (() => void) | undefined;
const collectMock = vi.fn<() => Promise<unknown>>(() =>
  new Promise<void>((resolve) => { collectResolve = resolve; }),
);

vi.mock("../aggregator/index.js", () => ({
  collect: (...args: Parameters<typeof collectMock>) => collectMock(...args),
}));

const storeCloseMock = vi.fn();
vi.mock("../store/index.js", () => ({
  Store: class {
    close() { storeCloseMock(); }
  },
}));

// Mock fs.watch to capture the callback
let watchCallback: ((event: string, filename: string) => void) | undefined;
const watchCloseMock = vi.fn();
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: () => true,
      watch: (_path: string, _opts: unknown, cb: (event: string, filename: string) => void) => {
        watchCallback = cb;
        return { close: watchCloseMock };
      },
    },
  };
});

import { AutoCollector } from "../extension/collector.js";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AutoCollector — debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    collectMock.mockClear();
    storeCloseMock.mockClear();
    watchCloseMock.mockClear();
    watchCallback = undefined;
    // Default: collect resolves immediately
    collectMock.mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("start() runs an initial collection immediately", async () => {
    const collector = new AutoCollector();
    collector.start();
    // Let the microtask (initial runCollect) complete
    await vi.runAllTimersAsync();
    expect(collectMock).toHaveBeenCalledTimes(1);
    collector.dispose();
  });

  it("start() sets up a file watcher", () => {
    const collector = new AutoCollector();
    collector.start();
    expect(watchCallback).toBeDefined();
    collector.dispose();
  });

  it("file changes are debounced — rapid events produce one collect", async () => {
    const collector = new AutoCollector();
    const cb = vi.fn();
    collector.onDidCollect(cb);
    collector.start();

    // Let initial collection complete
    await vi.runAllTimersAsync();
    collectMock.mockClear();
    cb.mockClear();

    // Simulate 5 rapid file changes
    watchCallback!("change", "a.jsonl");
    watchCallback!("change", "b.jsonl");
    watchCallback!("change", "c.jsonl");
    watchCallback!("change", "d.jsonl");
    watchCallback!("change", "e.jsonl");

    // Advance past debounce window (5s)
    await vi.advanceTimersByTimeAsync(5_000);

    expect(collectMock).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
    collector.dispose();
  });

  it("debounce resets on each new event within the window", async () => {
    const collector = new AutoCollector();
    collector.start();
    await vi.runAllTimersAsync();
    collectMock.mockClear();

    // Fire event, wait 3s, fire another — first timer should be cancelled
    watchCallback!("change", "a.jsonl");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(collectMock).not.toHaveBeenCalled();

    watchCallback!("change", "b.jsonl");
    await vi.advanceTimersByTimeAsync(3_000);
    // Only 3s since last event — still within debounce window
    expect(collectMock).not.toHaveBeenCalled();

    // Advance remaining 2s to complete second debounce
    await vi.advanceTimersByTimeAsync(2_000);
    expect(collectMock).toHaveBeenCalledTimes(1);
    collector.dispose();
  });

  it("queues a re-run if a file change arrives during collection", async () => {
    // Make collect hang until we resolve it
    let resolve!: () => void;
    collectMock.mockImplementation(() =>
      new Promise<void>((r) => { resolve = r; }),
    );

    const collector = new AutoCollector();
    const cb = vi.fn();
    collector.onDidCollect(cb);
    collector.start();

    // Initial collection is now in progress (hanging)
    // Simulate a file change while collecting
    watchCallback!("change", "x.jsonl");

    // Advance past debounce — runCollect sees collecting=true, sets pendingRerun
    await vi.advanceTimersByTimeAsync(5_000);

    // Resolve the first collection
    resolve();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    expect(cb).toHaveBeenCalledTimes(1); // first collection complete

    // Now make collect resolve immediately for the re-run
    collectMock.mockImplementation(() => Promise.resolve());

    // Advance past debounce for the re-run (pendingRerun → scheduleCollect → 5s)
    await vi.advanceTimersByTimeAsync(5_000);

    expect(collectMock).toHaveBeenCalledTimes(2); // initial + re-run
    expect(cb).toHaveBeenCalledTimes(2);
    collector.dispose();
  });

  it("closes the store after each collection", async () => {
    const collector = new AutoCollector();
    collector.start();
    await vi.runAllTimersAsync();
    expect(storeCloseMock).toHaveBeenCalled();
    collector.dispose();
  });

  it("dispose() closes the watcher and cancels pending timers", async () => {
    const collector = new AutoCollector();
    collector.start();
    await vi.runAllTimersAsync();

    // Schedule a debounced collect
    watchCallback!("change", "a.jsonl");

    collector.dispose();
    expect(watchCloseMock).toHaveBeenCalledTimes(1);

    // Advance timers — the debounced collect should NOT fire
    collectMock.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(collectMock).not.toHaveBeenCalled();
  });

  it("collection failure is non-fatal — callbacks are not fired but collector continues", async () => {
    collectMock.mockImplementation(() => Promise.reject(new Error("db locked")));
    const cb = vi.fn();
    const collector = new AutoCollector();
    collector.onDidCollect(cb);
    collector.start();
    await vi.runAllTimersAsync();

    expect(cb).not.toHaveBeenCalled(); // failure → no callback

    // Next collection should still work
    collectMock.mockImplementation(() => Promise.resolve());
    watchCallback!("change", "a.jsonl");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(cb).toHaveBeenCalledTimes(1);
    collector.dispose();
  });
});
