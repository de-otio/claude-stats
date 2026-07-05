/**
 * `claude-stats purge` CLI command — dry-run-by-default gating.
 *
 * The command must NEVER delete anything unless `--yes` is passed; without it,
 * it prints a preview and exits 0. These tests mock `purgeAllData` so they never
 * touch the real `~/.claude-stats` tree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const purgeAllDataMock = vi.fn();

vi.mock("../../archive/index.js", () => ({
  purgeAllData: purgeAllDataMock,
}));

describe("purge command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    purgeAllDataMock.mockReset();
    purgeAllDataMock.mockReturnValue({
      outcomes: [
        { target: "/fake/archive", deleted: true, existed: true },
        { target: "/fake/bundle", deleted: true, existed: true },
      ],
      unregistered: true,
      ok: true,
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("without --yes: prints a dry-run preview and never calls purgeAllData", async () => {
    const { buildCli } = await import("../../cli/index.js");
    const program = await buildCli();
    await program.parseAsync(["node", "claude-stats", "purge"]);

    expect(purgeAllDataMock).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toMatch(/Dry run/i);
    expect(output).toMatch(/would delete/i);
  });

  it("with --yes: calls purgeAllData and does not delete the DB by default", async () => {
    const { buildCli } = await import("../../cli/index.js");
    const program = await buildCli();
    await program.parseAsync(["node", "claude-stats", "purge", "--yes"]);

    expect(purgeAllDataMock).toHaveBeenCalledTimes(1);
    expect(purgeAllDataMock).toHaveBeenCalledWith({ deleteDb: false });
  });

  it("with --yes --include-db: passes deleteDb: true", async () => {
    const { buildCli } = await import("../../cli/index.js");
    const program = await buildCli();
    await program.parseAsync(["node", "claude-stats", "purge", "--yes", "--include-db"]);

    expect(purgeAllDataMock).toHaveBeenCalledWith({ deleteDb: true });
  });
});
