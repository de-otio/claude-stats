import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  isPathSafeComponent,
  assertPathSafeComponent,
  isValidDeviceId,
  assertDeviceId,
  type DeviceId,
  type AggregateProjection,
  type HasNoPersonalFields,
} from "@claude-stats/core/types/shard";

// A synthetic, well-formed device id (fake UUID — no real data).
const UUID = "3f9a1c2e-aaaa-bbbb-cccc-0123456789ab";
const HEX = "deadbeefcafe0123";

describe("isPathSafeComponent", () => {
  it("accepts ordinary component names", () => {
    for (const ok of ["a", "session-01", "proj_x", "deadbeef", UUID, "a..b", "..hidden", "x".repeat(255)]) {
      expect(isPathSafeComponent(ok)).toBe(true);
    }
  });

  it("rejects empty, over-long, self/parent refs, separators, NUL and control chars", () => {
    for (const bad of ["", "x".repeat(256), ".", "..", "a/b", "a\\b", "/", "..\\..", "a\0b", "a\nb", "\t", "x\x7f"]) {
      expect(isPathSafeComponent(bad)).toBe(false);
    }
  });

  it("assertPathSafeComponent throws on unsafe input without echoing the value", () => {
    expect(() => assertPathSafeComponent("../etc", "device id")).toThrowError(/Unsafe device id/);
    // The thrown message must not leak the offending value.
    try {
      assertPathSafeComponent("../secret-path", "path component");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-path");
    }
    expect(() => assertPathSafeComponent("ok")).not.toThrow();
  });

  it("property: any string containing a separator or NUL is rejected (traversal guard)", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom("/", "\\", "\0"),
        (s, sep) => {
          const withSep = `a${sep}${s}`;
          expect(isPathSafeComponent(withSep)).toBe(false);
        },
      ),
      { numRuns: 300, seed: 42 },
    );
  });
});

describe("isValidDeviceId / assertDeviceId", () => {
  it("accepts a lowercase UUID and lowercase hex (8–64 chars)", () => {
    expect(isValidDeviceId(UUID)).toBe(true);
    expect(isValidDeviceId(HEX)).toBe(true);
    expect(isValidDeviceId("a".repeat(64))).toBe(true);
  });

  it("rejects uppercase, too-short hex, non-hex, path-y ids, and traversal attempts", () => {
    for (const bad of [
      UUID.toUpperCase(),
      "DEADBEEFCAFE0123",
      "abc123", // 6 chars < 8
      "a".repeat(65), // > 64
      "not-hex-zz",
      "../../etc/passwd",
      "..",
      "dead/beef",
      "dead beef",
      "",
    ]) {
      expect(isValidDeviceId(bad)).toBe(false);
    }
  });

  it("assertDeviceId brands a valid id and throws on an invalid one", () => {
    const id: DeviceId = assertDeviceId(UUID);
    expect(id).toBe(UUID);
    expect(() => assertDeviceId("../evil")).toThrowError(/Invalid DeviceId/);
  });

  it("property: a validated device id is always path-safe (write==read guard)", () => {
    const hexArb = fc
      .array(fc.constantFrom(..."0123456789abcdef".split("")), { minLength: 1, maxLength: 80 })
      .map((chars) => chars.join(""));
    fc.assert(
      fc.property(hexArb, (lower) => {
        if (isValidDeviceId(lower)) {
          // Every accepted id must also survive the shared path-safety guard —
          // this is the invariant that makes on-read validation safe (F5).
          expect(isPathSafeComponent(lower)).toBe(true);
        }
      }),
      { numRuns: 300, seed: 7 },
    );
  });
});

describe("AggregateProjection plane-separation invariant", () => {
  it("compile-time: the aggregate type names no forbidden personal field", () => {
    // If this ever regresses, `HasNoPersonalFields<AggregateProjection>` becomes
    // `false` and the assignment below fails to type-check (Phase-G structural
    // test guards the runtime shape too).
    const clean: HasNoPersonalFields<AggregateProjection> = true;
    expect(clean).toBe(true);
  });

  it("a hand-built aggregate carries only counts/totals — no session/prompt data", () => {
    const agg: AggregateProjection = {
      periodStart: "2026-07-01",
      periodKind: "day",
      cohortId: "opaque-cohort-1",
      sessionCount: 3,
      promptCount: 40,
      assistantMessageCount: 41,
      inputTokens: 1000,
      outputTokens: 2000,
      cacheCreationTokens: 10,
      cacheReadTokens: 20,
      estimatedCostUsd: 1.23,
      models: ["a-model", "b-model"],
      _schema: 1,
    };
    // The keys are a closed set of non-sensitive aggregates.
    expect(Object.keys(agg).sort()).not.toContain("promptText");
    expect(Object.keys(agg)).not.toContain("sourceFile");
    expect(Object.keys(agg)).not.toContain("sessionId");
  });
});
