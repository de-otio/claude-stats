/**
 * CLI entry point — defines all commands using Commander.
 * See doc/analysis/03-architecture.md — CLI Interface.
 */
import { Command } from "commander";
import { collect } from "../aggregator/index.js";
import { Store, validateTag } from "../store/index.js";
import { printSummary, printStatus, printSearchResults, printSessionList, printSessionDetail, printTrend, printSpendingReport, printTicketReport, periodRange } from "../reporter/index.js";
import { searchHistory } from "../history/index.js";
import { loadConfig, saveConfig, createJudgeProviderFromConfig, ticketProjectKeys } from "../config.js";
import { generateJustificationPack, parseSections } from "../pack/index.js";
import { parseCostExplorerCsv, formatCsvImportError } from "@claude-stats/core/reconciliation";
import { checkThresholds } from "../alerts.js";
import { formatCost } from "@claude-stats/core/pricing";
import { buildDashboard } from "../dashboard/index.js";
import { runTaskClassPass } from "../task-class/index.js";
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
import { registerAccountCommands } from "./account-commands.js";
import { registerOtelCommands } from "./otel-commands.js";
import { registerRepairCommands } from "./repair-commands.js";
import { registerPlanAdvisorCommands } from "./plan-advisor-commands.js";
import { registerSyncCommands } from "./sync-commands.js";
import {
  loadSyncConfig,
  saveSyncConfig,
  loadPersistedConfig,
  savePersistedConfig,
  removeSyncConfig,
  discoverConfig,
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
import { paths } from "@claude-stats/core/paths";
import { requireTicketKey } from "@claude-stats/core/tickets";

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
        const result = await collect(store, { verbose: opts.verbose, ticketAllowlist: ticketProjectKeys(loadConfig()) });
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
    .option("--since <date>", t("cli:commands.sinceFlag"))
    .option("--until <date>", t("cli:commands.untilFlag"))
    .option("--timezone <tz>", t("cli:commands.reportTimezone"))
    .option("--source <entrypoint>", t("cli:commands.reportSource"))
    .option("--include-ci", t("cli:commands.reportIncludeCi"))
    .option("--detail", t("cli:commands.reportDetail"))
    .option("--trend", t("cli:commands.reportTrend"))
    .option("--tag <tag>", t("cli:commands.reportTag"))
    .option("--ticket <key>", t("cli:commands.reportTicket"))
    .option("--session <id>", t("cli:commands.reportSession"))
    .option("--html [outfile]", t("cli:commands.reportHtml"))
    .action(
      async (opts: {
        project?: string;
        repo?: string;
        account?: string;
        source?: string;
        period?: string;
        since?: string;
        until?: string;
        timezone?: string;
        includeCi?: boolean;
        detail?: boolean;
        trend?: boolean;
        session?: string;
        tag?: string;
        ticket?: string;
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
            ticket: opts.ticket,
            period: opts.period as "day" | "week" | "month" | "all" | undefined,
            since: opts.since,
            until: opts.until,
            timezone: opts.timezone,
            includeCI: opts.includeCi,
          };
          if (opts.html) {
            const data = buildDashboard(store, reportOpts);
            const { attachCostPerTask, attachInsights } = await import("../dashboard/index.js");
            await attachCostPerTask(store, data, reportOpts);
            attachInsights(store, data, reportOpts, loadConfig());
            // Pass the CLI translator so the exported HTML is localized; without
            // it every label (not just this card) renders as a raw i18n key.
            const html = renderDashboard(data, t);
            const today = new Date().toISOString().slice(0, 10);
            const outfile = typeof opts.html === "string" && opts.html.length > 0
              ? opts.html
              : `claude-stats-${today}.html`;
            writeFileSync(outfile, html, "utf-8");
            console.log(t("cli:report.wroteFile", { file: outfile }));
            return;
          }
          if (opts.ticket) {
            printTicketReport(store, reportOpts);
          } else if (opts.session) {
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
        } catch (err) {
          if (err instanceof RangeError) {
            console.error(t("cli:errors.invalidDateRange", { message: err.message }));
            process.exitCode = 1;
            return;
          }
          throw err;
        } finally {
          store.close();
        }
      }
    );

  program
    .command("pack")
    .description(t("cli:commands.pack"))
    .requiredOption("--period <yyyy-mm>", t("cli:commands.packPeriod"))
    .option("--timezone <tz>", t("cli:commands.reportTimezone"))
    .option("--sections <list>", t("cli:commands.packSections"))
    .option("--project <path>", t("cli:commands.reportProject"))
    .option("--account <uuid>", t("cli:commands.reportAccount"))
    .option("--out <dir>", t("cli:commands.packOut"))
    .option("--json", t("cli:commands.packJson"))
    .option("--invoice-csv <path>", t("cli:commands.packInvoiceCsv"))
    .action(
      async (opts: {
        period: string;
        timezone?: string;
        sections?: string;
        project?: string;
        account?: string;
        out?: string;
        json?: boolean;
        invoiceCsv?: string;
      }) => {
        loadCachedPricing();
        const config = loadConfig();
        const store = new Store();
        try {
          // `--invoice-csv` overrides `config.reconciliation.invoiceTotal` for
          // THIS run only — it never writes back to config (04 §4.3 rule 1:
          // "the top-down figure is imported, never fetched"). A malformed
          // export fails loudly here, before any pack is written, rather than
          // producing a pack with a silently wrong reconciled figure.
          let invoiceTotalOverride: number | null | undefined;
          if (opts.invoiceCsv) {
            let csvText: string;
            try {
              csvText = fs.readFileSync(opts.invoiceCsv, "utf-8");
            } catch (err) {
              console.error(
                t("cli:errors.invalidInvoiceCsv", {
                  path: opts.invoiceCsv,
                  message: err instanceof Error ? err.message : String(err),
                }),
              );
              process.exitCode = 1;
              return;
            }
            const parsed = parseCostExplorerCsv(csvText);
            if (!parsed.ok) {
              console.error(
                t("cli:errors.invalidInvoiceCsv", { path: opts.invoiceCsv, message: formatCsvImportError(parsed.error) }),
              );
              process.exitCode = 1;
              return;
            }
            invoiceTotalOverride = parsed.value.total;
          }

          const written = generateJustificationPack(
            store,
            config,
            {
              period: opts.period,
              timezone: opts.timezone,
              sections: parseSections(opts.sections),
              projectPath: opts.project,
              accountUuid: opts.account,
              invoiceTotalOverride,
            },
            opts.out ?? process.cwd()
          );
          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  dir: written.dir,
                  htmlPath: written.htmlPath,
                  ticketsCsvPath: written.ticketsCsvPath,
                  nonTicketCsvPath: written.nonTicketCsvPath,
                  summaryCsvPath: written.summaryCsvPath,
                  sections: written.model.sections,
                },
                null,
                2
              )
            );
          } else {
            console.log(t("cli:report.wrotePack", { dir: written.dir }));
          }
        } catch (err) {
          if (err instanceof RangeError) {
            console.error(t("cli:errors.invalidPackPeriod", { message: err.message }));
            process.exitCode = 1;
            return;
          }
          throw err;
        } finally {
          store.close();
        }
      }
    );

  program
    .command("constraint-impact")
    .description(t("cli:commands.constraintImpact"))
    .option("--date <yyyy-mm-dd>", t("cli:commands.constraintImpactDate"))
    .option("--since <date>", t("cli:commands.sinceFlag"))
    .option("--until <date>", t("cli:commands.untilFlag"))
    .option("--project <path>", t("cli:commands.reportProject"))
    .option("--account <uuid>", t("cli:commands.reportAccount"))
    .option("--min-sessions <n>", t("cli:commands.constraintImpactMinSessions"))
    .option("--csv <path>", t("cli:commands.constraintImpactCsv"))
    .action(async (opts: {
      date?: string;
      since?: string;
      until?: string;
      project?: string;
      account?: string;
      minSessions?: string;
      csv?: string;
    }) => {
      loadCachedPricing();
      const config = loadConfig();
      const events = config.policyEvents ?? [];
      if (events.length === 0) {
        console.error(
          "No policy events declared. This report compares the windows either side of a DECLARED " +
            "policy boundary and never infers one from the data (constraint-impact/03 §3.1) — add an " +
            'entry to config.policyEvents, e.g. { "date": "2026-05-01", "kind": "model-removal", ' +
            '"detail": "opus" }.',
        );
        process.exitCode = 1;
        return;
      }
      const policyEvent = opts.date ? events.find((e) => e.date === opts.date) : events[events.length - 1];
      if (!policyEvent) {
        console.error(
          `No declared policy event with date "${opts.date}". Declared dates: ${events.map((e) => e.date).join(", ")}.`,
        );
        process.exitCode = 1;
        return;
      }

      const { buildConstraintImpactReport } = await import("../constraintImpact/index.js");
      const { renderConstraintImpactCsv } = await import("@claude-stats/core/constraintImpact");
      const toBoundMs = (d: string | undefined): number | undefined =>
        d ? Date.parse(`${d}T00:00:00.000Z`) : undefined;

      const store = new Store();
      await collect(store, { ticketAllowlist: ticketProjectKeys(config) });
      try {
        const { report, coverage } = buildConstraintImpactReport(store, policyEvent, {
          projectPath: opts.project,
          accountUuid: opts.account,
          since: toBoundMs(opts.since),
          until: toBoundMs(opts.until),
          minSessionsPerClass: opts.minSessions ? Number(opts.minSessions) : undefined,
          rateOverrides: config.pricing?.rates,
          hourlyRate: config.rate?.hourly ?? null,
          currency: config.rate?.currency ?? "USD",
        });

        if (opts.csv) {
          fs.writeFileSync(opts.csv, renderConstraintImpactCsv(report), "utf-8");
        }

        // JSON-only, same precedent as `cost-per-task --calibrate`: this is a
        // structured diagnostic with no localized prose to translate — pipe to jq.
        process.stdout.write(
          JSON.stringify(
            {
              declaredPolicyEvents: events,
              policyEvent,
              boundary: new Date(report.boundaryMs).toISOString(),
              coverage,
              confoundNote: report.confoundNote,
              notMeasured: report.notMeasured,
              minSessionsPerClass: report.minSessionsPerClass,
              hourlyRate: report.hourlyRate,
              currency: report.currency,
              netEffectAvailable: report.netEffectAvailable,
              classesCompared: report.classesCompared,
              classesInsufficientData: report.classesInsufficientData,
              totalTokenSavings: report.totalTokenSavings,
              totalDevTimeCost: report.totalDevTimeCost,
              totalNetEffect: report.totalNetEffect,
              classes: report.classes,
              ...(opts.csv ? { csvPath: opts.csv } : {}),
            },
            null,
            2,
          ) + "\n",
        );
      } finally {
        store.close();
      }
    });

  program
    .command("spending")
    .description(t("cli:commands.spending"))
    .option("--period <period>", t("cli:commands.spendingPeriod"), "day")
    .option("--since <date>", t("cli:commands.sinceFlag"))
    .option("--until <date>", t("cli:commands.untilFlag"))
    .option("--project <path>", t("cli:commands.reportProject"))
    .option("--model <name>", t("cli:commands.spendingModel"))
    .option("--top <n>", t("cli:commands.spendingTop"), "5")
    .option("--json", t("cli:commands.spendingJson"))
    .option("--sort <key>", t("cli:commands.spendingSort"), "cost")
    .option("--timezone <tz>", t("cli:commands.reportTimezone"))
    .option("--account <uuid>", t("cli:commands.reportAccount"))
    .action((opts: {
      period?: string;
      since?: string;
      until?: string;
      project?: string;
      model?: string;
      top?: string;
      json?: boolean;
      sort?: string;
      timezone?: string;
      account?: string;
    }) => {
      loadCachedPricing();
      const store = new Store();
      try {
        printSpendingReport(store, {
          period: opts.period as "day" | "week" | "month" | "all" | undefined,
          since: opts.since,
          until: opts.until,
          projectPath: opts.project,
          model: opts.model,
          top: opts.top ? parseInt(opts.top, 10) : 5,
          json: opts.json,
          sort: (opts.sort as "cost" | "tokens" | "prompts") ?? "cost",
          timezone: opts.timezone,
          accountUuid: opts.account,
        });
      } catch (err) {
        if (err instanceof RangeError) {
          console.error(t("cli:errors.invalidDateRange", { message: err.message }));
          process.exitCode = 1;
          return;
        }
        throw err;
      } finally {
        store.close();
      }
    });

  program
    .command("cost-per-task")
    .description(t("cli:commands.costPerTask"))
    .option("--period <period>", t("cli:commands.costPerTaskPeriod"), "month")
    .option("--since <date>", t("cli:commands.sinceFlag"))
    .option("--until <date>", t("cli:commands.untilFlag"))
    .option("--project <path>", t("cli:commands.reportProject"))
    .option("--account <uuid>", t("cli:commands.reportAccount"))
    .option("--repo <url>", t("cli:commands.reportRepo"))
    .option("--include-ci", t("cli:commands.reportIncludeCi"))
    .option("--by-model", t("cli:commands.costPerTaskByModel"))
    .option("--timezone <tz>", t("cli:commands.reportTimezone"))
    .option("--json", t("cli:commands.spendingJson"))
    .option("--calibrate", t("cli:commands.costPerTaskCalibrate"))
    .option("--llm-judge", t("cli:commands.costPerTaskLlmJudge"))
    .action(async (opts: {
      period?: string;
      since?: string;
      until?: string;
      project?: string;
      account?: string;
      repo?: string;
      includeCi?: boolean;
      byModel?: boolean;
      timezone?: string;
      json?: boolean;
      calibrate?: boolean;
      llmJudge?: boolean;
    }) => {
      loadCachedPricing();
      const { buildCostPerTaskReport, buildCalibrationReport } = await import("../cost-per-task/index.js");
      const { printCostPerTask } = await import("../reporter/index.js");
      const { createEmbeddingProvider } = await import("../recap/embeddings.js");
      const config = loadConfig();
      // Phase D: --llm-judge (or config.llmJudge.enabled) builds the provider from
      // config; null when endpoint/model are missing (graceful no-op + a warning).
      const wantJudge = opts.llmJudge === true || config.llmJudge?.enabled === true;
      const judgeProvider = wantJudge
        ? createJudgeProviderFromConfig({ ...config, llmJudge: { ...config.llmJudge, enabled: true } })
        : null;
      if (wantJudge && !judgeProvider) {
        process.stderr.write(t("cli:commands.costPerTaskLlmJudgeUnconfigured") + "\n");
      }
      const store = new Store();
      await collect(store, { ticketAllowlist: ticketProjectKeys(config) });
      try {
        let embeddingProvider = null;
        try {
          embeddingProvider = await createEmbeddingProvider({ mode: "auto" });
        } catch {
          embeddingProvider = null;
        }
        const common = {
          period: opts.period as "day" | "week" | "month" | "all" | undefined,
          since: opts.since,
          until: opts.until,
          projectPath: opts.project,
          accountUuid: opts.account,
          repoUrl: opts.repo,
          includeCI: opts.includeCi,
          tz: opts.timezone,
          digestDeps: { embeddingProvider },
          judgeProvider,
          experimentalSignals: config.experimentalSignals === true,
        };
        if (opts.calibrate) {
          // Diagnostic: agreement of the proxy/combiner with the user's labels.
          // JSON-only so there is no localized prose to translate; pipe to jq.
          //
          // `outcome` is K's vocabulary (`calibration/index.ts`): gated on the
          // n=30 floor, `rate` (not "accuracy"), and K's caveat sentence — the
          // same shape `get_calibration`'s MCP tool returns. `diagnostics` keeps
          // the richer proxy-vs-combiner comparison the Phase-A signals gate
          // needs (per-class precision/recall, Brier, `meetsFailedFloor`), with
          // its own `accuracy` field renamed at this boundary — see
          // `renameAccuracyField`'s doc: that field is the SAME self-selected-
          // sample number K's module exists to stop being read as accuracy.
          const calibration = await buildCalibrationReport(store, common);
          const { outcomeCalibrationFrom, calibrationJson, renameAccuracyField } =
            await import("../calibration/index.js");
          const estimate = outcomeCalibrationFrom(calibration);
          process.stdout.write(
            JSON.stringify(
              {
                outcome: calibrationJson(t, estimate),
                diagnostics: {
                  n: calibration.n,
                  floor: calibration.floor,
                  proxyOnly: renameAccuracyField(calibration.proxyOnly),
                  withSignals: renameAccuracyField(calibration.withSignals),
                },
              },
              null,
              2,
            ) + "\n",
          );
          return;
        }
        const report = await buildCostPerTaskReport(store, {
          ...common,
          byModel: opts.byModel === true,
        });
        printCostPerTask(report, process.stdout, { json: opts.json });
      } catch (err) {
        if (err instanceof RangeError) {
          console.error(t("cli:errors.invalidDateRange", { message: err.message }));
          process.exitCode = 1;
          return;
        }
        throw err;
      } finally {
        store.close();
      }
    });

  program
    .command("task-outcome <item> [value]")
    .description(
      "Label a task's outcome (success|partial|fail) so the cost-per-task " +
        "metric rests on ground truth instead of a proxy. <item> is an id " +
        "prefix or prompt substring from today's recap; use --clear to remove.",
    )
    .option("--clear", "Remove any outcome label for the matched task")
    .action(async (itemSelector: string, value: string | undefined, opts: { clear?: boolean }) => {
      const { buildDailyDigest } = await import("../recap/index.js");
      const { openCorrections, computeSignature } = await import("../recap/corrections.js");
      const valid = new Set(["success", "partial", "fail"]);
      if (!opts.clear) {
        if (!value || !valid.has(value)) {
          process.stderr.write(
            `Provide an outcome: success | partial | fail (or --clear). Got "${value ?? ""}".\n`,
          );
          process.exit(1);
        }
      }
      const store = new Store();
      await collect(store, { ticketAllowlist: ticketProjectKeys(loadConfig()) });
      try {
        const digest = await buildDailyDigest(store, {});
        const item = await resolveItem(digest, itemSelector);
        if (!item) {
          process.stderr.write(`No item matching "${itemSelector}" in today's digest.\n`);
          process.exit(1);
        }
        const sig = computeSignature(item);
        const client = openCorrections();
        try {
          if (opts.clear) {
            // Remove every stored outcome action for this signature.
            const outcomes = client.forSignature(sig).filter((a) => a.kind === "outcome");
            for (const a of outcomes) client.remove(sig, a);
            console.log(
              outcomes.length > 0
                ? `Cleared outcome label for "${item.id}".`
                : `No outcome label set for "${item.id}".`,
            );
          } else {
            client.add(sig, { kind: "outcome", value: value as "success" | "partial" | "fail" });
            console.log(`Outcome recorded: "${item.id}" → ${value}.`);
          }
        } finally {
          client.close();
        }
      } finally {
        store.close();
      }
    });

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
    .option("--since <date>", t("cli:commands.sinceFlag"))
    .option("--until <date>", t("cli:commands.untilFlag"))
    .option("--timezone <tz>", t("cli:commands.reportTimezone"))
    .action((opts: { format?: string; project?: string; period?: string; since?: string; until?: string; timezone?: string }) => {
      const store = new Store();
      try {
        const { since, until } = periodRange(
          {
            period: opts.period as "day" | "week" | "month" | "all" | undefined,
            since: opts.since,
            until: opts.until,
          },
          opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
        );
        const rows = store.getSessions({
          projectPath: opts.project,
          since: since > 0 ? since : undefined,
          until: since > 0 ? until : undefined,
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
      } catch (err) {
        if (err instanceof RangeError) {
          console.error(t("cli:errors.invalidDateRange", { message: err.message }));
          process.exitCode = 1;
          return;
        }
        throw err;
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
    .command("ticket")
    .description(t("cli:commands.ticket"))
    .argument("<session-id>", t("cli:commands.ticketSessionArg"))
    .argument("[key]", t("cli:commands.ticketKeyArg"))
    .option("--negate", t("cli:commands.ticketNegate"))
    .option("--remove", t("cli:commands.ticketRemove"))
    .option("--list", t("cli:commands.ticketList"))
    .action((sessionId: string, key: string | undefined, opts: { negate?: boolean; remove?: boolean; list?: boolean }) => {
      const store = new Store();
      try {
        const session = store.findSession(sessionId);
        if (!session) {
          console.error(t("cli:tag.noSessionMatch", { sessionId }));
          process.exitCode = 1;
          return;
        }
        const shortId = session.session_id.slice(0, 6);

        // --negate/--remove name an ACTION on a specific key; without a key
        // there is nothing to act on. Falling through to the list branch
        // below would silently drop the flag and exit 0 as if `--list` had
        // been requested — a mistyped invocation reading as success.
        if ((opts.negate || opts.remove) && !key) {
          console.error(t("cli:ticket.keyRequired"));
          process.exitCode = 1;
          return;
        }

        if (opts.list || !key) {
          const links = store.getTicketLinksForSession(session.session_id);
          if (links.length === 0) {
            console.log(t("cli:ticket.sessionNoLinks", { sessionId: shortId }));
          } else {
            console.log(t("cli:ticket.sessionLinks", { sessionId: shortId }));
            for (const link of links) {
              const status = link.negated ? t("cli:ticket.negatedLabel") : t("cli:ticket.activeLabel");
              console.log(
                `  ${link.ticket_key}  ${link.source}/${link.confidence}  ${status}`,
              );
            }
          }
          if (!key) return;
        }

        let normalizedKey: string;
        try {
          normalizedKey = requireTicketKey(key);
        } catch (err) {
          console.error((err as Error).message);
          process.exitCode = 1;
          return;
        }

        if (opts.negate) {
          store.negateTicketLink(session.session_id, normalizedKey);
          console.log(t("cli:ticket.negated", { key: normalizedKey, sessionId: shortId }));
        } else if (opts.remove) {
          store.removeTicketLink(session.session_id, normalizedKey, "tag");
          console.log(t("cli:ticket.removed", { key: normalizedKey, sessionId: shortId }));
        } else {
          store.addTicketLink({
            sessionId: session.session_id,
            ticketKey: normalizedKey,
            source: "tag",
            confidence: "high",
          });
          console.log(t("cli:ticket.linked", { key: normalizedKey, sessionId: shortId }));
        }
      } finally {
        store.close();
      }
    });

  program
    .command("task-class")
    .description(t("cli:commands.taskClass"))
    .option("--limit <n>", t("cli:commands.taskClassLimit"))
    .action((opts: { limit?: string }) => {
      const store = new Store();
      try {
        const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;
        const run = runTaskClassPass(store, {
          ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
        });
        console.log(
          t("cli:taskClass.passSummary", {
            classified: run.classified,
            alreadyCurrent: run.alreadyCurrent,
            remaining: run.remaining,
            version: run.version,
          }),
        );

        const counts = store.getTaskClassCounts();
        const total = counts.fine.reduce((sum, r) => sum + r.n, 0);
        if (total === 0) {
          console.log(t("cli:taskClass.noSessions"));
          return;
        }

        // The confidence tier travels WITH the count, never on a separate line
        // a reader can skip: spec §5.7 gives every classification a tier and a
        // per-class figure quoted without one implies a certainty it lacks.
        const tiers = new Map<string, { high: number; medium: number; low: number }>();
        for (const row of counts.byConfidence) {
          const slot = tiers.get(row.task_class) ?? { high: 0, medium: 0, low: 0 };
          if (row.confidence === "high") slot.high += row.n;
          else if (row.confidence === "medium") slot.medium += row.n;
          else slot.low += row.n;
          tiers.set(row.task_class, slot);
        }

        console.log(`\n${t("cli:taskClass.fineHeader")}`);
        for (const row of counts.fine) {
          const mix = tiers.get(row.task_class) ?? { high: 0, medium: 0, low: 0 };
          console.log(
            `  ${row.task_class.padEnd(22)} ${String(row.n).padStart(6)}   ${t("cli:taskClass.confidenceMix", mix)}`,
          );
        }
        console.log(`\n${t("cli:taskClass.coarseHeader")}`);
        for (const row of counts.coarse) {
          console.log(`  ${row.coarse_class.padEnd(22)} ${String(row.n).padStart(6)}`);
        }
        if (counts.abstain.length > 0) {
          console.log(`\n${t("cli:taskClass.abstainHeader")}`);
          for (const row of counts.abstain) {
            console.log(`  ${row.abstain_reason.padEnd(22)} ${String(row.n).padStart(6)}`);
          }
        }
        // The coverage denominator is not optional output: a per-class table
        // without it implies a completeness it does not have.
        console.log(
          `\n${t("cli:taskClass.coverage", { classified: total, unclassified: counts.unclassified })}`,
        );

        // Spec §5.10: the fine grain is report-grade UNDER A STATED CAVEAT, and
        // any surface quoting a per-class figure carries the caveat with it.
        // This is that surface, so it prints it — unconditionally, not behind a
        // verbosity flag.
        console.log(`\n${t("cli:taskClass.caveat")}`);

        // A store classified by two rule sets cannot anchor a before/after
        // comparison — say so rather than letting the mixture pass silently.
        const versions = store.getTaskClassVersions();
        if (versions.length > 1) {
          console.warn(
            t("cli:taskClass.mixedVersions", {
              versions: versions.map((v) => `v${v.classifier_version} (${v.n})`).join(", "),
            }),
          );
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
        const result = await collect(store, { verbose: opts.verbose, ticketAllowlist: ticketProjectKeys(loadConfig()) });
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
    .option("--since <date>", t("cli:commands.sinceFlag"))
    .option("--until <date>", t("cli:commands.untilFlag"))
    .option("--project <path>", t("cli:commands.dashboardProject"))
    .option("--repo <url>", t("cli:commands.dashboardRepo"))
    .action(async (opts: { period?: string; since?: string; until?: string; project?: string; repo?: string }) => {
      const store = new Store();
      try {
        const dashOpts = {
          period: opts.period as "day" | "week" | "month" | "all" | undefined,
          since: opts.since,
          until: opts.until,
          projectPath: opts.project,
          repoUrl: opts.repo,
        };
        const data = buildDashboard(store, dashOpts);
        const { attachCostPerTask, attachInsights } = await import("../dashboard/index.js");
        await attachCostPerTask(store, data, dashOpts);
        attachInsights(store, data, dashOpts, loadConfig());
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        if (err instanceof RangeError) {
          console.error(t("cli:errors.invalidDateRange", { message: err.message }));
          process.exitCode = 1;
          return;
        }
        throw err;
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
      const { server } = startServer(port, store);

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(t("cli:serve.portInUse", { port }));
          store.close();
          process.exit(1);
        }
        throw err;
      });

      // Bind to loopback only — do NOT bind to 0.0.0.0. The dashboard writes
      // to ~/.claude-stats/config.json and must not be reachable from the LAN.
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address() as import("node:net").AddressInfo;
        const url = `http://127.0.0.1:${addr.port}/`;
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

  program
    .command("mcp")
    .description("Start a local MCP server over stdio for AI agent access to your stats")
    .action(async () => {
      const { startMcpServer } = await import("../mcp/index.js");
      await startMcpServer();
    });

  // Hold a reference to the parent `recap` command so v3.05/v3.09 nested
  // subcommands (`recap precompute`, `recap correct …`) attach via Commander's
  // proper nested-subcommand syntax. Registering them as separate top-level
  // entries via `program.command("recap precompute")` would conflict with the
  // already-registered `recap` command.
  const recapCmd = program
    .command("recap")
    .description("What did I get done today? — clustered day summary")
    .option("--date <date>", "YYYY-MM-DD (defaults to today)")
    .option("--tz <tz>", "IANA timezone (defaults to system TZ)")
    .option("--all", "Include low-confidence items (currently shown by default in v1)")
    .option("--json", "Machine-readable JSON output")
    .option("--embeddings <mode>", "on|off|auto — enable local sentence embeddings for clustering", "auto")
    .action(async (opts: { date?: string; tz?: string; all?: boolean; json?: boolean; embeddings?: string }) => {
      const { Store } = await import("../store/index.js");
      const { collect } = await import("../aggregator/index.js");
      const { buildDailyDigest } = await import("../recap/index.js");
      const { createEmbeddingProvider } = await import("../recap/embeddings.js");
      const { printDailyRecap } = await import("../reporter/index.js");
      const store = new Store();
      await collect(store, { ticketAllowlist: ticketProjectKeys(loadConfig()) });

      // Parse and validate --embeddings flag
      const rawMode = opts.embeddings ?? 'auto';
      const embeddingsMode: 'on' | 'off' | 'auto' =
        rawMode === 'on' || rawMode === 'off' || rawMode === 'auto'
          ? rawMode
          : 'auto';

      // Create embedding provider (may return null if mode=auto and model not cached,
      // or mode=off, or the model is missing/invalid)
      let embeddingProvider = null;
      try {
        embeddingProvider = await createEmbeddingProvider({ mode: embeddingsMode });
      } catch {
        // createEmbeddingProvider never throws, but be defensive
        embeddingProvider = null;
      }

      const digest = await buildDailyDigest(store, {
        date: opts.date,
        tz: opts.tz,
      }, {
        embeddingProvider,
      });
      if (opts.json) {
        console.log(JSON.stringify(digest, null, 2));
        return;
      }
      printDailyRecap(digest, process.stdout, { showAll: opts.all === true });
    });

  // ── recap precompute ──────────────────────────────────────────────────────
  recapCmd
    .command("precompute")
    .description(
      "Pre-build the daily-recap cache for prior days (manual install — does not modify crontab)",
    )
    .option("--lookback-days <n>", "Days to pre-build", "7")
    .option("--date <YYYY-MM-DD>", "Build a single date only")
    .option(
      "--install-cron",
      "Print a crontab/launchd snippet and exit (does not modify crontab)",
    )
    .action(
      async (opts: {
        lookbackDays?: string;
        date?: string;
        installCron?: boolean;
      }) => {
        if (opts.installCron) {
          const binPath = process.argv[1] ?? "claude-stats";
          console.log(
            "# claude-stats: pre-compute daily recap at 00:05 local time",
          );
          console.log(`5 0 * * * ${binPath} recap precompute --lookback-days 1`);
          if (process.platform === "darwin") {
            console.log(
              "\n# Alternative: launchd plist (macOS) — save as ~/Library/LaunchAgents/com.claude-stats.recap.plist",
            );
            console.log("# and run: launchctl load ~/Library/LaunchAgents/com.claude-stats.recap.plist");
          } else if (process.platform === "win32") {
            console.log(
              "\n# Windows Task Scheduler: schtasks /create /tn claude-stats-recap /tr \"" +
                binPath +
                " recap precompute --lookback-days 1\" /sc DAILY /st 00:05",
            );
          }
          console.log(
            "\n# Note: copy the line above and add it manually with `crontab -e`.",
          );
          return;
        }

        const { Store: StorePC } = await import("../store/index.js");
        const { collect: collectPC } = await import("../aggregator/index.js");
        const { precomputeDigests } = await import("../recap/precompute.js");
        const store = new StorePC();
        await collectPC(store);
        try {
          const result = await precomputeDigests(
            store,
            opts.date
              ? { date: opts.date }
              : { lookbackDays: parseInt(opts.lookbackDays ?? "7", 10) },
          );
          console.log(
            `pre-computed ${result.precomputed}, skipped ${result.skipped}, failures ${result.failures}`,
          );
        } finally {
          store.close();
        }
      },
    );

  // ── recap correct * ───────────────────────────────────────────────────────

  /**
   * Helper: look up a DailyDigestItem by an id prefix (16-char hex) or a
   * substring of its firstPrompt. Returns null if not found, throws if
   * ambiguous.
   */
  async function resolveItem(
    digest: import("../recap/types.js").DailyDigest,
    selector: string,
  ): Promise<import("../recap/types.js").DailyDigestItem | null> {
    const { items } = digest;

    // First: try id prefix match
    const idMatches = items.filter((i) => i.id.startsWith(selector));
    if (idMatches.length === 1) return idMatches[0]!;
    if (idMatches.length > 1) {
      process.stderr.write(
        `Ambiguous id prefix "${selector}" — matches: ${idMatches.map((i) => i.id).join(", ")}\n`,
      );
      process.exit(1);
    }

    // Second: substring match on firstPrompt
    const lowerSel = selector.toLowerCase();
    const promptMatches = items.filter((i) => {
      if (i.firstPrompt === null) return false;
      // Strip untrusted markers for matching
      const plain = i.firstPrompt
        .replace(/<untrusted-stored-content>/g, "")
        .replace(/<\/untrusted-stored-content>/g, "")
        .trim()
        .toLowerCase();
      return plain.includes(lowerSel);
    });

    if (promptMatches.length === 1) return promptMatches[0]!;
    if (promptMatches.length > 1) {
      process.stderr.write(
        `Ambiguous selector "${selector}" — candidates:\n` +
          promptMatches
            .map((i) => `  ${i.id}: ${(i.firstPrompt ?? "").slice(0, 60)}`)
            .join("\n") +
          "\n",
      );
      process.exit(1);
    }

    return null;
  }

  // Parent command for `recap correct …` subcommands
  const correctCmd = recapCmd
    .command("correct")
    .description("Manage user corrections to clustered recap items");

  correctCmd
    .command("list")
    .description("List all user corrections stored in the corrections database")
    .action(async () => {
      const { openCorrections } = await import("../recap/corrections.js");
      const client = openCorrections();
      try {
        const entries = client.list();
        if (entries.length === 0) {
          console.log("No corrections stored.");
          return;
        }
        for (const entry of entries) {
          const { id, sig, action } = entry;
          const actionStr =
            action.kind === "rename"
              ? `rename → \`${action.label}\``
              : action.kind === "merge"
                ? `merge with ${action.otherSignature.projectPath}`
                : action.kind === "split"
                  ? `split segment ${action.segmentId}`
                  : action.kind === "outcome"
                    ? `outcome → ${action.value}`
                    : "hide";
          console.log(
            `[${id}] ${sig.projectPath} | \`${sig.promptPrefix}\` | ${actionStr}`,
          );
        }
      } finally {
        client.close();
      }
    });

  correctCmd
    .command("remove <correctionId>")
    .description("Remove a correction by its numeric id (from `recap correct list`)")
    .action(async (correctionIdStr: string) => {
      const { openCorrections } = await import("../recap/corrections.js");
      const correctionId = parseInt(correctionIdStr, 10);
      if (isNaN(correctionId)) {
        process.stderr.write(`Invalid correction id: "${correctionIdStr}"\n`);
        process.exit(1);
      }
      const client = openCorrections();
      try {
        const entries = client.list();
        const entry = entries.find((e) => e.id === correctionId);
        if (!entry) {
          process.stderr.write(`Correction ${correctionId} not found.\n`);
          process.exit(1);
        }
        client.remove(entry.sig, entry.action);
        console.log(`Removed correction ${correctionId}.`);
      } finally {
        client.close();
      }
    });

  correctCmd
    .command("hide <item>")
    .description("Hide a digest item from future recaps (by id prefix or prompt substring)")
    .action(async (itemSelector: string) => {
      const { Store: StoreCH } = await import("../store/index.js");
      const { collect: collectCH } = await import("../aggregator/index.js");
      const { buildDailyDigest } = await import("../recap/index.js");
      const { openCorrections, computeSignature } = await import(
        "../recap/corrections.js"
      );
      const store = new StoreCH();
      await collectCH(store);
      try {
        const digest = await buildDailyDigest(store, {});
        const item = await resolveItem(digest, itemSelector);
        if (!item) {
          process.stderr.write(`No item matching "${itemSelector}" in today's digest.\n`);
          process.exit(1);
        }
        const sig = computeSignature(item);
        const client = openCorrections();
        try {
          client.add(sig, { kind: "hide" });
          console.log(`Correction added: hide "${item.id}".`);
        } finally {
          client.close();
        }
      } finally {
        store.close();
      }
    });

  correctCmd
    .command("rename <item> <label>")
    .description("Rename a digest item with a custom label")
    .action(async (itemSelector: string, label: string) => {
      const { Store: StoreCR } = await import("../store/index.js");
      const { collect: collectCR } = await import("../aggregator/index.js");
      const { buildDailyDigest } = await import("../recap/index.js");
      const { openCorrections, computeSignature } = await import(
        "../recap/corrections.js"
      );
      const store = new StoreCR();
      await collectCR(store);
      try {
        const digest = await buildDailyDigest(store, {});
        const item = await resolveItem(digest, itemSelector);
        if (!item) {
          process.stderr.write(`No item matching "${itemSelector}" in today's digest.\n`);
          process.exit(1);
        }
        const sig = computeSignature(item);
        const client = openCorrections();
        try {
          client.add(sig, { kind: "rename", label });
          console.log(`Correction added: rename "${item.id}" to \`${label}\`.`);
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          process.exit(1);
        } finally {
          client.close();
        }
      } finally {
        store.close();
      }
    });

  correctCmd
    .command("ticket <item> <key>")
    .description("Assign a work-item key to a digest item, and link every session it covers")
    .action(async (itemSelector: string, keyArg: string) => {
      const { Store: StoreCT } = await import("../store/index.js");
      const { collect: collectCT } = await import("../aggregator/index.js");
      const { buildDailyDigest } = await import("../recap/index.js");
      const { openCorrections, computeSignature } = await import(
        "../recap/corrections.js"
      );
      const store = new StoreCT();
      await collectCT(store);
      try {
        const digest = await buildDailyDigest(store, {});
        const item = await resolveItem(digest, itemSelector);
        if (!item) {
          process.stderr.write(`No item matching "${itemSelector}" in today's digest.\n`);
          process.exit(1);
        }
        let key: string;
        try {
          key = requireTicketKey(keyArg);
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          process.exitCode = 1;
          return;
        }
        const sig = computeSignature(item);
        const client = openCorrections();
        try {
          client.add(sig, { kind: "ticket", key });
        } catch (err) {
          process.stderr.write(`${(err as Error).message}\n`);
          process.exitCode = 1;
          return;
        } finally {
          client.close();
        }
        // The correction above labels the digest item; this is what makes the
        // assignment reach cost aggregation, which reads `ticket_links`, not
        // the recap corrections DB.
        const { applyTicketCorrectionWriteThrough } = await import("../ticketing/index.js");
        applyTicketCorrectionWriteThrough(store, item.sessionIds, key);
        console.log(`Correction added: ticket "${key}" assigned to "${item.id}" (${item.sessionIds.length} session(s) linked).`);
      } finally {
        store.close();
      }
    });

  correctCmd
    .command("merge <itemA> <itemB>")
    .description("Merge two digest items into one for all future recaps")
    .action(async (itemASelector: string, itemBSelector: string) => {
      const { Store: StoreCM } = await import("../store/index.js");
      const { collect: collectCM } = await import("../aggregator/index.js");
      const { buildDailyDigest } = await import("../recap/index.js");
      const { openCorrections, computeSignature } = await import(
        "../recap/corrections.js"
      );
      const store = new StoreCM();
      await collectCM(store);
      try {
        const digest = await buildDailyDigest(store, {});
        const itemA = await resolveItem(digest, itemASelector);
        const itemB = await resolveItem(digest, itemBSelector);
        if (!itemA) {
          process.stderr.write(`No item matching "${itemASelector}" in today's digest.\n`);
          process.exit(1);
        }
        if (!itemB) {
          process.stderr.write(`No item matching "${itemBSelector}" in today's digest.\n`);
          process.exit(1);
        }
        const sigA = computeSignature(itemA);
        const sigB = computeSignature(itemB);
        const client = openCorrections();
        try {
          client.add(sigA, { kind: "merge", otherSignature: sigB });
          console.log(`Correction added: merge "${itemA.id}" with "${itemB.id}".`);
        } finally {
          client.close();
        }
      } finally {
        store.close();
      }
    });

  correctCmd
    .command("split <item> <segmentId>")
    .description("Split a named segment out of a digest item into its own item")
    .action(async (itemSelector: string, segmentIdStr: string) => {
      const { Store: StoreCS } = await import("../store/index.js");
      const { collect: collectCS } = await import("../aggregator/index.js");
      const { buildDailyDigest } = await import("../recap/index.js");
      const { openCorrections, computeSignature } = await import(
        "../recap/corrections.js"
      );
      const store = new StoreCS();
      await collectCS(store);
      try {
        const digest = await buildDailyDigest(store, {});
        const item = await resolveItem(digest, itemSelector);
        if (!item) {
          process.stderr.write(`No item matching "${itemSelector}" in today's digest.\n`);
          process.exit(1);
        }
        const sig = computeSignature(item);
        const client = openCorrections();
        try {
          client.add(sig, {
            kind: "split",
            segmentId: segmentIdStr as import("../recap/types.js").SegmentId,
          });
          console.log(`Correction added: split segment "${segmentIdStr}" from "${item.id}".`);
        } finally {
          client.close();
        }
      } finally {
        store.close();
      }
    });

  // Account-attribution command groups (bodies filled in Phase 2).
  registerAccountCommands(program);
  registerOtelCommands(program);
  registerRepairCommands(program);
  registerPlanAdvisorCommands(program);
  // Aggregate-only cloud sync: setup / sync / disconnect.
  registerSyncCommands(program);

  program
    .command("purge")
    .description(
      "Permanently delete all locally stored claude-stats data (transcript archive " +
        "and export bundles; the stats DB and cloud-sync config are opt-in via flags). " +
        "Without --yes this is a dry run: it prints what would be deleted and exits.",
    )
    .option("--yes", "Actually perform the deletion (omit for a dry-run preview only)")
    .option("--include-db", "Also delete the stats database (and its -wal/-shm sidecars)")
    .option("--also-cloud", "Also remove local cloud-sync configuration and clear auth tokens (org/team plane)")
    .option(
      "--backup-cloud",
      "Also delete THIS DEVICE's copy in your personal backup location (Dropbox/iCloud/Drive/OneDrive/" +
        "local folder). Other enrolled devices keep their own copies until they too run this.",
    )
    .action(async (opts: { yes?: boolean; includeDb?: boolean; alsoCloud?: boolean; backupCloud?: boolean }) => {
      const targets = [paths.archiveDir, paths.bundleDir];
      if (opts.includeDb) targets.push(paths.statsDb);

      const { describePurgeScope } = await import("../ux/purge-scope.js");
      const backupTarget = loadConfig().backup?.target;
      const cloudScope = describePurgeScope("also-cloud");

      if (!opts.yes) {
        console.log("Dry run — nothing was deleted. Pass --yes to actually purge.\n");
        console.log("Would delete:");
        for (const target of targets) console.log(`  - ${target}`);
        if (!opts.includeDb) {
          console.log(`  (stats DB at ${paths.statsDb} would be KEPT — pass --include-db to delete it)`);
        }
        console.log("Would unregister the claude-stats MCP server from ~/.claude.json.");
        if (opts.alsoCloud) {
          console.log("Would remove local cloud-sync configuration and clear auth tokens (org/team plane).");
        }
        if (opts.backupCloud) {
          if (backupTarget) {
            console.log(`  - This device's shards in your backup location (${backupTarget})`);
            console.log(`  Note: ${cloudScope.otherDevicesNote}`);
          } else {
            console.log("  (--backup-cloud requested, but backup/sync isn't configured on this device — nothing to delete there.)");
          }
        }
        return;
      }

      const { purgeAllData } = await import("../archive/index.js");
      const result = purgeAllData({ deleteDb: opts.includeDb === true });

      for (const outcome of result.outcomes) {
        if (outcome.error) {
          console.error(`Failed to delete ${outcome.target}: ${outcome.error}`);
        } else if (outcome.existed) {
          console.log(`Deleted ${outcome.target}`);
        }
      }
      console.log(
        result.unregistered
          ? "Unregistered the claude-stats MCP server from ~/.claude.json."
          : "MCP server was not registered (or unregister failed) — no change needed there.",
      );

      if (opts.alsoCloud) {
        clearTokens();
        removeSyncConfig();
        console.log("Removed local cloud-sync configuration and cleared auth tokens (org/team plane).");
      }

      if (opts.backupCloud) {
        if (!backupTarget) {
          console.log("Backup/sync isn't configured on this device — nothing to delete from the cloud copy.");
        } else {
          // This device's identity/DEK bootstrap (recovery-key unwrap for a
          // headless CLI run) isn't wired into this command yet — the deletion
          // mechanics themselves (`purgeDeviceCloudCopy`) are implemented and
          // tested in ux/purge-scope.ts, ready to be called once that identity
          // assembly lands. Until then, be explicit rather than silently no-op.
          console.log(
            "Cloud backup-copy deletion for this device isn't wired into the CLI yet " +
              "(needs this device's enrolled backup identity). Local data has still been purged; " +
              "delete this device's subfolder from your backup location manually if needed.",
          );
        }
        console.log(cloudScope.otherDevicesNote);
      }

      if (!result.ok) {
        process.exitCode = 1;
        return;
      }
      console.log("\nPurge complete.");
    });

  return program;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}
