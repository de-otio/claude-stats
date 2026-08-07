/**
 * Unit and property tests for the pure task-class classifier.
 *
 * The agreement harness (`task-class-agreement.test.ts`) measures whether the
 * rules recover intended behaviour. This file pins the things agreement cannot
 * see: the boundary of every threshold, the invariants that must hold for ANY
 * input, and the failure paths that would silently corrupt a per-class delta.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  COARSE_OF,
  TASK_CLASS_VERSION,
  classifyTaskClass,
  classifySession,
  deriveFeatures,
  isConfigPath,
  isProsePath,
  type TaskClassFeatures,
} from "@claude-stats/core/taskClass";

/** A zeroed feature vector; tests set only the fields they care about. */
function features(over: Partial<TaskClassFeatures> = {}): TaskClassFeatures {
  return {
    toolCalls: 0, editCalls: 0, writeCalls: 0, readCalls: 0, searchCalls: 0,
    bashCalls: 0, filesTouched: 0, editedFiles: 0, configFiles: 0, proseFiles: 0,
    toolErrors: 0, turns: 1,
    ...over,
  };
}

describe("path rules", () => {
  it("classifies config by extension, basename and directory segment", () => {
    expect(isConfigPath("/w/a/package.json")).toBe(true);
    expect(isConfigPath("/w/a/package-lock.json")).toBe(true);
    expect(isConfigPath("/w/a/Dockerfile")).toBe(true);
    expect(isConfigPath("/w/a/.npmrc")).toBe(true);
    expect(isConfigPath("/w/a/terraform/main.tf")).toBe(true);
    expect(isConfigPath("/w/a/.github/workflows/ci.yml")).toBe(true);
    expect(isConfigPath("C:\\w\\a\\.github\\workflows\\ci.yml")).toBe(true);
  });

  it("does not treat a source file as config just because it is named like a directory", () => {
    // The segment scan skips the basename on purpose: `deploy.ts` is code.
    expect(isConfigPath("/w/a/src/deploy.ts")).toBe(false);
    expect(isConfigPath("/w/a/src/order.ts")).toBe(false);
  });

  it("treats a leading-dot basename as having no extension", () => {
    // `.eslintrc` must match by basename, not resolve `.eslintrc` as an extension.
    expect(isConfigPath("/w/a/.eslintrc")).toBe(true);
    expect(isProsePath("/w/a/.eslintrc")).toBe(false);
  });

  it("classifies prose separately from config", () => {
    expect(isProsePath("/w/a/README.md")).toBe(true);
    expect(isProsePath("/w/a/doc/design.adoc")).toBe(true);
    expect(isConfigPath("/w/a/README.md")).toBe(false);
  });
});

