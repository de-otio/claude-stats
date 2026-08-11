/**
 * `repair` command registration.
 *
 *   repair project-paths [--dry-run]
 *       — recompute project_path (and dependent repo_url) for every session
 *         whose source file still exists, using the session's own `cwd` as
 *         ground truth instead of the lossy decoded directory name.
 *         Auto-backup + atomic; --dry-run = no write.
 *
 *   repair ticket-links [--dry-run]
 *       — drop every AUTOMATIC ticket link and re-derive it under the CURRENT
 *         `tickets.projectKeys` allowlist. Manual links and negations survive.
 *         Auto-backup + atomic; --dry-run runs it and rolls back.
 *
 * Thin command layer (cli/** is excluded from coverage — keep logic in
 * covered modules): parse args → call the covered repair function and print.
 *
 * i18n namespace: cli:repair.*
 */
import type { Command } from "commander";
import { Store } from "../store/index.js";
import { repairProjectPaths } from "../repair/project-paths.js";
import { reextractTicketLinks } from "../repair/ticket-links.js";
import { loadConfig, ticketProjectKeys } from "../config.js";
import { t } from "../i18n.js";

export function registerRepairCommands(program: Command): void {
  const repair = program
    .command("repair")
    .description(t("cli:repair.description"));

  repair
    .command("project-paths")
    .description(t("cli:repair.projectPaths.description"))
    .option("--dry-run", t("cli:repair.projectPaths.dryRunOption"))
    .action(async (opts: { dryRun?: boolean }) => {
      await runRepairProjectPaths(opts.dryRun ?? false);
    });

  repair
    .command("ticket-links")
    .description(t("cli:repair.ticketLinks.description"))
    .option("--dry-run", t("cli:repair.ticketLinks.dryRunOption"))
    .action((opts: { dryRun?: boolean }) => {
      runRepairTicketLinks(opts.dryRun ?? false);
    });
}

function runRepairTicketLinks(dryRun: boolean): void {
  const store = new Store();
  try {
    const allowlist = ticketProjectKeys(loadConfig());
    // The allowlist in force is printed BEFORE the numbers: the whole point of
    // the repair is that the outcome depends on it, and a reader who forgot to
    // save their keys would otherwise read a disappointing summary as a bug in
    // the tool rather than an empty allowlist.
    console.log(
      allowlist
        ? t("cli:repair.ticketLinks.allowlist", { keys: allowlist.join(", ") })
        : t("cli:repair.ticketLinks.noAllowlist"),
    );

    const summary = reextractTicketLinks(store, { dryRun, allowlist }, Date.now);

    console.log(
      summary.dryRun
        ? t("cli:repair.ticketLinks.dryRunHeader")
        : t("cli:repair.ticketLinks.doneHeader"),
    );
    if (summary.backupPath) {
      console.log(t("cli:repair.ticketLinks.backupWritten", { path: summary.backupPath }));
    }
    console.log(
      t("cli:repair.ticketLinks.summary", {
        sessions: summary.sessionsScanned,
        removed: summary.removed,
        created: summary.created,
        manual: summary.manualPreserved,
      }),
    );
    console.log(
      t("cli:repair.ticketLinks.keys", { before: summary.keysBefore, after: summary.keysAfter }),
    );
  } finally {
    store.close();
  }
}

async function runRepairProjectPaths(dryRun: boolean): Promise<void> {
  const store = new Store();
  try {
    const summary = await repairProjectPaths(store, { dryRun }, Date.now);

    if (summary.dryRun) {
      console.log(t("cli:repair.projectPaths.dryRunHeader"));
    } else {
      console.log(t("cli:repair.projectPaths.doneHeader"));
      if (summary.backupPath) {
        console.log(t("cli:repair.projectPaths.backupWritten", { path: summary.backupPath }));
      }
    }
    console.log(
      t("cli:repair.projectPaths.summary", {
        total: summary.totalSessions,
        changed: summary.changed,
        unfixable: summary.unfixable,
      }),
    );
  } finally {
    store.close();
  }
}
