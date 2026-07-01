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
 *   account own                  — manage cost-ownership rules (create, list, clear).
 *   account classify             — show project clusters ranked by estimated cost.
 *
 * i18n namespace: cli:account.* (locale files are batched in Phase 3).
 */
import os from "node:os";
import type { Command } from "commander";
import { Store } from "../store/index.js";
import { readClaudeAccount } from "../account.js";
import { reattribute, resolveOwner, clusterProjects } from "../attribution/index.js";
import { t } from "../i18n.js";
import type { OwnerTarget } from "@claude-stats/core/types";

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
    .option("--force", t("cli:account.forceOption"))
    .action((opts: { dryRun?: boolean; force?: boolean }) => {
      runReattribute(opts.dryRun ?? false, opts.force ?? false);
    });

  account
    .command("own")
    .description(t("cli:account.own.description"))
    .option("--account <uuid|split>", t("cli:account.own.accountOption"))
    .option("--path <glob>", t("cli:account.own.pathOption"))
    .option("--remote <glob>", t("cli:account.own.remoteOption"))
    .option("--dry-run", t("cli:account.own.dryRunOption"))
    .option("--force", t("cli:account.own.forceOption"))
    .option("--list", t("cli:account.own.listOption"))
    .option("--clear <id>", t("cli:account.own.clearOption"))
    .action(
      (opts: {
        account?: string;
        path?: string;
        remote?: string;
        dryRun?: boolean;
        force?: boolean;
        list?: boolean;
        clear?: string;
      }) => {
        runAccountOwn(opts);
      },
    );

  account
    .command("classify")
    .description(t("cli:account.classify.description"))
    .action(() => {
      runAccountClassify();
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
function runReattribute(dryRun: boolean, force: boolean): void {
  const store = new Store();
  try {
    const summary = reattribute(store, { dryRun, force }, Date.now);

    // Real run blocked by the safety guard: warn and stop (no changes made).
    if (summary.refused && !dryRun) {
      console.log(t("cli:account.reattributeRefused", { attributed: summary.attributedBefore }));
      printBySource(summary.bySource);
      return;
    }

    if (summary.dryRun) {
      console.log(t("cli:account.reattributeDryRunHeader"));
      if (summary.refused) {
        console.log(t("cli:account.reattributeRefused", { attributed: summary.attributedBefore }));
      }
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
    printBySource(summary.bySource);
    if (summary.messagesStamped > 0) {
      console.log(
        t("cli:account.reattributeMessagesStamped", { count: summary.messagesStamped }),
      );
    }
  } finally {
    store.close();
  }
}

/** Print the per-source assignment breakdown (indented). */
function printBySource(bySource: Record<string, number>): void {
  for (const [source, count] of Object.entries(bySource)) {
    console.log(`  ${source}: ${count}`);
  }
}

/**
 * Expand a leading "~/" in a glob path to the OS home directory.
 * Pure: does no I/O, just string replacement.
 */
function expandTilde(p: string): string {
  if (p.startsWith("~/")) {
    return os.homedir() + p.slice(1);
  }
  return p;
}

/** Format a dollar cost with 4 decimal places for display. */
function formatCost(cost: number): string {
  return "$" + cost.toFixed(4);
}

/**
 * `account own` subcommand handler.
 * Delegates all business logic to store/attribution modules; this function
 * is only responsible for parsing opts and printing.
 */
function runAccountOwn(opts: {
  account?: string;
  path?: string;
  remote?: string;
  dryRun?: boolean;
  force?: boolean;
  list?: boolean;
  clear?: string;
}): void {
  // --list: show all existing rules
  if (opts.list) {
    const store = new Store();
    try {
      const rules = store.listOwnerRules();
      if (rules.length === 0) {
        console.log(t("cli:account.own.noRules"));
        return;
      }
      console.log(t("cli:account.own.listHeader"));
      for (const rule of rules) {
        const matcher = [
          rule.pathGlob ? `path:${rule.pathGlob}` : null,
          rule.remoteGlob ? `remote:${rule.remoteGlob}` : null,
        ]
          .filter(Boolean)
          .join(", ");
        const target =
          rule.target.kind === "split" ? "split" : rule.target.accountUuid;
        console.log(`  ${rule.id} · ${matcher} · ${target}`);
      }
    } finally {
      store.close();
    }
    return;
  }

  // --clear <id>: remove a rule and revert its sessions
  if (opts.clear !== undefined) {
    const id = parseInt(opts.clear, 10);
    if (isNaN(id)) {
      console.error(`Invalid rule id: ${opts.clear}`);
      process.exit(1);
    }
    const store = new Store();
    try {
      // Find the rule to verify it exists and compute matched sessions
      const rules = store.listOwnerRules();
      const rule = rules.find((r) => r.id === id);
      if (!rule) {
        console.error(`No owner rule with id ${id}`);
        process.exit(1);
      }

      // Determine which sessions this rule currently matches
      const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
      const matchedIds = sessions
        .filter(
          (s) =>
            resolveOwner(
              { projectPath: s.project_path, repoUrl: s.repo_url },
              [rule],
            ) !== null,
        )
        .map((s) => s.session_id);

      // Clear overrides and delete the rule
      store.clearOverridesForRule(matchedIds);
      store.deleteOwnerRule(id);

      // Reattribute so surviving rules + inference fills the cleared sessions
      reattribute(store, { dryRun: false, force: true }, Date.now);

      console.log(
        t("cli:account.own.deleted", { count: matchedIds.length }),
      );
    } finally {
      store.close();
    }
    return;
  }

  // Create mode: requires --account and at least one of --path/--remote
  if (!opts.account) {
    console.error(
      "account own: --account <uuid|split> is required (or use --list or --clear)",
    );
    process.exit(1);
  }
  if (!opts.path && !opts.remote) {
    console.error("account own: at least one of --path or --remote is required");
    process.exit(1);
  }

  // Build target
  const target: OwnerTarget =
    opts.account === "split"
      ? { kind: "split" }
      : { kind: "account", accountUuid: opts.account };

  // Expand leading "~/" in --path before storing (the core stays pure)
  const pathGlob = opts.path ? expandTilde(opts.path) : null;
  const remoteGlob = opts.remote ?? null;

  const store = new Store();
  try {
    const sessions = store.getSessions({ includeCI: true, includeDeleted: true });

    // Build the candidate rule (without an id/createdAt yet) for dry-run matching
    const candidateRule = {
      id: -1,
      pathGlob,
      remoteGlob,
      target,
      createdAt: Date.now(),
    };

    const matchedSessions = sessions.filter(
      (s) =>
        resolveOwner(
          { projectPath: s.project_path, repoUrl: s.repo_url },
          [candidateRule],
        ) !== null,
    );

    const matchedCount = matchedSessions.length;
    const totalCount = sessions.length;

    if (opts.dryRun) {
      // Compute cost of matched sessions and how many are currently otel/telemetry
      const matchedIds = matchedSessions.map((s) => s.session_id);
      const costMap = store.getCostBySession(matchedIds);
      const totalCost = Array.from(costMap.values()).reduce((a, b) => a + b, 0);
      const displacedCount = matchedSessions.filter(
        (s) =>
          s.account_source === "otel" ||
          s.account_source === "telemetry",
      ).length;

      console.log(
        t("cli:account.own.dryRunSummary", {
          matched: matchedCount,
          cost: formatCost(totalCost),
          displaced: displacedCount,
        }),
      );
      return;
    }

    // Overbroad guard: refuse if >90% of sessions would be matched, unless --force
    if (totalCount > 0 && matchedCount / totalCount > 0.9 && !opts.force) {
      const pct = Math.round((matchedCount / totalCount) * 100);
      console.error(
        t("cli:account.own.refusedOverbroad", { pct }),
      );
      process.exit(1);
    }

    // Create the rule (store validates all-wildcard, cap, target-exists)
    const created = store.createOwnerRule({ pathGlob, remoteGlob, target }, Date.now);

    // Reattribute so the new rule is applied
    reattribute(store, { dryRun: false, force: true }, Date.now);

    console.log(t("cli:account.own.created", { id: created.id }));
  } finally {
    store.close();
  }
}

/**
 * `account classify` subcommand handler.
 * Prints project clusters ranked by estimated cost and the unclassified total.
 * NEVER snapshot this output in a test (it renders real paths/remotes).
 */
function runAccountClassify(): void {
  const store = new Store();
  try {
    const sessions = store.getSessions({ includeCI: true, includeDeleted: true });
    if (sessions.length === 0) {
      console.log(t("cli:account.classify.noData"));
      return;
    }

    const clusterInputs = sessions.map((s) => ({
      sessionId: s.session_id,
      projectPath: s.project_path,
      repoUrl: s.repo_url,
    }));

    const costBySession = store.getCostBySession();
    const clusters = clusterProjects(clusterInputs, costBySession);

    // Determine which sessions have no matching owner rule
    const rules = store.listOwnerRules();
    const unclassifiedCost = sessions.reduce((sum, s) => {
      const match = resolveOwner(
        { projectPath: s.project_path, repoUrl: s.repo_url },
        rules,
      );
      if (match === null) {
        return sum + (costBySession.get(s.session_id) ?? 0);
      }
      return sum;
    }, 0);

    console.log(t("cli:account.classify.header"));
    for (const cluster of clusters) {
      console.log(
        t("cli:account.classify.row", {
          label: cluster.label,
          projects: cluster.projectPaths.length,
          sessions: cluster.sessionCount,
          cost: formatCost(cluster.estimatedCost),
        }),
      );
    }
    console.log(
      t("cli:account.classify.unclassified", {
        cost: formatCost(unclassifiedCost),
      }),
    );
  } finally {
    store.close();
  }
}