describe("feature derivation", () => {
  it("is order-independent — SQLite row order must not change a class", () => {
    const a = { tools: ["Read", "Edit"], filePaths: ["/w/a/x.ts"], toolErrorCount: 1 };
    const b = { tools: ["Bash"], filePaths: [], toolErrorCount: 0 };
    const c = { tools: ["Grep"], filePaths: ["/w/a/y.ts"], toolErrorCount: 2 };
    expect(deriveFeatures([a, b, c])).toEqual(deriveFeatures([c, a, b]));
  });

  it("counts DISTINCT files, so re-editing one file is not a multi-file sweep", () => {
    const f = deriveFeatures([
      { tools: ["Edit"], filePaths: ["/w/a/x.ts"] },
      { tools: ["Edit"], filePaths: ["/w/a/x.ts"] },
      { tools: ["Edit"], filePaths: ["/w/a/x.ts"] },
    ]);
    expect(f.filesTouched).toBe(1);
    expect(f.editedFiles).toBe(1);
    expect(f.editCalls).toBe(3);
  });

  it("separates files CHANGED from files merely read", () => {
    const f = deriveFeatures([
      { tools: ["Read"], filePaths: ["/w/a/a.ts"] },
      { tools: ["Read"], filePaths: ["/w/a/b.ts"] },
      { tools: ["Read"], filePaths: ["/w/a/c.ts"] },
      { tools: ["Edit"], filePaths: ["/w/a/d.ts"] },
    ]);
    expect(f.filesTouched).toBe(4);
    expect(f.editedFiles).toBe(1);
  });

  it("does not report a focused fix after wide reading as a multi-file sweep", () => {
    // The regression this guards: keying the sweep rule on files SEEN rather
    // than files CHANGED turned "read eight files, edit one heavily" — a
    // focused change informed by wide reading — into `refactor-multi-file`,
    // contaminating the class most likely to be quoted in a tier argument.
    const messages = [
      ...["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => ({
        tools: ["Read"], filePaths: [`/w/a/${n}.ts`],
      })),
      ...Array.from({ length: 6 }, () => ({ tools: ["Edit"], filePaths: ["/w/a/a.ts"] })),
    ];
    const f = deriveFeatures(messages);
    expect(f.filesTouched).toBe(8);
    expect(f.editedFiles).toBe(1);
    const r = classifyTaskClass(f);
    expect(r.fine).not.toBe("refactor-multi-file");
    expect(r.fine).toBe("unknown");
    expect(r.coarse).toBe("build");
  });

  it("attributes a mixed Read+Edit message's paths to the change (stated approximation)", () => {
    // Tool names and path arguments are stored per message but not paired, so
    // this over-counts by design. Pinning it means the approximation is a
    // documented choice rather than an accident someone later "fixes" blindly.
    const f = deriveFeatures([{ tools: ["Read", "Edit"], filePaths: ["/w/a/x.ts", "/w/a/y.ts"] }]);
    expect(f.editedFiles).toBe(2);
  });

  it("falls back to message count for turns when is_turn_start is absent (pre-V18)", () => {
    const f = deriveFeatures([{ tools: ["Read"] }, { tools: ["Read"] }]);
    expect(f.turns).toBe(2);
  });

  it("tolerates null/absent columns without throwing", () => {
    expect(() =>
      deriveFeatures([{ tools: null, filePaths: null, toolErrorCount: null, isTurnStart: null }]),
    ).not.toThrow();
  });
});

