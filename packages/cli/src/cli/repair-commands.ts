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
 *   repair dedupe [--dry-run]
 *       — re-parse every session whose transcript still exists so its usage
 *         is counted once per API response (`cost_basis = 'per-response'`)
 *         instead of once per content block (`'pre-dedupe'`). Sessions with
 *         no transcript stay `'pre-dedupe'` and are reported. Auto-backup,
 *         advisory lock; --dry-run = no write.
 *
 *   repair agent-attribution [--dry-run]
 *       — one-time re-parse of surviving transcripts so existing sessions gain
 *         agent type / spawn details and messages gain their skill. Gated on
 *         metadata `agent_attribution_backfill = v25`. Auto-backup (0600),
 *         shared advisory lock; --dry-run = counts only, no write.
 *
 *   repair request-records [--dry-run] [--force]
 *       — one-time re-parse of surviving transcripts so existing history gains
 *         `api_requests` rows and `messages.request_ref`. Gated on metadata
 *         `request_records_backfill = v28`; --force re-runs anyway. Auto-backup
 *         (0600), shared advisory lock; --dry-run = counts only, no write.
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
import { repairDedupe, RepairLockHeldError } from "../repair/dedupe.js";
import { repairAgentAttribution } from "../repair/agentAttribution.js";
import { repairRequestRecords } from "../repair/requestRecords.js";
import { loadConfig, ticketProjectKeys } from "../config.js";
import { t } from "../i18n.js";
import { formatTokens } from "../reporter/index.js";

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

  repair
    .command("dedupe")
    .description(t("cli:repair.dedupe.description"))
    .option("--dry-run", t("cli:repair.dedupe.dryRunOption"))
    .action(async (opts: { dryRun?: boolean }) => {
      await runRepairDedupe(opts.dryRun ?? false);
    });

  repair
    .command("agent-attribution")
    .description(t("cli:repair.agentAttribution.description"))
    .option("--dry-run", t("cli:repair.agentAttribution.dryRunOption"))
    .action(async (opts: { dryRun?: boolean }) => {
      await runRepairAgentAttribution(opts.dryRun ?? false);
    });

  repair
    .command("request-records")
    .description(t("cli:repair.requestRecords.description"))
    .option("--dry-run", t("cli:repair.requestRecords.dryRunOption"))
    .option("--force", t("cli:repair.requestRecords.forceOption"))
    .action(async (opts: { dryRun?: boolean; force?: boolean }) => {
      await runRepairRequestRecords(opts.dryRun ?? false, opts.force ?? false);
    });
}

