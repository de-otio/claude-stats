/**
 * HMAC-SHA-256 account ID derivation.
 *
 * The raw account_uuid never leaves the user's device. Only a one-way
 * HMAC-derived accountId is stored in the cloud. The salt is per-user,
 * so two users with the same account_uuid produce different accountId values.
 *
 * See doc/analysis/team-app/11-account-separation.md
 */
import crypto from "node:crypto";

/**
 * Derive a privacy-preserving account ID from the raw account UUID.
 *
 * accountId = HMAC-SHA-256(account_uuid, userSalt).slice(0, 32)
 *
 * @param accountUuid - Raw account UUID from ~/.claude.json
 * @param userSalt - Per-user random salt (64-char hex string)
 * @returns 32-char hex string suitable for use as accountId
 */
export function deriveAccountId(accountUuid: string, userSalt: string): string {
  const hmac = crypto.createHmac("sha256", userSalt);
  hmac.update(accountUuid);
  return hmac.digest("hex").slice(0, 32);
}

/**
 * Generate a random user salt (32 bytes = 64 hex chars).
 * Generated once during `sync --setup` and stored in the user's
 * cloud profile + local sync_config table.
 */
export function generateUserSalt(): string {
  return crypto.randomBytes(32).toString("hex");
}
