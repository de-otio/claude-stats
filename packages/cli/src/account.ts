/**
 * Read the currently logged-in Claude account from ~/.claude.json.
 *
 * This file only ever contains one account (Claude Code doesn't support
 * concurrent multi-account usage), so the value reflects whoever is
 * logged in at the time of reading.
 */
import fs from "node:fs";
import { paths } from "@claude-stats/core/paths";

export interface ClaudeAccount {
  accountUuid: string;
  emailAddress: string | null;
  organizationUuid: string | null;
  organizationType: string | null;
  organizationRateLimitTier: string | null;
  userRateLimitTier: string | null;
  seatTier: string | null;
  billingType: string | null;
  hasExtraUsageEnabled: boolean | null;
}

/** Narrow an untrusted JSON value to `string | null` (drops non-strings). */
function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** Narrow an untrusted JSON value to `boolean | null` (drops non-booleans). */
function asBoolean(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

export function readClaudeAccount(): ClaudeAccount | null {
  try {
    const raw = fs.readFileSync(paths.claudeConfigFile, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const acct = data.oauthAccount as Record<string, unknown> | undefined;
    if (acct && typeof acct.accountUuid === "string") {
      // Harden against prototype pollution (plan §7 sec#6): copy only the
      // fields we need off the untrusted JSON.parse result into a
      // null-prototype object before reading them. We deliberately do NOT
      // capture organizationName / displayName (identifying).
      const src: Record<string, unknown> = Object.assign(Object.create(null), {
        accountUuid: acct.accountUuid,
        emailAddress: acct.emailAddress,
        organizationUuid: acct.organizationUuid,
        organizationType: acct.organizationType,
        organizationRateLimitTier: acct.organizationRateLimitTier,
        userRateLimitTier: acct.userRateLimitTier,
        seatTier: acct.seatTier,
        billingType: acct.billingType,
        hasExtraUsageEnabled: acct.hasExtraUsageEnabled,
      });
      return {
        accountUuid: src.accountUuid as string,
        emailAddress: asString(src.emailAddress),
        organizationUuid: asString(src.organizationUuid),
        organizationType: asString(src.organizationType),
        organizationRateLimitTier: asString(src.organizationRateLimitTier),
        userRateLimitTier: asString(src.userRateLimitTier),
        seatTier: asString(src.seatTier),
        billingType: asString(src.billingType),
        hasExtraUsageEnabled: asBoolean(src.hasExtraUsageEnabled),
      };
    }
  } catch {
    // File missing or malformed — ignore
  }
  return null;
}
