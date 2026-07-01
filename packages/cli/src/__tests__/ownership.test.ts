/**
 * Cost-ownership engine tests (Phase 2 A) — Unit A.
 *
 * Covers the PURE glob matcher, `ownerOf` URL normalization, and `resolveOwner`
 * specificity/tiebreak/OR-match/split/no-match, plus a seeded-LCG property test
 * proving order-independence.
 *
 * Determinism: no `Date.now()`, no clock; all timestamps/ids are fixed literals.
 * Confidentiality: all account/rule shapes come from `__tests__/fixtures/
 * accounts.ts` (00000000- UUIDs, @example.com); git hosts are the placeholder
 * `github.com/example-org` / `gitlab.example.com`; all paths are `/home/user/…`.
 */
import { describe, it, expect } from "vitest";

import { matchGlob, ownerOf, resolveOwner } from "../attribution/ownership.js";
import type { OwnerRule } from "@claude-stats/core/types";
import {
  ACCOUNT_A_UUID,
  ACCOUNT_B_UUID,
  makeOwnerRule,
  PERSONAL_PATH_GLOB,
  WORK_PATH_GLOB,
  PERSONAL_REMOTE_GLOB,
  WORK_REMOTE_GLOB,
} from "./fixtures/accounts.js";

// ── matchGlob: dialect + anchoring table ──────────────────────────────────────

describe("matchGlob — dialect, anchoring, ** = zero, * not crossing /", () => {
  // [glob, value, expected]
  const cases: Array<[string, string, boolean]> = [
    // ** matches across segments including ZERO segments (trailing /**)
    ["/home/user/work/**", "/home/user/work/p", true],
    ["/home/user/work/**", "/home/user/work/p/q", true],
    ["/home/user/work/**", "/home/user/work/", true],
    ["/home/user/work/**", "/home/user/work", true], // ** = zero, no slash
    ["/home/user/work/**", "/home/user/worktree", false], // must NOT bleed past segment
    ["/home/user/work/**", "/home/user/wor", false],
    ["/home/user/work/**", "/home/user", false],

    // fully anchored: no partial / prefix / suffix matches
    ["github.com/example-org", "github.com/example-org", true],
    ["github.com/example-org", "github.com/example-org-fork", false],
    ["github.com/example-org", "xgithub.com/example-org", false],
    ["github.com/example-org", "github.com/example-or", false],

    // single * = any run WITHIN one segment; never crosses /
    ["/home/user/*", "/home/user/project-x", true],
    ["/home/user/*", "/home/user/", true], // * matches empty run
    ["/home/user/*", "/home/user/a/b", false], // * cannot cross /
    ["github.com/*", "github.com/example-org", true],
    ["github.com/*", "github.com/example-org/repo", false], // * stops at /

    // * mid-segment
    ["/home/user/proj-*", "/home/user/proj-x", true],
    ["/home/user/proj-*", "/home/user/proj-x/y", false],
    ["*.git", "repo.git", true],
    ["*.git", "a/repo.git", false], // * cannot cross /

    // ** in the middle spans segments
    ["/home/**/repo", "/home/a/b/repo", true],
    ["/home/**/repo", "/home/repo", true], // ** = zero here too
    ["/home/**/repo", "/home/a/b/repo/x", false],

    // exact glob (no wildcards) is a whole-string match
    ["/home/user/project-x", "/home/user/project-x", true],
    ["/home/user/project-x", "/home/user/project-x/", false],
    ["", "", true],
    ["", "x", false],

    // case-sensitive
    ["/home/User/**", "/home/user/x", false],
    ["/home/user/**", "/home/User/x", false],
  ];

  for (const [glob, value, expected] of cases) {
    it(`${JSON.stringify(glob)} vs ${JSON.stringify(value)} → ${expected}`, () => {
      expect(matchGlob(glob, value)).toBe(expected);
    });
  }

  it("uses the fixture path globs against representative values", () => {
    expect(matchGlob(PERSONAL_PATH_GLOB, "/home/user/personal/blog")).toBe(true);
    expect(matchGlob(PERSONAL_PATH_GLOB, "/home/user/personal")).toBe(true); // ** = zero
    expect(matchGlob(PERSONAL_PATH_GLOB, "/home/user/personalized")).toBe(false);
    expect(matchGlob(WORK_PATH_GLOB, "/home/user/work/client/app")).toBe(true);
    expect(matchGlob(WORK_PATH_GLOB, "/home/user/personal/x")).toBe(false);
  });

  it("does not blow up on adversarial many-star globs (ReDoS-free)", () => {
    // A regex like /^(.*)*$/ against a long non-matching tail would hang; this
    // memoized matcher stays polynomial. Just assert it returns promptly.
    const glob = "/a/" + "**/".repeat(20) + "z";
    const value = "/a/" + "x/".repeat(50) + "nope";
    expect(matchGlob(glob, value)).toBe(false);
    const stars = "*".repeat(40) + "b";
    expect(matchGlob(stars, "a".repeat(60))).toBe(false);
  });
});