async function runRepairRequestRecords(dryRun: boolean, force: boolean): Promise<void> {
  const store = new Store();
  try {
    let summary;
    try {
      summary = await repairRequestRecords(
        store,
        { dryRun, force, ticketAllowlist: ticketProjectKeys(loadConfig()) },
        Date.now,
      );
    } catch (err) {
      if (err instanceof RepairLockHeldError) {
        console.error(
          t("cli:repair.requestRecords.lockHeld", {
            pid: err.holder.pid,
            started: new Date(err.holder.startedAt).toLocaleString(),
          }),
        );
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    if (summary.alreadyDone) {
      console.log(t("cli:repair.requestRecords.alreadyDone"));
      return;
    }
    console.log(
      summary.dryRun
        ? t("cli:repair.requestRecords.dryRunHeader")
        : t("cli:repair.requestRecords.doneHeader"),
    );
    if (summary.backupPath) {
      console.log(t("cli:repair.requestRecords.backupWritten", { path: summary.backupPath }));
    }
    // Counts only — never request ids, shape hashes or any other field value.
    console.log(
      t(summary.dryRun ? "cli:repair.requestRecords.dryRunSummary" : "cli:repair.requestRecords.summary", {
        files: summary.files,
        lines: summary.requestLines,
        requests: summary.requestsStored,
      }),
    );
    if (summary.parseErrors > 0) {
      console.warn(t("cli:repair.requestRecords.parseErrors", { count: summary.parseErrors }));
    }
  } finally {
    store.close();
  }
}

async function runRepairAgentAttribution(dryRun: boolean): Promise<void> {
  const store = new Store();
  try {
    let summary;
    try {
      summary = await repairAgentAttribution(
        store,
        { dryRun, ticketAllowlist: ticketProjectKeys(loadConfig()) },
        Date.now,
      );
    } catch (err) {
      if (err instanceof RepairLockHeldError) {
        console.error(
          t("cli:repair.agentAttribution.lockHeld", {
            pid: err.holder.pid,
            started: new Date(err.holder.startedAt).toLocaleString(),
          }),
        );
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    if (summary.alreadyDone) {
      console.log(t("cli:repair.agentAttribution.alreadyDone"));
      return;
    }
    console.log(
      summary.dryRun
        ? t("cli:repair.agentAttribution.dryRunHeader")
        : t("cli:repair.agentAttribution.doneHeader"),
    );
    if (summary.backupPath) {
      console.log(t("cli:repair.agentAttribution.backupWritten", { path: summary.backupPath }));
    }
    // Counts only — never agent-type or skill names.
    console.log(
      t(summary.dryRun ? "cli:repair.agentAttribution.dryRunSummary" : "cli:repair.agentAttribution.summary", {
        files: summary.files,
        sessions: summary.sessionsGainingAgentType,
        messages: summary.messagesGainingSkill,
      }),
    );
    if (summary.parseErrors > 0) {
      console.warn(t("cli:repair.agentAttribution.parseErrors", { count: summary.parseErrors }));
    }
  } finally {
    store.close();
  }
}

async function runRepairDedupe(dryRun: boolean): Promise<void> {
  const store = new Store();
  try {
    let summary;
    try {
      summary = await repairDedupe(
        store,
        { dryRun, ticketAllowlist: ticketProjectKeys(loadConfig()) },
        Date.now,
      );
    } catch (err) {
      if (err instanceof RepairLockHeldError) {
        console.error(
          t("cli:repair.dedupe.lockHeld", {
            pid: err.holder.pid,
            started: new Date(err.holder.startedAt).toLocaleString(),
          }),
        );
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    console.log(
      summary.dryRun ? t("cli:repair.dedupe.dryRunHeader") : t("cli:repair.dedupe.doneHeader"),
    );
    if (summary.backupPath) {
      console.log(t("cli:repair.dedupe.backupWritten", { path: summary.backupPath }));
    }
    console.log(
      t("cli:repair.dedupe.sessions", {
        repaired: summary.sessionsRepaired,
        skipped: summary.sessionsSkippedNoTranscript,
        clean: summary.sessionsAlreadyClean,
      }),
    );
    console.log(
      t("cli:repair.dedupe.rows", {
        inScope: summary.preDedupeRowsInScope,
        relabelled: summary.rowsRelabelled,
        remaining: summary.preDedupeRowsRemaining,
      }),
    );
    if (summary.sessionsRepaired > 0) {
      const b = summary.before;
      const a = summary.after;
      console.log(
        t("cli:repair.dedupe.tokens", {
          beforeInput: formatTokens(b.inputTokens + b.cacheReadTokens + b.cacheCreationTokens),
          beforeOutput: formatTokens(b.outputTokens),
          afterInput: formatTokens(a.inputTokens + a.cacheReadTokens + a.cacheCreationTokens),
          afterOutput: formatTokens(a.outputTokens),
        }),
      );
    }
    if (summary.preDedupeRowsRemaining > 0) {
      console.log(t("cli:repair.dedupe.remainingNote"));
    }
    if (summary.parseErrors > 0) {
      console.warn(t("cli:repair.dedupe.parseErrors", { count: summary.parseErrors }));
    }
  } finally {
    store.close();
  }
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
