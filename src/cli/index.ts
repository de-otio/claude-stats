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
import { formatCost } from "../pricing.js";
import { buildDashboard } from "../dashboard/index.js";
import { renderDashboard } from "../server/template.js";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { startServer } from "../server/index.js";
import { initPricingCache, loadCachedPricing } from "../pricing-cache.js";

export function buildCli(): Command {
  const program = new Command();

  program
    .name("claude-stats")
    .description("Collect and analyse Claude Code usage statistics")
    .version("0.1.0");

  program
    .command("collect")
    .description("Run incremental collection from ~/.claude/projects/")
    .option("-v, --verbose", "Show per-file progress")
    .action(async (opts: { verbose?: boolean }) => {
      await initPricingCache();
      const store = new Store();
      try {
        console.log("Collecting...");
        const result = await collect(store, { verbose: opts.verbose });
        console.log(
          `Done. ${result.filesProcessed} files processed, ` +
            `${result.filesSkipped} skipped, ` +
            `${result.sessionsUpserted} sessions upserted, ` +
            `${result.messagesUpserted} messages upserted` +
            (result.accountsMatched > 0 ? `, ${result.accountsMatched} accounts matched from telemetry` : "") +
            `.`
        );
        if (result.parseErrors > 0) {
          console.warn(
            `⚠  ${result.parseErrors} parse errors quarantined — run 'diagnose' for details.`
          );
        }
        if (result.schemaChanges.length > 0) {
          console.warn(`⚠  Schema changes detected: ${result.schemaChanges.join(", ")}`);
        }

        // Check cost thresholds after collection
        const config = loadConfig();
        if (config.costThresholds) {
          const checks = checkThresholds(store, config);
          for (const check of checks) {
            if (check.exceeded) {
              console.warn(
                `⚠  ${check.period.charAt(0).toUpperCase() + check.period.slice(1)}ly cost: ~${formatCost(check.currentCost)} exceeds threshold of ${formatCost(check.threshold)}`
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
    .description("Show usage summary")
    .option("--project <path>", "Filter to a specific project path")
    .option("--repo <url>", "Filter to a specific git remote URL (e.g. https://github.com/org/repo)")
    .option("--account <uuid>", "Filter to a specific account UUID (use 'list' to see known accounts)")
    .option(
      "--period <period>",
      "Time period: day, week, month, or all (default: all)",
      "all"
    )
    .option("--timezone <tz>", "Timezone for day/week/month bucketing (default: local)")
    .option("--source <entrypoint>", "Filter by entrypoint (e.g. claude, claude-vscode)")
    .option("--include-ci", "Include CI/automated sessions (excluded by default)")
    .option("--detail", "Show per-session listing instead of aggregate")
    .option("--trend", "Show usage broken down by time period instead of aggregate")
    .option("--tag <tag>", "Filter sessions by tag")
    .option("--session <id>", "Show detailed view of a single session")
    .option("--html [outfile]", "Write a self-contained HTML report to a file")
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
          process.stderr.write("Cannot combine --html with --trend or --detail\n");
          process.exitCode = 1;
          return;
        }
        if (opts.trend && opts.detail) {
          console.error("Cannot combine --trend and --detail");
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
            console.log(`Wrote ${outfile}`);
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
    .description("Show database size, row counts, and last collection time")
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
    .description("Export data to CSV or JSON")
    .option("--format <fmt>", "Output format: csv or json (default: json)", "json")
    .option("--project <path>", "Filter to a specific project path")
    .option("--period <period>", "Time period: day, week, month, or all", "all")
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
    .description("Show schema fingerprint diffs, quarantined lines, and version changes")
    .action(() => {
      const store = new Store();
      try {
        const status = store.getStatus();
        console.log(`\n─── Diagnose ───\n`);
        console.log(`Quarantined lines : ${status.quarantineCount}`);
        console.log(`\nUse 'status' for database metrics.`);
      } finally {
        store.close();
      }
    });

  program
    .command("search <query>")
    .description("Search prompt history")
    .option("--project <path>", "Filter to a specific project path")
    .option("--limit <n>", "Maximum results", "20")
    .option("--count", "Show only the match count")
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
    .description("Manage configuration")
    .argument("<action>", "set, show, or unset")
    .argument("[key]", "Config key (e.g., cost.day)")
    .argument("[value]", "Value to set")
    .action((action: string, key?: string, value?: string) => {
      const config = loadConfig();

      if (action === "show") {
        console.log("\n─── Configuration ───");
        if (config.costThresholds) {
          for (const period of ["day", "week", "month"] as const) {
            const val = config.costThresholds[period];
            if (val !== undefined) {
              console.log(`cost.${period}   : ${formatCost(val)}`);
            }
          }
        }
        if (!config.costThresholds || Object.keys(config.costThresholds).length === 0) {
          console.log("(no configuration set)");
        }
        console.log();
        return;
      }

      if (action === "set") {
        if (!key || value === undefined) {
          console.error("Usage: claude-stats config set <key> <value>");
          process.exitCode = 1;
          return;
        }
        const match = key.match(/^cost\.(day|week|month)$/);
        if (!match) {
          console.error(`Unknown config key: ${key}. Valid keys: cost.day, cost.week, cost.month`);
          process.exitCode = 1;
          return;
        }
        const period = match[1] as "day" | "week" | "month";
        const num = parseFloat(value);
        if (isNaN(num) || num < 0) {
          console.error(`Invalid value: ${value}. Must be a non-negative number.`);
          process.exitCode = 1;
          return;
        }
        config.costThresholds = config.costThresholds ?? {};
        config.costThresholds[period] = num;
        saveConfig(config);
        console.log(`Set ${key} = ${formatCost(num)}`);
        return;
      }

      if (action === "unset") {
        if (!key) {
          console.error("Usage: claude-stats config unset <key>");
          process.exitCode = 1;
          return;
        }
        const match = key.match(/^cost\.(day|week|month)$/);
        if (!match) {
          console.error(`Unknown config key: ${key}. Valid keys: cost.day, cost.week, cost.month`);
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
        console.log(`Unset ${key}`);
        return;
      }

      console.error(`Unknown action: ${action}. Use set, show, or unset.`);
      process.exitCode = 1;
    });

  program
    .command("tag")
    .description("Manage session tags")
    .argument("<session-id>", "Session ID (or prefix)")
    .argument("[tags...]", "Tags to add")
    .option("--remove", "Remove the specified tags instead of adding")
    .option("--list", "List tags for the session")
    .action((sessionId: string, tags: string[], opts: { remove?: boolean; list?: boolean }) => {
      const store = new Store();
      try {
        const session = store.findSession(sessionId);
        if (!session) {
          console.error(`No session found matching "${sessionId}".`);
          process.exitCode = 1;
          return;
        }

        if (opts.list) {
          const sessionTags = store.getTagsForSession(session.session_id);
          if (sessionTags.length === 0) {
            console.log(`Session ${session.session_id.slice(0, 6)}: (no tags)`);
          } else {
            console.log(`Session ${session.session_id.slice(0, 6)}: ${sessionTags.join(", ")}`);
          }
          return;
        }

        if (tags.length === 0) {
          console.error("No tags specified. Provide one or more tags to add/remove.");
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

        const action = opts.remove ? "Removed" : "Added";
        console.log(`${action} tag(s): ${tags.join(", ")} ${opts.remove ? "from" : "to"} session ${session.session_id.slice(0, 6)}`);
      } finally {
        store.close();
      }
    });

  program
    .command("tags")
    .description("List all tags with session counts")
    .action(() => {
      const store = new Store();
      try {
        const tagCounts = store.getTagCounts();
        if (tagCounts.length === 0) {
          console.log("No tags found.");
          return;
        }
        for (const { tag, count } of tagCounts) {
          const label = count === 1 ? "session" : "sessions";
          console.log(`${tag.padEnd(20)} (${count} ${label})`);
        }
      } finally {
        store.close();
      }
    });

  program
    .command("backfill")
    .description("Re-parse all session files to backfill new fields (e.g. prompt_text)")
    .option("-v, --verbose", "Show per-file progress")
    .action(async (opts: { verbose?: boolean }) => {
      const store = new Store();
      try {
        const count = store.resetCheckpoints();
        console.log(`Reset ${count} file checkpoints. Running full re-collection...`);
        const result = await collect(store, { verbose: opts.verbose });
        console.log(
          `Backfill complete. ${result.filesProcessed} files re-processed, ` +
            `${result.messagesUpserted} messages updated.`
        );
        if (result.parseErrors > 0) {
          console.warn(`⚠  ${result.parseErrors} parse errors quarantined.`);
        }
      } finally {
        store.close();
      }
    });

  program
    .command("dashboard")
    .description("Output dashboard-ready JSON to stdout")
    .option("--period <period>", "day, week, month, or all", "all")
    .option("--project <path>", "Filter to a specific project")
    .option("--repo <url>", "Filter to a specific repo")
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
    .description("Start a local web dashboard")
    .option("--port <n>", "Port to listen on", "9120")
    .option("--open", "Open in default browser after starting")
    .action(async (opts: { port: string; open?: boolean }) => {
      const port = parseInt(opts.port, 10);
      const store = new Store();
      const server = startServer(port, store);

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(`Error: port ${port} is already in use`);
          store.close();
          process.exit(1);
        }
        throw err;
      });

      server.listen(port, "127.0.0.1", () => {
        const addr = server.address() as import("node:net").AddressInfo;
        const url = `http://localhost:${addr.port}`;
        console.log(`Listening on ${url}`);
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