// ── ownerOf: every URL form ───────────────────────────────────────────────────

describe("ownerOf — normalizes every remote form to host/firstSegment", () => {
  const cases: Array<[string | null, string | null]> = [
    // scp-like
    ["git@github.com:example-org/repo.git", "github.com/example-org"],
    ["git@github.com:example-org/repo", "github.com/example-org"],
    // https with and without .git
    ["https://github.com/example-org/repo", "github.com/example-org"],
    ["https://github.com/example-org/repo.git", "github.com/example-org"],
    ["http://github.com/example-org/repo", "github.com/example-org"],
    // ssh:// with a port + credentials
    ["ssh://git@github.com:2222/example-org/repo", "github.com/example-org"],
    ["ssh://git@github.com:2222/example-org/repo.git", "github.com/example-org"],
    // nested groups → OWNER is the first path segment after host
    ["git@gitlab.example.com:group/sub/repo.git", "gitlab.example.com/group"],
    ["https://gitlab.example.com/group/sub/repo.git", "gitlab.example.com/group"],
    // https with embedded credentials
    ["https://user:token@github.com/example-org/repo.git", "github.com/example-org"],
    // host case is lowercased; owner segment case preserved
    ["git@GitHub.com:Example-Org/repo.git", "github.com/Example-Org"],
    // trailing slash / whitespace
    ["  https://github.com/example-org/repo.git  ", "github.com/example-org"],
    // unparseable / empty → null
    [null, null],
    ["", null],
    ["   ", null],
    ["not-a-url", null],
    ["https://github.com", null], // no path segment → null
    ["https://github.com/", null], // empty path → null
    ["git@github.com:", null], // no path after colon → null
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(ownerOf(input)).toBe(expected);
    });
  }
});

// ── resolveOwner: matching, specificity, ties, OR, split, no-match ────────────

