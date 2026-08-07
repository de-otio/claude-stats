/**
 * `claude-stats task-class` — the honesty contract of the printed surface.
 *
 * Spec §5.10 ends: "any surface quoting a per-class figure carries the caveat
 * with it", and §5.7 gives every classification a confidence tier. The verb is
 * the first surface to quote per-class figures, so both have to appear in its
 * output — unconditionally, not behind a flag, and not left to the reader.
 *
 * `t()` is stubbed to echo its key and interpolation values rather than a
 * rendered sentence. Two reasons: the CLI's i18n loads locale JSON through
 * `createRequire` from the package's BUILT `dist/`, which a test run against
 * source cannot refresh; and the assertion that matters here is "the verb asks
 * for the caveat key and hands the tier counts to it", not the wording — the
 * wording's existence in all ten locales is `npm run locales:check`'s job.
 *
 * The store is stubbed too, so this never opens a real `~/.claude-stats`
 * database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const counts = {
  fine: [
    { task_class: "refactor-multi-file", n: 12 },
    { task_class: "unknown", n: 5 },
  ],
  coarse: [{ coarse_class: "build", n: 17 }],
  abstain: [{ abstain_reason: "below-threshold", n: 5 }],
  byConfidence: [
    { task_class: "refactor-multi-file", confidence: "high", n: 4 },
    { task_class: "refactor-multi-file", confidence: "medium", n: 8 },
    { task_class: "unknown", confidence: "low", n: 5 },
  ],
  unclassified: 3,
};

class StoreStub {
  getTaskClassCounts() { return counts; }
  getTaskClassVersions() { return [{ classifier_version: 2, n: 17 }]; }
  close() { /* no-op */ }
}

vi.mock("../store/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/index.js")>();
  return { ...actual, Store: StoreStub };
});

vi.mock("../task-class/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../task-class/index.js")>();
  return {
    ...actual,
    runTaskClassPass: () => ({ classified: 0, alreadyCurrent: 17, remaining: 0, version: 2 }),
  };
});

vi.mock("../i18n.js", () => ({
  initCliI18n: async () => {},
  t: (key: string, opts?: Record<string, unknown>) =>
    opts === undefined ? key : `${key} ${JSON.stringify(opts)}`,
}));

describe("task-class command output", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(): Promise<string> {
    const { buildCli } = await import("../cli/index.js");
    const program = await buildCli();
    await program.parseAsync(["node", "claude-stats", "task-class"]);
    return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
  }

  it("prints the §5.10 caveat alongside the per-class tables", async () => {
    // Without this the verb ships confident-looking class totals whose ground
    // truth is a generated corpus, with nothing on the page saying so.
    const out = await run();
    expect(out).toContain("cli:taskClass.caveat");
  });

  it("prints a confidence tier beside every fine-class count", async () => {
    const out = await run();
    const lines = out.split("\n");
    const decided = lines.find((l) => l.includes("refactor-multi-file"));
    expect(decided).toBeDefined();
    expect(decided).toContain("12");
    expect(decided).toContain("cli:taskClass.confidenceMix");
    expect(decided).toContain('"high":4');
    expect(decided).toContain('"medium":8');
    expect(decided).toContain('"low":0');
    // Abstentions are `low` by construction — the tier must say so, not omit it.
    const abstained = lines.find((l) => l.trimStart().startsWith("unknown"));
    expect(abstained).toContain('"low":5');
  });

  it("still publishes the coverage denominator", async () => {
    const out = await run();
    expect(out).toContain("cli:taskClass.coverage");
    expect(out).toContain('"classified":17');
    expect(out).toContain('"unclassified":3');
  });
});