describe("rule boundaries", () => {
  it("R0: below MIN_TOOL_CALLS abstains as sparse", () => {
    const r = classifyTaskClass(features({ toolCalls: 2, readCalls: 2 }));
    expect(r.fine).toBe("unknown");
    expect(r.abstainReason).toBe("sparse");
    expect(r.coarse).toBe("unknown");
  });

  it("R0 boundary: exactly MIN_TOOL_CALLS is classified", () => {
    const r = classifyTaskClass(features({ toolCalls: 3, readCalls: 3 }));
    expect(r.fine).toBe("explore");
  });

  it("R1: one error is never enough, regardless of rate", () => {
    // 1 error in 3 calls is a rate of 0.33 — above the floor — but a rate
    // computed off a single failure is not evidence.
    const r = classifyTaskClass(features({ toolCalls: 3, readCalls: 3, toolErrors: 1 }));
    expect(r.fine).toBe("explore");
  });

  it("R1: the error clause does not fire on a broad sweep", () => {
    // 8 files touched — above DEBUG_MAX_FILES — so an error-heavy multi-file
    // edit stays a sweep instead of diluting the debug class.
    const r = classifyTaskClass(
      features({ toolCalls: 20, editCalls: 10, editedFiles: 8, toolErrors: 5 }),
    );
    expect(r.fine).toBe("refactor-multi-file");
  });

  it("R1: the error clause DOES fire on a narrow surface", () => {
    const r = classifyTaskClass(
      features({ toolCalls: 20, editCalls: 4, readCalls: 10, bashCalls: 6, editedFiles: 2, toolErrors: 5 }),
    );
    expect(r.fine).toBe("debug");
    expect(r.coarse).toBe("diagnose");
  });

  it("R1: execution dominance needs near-zero mutation", () => {
    const investigating = classifyTaskClass(features({ toolCalls: 10, bashCalls: 8, readCalls: 2 }));
    expect(investigating.fine).toBe("debug");
    // Same bash share, but real mutation alongside → not diagnosis.
    const buildingAndTesting = classifyTaskClass(
      features({ toolCalls: 20, bashCalls: 10, editCalls: 6, editedFiles: 5 }),
    );
    expect(buildingAndTesting.fine).toBe("refactor-multi-file");
  });

  it("R2: one Write beside many Edits is not greenfield", () => {
    const r = classifyTaskClass(
      features({ toolCalls: 12, writeCalls: 1, editCalls: 6, editedFiles: 5 }),
    );
    expect(r.fine).toBe("refactor-multi-file");
  });

  it("R2: two Writes carrying half the mutation is greenfield", () => {
    const r = classifyTaskClass(features({ toolCalls: 8, writeCalls: 3, editCalls: 1, editedFiles: 3 }));
    expect(r.fine).toBe("greenfield");
    expect(r.coarse).toBe("build");
    expect(r.confidence).toBe("high");
  });

  it("R3: an incidentally-touched config file does not make a config chore", () => {
    // 1 config file out of 5 = 0.2, far below the dominance floor.
    const r = classifyTaskClass(
      features({ toolCalls: 14, editCalls: 7, editedFiles: 5, configFiles: 1 }),
    );
    expect(r.fine).toBe("refactor-multi-file");
  });

  it("R3: config dominance wins even when the sweep rule would also fire", () => {
    const r = classifyTaskClass(
      features({ toolCalls: 14, editCalls: 7, editedFiles: 4, configFiles: 4 }),
    );
    expect(r.fine).toBe("config-chore");
  });

  it("R4: a documentation sweep abstains rather than posing as a refactor", () => {
    const r = classifyTaskClass(
      features({ toolCalls: 16, editCalls: 8, editedFiles: 5, proseFiles: 5 }),
    );
    expect(r.fine).toBe("unknown");
    expect(r.abstainReason).toBe("prose-dominant");
    // It demonstrably changed files, so the coarse grain still carries it.
    expect(r.coarse).toBe("build");
  });

  it("R5 boundary: one edit short of the floor abstains instead of guessing", () => {
    const short = classifyTaskClass(features({ toolCalls: 10, editCalls: 4, editedFiles: 4 }));
    expect(short.fine).toBe("unknown");
    expect(short.abstainReason).toBe("below-threshold");
    expect(short.coarse).toBe("build");
    const enough = classifyTaskClass(features({ toolCalls: 10, editCalls: 5, editedFiles: 4 }));
    expect(enough.fine).toBe("refactor-multi-file");
  });

  it("R7: a small targeted edit abstains at the fine grain and is rescued at the coarse", () => {
    const r = classifyTaskClass(features({ toolCalls: 4, editCalls: 1, readCalls: 2, bashCalls: 1, editedFiles: 1 }));
    expect(r.fine).toBe("unknown");
    expect(r.abstainReason).toBe("below-threshold");
    expect(r.coarse).toBe("build");
  });

  it("pre-V10 rows (no file evidence) cannot trigger the file-count rules", () => {
    // Mutating, zero paths. Neither config nor prose nor sweep may fire — a
    // rule that read an empty vector as "zero files" would classify a decade of
    // history as small targeted edits with false confidence.
    const r = classifyTaskClass(features({ toolCalls: 20, editCalls: 12, editedFiles: 0 }));
    expect(r.fine).toBe("unknown");
    expect(r.abstainReason).toBe("below-threshold");
  });
});

