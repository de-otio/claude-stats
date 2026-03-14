/**
 * CLI entry point — defines all commands using Commander.
 * See doc/analysis/03-architecture.md — CLI Interface.
 */
import { Command } from "commander";
import { collect } from "../aggregator/index.js";
import { Store, validateTag } from "../store/index.js";
import { printSummary, printStatus, printSearchResults, printSessionList, printSessionDetail, printTrend } from "../reporter/index.js";
import { searchHistory } from "../history/index.js";
import { loadConfig, saveConfig } from "../config.js";
import { checkThresholds } from "../alerts.js";
import { formatCost } from "@claude-stats/core/pricing";
import { buildDashboard } from "../dashboard/index.js";
import { renderDashboard } from "../server/template.js";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { startServer } from "../server/index.js";
import { initPricingCache, loadCachedPricing } from "../pricing-cache.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { initCliI18n, t } from "../i18n.js";
import {
  loadSyncConfig,
  saveSyncConfig,
  loadPersistedConfig,
  savePersistedConfig,
  removeSyncConfig,
  discoverConfig,
  syncSessions,
  getSyncStatus,
  deriveAccountId,
  generateUserSalt,
  initiateAuth,
  respondToChallenge,
  pollForTokens,
  saveTokens,
  clearTokens,
  type SyncConfig,
  type PersistedSyncConfig,
} from "../sync/index.js";

