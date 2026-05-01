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
}

export function readClaudeAccount(): ClaudeAccount | null {
  try {
    const raw = fs.readFileSync(paths.claudeConfigFile, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const acct = data.oauthAccount as Record<string, unknown> | undefined;
    if (acct && typeof acct.accountUuid === "string") {
      return {
        accountUuid: acct.accountUuid,
        emailAddress: typeof acct.emailAddress === "string" ? acct.emailAddress : null,
        organizationUuid: typeof acct.organizationUuid === "string" ? acct.organizationUuid : null,
      };
    }
  } catch {
    // File missing or malformed — ignore
  }
  return null;
}
