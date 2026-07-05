/**
 * `otel` command registration (Phase 2 D).
 *
 * Thin command layer (cli/** is excluded from coverage — keep logic in covered
 * modules): parse args → call the covered otel/store functions and print.
 *
 *   account otel ingest --file <path>
 *       — read a Claude Code OTLP export file (OTLP/JSON or JSONL) and apply
 *         AUTHORITATIVE account attribution from its resource attributes
 *         (user.account_uuid + session.id), covering all surfaces.
 *
 * Enabling OTEL is a USER/HUMAN step (the build never edits the user's env or
 * settings). See doc/user-doc/account-otel.md and the help text below.
 *
 * i18n namespace: cli:otel.* (locale files are batched in Phase 3).
 */
import type { Command } from "commander";
import { Store } from "../store/index.js";
import { ingestOtel } from "../otel/index.js";
import { t } from "../i18n.js";

export function registerOtelCommands(program: Command): void {
  // Nest under the existing `account` command if present, else create it so the
  // group exists. Unit A owns the `account` root command; to avoid a duplicate
  // registration we look it up and only add the subcommand here.
  const account =
    program.commands.find((c) => c.name() === "account") ??
    program.command("account");

  const otel = account
    .command("otel")
    .description(t("cli:otel.description"))
    .addHelpText("after", () => "\n" + t("cli:otel.enableHelp"));

  otel
    .command("ingest")
    .description(t("cli:otel.ingestDescription"))
    .requiredOption("--file <path>", t("cli:otel.fileOption"))
    .action(async (opts: { file: string }) => {
      await runIngest(opts.file);
    });
}

/** Read the OTLP file and apply authoritative attribution; print a summary. */
async function runIngest(filePath: string): Promise<void> {
  const store = new Store();
  try {
    const summary = await ingestOtel(store, filePath, Date.now);
    console.log(
      t("cli:otel.ingestSummary", {
        records: summary.recordCount,
        sessions: summary.sessions,
        accounts: summary.accounts,
        changed: summary.changed,
      }),
    );
    if (summary.malformed > 0) {
      console.log(t("cli:otel.malformedSkipped", { count: summary.malformed }));
    }
    if (summary.truncated) {
      console.log(t("cli:otel.truncated"));
    }
  } finally {
    store.close();
  }
}