describe("invariants that must hold for every input", () => {
  const arbFeatures = fc.record({
    toolCalls: fc.integer({ min: 0, max: 200 }),
    editCalls: fc.integer({ min: 0, max: 100 }),
    writeCalls: fc.integer({ min: 0, max: 100 }),
    readCalls: fc.integer({ min: 0, max: 100 }),
    searchCalls: fc.integer({ min: 0, max: 100 }),
    bashCalls: fc.integer({ min: 0, max: 100 }),
    filesTouched: fc.integer({ min: 0, max: 60 }),
    editedFiles: fc.integer({ min: 0, max: 60 }),
    configFiles: fc.integer({ min: 0, max: 60 }),
    proseFiles: fc.integer({ min: 0, max: 60 }),
    toolErrors: fc.integer({ min: 0, max: 100 }),
    turns: fc.integer({ min: 0, max: 60 }),
  });

  it("never throws and always returns a member of the closed unions", () => {
    const fine = new Set(["debug", "refactor-multi-file", "greenfield", "review", "config-chore", "explore", "unknown"]);
    const coarse = new Set(["build", "diagnose", "support", "unknown"]);
    fc.assert(
      fc.property(arbFeatures, (f) => {
        const r = classifyTaskClass(f);
        expect(fine.has(r.fine)).toBe(true);
        expect(coarse.has(r.coarse)).toBe(true);
        expect(["high", "medium", "low"]).toContain(r.confidence);
      }),
      { numRuns: 500 },
    );
  });

  it("stamps the current classifier version on every result", () => {
    fc.assert(
      fc.property(arbFeatures, (f) => {
        expect(classifyTaskClass(f).version).toBe(TASK_CLASS_VERSION);
      }),
      { numRuns: 200 },
    );
  });

  it("keeps the coarse column consistent with a decided fine column", () => {
    // The two columns are stored separately and filtered separately; if they
    // could disagree, a `build` total and the sum of its fine classes would
    // silently differ in a report.
    fc.assert(
      fc.property(arbFeatures, (f) => {
        const r = classifyTaskClass(f);
        if (r.fine !== "unknown") expect(r.coarse).toBe(COARSE_OF[r.fine]);
      }),
      { numRuns: 500 },
    );
  });

  it("sets abstainReason exactly when the fine class is unknown", () => {
    fc.assert(
      fc.property(arbFeatures, (f) => {
        const r = classifyTaskClass(f);
        expect(r.abstainReason === null).toBe(r.fine !== "unknown");
        if (r.fine === "unknown") expect(r.confidence).toBe("low");
      }),
      { numRuns: 500 },
    );
  });

  it("is deterministic — the same vector always yields the same answer", () => {
    fc.assert(
      fc.property(arbFeatures, (f) => {
        expect(classifyTaskClass(f)).toEqual(classifyTaskClass({ ...f }));
      }),
      { numRuns: 200 },
    );
  });

  it("never emits `review` in v1 — it is merged into `explore` (spec §5.4)", () => {
    fc.assert(
      fc.property(arbFeatures, (f) => {
        expect(classifyTaskClass(f).fine).not.toBe("review");
      }),
      { numRuns: 500 },
    );
  });

  it("adding reads to a non-mutating session never makes it a build class", () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 40 }), fc.integer({ min: 0, max: 40 }), (base, extra) => {
        const r = classifyTaskClass(features({ toolCalls: base + extra, readCalls: base + extra }));
        expect(r.coarse).not.toBe("build");
      }),
      { numRuns: 200 },
    );
  });
});

describe("classifySession end-to-end", () => {
  it("classifies a session with no messages as sparse rather than omitting it", () => {
    const r = classifySession([]);
    expect(r.fine).toBe("unknown");
    expect(r.abstainReason).toBe("sparse");
  });

  it("recovers a config chore from raw message rows", () => {
    const r = classifySession([
      { tools: ["Read", "Edit"], filePaths: ["/w/a/package.json"], isTurnStart: true },
      { tools: ["Edit"], filePaths: ["/w/a/.github/workflows/ci.yml"] },
      { tools: ["Bash"], filePaths: [] },
    ]);
    expect(r.fine).toBe("config-chore");
    expect(r.coarse).toBe("build");
  });
});
