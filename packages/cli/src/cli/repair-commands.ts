/**
 * `repair` command registration.
 *
 *   repair project-paths [--dry-run]
 *       — recompute project_path (and dependent repo_url) for every session
 *         whose source file still exists, using the session's own `cwd` as
 *         ground truth instead of the lossy decoded directory name.
 *         Auto-backup + atomic; --dry-run = no write.
 *
 * Thin command layer (cli/** is excluded from coverage — keep logic in
 * covered modules): parse args → call the covered repair function and print.
 *
 * i18n namespace: cli:repair.*
 */
import type { Command } from "commander";
import { Store } from "../store/index.js";
import { repairProjectPaths } from "../repair/project-paths.js";
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
