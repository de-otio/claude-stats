/**
 * Account-linking core (sync/index.ts): buildAccountMappings + listLinkableAccounts.
 *
 * These are the functions that were missing entirely — without them
 * `accountMappings` was never populated and `syncAggregates` always reported
 * "No linked accounts". buildAccountMappings is pure (HMAC over a salt), so it
 * is fully deterministic and testable without touching disk. listLinkableAccounts
 * is a projection over a real (temp) Store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../store/index.js";
import {
  buildAccountMappings,
  listLinkableAccounts,
  deriveAccountId,
} from "../sync/index.js";

/** Non-empty-array head with a clear failure when empty (satisfies strict indexing). */
function firstOf<T>(xs: T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error("expected at least one element");
  return x;
}

describe("buildAccountMappings", () => {
  const salt = "a".repeat(64);

  it("derives the same accountId the server-facing path uses (HMAC over salt)", () => {
    const m = firstOf(
      buildAccountMappings([{ accountUuid: "uuid-1", label: "me@example.com" }], salt),
    );
    expect(m.accountId).toBe(deriveAccountId("uuid-1", salt));
    expect(m.accountUuid).toBe("uuid-1");
    expect(m.label).toBe("me@example.com");
    expect(m.shareWithTeams).toBe(true); // default
  });

  it("is deterministic: same uuid + salt → same accountId", () => {
    const a = firstOf(buildAccountMappings([{ accountUuid: "u", label: "x" }], salt));
    const b = firstOf(buildAccountMappings([{ accountUuid: "u", label: "x" }], salt));
    expect(a.accountId).toBe(b.accountId);
  });

  it("is salt-scoped: same uuid, different salt → different accountId", () => {
    const a = firstOf(buildAccountMappings([{ accountUuid: "u", label: "x" }], "a".repeat(64)));
    const b = firstOf(buildAccountMappings([{ accountUuid: "u", label: "x" }], "b".repeat(64)));
    expect(a.accountId).not.toBe(b.accountId);
  });

  it("never leaks the raw uuid into the derived handle", () => {
    const m = firstOf(
      buildAccountMappings([{ accountUuid: "secret-uuid", label: "x" }], salt),
    );
    expect(m.accountId).not.toContain("secret-uuid");
    expect(m.accountId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("honors an explicit shareWithTeams=false", () => {
    const m = firstOf(
      buildAccountMappings([{ accountUuid: "u", label: "x", shareWithTeams: false }], salt),
    );
    expect(m.shareWithTeams).toBe(false);
  });

  it("returns [] for an empty selection", () => {
    expect(buildAccountMappings([], salt)).toEqual([]);
  });
});

describe("listLinkableAccounts", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-link-"));
    store = new Store(join(dir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(overrides: Partial<Parameters<Store["upsertAccount"]>[0]>) {
    store.upsertAccount({
      accountUuid: "uuid",
      organizationUuid: null,
      emailHash: null,
      emailLabel: null,
      organizationType: null,
      rateLimitTier: null,
      userRateLimitTier: null,
      seatTier: null,
      billingType: null,
      subscriptionType: null,
      firstObservedAt: 1,
      lastObservedAt: 1,
      ...overrides,
    });
  }

  it("projects label from emailLabel and detail from subscriptionType", () => {
    seed({ accountUuid: "u1", emailLabel: "me@example.com", subscriptionType: "max" });
    const a = firstOf(listLinkableAccounts(store));
    expect(a).toEqual({ accountUuid: "u1", label: "me@example.com", detail: "max" });
  });

  it("falls back to the uuid as label when no email is known", () => {
    seed({ accountUuid: "u-no-email", emailLabel: null, seatTier: "team" });
    const a = firstOf(listLinkableAccounts(store));
    expect(a.label).toBe("u-no-email");
    expect(a.detail).toBe("team"); // seatTier fallback when subscriptionType absent
  });

  it("returns [] when the store has no accounts", () => {
    expect(listLinkableAccounts(store)).toEqual([]);
  });

  it("orders by last observed, most recent first", () => {
    seed({ accountUuid: "older", emailLabel: "old@x", lastObservedAt: 100 });
    seed({ accountUuid: "newer", emailLabel: "new@x", lastObservedAt: 200 });
    const uuids = listLinkableAccounts(store).map((a) => a.accountUuid);
    expect(uuids).toEqual(["newer", "older"]);
  });
});
