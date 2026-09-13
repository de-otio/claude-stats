import { describe, expect, it } from "vitest";
import { isSqliteBusy, withBusyRetry } from "../repair/dedupe.js";
import { costBasisLabel, summarizeCostBasis } from "../reporter/cost-basis.js";

/** The exact shape `node:sqlite` threw on the first production run. */
function busyError(): Error & { code: string; errcode: number; errstr: string } {
  return Object.assign(new Error("database is locked"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
    errstr: "database is locked",
  });
}

describe("isSqliteBusy", () => {
  it("recognises SQLITE_BUSY by errcode and by message", () => {
    expect(isSqliteBusy(busyError())).toBe(true);
    expect(isSqliteBusy(Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" }))).toBe(true);
  });
  it("does not match other sqlite errors, plain errors, or non-errors", () => {
    expect(isSqliteBusy(Object.assign(new Error("UNIQUE constraint failed"), { code: "ERR_SQLITE_ERROR", errcode: 19 }))).toBe(false);
    expect(isSqliteBusy(new Error("database is locked"))).toBe(false); // no sqlite code
    expect(isSqliteBusy(null)).toBe(false);
    expect(isSqliteBusy("database is locked")).toBe(false);
  });
});

describe("withBusyRetry", () => {
  it("retries a busy failure with exponential backoff and returns the eventual result", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await withBusyRetry(
      async () => {
        calls++;
        if (calls < 3) throw busyError();
        return "done";
      },
      { baseDelayMs: 10, sleep: async (ms) => { delays.push(ms); } },
    );
    expect(result).toBe("done");
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it("gives up after the configured attempts and rethrows the busy error", async () => {
    let calls = 0;
    await expect(
      withBusyRetry(async () => { calls++; throw busyError(); }, { attempts: 4, baseDelayMs: 1, sleep: async () => {} }),
    ).rejects.toMatchObject({ errcode: 5 });
    expect(calls).toBe(4);
  });

  it("rethrows a non-busy error immediately without retrying", async () => {
    let calls = 0;
    await expect(
      withBusyRetry(async () => { calls++; throw new Error("boom"); }, { sleep: async () => {} }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("reports each retry to the caller", async () => {
    const seen: Array<[number, number]> = [];
    let calls = 0;
    await withBusyRetry(
      async () => { calls++; if (calls === 1) throw busyError(); return 1; },
      { baseDelayMs: 5, sleep: async () => {}, onRetry: (a, d) => { seen.push([a, d]); } },
    );
    expect(seen).toEqual([[1, 5]]);
  });
});

describe("costBasisLabel after a completed repair", () => {
  const t = (key: string, opts?: Record<string, unknown>) => `${key}|${JSON.stringify(opts ?? {})}`;
  const mixed = { preDedupeRows: 30, perResponseRows: 70 };
  const allPre = { preDedupeRows: 5, perResponseRows: 0 };

  it("advises running the repair when none has run", () => {
    expect(costBasisLabel(summarizeCostBasis(mixed), t)).toMatch(/^cli:costBasis\.mixed\|/);
    expect(costBasisLabel(summarizeCostBasis(allPre), t)).toMatch(/^cli:costBasis\.allPreDedupe\|/);
  });

  it("switches to the repaired variant once a repair has completed, keeping the numbers", () => {
    const label = costBasisLabel(summarizeCostBasis(mixed, true), t);
    expect(label).toMatch(/^cli:costBasis\.mixedRepaired\|/);
    expect(label).toContain('"rows":30');
    expect(label).toContain('"percent":30');
    expect(costBasisLabel(summarizeCostBasis(allPre, true), t)).toMatch(/^cli:costBasis\.allPreDedupeRepaired\|/);
  });

  it("stays silent on a clean window regardless of repair state", () => {
    expect(costBasisLabel(summarizeCostBasis({ preDedupeRows: 0, perResponseRows: 9 }, true), t)).toBeNull();
    expect(costBasisLabel(summarizeCostBasis({ preDedupeRows: 0, perResponseRows: 0 }, true), t)).toBeNull();
  });
});