describe("resolveOwner", () => {
  it("returns null when no rule matches", () => {
    const rules = [makeOwnerRule({ id: 1, pathGlob: WORK_PATH_GLOB, remoteGlob: null })];
    expect(
      resolveOwner({ projectPath: "/home/user/personal/x", repoUrl: null }, rules),
    ).toBeNull();
  });

  it("returns null for empty rules", () => {
    expect(resolveOwner({ projectPath: "/home/user/x", repoUrl: null }, [])).toBeNull();
  });

  it("matches on the path axis", () => {
    const rules = [
      makeOwnerRule({
        id: 1,
        pathGlob: WORK_PATH_GLOB,
        remoteGlob: null,
        target: { kind: "account", accountUuid: ACCOUNT_B_UUID },
      }),
    ];
    expect(
      resolveOwner({ projectPath: "/home/user/work/app", repoUrl: null }, rules),
    ).toEqual({ kind: "account", accountUuid: ACCOUNT_B_UUID });
  });

  it("matches on the remote axis (OR) even when the path does not match", () => {
    const rules = [
      makeOwnerRule({
        id: 1,
        pathGlob: WORK_PATH_GLOB, // will NOT match the path below
        remoteGlob: "github.com/example-org",
        target: { kind: "account", accountUuid: ACCOUNT_A_UUID },
      }),
    ];
    expect(
      resolveOwner(
        { projectPath: "/home/user/somewhere-else", repoUrl: "git@github.com:example-org/repo.git" },
        rules,
      ),
    ).toEqual({ kind: "account", accountUuid: ACCOUNT_A_UUID });
  });

  it("does not match a remote glob when repoUrl is unparseable (owner=null)", () => {
    const rules = [
      makeOwnerRule({ id: 1, pathGlob: null, remoteGlob: "github.com/*" }),
    ];
    expect(
      resolveOwner({ projectPath: "/home/user/x", repoUrl: "not-a-url" }, rules),
    ).toBeNull();
  });

  it("uses the fixture remote glob (gitlab.example.com/*) against a nested owner", () => {
    const rules = [
      makeOwnerRule({
        id: 1,
        pathGlob: null,
        remoteGlob: WORK_REMOTE_GLOB, // gitlab.example.com/*
        target: { kind: "account", accountUuid: ACCOUNT_B_UUID },
      }),
    ];
    expect(
      resolveOwner(
        { projectPath: "/home/user/x", repoUrl: "git@gitlab.example.com:group/sub/repo.git" },
        rules,
      ),
    ).toEqual({ kind: "account", accountUuid: ACCOUNT_B_UUID });
  });

  it("PERSONAL_REMOTE_GLOB (three-segment) does NOT match a two-segment owner", () => {
    // ownerOf yields host/firstSegment only; a `.../*` third segment never exists.
    const rules = [
      makeOwnerRule({ id: 1, pathGlob: null, remoteGlob: PERSONAL_REMOTE_GLOB }),
    ];
    expect(
      resolveOwner(
        { projectPath: "/home/user/x", repoUrl: "git@github.com:example-org/repo.git" },
        rules,
      ),
    ).toBeNull();
  });

  it("picks the more specific glob among matching rules (higher non-wildcard count)", () => {
    const broad = makeOwnerRule({
      id: 1,
      pathGlob: "/home/user/**",
      remoteGlob: null,
      target: { kind: "account", accountUuid: ACCOUNT_A_UUID },
    });
    const specific = makeOwnerRule({
      id: 2,
      pathGlob: "/home/user/work/**",
      remoteGlob: null,
      target: { kind: "account", accountUuid: ACCOUNT_B_UUID },
    });
    const target = resolveOwner(
      { projectPath: "/home/user/work/app", repoUrl: null },
      [broad, specific],
    );
    expect(target).toEqual({ kind: "account", accountUuid: ACCOUNT_B_UUID });
  });

  it("an exact (wildcard-free) glob outranks ANY wildcard glob, even a longer one", () => {
    const longWildcard = makeOwnerRule({
      id: 1,
      pathGlob: "/home/user/work/deeply/nested/**", // many non-wildcard chars
      remoteGlob: null,
      target: { kind: "account", accountUuid: ACCOUNT_A_UUID },
    });
    const exactShort = makeOwnerRule({
      id: 2,
      pathGlob: "/home/user/work/deeply/nested/app", // exact, fewer chars total but exact
      remoteGlob: null,
      target: { kind: "account", accountUuid: ACCOUNT_B_UUID },
    });
    const target = resolveOwner(
      { projectPath: "/home/user/work/deeply/nested/app", repoUrl: null },
      [longWildcard, exactShort],
    );
    expect(target).toEqual({ kind: "account", accountUuid: ACCOUNT_B_UUID });
  });

  it("for a rule matching on both axes, uses the MORE specific matching glob", () => {
    // Rule X matches only via a broad path glob. Rule Y matches on both a broad
    // path AND an exact remote → Y's score comes from the exact remote and wins.
    const broadPathOnly = makeOwnerRule({
      id: 1,
      pathGlob: "/home/user/**",
      remoteGlob: null,
      target: { kind: "account", accountUuid: ACCOUNT_A_UUID },
    });
    const bothAxes = makeOwnerRule({
      id: 2,
      pathGlob: "/home/user/**", // also broad
      remoteGlob: "github.com/example-org", // exact → high specificity
      target: { kind: "account", accountUuid: ACCOUNT_B_UUID },
    });
    const target = resolveOwner(
      { projectPath: "/home/user/work/app", repoUrl: "git@github.com:example-org/repo.git" },
      [broadPathOnly, bothAxes],
    );
    expect(target).toEqual({ kind: "account", accountUuid: ACCOUNT_B_UUID });
  });

  it("breaks specificity ties by higher createdAt, then higher id", () => {
    const base = { pathGlob: "/home/user/work/**", remoteGlob: null };
    const older = makeOwnerRule({
      ...base,
      id: 5,
      createdAt: 1000,
      target: { kind: "account", accountUuid: ACCOUNT_A_UUID },
    });
    const newer = makeOwnerRule({
      ...base,
      id: 2,
      createdAt: 2000,
      target: { kind: "account", accountUuid: ACCOUNT_B_UUID },
    });
    // Same specificity → newer createdAt (2000) wins even with a lower id.
    expect(
      resolveOwner({ projectPath: "/home/user/work/app", repoUrl: null }, [older, newer]),
    ).toEqual({ kind: "account", accountUuid: ACCOUNT_B_UUID });

    // Equal createdAt → higher id wins.
    const a = makeOwnerRule({
      ...base,
      id: 3,
      createdAt: 5000,
      target: { kind: "account", accountUuid: ACCOUNT_A_UUID },
    });
    const b = makeOwnerRule({
      ...base,
      id: 9,
      createdAt: 5000,
      target: { kind: "account", accountUuid: ACCOUNT_B_UUID },
    });
    expect(
      resolveOwner({ projectPath: "/home/user/work/app", repoUrl: null }, [a, b]),
    ).toEqual({ kind: "account", accountUuid: ACCOUNT_B_UUID });
  });

  it("a split rule competes on equal footing and can win on specificity", () => {
    const accountBroad = makeOwnerRule({
      id: 1,
      pathGlob: "/home/user/**",
      remoteGlob: null,
      target: { kind: "account", accountUuid: ACCOUNT_A_UUID },
    });
    const splitSpecific = makeOwnerRule({
      id: 2,
      pathGlob: "/home/user/work/**",
      remoteGlob: null,
      target: { kind: "split" },
    });
    expect(
      resolveOwner({ projectPath: "/home/user/work/app", repoUrl: null }, [accountBroad, splitSpecific]),
    ).toEqual({ kind: "split" });
  });

  it("a split rule can also lose to a more specific account rule", () => {
    const splitBroad = makeOwnerRule({
      id: 1,
      pathGlob: "/home/user/**",
      remoteGlob: null,
      target: { kind: "split" },
    });
    const accountSpecific = makeOwnerRule({
      id: 2,
      pathGlob: "/home/user/work/**",
      remoteGlob: null,
      target: { kind: "account", accountUuid: ACCOUNT_A_UUID },
    });
    expect(
      resolveOwner({ projectPath: "/home/user/work/app", repoUrl: null }, [splitBroad, accountSpecific]),
    ).toEqual({ kind: "account", accountUuid: ACCOUNT_A_UUID });
  });
});

