/**
 * Observation writer (Phase 2 A).
 *
 * Records an append-only `account_observations` row when the currently
 * logged-in CLI account CHANGES, and upserts the `accounts` metadata row.
 * Dedupes against the latest CLI observation so a no-change collect does not
 * append a redundant row.
 *
 * The clock is injected (`now: () => number`) for determinism — the only
 * stateful seam in the attribution module. Email is never stored raw: we store
 * `sha256(lowercased email)` as `email_hash` (plan §4 / ASSUMPTIONS #8). The
 * raw email is kept only as `emailLabel` for local current-account display
 * (never emitted on the unauthenticated HTTP path — see Unit C redaction).
 */
import { createHash } from "node:crypto";
import type { Store } from "../store/index.js";
import type { readClaudeAccount } from "../account.js";

type ClaudeAccount = ReturnType<typeof readClaudeAccount>;

/** sha256 of the lowercased, trimmed email (stable, non-reversible). */
export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

/**
 * The CLI surface used for observation rows written during `collect`. The
 * observation writer always records the *current* account as active on the CLI
 * surface (that's the surface `readClaudeAccount` reflects).
 */
const CLI_SURFACE = "cli";

/** The observation source tag for collect-time current-account sightings. */
const COLLECT_SOURCE = "collect";

/**
 * Write an observation for the current account if it changed since the last CLI
 * observation. No-op when `account` is null (not logged in / unreadable).
 *
 * Returns `true` when a new observation row was appended, `false` when the
 * current account matched the latest CLI observation (deduped) or there was no
 * account to record. The `accounts` metadata row is upserted on every non-null
 * call (so tier/billing/email_hash stay fresh) regardless of dedupe.
 */
export function writeObservation(
  store: Store,
  account: ClaudeAccount,
  now: () => number,
): boolean {
  if (account === null) return false;

  const ts = now();
  const rateLimitTier = account.organizationRateLimitTier ?? account.userRateLimitTier ?? null;
  const billingType = account.billingType ?? null;
  const emailHash = account.emailAddress ? hashEmail(account.emailAddress) : null;

  // Always refresh the accounts metadata row (monotonic upsert in the store).
  store.upsertAccount({
    accountUuid: account.accountUuid,
    organizationUuid: account.organizationUuid,
    emailHash,
    emailLabel: account.emailAddress,
    organizationType: account.organizationType,
    rateLimitTier: account.organizationRateLimitTier,
    userRateLimitTier: account.userRateLimitTier,
    seatTier: account.seatTier,
    billingType: account.billingType,
    subscriptionType: null, // unknown from ~/.claude.json; telemetry/otel fill it
    firstObservedAt: ts,
    lastObservedAt: ts,
  });

  // Dedupe: only append an observation when the account differs from the most
  // recent CLI observation. getAccountObservations('cli') is ASC by time, so
  // the latest is the last element.
  const cliObs = store.getAccountObservations(CLI_SURFACE);
  const latest = cliObs.length > 0 ? cliObs[cliObs.length - 1]! : null;
  if (latest && latest.accountUuid === account.accountUuid) {
    return false; // unchanged — no new observation
  }

  store.recordAccountObservation({
    accountUuid: account.accountUuid,
    observedAt: ts,
    source: COLLECT_SOURCE,
    surface: CLI_SURFACE,
    rateLimitTier,
    billingType,
  });
  return true;
}