export async function buildCli(): Promise<Command> {
  // Pre-parse --locale from argv before commander processes it
  const localeIdx = process.argv.indexOf("--locale");
  const locale = localeIdx !== -1 && process.argv[localeIdx + 1]
    ? process.argv[localeIdx + 1]
    : undefined;

  await initCliI18n(locale);

  const program = new Command();

  program
    .name("claude-stats")
    .description(t("cli:commands.programDescription"))
    .version("0.1.0")
    .option("--locale <lang>", t("cli:commands.locale"));

  program
    .command("collect")
    .description(t("cli:commands.collect"))
    .option("-v, --verbose", t("cli:commands.collectVerbose"))
    .action(async (opts: { verbose?: boolean }) => {
      await initPricingCache();
      const store = new Store();
      try {
        console.log(t("cli:collection.collecting"));
        const result = await collect(store, { verbose: opts.verbose });
        const msg = result.accountsMatched > 0
          ? t("cli:collection.doneWithAccounts", {
              filesProcessed: result.filesProcessed,
              filesSkipped: result.filesSkipped,
              sessionsUpserted: result.sessionsUpserted,
              messagesUpserted: result.messagesUpserted,
              accountsMatched: result.accountsMatched,
            })
          : t("cli:collection.done", {
              filesProcessed: result.filesProcessed,
              filesSkipped: result.filesSkipped,
              sessionsUpserted: result.sessionsUpserted,
              messagesUpserted: result.messagesUpserted,
            });
        console.log(msg);
        if (result.parseErrors > 0) {
          console.warn(
            t("cli:collection.parseErrors", { count: result.parseErrors })
          );
        }
        if (result.schemaChanges.length > 0) {
          console.warn(t("cli:collection.schemaChanges", { changes: result.schemaChanges.join(", ") }));
        }

        // Check cost thresholds after collection
        const config = loadConfig();
        if (config.costThresholds) {
          const checks = checkThresholds(store, config);
          for (const check of checks) {
            if (check.exceeded) {
              console.warn(
                t("cli:collection.costExceeded", {
                  period: check.period.charAt(0).toUpperCase() + check.period.slice(1) + "ly",
                  currentCost: formatCost(check.currentCost),
                  threshold: formatCost(check.threshold),
                })
              );
            }
          }
        }
      } finally {
        store.close();
      }
    });

  program
    .command("report")
    .description(t("cli:commands.report"))
    .option("--project <path>", t("cli:commands.reportProject"))
    .option("--repo <url>", t("cli:commands.reportRepo"))
    .option("--account <uuid>", t("cli:commands.reportAccount"))
    .option(
      "--period <period>",
      t("cli:commands.reportPeriod"),
      "all"
    )
    .option("--timezone <tz>", t("cli:commands.reportTimezone"))
    .option("--source <entrypoint>", t("cli:commands.reportSource"))
    .option("--include-ci", t("cli:commands.reportIncludeCi"))
    .option("--detail", t("cli:commands.reportDetail"))
    .option("--trend", t("cli:commands.reportTrend"))
    .option("--tag <tag>", t("cli:commands.reportTag"))
    .option("--session <id>", t("cli:commands.reportSession"))
    .option("--html [outfile]", t("cli:commands.reportHtml"))
    .action(
      (opts: {
        project?: string;
        repo?: string;
        account?: string;
        source?: string;
        period?: string;
        timezone?: string;
        includeCi?: boolean;
        detail?: boolean;
        trend?: boolean;
        session?: string;
        tag?: string;
        html?: string | boolean;
      }) => {
        loadCachedPricing();
        if (opts.html && (opts.trend || opts.detail)) {
          process.stderr.write(t("cli:errors.cannotCombineHtml") + "\n");
          process.exitCode = 1;
          return;
        }
        if (opts.trend && opts.detail) {
          console.error(t("cli:errors.cannotCombineTrendDetail"));
          process.exit(1);
        }
        const store = new Store();
        try {
          const reportOpts = {
            projectPath: opts.project,
            repoUrl: opts.repo,
            accountUuid: opts.account,
            entrypoint: opts.source,
            tag: opts.tag,
            period: opts.period as "day" | "week" | "month" | "all" | undefined,
            timezone: opts.timezone,
            includeCI: opts.includeCi,
          };
          if (opts.html) {
            const data = buildDashboard(store, reportOpts);
            const html = renderDashboard(data);
            const today = new Date().toISOString().slice(0, 10);
            const outfile = typeof opts.html === "string" && opts.html.length > 0
              ? opts.html
              : `claude-stats-${today}.html`;
            writeFileSync(outfile, html, "utf-8");
            console.log(t("cli:report.wroteFile", { file: outfile }));
            return;
          }
          if (opts.session) {
            printSessionDetail(store, opts.session, reportOpts);
          } else if (opts.trend) {
            // Default to "month" when --trend used without explicit --period
            if (!opts.period || opts.period === "all") {
              reportOpts.period = "month";
            }
            printTrend(store, reportOpts);
          } else if (opts.detail) {
            printSessionList(store, reportOpts);
          } else {
            printSummary(store, reportOpts);
          }
        } finally {
          store.close();
        }
      }
    );

  program
    .command("status")
    .description(t("cli:commands.status"))
    .action(() => {
      const store = new Store();
      try {
        printStatus(store.getStatus());
      } finally {
        store.close();
      }
    });

  program
    .command("export")
    .description(t("cli:commands.export"))
    .option("--format <fmt>", t("cli:commands.exportFormat"), "json")
    .option("--project <path>", t("cli:commands.exportProject"))
    .option("--period <period>", t("cli:commands.exportPeriod"), "all")
    .action((opts: { format?: string; project?: string; period?: string }) => {
      const store = new Store();
      try {
        const rows = store.getSessions({
          projectPath: opts.project,
        });

        if (opts.format === "csv") {
          const headers = [
            "session_id", "project_path", "first_timestamp", "last_timestamp",
            "claude_version", "entrypoint", "prompt_count",
            "input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens",
            "account_uuid", "subscription_type",
          ];
          console.log(headers.join(","));
          for (const row of rows) {
            console.log(
              [
                row.session_id,
                `"${row.project_path}"`,
                row.first_timestamp,
                row.last_timestamp,
                row.claude_version,
                row.entrypoint,
                row.prompt_count,
                row.input_tokens,
                row.output_tokens,
                row.cache_creation_tokens,
                row.cache_read_tokens,
                row.account_uuid ?? "",
                row.subscription_type ?? "",
              ].join(",")
            );
          }
        } else {
          console.log(JSON.stringify(rows, null, 2));
        }
      } finally {
        store.close();
      }
    });

  program
    .command("diagnose")
    .description(t("cli:commands.diagnose"))
    .action(() => {
      const store = new Store();
      try {
        const status = store.getStatus();
        console.log(`\n\u2500\u2500\u2500 ${t("cli:report.titleDiagnose")} \u2500\u2500\u2500\n`);
        console.log(t("cli:diagnose.quarantinedLines", { count: status.quarantineCount }));
        console.log(`\n${t("cli:diagnose.useStatus")}`);
      } finally {
        store.close();
      }
    });

  program
    .command("search <query>")
    .description(t("cli:commands.search"))
    .option("--project <path>", t("cli:commands.searchProject"))
    .option("--limit <n>", t("cli:commands.searchLimit"), "20")
    .option("--count", t("cli:commands.searchCount"))
    .action((query: string, opts: { project?: string; limit?: string; count?: boolean }) => {
      const results = searchHistory({
        query,
        project: opts.project,
        limit: parseInt(opts.limit ?? "20", 10),
      });
      if (opts.count) {
        console.log(results.length);
      } else {
        printSearchResults(results, query);
      }
    });

  program
    .command("config")
    .description(t("cli:commands.config"))
    .argument("<action>", t("cli:commands.configActionArg"))
    .argument("[key]", t("cli:commands.configKeyArg"))
    .argument("[value]", t("cli:commands.configValueArg"))
    .action((action: string, key?: string, value?: string) => {
      const config = loadConfig();

      if (action === "show") {
        console.log(`\n\u2500\u2500\u2500 ${t("cli:report.titleConfig")} \u2500\u2500\u2500`);
        if (config.costThresholds) {
          for (const period of ["day", "week", "month"] as const) {
            const val = config.costThresholds[period];
            if (val !== undefined) {
              console.log(`cost.${period}   : ${formatCost(val)}`);
            }
          }
        }
        if (!config.costThresholds || Object.keys(config.costThresholds).length === 0) {
          console.log(t("cli:config.noConfig"));
        }
        console.log();
        return;
      }

      if (action === "set") {
        if (!key || value === undefined) {
          console.error(t("cli:config.usageSet"));
          process.exitCode = 1;
          return;
        }
        const match = key.match(/^cost\.(day|week|month)$/);
        if (!match) {
          console.error(t("cli:config.unknownKey", { key }));
          process.exitCode = 1;
          return;
        }
        const period = match[1] as "day" | "week" | "month";
        const num = parseFloat(value);
        if (isNaN(num) || num < 0) {
          console.error(t("cli:config.invalidValue", { value }));
          process.exitCode = 1;
          return;
        }
        config.costThresholds = config.costThresholds ?? {};
        config.costThresholds[period] = num;
        saveConfig(config);
        console.log(t("cli:config.setKey", { key, value: formatCost(num) }));
        return;
      }

      if (action === "unset") {
        if (!key) {
          console.error(t("cli:config.usageUnset"));
          process.exitCode = 1;
          return;
        }
        const match = key.match(/^cost\.(day|week|month)$/);
        if (!match) {
          console.error(t("cli:config.unknownKey", { key }));
          process.exitCode = 1;
          return;
        }
        const period = match[1] as "day" | "week" | "month";
        if (config.costThresholds) {
          delete config.costThresholds[period];
          if (Object.keys(config.costThresholds).length === 0) {
            delete config.costThresholds;
          }
        }
        saveConfig(config);
        console.log(t("cli:config.unsetKey", { key }));
        return;
      }

      console.error(t("cli:config.unknownAction", { action }));
      process.exitCode = 1;
    });

  program
    .command("tag")
    .description(t("cli:commands.tag"))
    .argument("<session-id>", t("cli:commands.tagSessionArg"))
    .argument("[tags...]", t("cli:commands.tagTagsArg"))
    .option("--remove", t("cli:commands.tagRemove"))
    .option("--list", t("cli:commands.tagList"))
    .action((sessionId: string, tags: string[], opts: { remove?: boolean; list?: boolean }) => {
      const store = new Store();
      try {
        const session = store.findSession(sessionId);
        if (!session) {
          console.error(t("cli:tag.noSessionMatch", { sessionId }));
          process.exitCode = 1;
          return;
        }

        if (opts.list) {
          const sessionTags = store.getTagsForSession(session.session_id);
          if (sessionTags.length === 0) {
            console.log(t("cli:tag.sessionNoTags", { sessionId: session.session_id.slice(0, 6) }));
          } else {
            console.log(t("cli:tag.sessionTags", { sessionId: session.session_id.slice(0, 6), tags: sessionTags.join(", ") }));
          }
          return;
        }

        if (tags.length === 0) {
          console.error(t("cli:tag.noTagsSpecified"));
          process.exitCode = 1;
          return;
        }

        for (const tag of tags) {
          try {
            if (opts.remove) {
              store.removeTag(session.session_id, tag);
            } else {
              store.addTag(session.session_id, tag);
            }
          } catch (err) {
            console.error((err as Error).message);
            process.exitCode = 1;
            return;
          }
        }

        if (opts.remove) {
          console.log(t("cli:tag.removed", { tags: tags.join(", "), sessionId: session.session_id.slice(0, 6) }));
        } else {
          console.log(t("cli:tag.added", { tags: tags.join(", "), sessionId: session.session_id.slice(0, 6) }));
        }
      } finally {
        store.close();
      }
    });

  program
    .command("tags")
    .description(t("cli:commands.tags"))
    .action(() => {
      const store = new Store();
      try {
        const tagCounts = store.getTagCounts();
        if (tagCounts.length === 0) {
          console.log(t("cli:tag.noTagsFound"));
          return;
        }
        for (const { tag, count } of tagCounts) {
          const label = t("cli:tag.tagCount", { count });
          console.log(`${tag.padEnd(20)} (${count} ${label})`);
        }
      } finally {
        store.close();
      }
    });

  program
    .command("backfill")
    .description(t("cli:commands.backfill"))
    .option("-v, --verbose", t("cli:commands.backfillVerbose"))
    .action(async (opts: { verbose?: boolean }) => {
      const store = new Store();
      try {
        const count = store.resetCheckpoints();
        console.log(t("cli:backfill.resetCheckpoints", { count }));
        const result = await collect(store, { verbose: opts.verbose });
        console.log(
          t("cli:backfill.complete", {
            filesProcessed: result.filesProcessed,
            messagesUpserted: result.messagesUpserted,
          })
        );
        if (result.parseErrors > 0) {
          console.warn(t("cli:backfill.parseErrors", { count: result.parseErrors }));
        }
      } finally {
        store.close();
      }
    });

  program
    .command("dashboard")
    .description(t("cli:commands.dashboard"))
    .option("--period <period>", t("cli:commands.dashboardPeriod"), "all")
    .option("--project <path>", t("cli:commands.dashboardProject"))
    .option("--repo <url>", t("cli:commands.dashboardRepo"))
    .action((opts: { period?: string; project?: string; repo?: string }) => {
      const store = new Store();
      try {
        const data = buildDashboard(store, {
          period: opts.period as "day" | "week" | "month" | "all" | undefined,
          projectPath: opts.project,
          repoUrl: opts.repo,
        });
        console.log(JSON.stringify(data, null, 2));
      } finally {
        store.close();
      }
    });

  program
    .command("serve")
    .description(t("cli:commands.serve"))
    .option("--port <n>", t("cli:commands.servePort"), "9120")
    .option("--open", t("cli:commands.serveOpen"))
    .action(async (opts: { port: string; open?: boolean }) => {
      const port = parseInt(opts.port, 10);
      const store = new Store();
      const server = startServer(port, store);

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(t("cli:serve.portInUse", { port }));
          store.close();
          process.exit(1);
        }
        throw err;
      });

      server.listen(port, "127.0.0.1", () => {
        const addr = server.address() as import("node:net").AddressInfo;
        const url = `http://localhost:${addr.port}`;
        console.log(t("cli:serve.listening", { url }));
        if (opts.open) openBrowser(url);
      });

      await new Promise<void>((resolve) => {
        const shutdown = () => { server.close(() => resolve()); };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
      store.close();
    });

  return program;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}