// ── property test: order-independence (seeded LCG shuffle) ─────────────────────

/** Tiny seeded LCG → deterministic pseudo-random in [0,1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Fisher–Yates shuffle driven by a seeded rng (pure over its inputs). */
function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

describe("property: resolveOwner is order-independent (total, deterministic)", () => {
  it("shuffling the rules array never changes the resolved target", () => {
    // A fixed, deterministic rule set spanning both axes, exact + wildcard,
    // account + split, distinct createdAt/id so ties resolve uniquely.
    const rules: OwnerRule[] = [
      makeOwnerRule({ id: 1, createdAt: 1000, pathGlob: "/home/user/**", remoteGlob: null, target: { kind: "account", accountUuid: ACCOUNT_A_UUID } }),
      makeOwnerRule({ id: 2, createdAt: 2000, pathGlob: "/home/user/work/**", remoteGlob: null, target: { kind: "account", accountUuid: ACCOUNT_B_UUID } }),
      makeOwnerRule({ id: 3, createdAt: 3000, pathGlob: "/home/user/personal/**", remoteGlob: null, target: { kind: "split" } }),
      makeOwnerRule({ id: 4, createdAt: 4000, pathGlob: null, remoteGlob: "gitlab.example.com/*", target: { kind: "account", accountUuid: ACCOUNT_A_UUID } }),
      makeOwnerRule({ id: 5, createdAt: 5000, pathGlob: null, remoteGlob: "github.com/example-org", target: { kind: "account", accountUuid: ACCOUNT_B_UUID } }),
      makeOwnerRule({ id: 6, createdAt: 6000, pathGlob: "/home/user/work/exact/app", remoteGlob: null, target: { kind: "account", accountUuid: ACCOUNT_A_UUID } }),
    ];

    const inputs: Array<{ projectPath: string; repoUrl: string | null }> = [
      { projectPath: "/home/user/work/app", repoUrl: null },
      { projectPath: "/home/user/personal/blog", repoUrl: null },
      { projectPath: "/home/user/misc", repoUrl: null },
      { projectPath: "/home/user/work/exact/app", repoUrl: null },
      { projectPath: "/home/user/nomatch-top", repoUrl: "git@github.com:example-org/repo.git" },
      { projectPath: "/home/user/x", repoUrl: "git@gitlab.example.com:group/sub/repo.git" },
      { projectPath: "/elsewhere", repoUrl: "not-a-url" },
    ];

    for (const input of inputs) {
      const expected = resolveOwner(input, rules);
      for (let seed = 1; seed <= 50; seed++) {
        const shuffled = shuffle(rules, lcg(seed));
        expect(resolveOwner(input, shuffled)).toEqual(expected);
      }
    }
  });
});
