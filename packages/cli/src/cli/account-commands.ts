/**
 * `account` command registration (Phase 2 A).
 *
 * Thin command layer (cli/** is excluded from coverage — keep logic in covered
 * modules): parse args → call covered attribution / store functions and print.
 *
 *   account                      — show the current logged-in account (tier /
 *                                  billing / seat) plus the known accounts from
 *                                  the accounts table.
 *   account reattribute [--dry-run]
 *                                — recompute attribution across the whole store
 *                                  (auto-backup + atomic; --dry-run = no write).
 *
 * i18n namespace: cli:account.* (locale files are batched in Phase 3).
 */
import type { Command } from "commander";
import { Store } from "../store/index.js";
import { readClaudeAccount } from "../account.js";
import { reattribute } from "../attribution/index.js";
import { t } from "../i18n.js";

export function registerAccountCommands(program: Command): void {
  const account = program
    .command("account")
    .description(t("cli:account.description"))
    .action(() => {
      printCurrentAccount();
    });

  account
    .command("reattribute")
    .description(t("cli:account.reattributeDescription"))
    .option("--dry-run", t("cli:account.dryRunOption"))
    .action((opts: { dryRun?: boolean }) => {
      runReattribute(opts.dryRun ?? false);
    });
}

/** Print the current account + known accounts table. */
function printCurrentAccount(): void {
  const current = readClaudeAccount();
  if (current) {
    console.log(t("cli:account.currentHeader"));
    console.log(`  ${t("cli:account.accountUuid")}: ${current.accountUuid}`);
    if (current.emailAddress) {
      console.log(`  ${t("cli:account.email")}: ${current.emailAddress}`);
    }
    console.log(
      `  ${t("cli:account.organizationType")}: ${current.organizationType ?? "—"}`,
    );
    console.log(
      `  ${t("cli:account.rateLimitTier")}: ${
        current.organizationRateLimitTier ?? current.userRateLimitTier ?? "—"
      }`,
    );
    console.log(`  ${t("cli:account.seatTier")}: ${current.seatTier ?? "—"}`);
    console.log(`  ${t("cli:account.billingType")}: ${current.billingType ?? "—"}`);
    console.log(
      `  ${t("cli:account.extraUsage")}: ${
        current.hasExtraUsageEnabled === null
          ? "—"
          : current.hasExtraUsageEnabled
            ? t("cli:account.enabled")
            : t("cli:account.disabled")
      }`,
    );
  } else {
    console.log(t("cli:account.noCurrentAccount"));
  }

  const store = new Store();
  try {
    const known = store.listAccountsFull();
    if (known.length === 0) {
      console.log(t("cli:account.noKnownAccounts"));
      return;
    }
    console.log("");
    console.log(t("cli:account.knownHeader"));
    for (const a of known) {
      const label = a.emailLabel ?? a.accountUuid;
      const sub = a.subscriptionType ?? a.seatTier ?? "—";
      console.log(`  ${label} — ${sub} (${a.accountUuid})`);
    }
  } finally {
    store.close();
  }
}

/** Run (or dry-run) re-attribution and print the summary. */
function runReattribute(dryRun: boolean): void {
  const store = new Store();
  try {
    const summary = reattribute(store, { dryRun }, Date.now);
    if (summary.dryRun) {
      console.log(t("cli:account.reattributeDryRunHeader"));
    } else {
      console.log(t("cli:account.reattributeDoneHeader"));
      if (summary.backupPath) {
        console.log(t("cli:account.backupWritten", { path: summary.backupPath }));
      }
    }
    console.log(
      t("cli:account.reattributeSummary", {
        total: summary.totalSessions,
        reset: summary.resetCount,
        changed: summary.changed,
      }),
    );
    for (const [source, count] of Object.entries(summary.bySource)) {
      console.log(`  ${source}: ${count}`);
    }
  } finally {
    store.close();
  }
}
