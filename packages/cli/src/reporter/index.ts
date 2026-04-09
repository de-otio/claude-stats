/**
 * Reporter — formats and prints usage summaries.
 * Timestamps are stored as UTC; timezone conversion happens here at report time.
 * See doc/analysis/02-collection-strategy.md — Timezone Handling.
 */
import type { Store, SessionRow, MessageRow, StatusInfo, SpendingReport } from "../store/index.js";
import type { SearchResult } from "../history/index.js";
import { estimateCost, formatCost } from "@claude-stats/core/pricing";
import { attributeToolCosts, groupByMcpServer, detectAnomalies } from "../spending.js";
import { t } from "../i18n.js";

export interface ReportOptions {
  projectPath?: string;
  repoUrl?: string;
  accountUuid?: string;
  entrypoint?: string;
  tag?: string;
  period?: "day" | "week" | "month" | "all";
  timezone?: string;
  includeCI?: boolean;
  /** Monthly plan fee in USD for ROI calculations (0 = disabled). */
  planFee?: number;
  /** Plan type string (e.g. "pro", "max_5x") used as fallback when telemetry subscription_type is absent. */
  planType?: string;
}

export function formatEntrypoint(ep: string): string {
  if (ep === "claude") return "cli";
  if (ep === "claude-vscode") return "vscode";
  return ep;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "< 1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

export function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1_024) return `${(n / 1_024).toFixed(0)} KB`;
  return `${n} B`;
}

/**
 * Returns the UTC epoch ms for midnight at the start of the given calendar date
 * (year/month/day) in the specified IANA timezone.
 *
 * Uses a reference point at UTC noon to derive the timezone's UTC offset on
 * that date (handles DST and sub-hour offsets like IST +5:30).
 */
function tzMidnight(year: number, month: number, day: number, tz: string): number {
  // noon UTC on that calendar date — safely within the day for any timezone
  const refUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  // Represent that UTC moment as a local wall-clock time in the target tz
  const localStr = refUtc.toLocaleString("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  // Parse "MM/DD/YYYY, HH:MM:SS" back as if it were UTC to get the offset
  const [datePart, timePart] = localStr.split(", ");
  const [mo, da, yr] = datePart!.split("/").map(Number);
  const [hr, mn, sc] = timePart!.split(":").map(Number);
  const localAsUtc = Date.UTC(yr!, mo! - 1, da!, hr!, mn!, sc!);
  const offsetMs = refUtc.getTime() - localAsUtc; // positive = tz ahead of UTC
  return Date.UTC(year, month - 1, day, 0, 0, 0) + offsetMs;
}

export function periodStart(period: string | undefined, tz: string): number {
  const now = new Date();
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [year, month, day] = dateFmt.format(now).split("-").map(Number) as [number, number, number];

  if (period === "day") {
    return tzMidnight(year, month, day, tz);
  }
  if (period === "week") {
    // Day of week (0=Sun) in the target timezone
    const dowFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" });
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(dowFmt.format(now));
    // Subtract dow days to reach Sunday; format in tz to get the correct calendar date
    const sunday = new Date(now.getTime() - dow * 86_400_000);
    const [wy, wm, wd] = dateFmt.format(sunday).split("-").map(Number) as [number, number, number];
    return tzMidnight(wy, wm, wd, tz);
  }
  if (period === "month") {
    return tzMidnight(year, month, 1, tz);
  }
  return 0;
}

type Totals = { sessions: number; input: number; output: number; prompts: number };

function makeTotals(): Totals {
  return { sessions: 0, input: 0, output: 0, prompts: 0 };
}

function addRow(totals: Totals, row: SessionRow): void {
  totals.sessions++;
  totals.input += row.input_tokens;
  totals.output += row.output_tokens;
  totals.prompts += row.prompt_count;
}

function printTable(
  title: string,
  entries: Array<[string, Totals]>,
  labelWidth: number = 40
): void {
  console.log(`\n\u2500\u2500\u2500 ${title} \u2500\u2500\u2500\n`);
  const header = `${"".padEnd(labelWidth)}  ${t("cli:report.tableHeaderSess").padStart(5)}  ${t("common:metrics.prompts").padStart(7)}  ${t("common:metrics.input").padStart(8)}  ${t("common:metrics.output").padStart(8)}`;
  console.log(header);
  console.log("\u2500".repeat(header.length));
  for (const [label, tot] of entries) {
    const name = label.length > labelWidth ? "\u2026" + label.slice(-(labelWidth - 1)) : label;
    console.log(
      `${name.padEnd(labelWidth)}  ${String(tot.sessions).padStart(5)}  ${String(tot.prompts).padStart(7)}  ${formatTokens(tot.input).padStart(8)}  ${formatTokens(tot.output).padStart(8)}`
    );
  }
}

// ── Temporal Trends ─────────────────────────────────────────────────────────

export interface TrendBucket {
  label: string;      // "Mon Mar 3", "Feb 24 – Mar 2", "Feb 2026"
  startMs: number;
  endMs: number;
}

/**
 * Build time buckets for trend display.
 * - week  → 7 daily buckets
 * - month → weekly buckets (Mon–Sun weeks, 4-5 rows)
 * - all   → monthly buckets from rangeStart to rangeEnd
 */
export function buildBuckets(period: string, tz: string, rangeStart: number, rangeEnd: number): TrendBucket[] {
  const buckets: TrendBucket[] = [];

  if (period === "week") {
    // 7 daily buckets
    const dayFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    let cursor = rangeStart;
    for (let i = 0; i < 7; i++) {
      const dayStart = cursor;
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;
      buckets.push({
        label: dayFmt.format(new Date(dayStart)),
        startMs: dayStart,
        endMs: dayEnd,
      });
      cursor = dayEnd;
    }
  } else if (period === "month") {
    // Weekly buckets (Mon–Sun), covering the full month
    const dateFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
    });
    // Find the Monday on or before rangeStart
    let cursor = rangeStart;
    // Walk through in week increments
    while (cursor < rangeEnd) {
      const weekStart = cursor;
      const weekEnd = Math.min(weekStart + 7 * 24 * 60 * 60 * 1000, rangeEnd);
      const lastDay = weekEnd - 24 * 60 * 60 * 1000; // last day in the week
      const label = `${dateFmt.format(new Date(weekStart))} \u2013 ${dateFmt.format(new Date(lastDay))}`;
      buckets.push({ label, startMs: weekStart, endMs: weekEnd });
      cursor = weekEnd;
    }
  } else {
    // "all" → monthly buckets
    const monthFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      year: "numeric",
    });
    // Parse rangeStart into year/month in the target timezone
    const startParts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(rangeStart)).split("-").map(Number);
    const endParts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(rangeEnd - 1)).split("-").map(Number);

    let year = startParts[0]!;
    let month = startParts[1]!;
    const endYear = endParts[0]!;
    const endMonth = endParts[1]!;

    while (year < endYear || (year === endYear && month <= endMonth)) {
      const monthStart = new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00Z`).getTime();
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;
      const monthEnd = new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00Z`).getTime();
      buckets.push({
        label: monthFmt.format(new Date(monthStart)),
        startMs: monthStart,
        endMs: monthEnd,
      });
      year = nextYear;
      month = nextMonth;
    }
  }

  return buckets;
}

export function printTrend(store: Store, opts: ReportOptions = {}): void {
  const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const period = opts.period ?? "month";
  const since = periodStart(period, tz);

  const rows = store.getSessions({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    entrypoint: opts.entrypoint,
    tag: opts.tag,
    since: since > 0 ? since : undefined,
    includeCI: opts.includeCI ?? false,
  });

  if (rows.length === 0) {
    console.log(t("cli:report.noSessions"));
    return;
  }

  const rangeStart = since > 0 ? since : Math.min(...rows.map(r => r.first_timestamp ?? Infinity));
  const rangeEnd = Date.now();

  const buckets = buildBuckets(period, tz, rangeStart, rangeEnd);

  // Initialize totals per bucket
  const bucketTotals = new Map<TrendBucket, Totals>();
  for (const b of buckets) {
    bucketTotals.set(b, makeTotals());
  }

  // Assign sessions to buckets
  for (const row of rows) {
    const ts = row.first_timestamp;
    if (ts == null) continue;
    const bucket = buckets.find(b => ts >= b.startMs && ts < b.endMs);
    if (bucket) {
      addRow(bucketTotals.get(bucket)!, row);
    }
  }

  // Compute grand totals
  const grandTotal = makeTotals();
  for (const tot of bucketTotals.values()) {
    grandTotal.sessions += tot.sessions;
    grandTotal.input += tot.input;
    grandTotal.output += tot.output;
    grandTotal.prompts += tot.prompts;
  }

  // Determine label column header
  const columnLabel = period === "week"
    ? t("cli:report.trendColumnDay")
    : period === "month"
      ? t("cli:report.trendColumnWeek")
      : t("cli:report.trendColumnMonth");
  const periodLabel = period === "week"
    ? t("cli:report.trendPeriodWeekly")
    : period === "month"
      ? t("cli:report.trendPeriodMonthly")
      : t("cli:report.trendPeriodAllTime");

  console.log(`\n\u2500\u2500\u2500 ${t("cli:report.titleTrend", { period: periodLabel, timezone: tz })} \u2500\u2500\u2500\n`);

  // Find max label width
  const labelWidth = Math.max(columnLabel.length, ...buckets.map(b => b.label.length), 5);

  const header = `${columnLabel.padEnd(labelWidth)}  ${t("common:metrics.sessions").padStart(8)}  ${t("common:metrics.prompts").padStart(7)}  ${t("common:metrics.input").padStart(8)}  ${t("common:metrics.output").padStart(8)}`;
  console.log(header);
  console.log("\u2500".repeat(header.length));

  for (const bucket of buckets) {
    const tot = bucketTotals.get(bucket)!;
    console.log(
      `${bucket.label.padEnd(labelWidth)}  ${String(tot.sessions).padStart(8)}  ${String(tot.prompts).padStart(7)}  ${formatTokens(tot.input).padStart(8)}  ${formatTokens(tot.output).padStart(8)}`
    );
  }

  console.log("\u2500".repeat(header.length));
  console.log(
    `${t("cli:report.tableTotal").padEnd(labelWidth)}  ${String(grandTotal.sessions).padStart(8)}  ${String(grandTotal.prompts).padStart(7)}  ${formatTokens(grandTotal.input).padStart(8)}  ${formatTokens(grandTotal.output).padStart(8)}`
  );
  console.log();
}

export function printSummary(store: Store, opts: ReportOptions = {}): void {
  const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const since = periodStart(opts.period, tz);

  const rows = store.getSessions({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    entrypoint: opts.entrypoint,
    tag: opts.tag,
    since: since > 0 ? since : undefined,
    includeCI: opts.includeCI ?? false,
  });

  if (rows.length === 0) {
    console.log(t("cli:report.noSessionsFiltered"));
    return;
  }

  // Aggregate totals
  let totalPrompts = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  let totalDurationMs = 0;
  const projectTotals = new Map<string, Totals>();
  const repoTotals = new Map<string, Totals>();
  const accountTotals = new Map<string, Totals>();
  const modelCounts = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  const entrypointCounts = new Map<string, number>();

  for (const row of rows) {
    totalPrompts += row.prompt_count;
    totalInput += row.input_tokens;
    totalOutput += row.output_tokens;
    totalCacheRead += row.cache_read_tokens;
    totalCacheCreate += row.cache_creation_tokens;
    if (row.first_timestamp != null && row.last_timestamp != null) {
      totalDurationMs += row.last_timestamp - row.first_timestamp;
    }

    const pt = projectTotals.get(row.project_path) ?? makeTotals();
    addRow(pt, row);
    projectTotals.set(row.project_path, pt);

    const repoKey = row.repo_url ?? "(no remote)";
    const rt = repoTotals.get(repoKey) ?? makeTotals();
    addRow(rt, row);
    repoTotals.set(repoKey, rt);

    const acctKey = row.account_uuid
      ? `${row.account_uuid.slice(0, 8)}\u2026 (${row.subscription_type ?? "unknown"})`
      : "(no account data)";
    const at = accountTotals.get(acctKey) ?? makeTotals();
    addRow(at, row);
    accountTotals.set(acctKey, at);

    const ep = row.entrypoint ?? "unknown";
    entrypointCounts.set(ep, (entrypointCounts.get(ep) ?? 0) + 1);

    const models: string[] = JSON.parse(row.models) as string[];
    for (const m of models) modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1);

    const tools: Array<{ name: string; count: number }> = JSON.parse(row.tool_use_counts) as Array<{ name: string; count: number }>;
    for (const tool of tools) toolCounts.set(tool.name, (toolCounts.get(tool.name) ?? 0) + tool.count);
  }

  const totalLogicalInput = totalInput + totalCacheCreate + totalCacheRead;
  const cacheEfficiency = totalLogicalInput > 0
    ? ((totalCacheRead / totalLogicalInput) * 100).toFixed(1)
    : "0.0";

  const periodLabel = opts.period
    ? `${opts.period} (${tz})`
    : t("common:periods.allTime");

  console.log(`\n\u2500\u2500\u2500 ${t("cli:report.titleSummary", { period: periodLabel })} \u2500\u2500\u2500\n`);
  const durationSuffix = totalDurationMs > 0 ? ` (${formatDuration(totalDurationMs)} ${t("cli:report.tableTotal").toLowerCase()})` : "";
  console.log(`${t("cli:report.labelSessions").padEnd(9)}: ${rows.length}${durationSuffix}`);
  console.log(`${t("cli:report.labelPrompts").padEnd(9)}: ${totalPrompts}`);
  console.log(`${t("cli:report.labelInput").padEnd(9)}: ${formatTokens(totalInput)}`);
  console.log(`${t("cli:report.labelOutput").padEnd(9)}: ${formatTokens(totalOutput)}`);
  console.log(`${t("cli:report.labelCache").padEnd(9)}: ${t("cli:report.cacheDetail", { read: formatTokens(totalCacheRead), created: formatTokens(totalCacheCreate), efficiency: cacheEfficiency })}`);

  // Cost estimation from per-message model data
  const messageTotals = store.getMessageTotals({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    since: since > 0 ? since : undefined,
  });
  let totalCost = 0;
  let unknownTokens = 0;
  for (const mt of messageTotals) {
    const result = estimateCost(
      mt.model,
      mt.input_tokens,
      mt.output_tokens,
      mt.cache_read_tokens,
      mt.cache_creation_tokens,
    );
    if (result.known) {
      totalCost += result.cost;
    } else {
      unknownTokens += mt.input_tokens + mt.output_tokens + mt.cache_read_tokens + mt.cache_creation_tokens;
    }
  }
  let costLine = `${t("cli:report.labelCost").padEnd(9)}: ${t("cli:report.costLine", { cost: formatCost(totalCost) })}`;
  if (unknownTokens > 0) {
    costLine += ` ${t("cli:report.costUnknown", { tokens: formatTokens(unknownTokens) })}`;
  }
  console.log(costLine);

  // Plan ROI — only shown when a plan fee is configured
  const planFee = opts.planFee ?? 0;
  if (planFee > 0) {
    const multiplier = totalCost / planFee;
    console.log(`${t("cli:report.labelPlanROI").padEnd(9)}: ${t("cli:report.planROI", { planFee: formatCost(planFee), multiplier: multiplier.toFixed(1) })}`);
    if (totalPrompts > 0) {
      console.log(`${"".padEnd(9)}: ${t("cli:report.planPerUnit", { costPerPrompt: formatCost(planFee / totalPrompts), costPerSession: formatCost(planFee / rows.length) })}`);
    }
  }

  // Velocity metrics — computed from sessions with active_duration_ms
  let totalActiveDurationMs = 0;
  let sessionsWithDuration = 0;
  for (const row of rows) {
    if (row.active_duration_ms != null && row.active_duration_ms > 0) {
      totalActiveDurationMs += row.active_duration_ms;
      sessionsWithDuration++;
    }
  }
  if (totalActiveDurationMs > 0 && totalPrompts > 0) {
    const totalActiveMin = totalActiveDurationMs / 60_000;
    const totalTokens = totalInput + totalOutput;
    const tokPerMin = Math.round(totalTokens / totalActiveMin);
    const promptsPerHour = ((totalPrompts / totalActiveDurationMs) * 3_600_000).toFixed(1);
    const outputPerPrompt = Math.round(totalOutput / totalPrompts);
    console.log(`${t("cli:report.labelVelocity").padEnd(9)}: ${t("cli:report.velocityDetail", { tokPerMin: formatTokens(tokPerMin), promptsPerHr: promptsPerHour, outputPerPrompt: formatTokens(outputPerPrompt) })}`);
  }

  // Throttle events across all sessions
  const totalThrottleEvents = rows.reduce((sum, r) => sum + (r.throttle_events ?? 0), 0);
  if (totalThrottleEvents > 0) {
    console.log(`${t("cli:report.labelThrottled").padEnd(9)}: ${t("cli:report.throttleDetail", { count: totalThrottleEvents })}`);
  }

  if (modelCounts.size > 0) {
    const models = Array.from(modelCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([m, c]) => `${m} (${c})`)
      .join(", ");
    console.log(`${t("cli:report.labelModels").padEnd(9)}: ${models}`);
  }

  if (entrypointCounts.size > 0) {
    const sources = Array.from(entrypointCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([ep, c]) => `${formatEntrypoint(ep)} (${c})`)
      .join(", ");
    console.log(`${t("cli:report.labelSource").padEnd(9)}: ${sources}`);
  }

  if (toolCounts.size > 0) {
    const topTools = Array.from(toolCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([toolName, c]) => `${toolName}:${c}`)
      .join("  ");
    console.log(`${t("cli:report.labelTopTools").padEnd(9)}: ${topTools}`);
  }

  const sessionIds = rows.map(r => r.session_id);
  const stopReasons = store.getStopReasonCounts(sessionIds);
  if (stopReasons.size > 0) {
    const stops = Array.from(stopReasons.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}:${count}`)
      .join("  ");
    console.log(`${t("cli:report.labelStops").padEnd(9)}: ${stops}`);
    const maxTokensCount = stopReasons.get("max_tokens") ?? 0;
    if (maxTokensCount > 0) {
      console.log(`  ${t("cli:report.maxTokensWarning", { count: maxTokensCount })}`);
    }
  }

  // Thinking blocks summary
  let totalThinkingBlocks = 0;
  let sessionsWithThinking = 0;
  for (const row of rows) {
    totalThinkingBlocks += row.thinking_blocks;
    if (row.thinking_blocks > 0) sessionsWithThinking++;
  }
  if (totalThinkingBlocks > 0) {
    const totalResponses = rows.reduce((sum, r) => sum + r.assistant_message_count, 0);
    const pct = totalResponses > 0
      ? ((sessionsWithThinking / rows.length) * 100).toFixed(0)
      : "0";
    console.log(`${t("cli:report.labelThinking").padEnd(9)}: ${t("cli:report.thinkingDetail", { blocks: totalThinkingBlocks, percent: pct })}`);
  }

  // By Account: shown when there are multiple accounts and no account filter is active
  if (!opts.accountUuid && accountTotals.size > 1) {
    const sorted = Array.from(accountTotals.entries()).sort((a, b) => b[1].input - a[1].input);
    printTable(t("cli:report.titleByAccount"), sorted, 50);
  }

  // By Repo: shown when there are multiple repos and no repo filter is active
  if (!opts.repoUrl && repoTotals.size > 1) {
    const sorted = Array.from(repoTotals.entries()).sort((a, b) => b[1].input - a[1].input);
    printTable(t("cli:report.titleByRepo"), sorted, 50);
  }

  // By Project: shown when there are multiple projects and no project filter is active
  if (!opts.projectPath && projectTotals.size > 1) {
    const sorted = Array.from(projectTotals.entries()).sort((a, b) => b[1].input - a[1].input);
    printTable(t("cli:report.titleByProject"), sorted, 40);
  }

  console.log();
}

// ── Token Spending Breakdown ──────────────────────────────────────────────

export interface SpendingOptions extends ReportOptions {
  top?: number;
  sort?: "cost" | "tokens" | "prompts";
  json?: boolean;
  model?: string;
}

export function printSpendingReport(store: Store, opts: SpendingOptions = {}): void {
  const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const since = periodStart(opts.period ?? "day", tz);
  const top = opts.top ?? 5;

  const report = store.getSpendingReport({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    since: since > 0 ? since : undefined,
    limit: Math.max(top, 20), // fetch enough for tool/anomaly analysis
  });

  if (report.topSessions.length === 0) {
    console.log(t("cli:report.noSessionsFiltered"));
    return;
  }

  // JSON output mode
  if (opts.json) {
    const toolCosts = attributeToolCosts(report.topMessages);
    const mcpServers = groupByMcpServer(toolCosts);
    const anomalies = detectAnomalies(report.topMessages);
    console.log(JSON.stringify({
      ...report,
      toolCosts,
      mcpServers,
      anomalies: anomalies.map(a => ({
        uuid: a.message.uuid,
        model: a.message.model,
        totalTokens: a.totalTokens,
        timesAvg: Math.round(a.timesAvg * 10) / 10,
        promptPreview: a.message.prompt_text?.slice(0, 120) ?? null,
      })),
    }, null, 2));
    return;
  }

  const periodLabel = opts.period === "day" ? "Today" : opts.period ?? "day";
  const dateStr = new Date().toLocaleDateString("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  console.log(`\n\u2500\u2500\u2500 ${t("cli:report.spendingTitle", { period: periodLabel, date: dateStr })} \u2500\u2500\u2500\n`);

  // 1. Total cost by model
  let grandTotal = 0;
  const modelCosts: Array<{ model: string; cost: number; input: number; output: number }> = [];
  for (const row of report.byModel) {
    if (opts.model && !row.model.startsWith(opts.model)) continue;
    const { cost } = estimateCost(row.model, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_creation_tokens);
    grandTotal += cost;
    modelCosts.push({ model: row.model, cost, input: row.input_tokens, output: row.output_tokens });
  }
  modelCosts.sort((a, b) => b.cost - a.cost);

  console.log(`${t("cli:report.spendingTotalCost")}: ${formatCost(grandTotal)}`);
  for (const mc of modelCosts) {
    const pct = grandTotal > 0 ? ((mc.cost / grandTotal) * 100).toFixed(1) : "0.0";
    const name = mc.model.replace(/^claude-/, "").replace(/-\d+$/, m => m);
    console.log(`  ${name.padEnd(14)} ${formatCost(mc.cost).padStart(8)} (${pct}%)  \u2014 ${formatTokens(mc.input)} input, ${formatTokens(mc.output)} output`);
  }

  // 2. Top sessions by cost
  console.log(`\n${t("cli:report.spendingTopSessions")}:`);
  const sessionMsgTotals = store.getMessageTotalsBySession(report.topSessions.map(s => s.session_id));
  const sessionCostMap = new Map<string, number>();
  for (const mt of sessionMsgTotals) {
    const { cost } = estimateCost(mt.model, mt.input_tokens, mt.output_tokens, mt.cache_read_tokens, mt.cache_creation_tokens);
    sessionCostMap.set(mt.session_id, (sessionCostMap.get(mt.session_id) ?? 0) + cost);
  }

  const sortedSessions = [...report.topSessions]
    .map(s => ({ session: s, cost: sessionCostMap.get(s.session_id) ?? 0 }))
    .sort((a, b) => {
      if (opts.sort === "tokens") return (b.session.input_tokens + b.session.output_tokens) - (a.session.input_tokens + a.session.output_tokens);
      if (opts.sort === "prompts") return b.session.prompt_count - a.session.prompt_count;
      return b.cost - a.cost;
    })
    .slice(0, top);

  for (let i = 0; i < sortedSessions.length; i++) {
    const { session: s, cost } = sortedSessions[i]!;
    const project = s.project_path.split("/").pop() ?? s.project_path;
    const dur = s.active_duration_ms ?? (s.last_timestamp && s.first_timestamp ? s.last_timestamp - s.first_timestamp : 0);
    const durStr = dur > 0 ? formatDuration(dur) : "";
    const models: string[] = JSON.parse(s.models) as string[];
    const modelShort = models[0]?.replace("claude-", "").replace(/-\d+-\d+$/, "") ?? "";
    console.log(`  #${i + 1}  ${formatCost(cost).padStart(7)}  ${project.padEnd(20).slice(0, 20)} (${s.prompt_count} prompts${durStr ? ", " + durStr : ""})  ${modelShort}`);
  }

  // 3. Top tools by cost
  const toolCosts = attributeToolCosts(report.topMessages);
  if (toolCosts.length > 0) {
    console.log(`\n${t("cli:report.spendingTopTools")}:`);
    for (const tc of toolCosts.slice(0, top)) {
      const label = tc.isMcp ? tc.tool : tc.tool;
      console.log(`  ${label.padEnd(30).slice(0, 30)} ${formatCost(tc.estimatedCost).padStart(7)} (${tc.invocationCount.toLocaleString()} calls)`);
    }
  }

  // 4. MCP server card
  const mcpServers = groupByMcpServer(toolCosts);
  if (mcpServers.length > 0) {
    console.log(`\n${t("cli:report.spendingMcpServers")}:`);
    for (const s of mcpServers) {
      console.log(`  ${s.server.padEnd(20).slice(0, 20)} ${formatCost(s.estimatedCost).padStart(7)}  (${s.totalCalls} calls, avg ${formatTokens(s.avgTokensPerCall)} tokens/call)`);
    }
  }

  // 5. Expensive prompts (anomalies)
  const anomalies = detectAnomalies(report.topMessages);
  if (anomalies.length > 0) {
    console.log(`\n${t("cli:report.spendingAnomalies")}:`);
    for (let i = 0; i < Math.min(anomalies.length, top); i++) {
      const a = anomalies[i]!;
      const preview = a.message.prompt_text?.slice(0, 60)?.replace(/\n/g, " ") ?? "(no prompt text)";
      const { cost } = estimateCost(
        a.message.model ?? "unknown",
        a.message.input_tokens, a.message.output_tokens,
        a.message.cache_read_tokens, a.message.cache_creation_tokens,
      );
      const modelShort = a.message.model?.replace("claude-", "") ?? "unknown";
      console.log(`  ${i + 1}. "${preview}${a.message.prompt_text && a.message.prompt_text.length > 60 ? "\u2026" : ""}"  \u2014 ${formatTokens(a.totalTokens)} tokens (${formatCost(cost)})  ${modelShort}`);
    }
  }

  // 6. Cache efficiency summary
  if (report.cacheEfficiency.length > 0) {
    let totalHits = 0, totalInput = 0;
    for (const ce of report.cacheEfficiency) {
      totalHits += ce.cache_hits;
      totalInput += ce.uncached_input;
    }
    const hitRate = (totalHits + totalInput) > 0
      ? ((totalHits / (totalHits + totalInput)) * 100).toFixed(1)
      : "0.0";
    // Estimate savings: cache reads are 10% of input cost, so saving is 90%
    let savedEstimate = 0;
    for (const ce of report.cacheEfficiency) {
      // Rough estimate: assume most common model for cache savings
      savedEstimate += (ce.cache_hits / 1_000_000) * 4.50; // avg saving of $4.50/M vs full input
    }
    console.log(`\n${t("cli:report.spendingCacheEfficiency")}: ${hitRate}% hit rate${savedEstimate > 0.01 ? ` (saved ~${formatCost(savedEstimate)})` : ""}`);
  }

  // 7. Subagent overhead
  if (report.subagentCosts.length > 0) {
    let totalSubagentTokens = 0, totalAgents = 0;
    for (const sc of report.subagentCosts) {
      totalSubagentTokens += sc.subagent_tokens;
      totalAgents += sc.subagent_count;
    }
    if (totalAgents > 0) {
      console.log(`${t("cli:report.spendingSubagents")}: ${formatTokens(totalSubagentTokens)} tokens across ${totalAgents} spawned agents`);
    }
  }

  console.log();
}

function highlightMatch(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    text.slice(0, idx) +
    "\x1b[1m" +
    text.slice(idx, idx + query.length) +
    "\x1b[22m" +
    text.slice(idx + query.length)
  );
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "\u2026";
}

export function printSearchResults(results: SearchResult[], query: string): void {
  if (results.length === 0) {
    console.log(t("cli:report.noSessionMatch", { sessionId: query }));
    return;
  }

  console.log(`\n\u2500\u2500\u2500 ${t("cli:report.titleSearch", { query })} \u2500\u2500\u2500\n`);

  for (const r of results) {
    const date = new Date(r.entry.timestamp);
    const ts = date.toISOString().slice(0, 16).replace("T", " ");
    const proj = truncate(r.entry.project, 35);
    const sid = r.entry.sessionId.slice(0, 6);
    const displayText = truncate(r.entry.display, 200);
    const highlighted = highlightMatch(displayText, query);

    console.log(`  ${ts}  ${proj.padEnd(35)}  ${sid}\u2026`);
    console.log(`    ${highlighted}`);
    console.log();
  }

  console.log(t("cli:report.resultsFound", { count: results.length }));
}

export function printSessionList(store: Store, opts: ReportOptions = {}): void {
  const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const since = periodStart(opts.period, tz);

  const rows = store.getSessions({
    projectPath: opts.projectPath,
    repoUrl: opts.repoUrl,
    accountUuid: opts.accountUuid,
    entrypoint: opts.entrypoint,
    tag: opts.tag,
    since: since > 0 ? since : undefined,
    includeCI: opts.includeCI ?? false,
  });

  if (rows.length === 0) {
    console.log(t("cli:report.noSessionsFiltered"));
    return;
  }

  const periodLabel = opts.period ? `${opts.period} (${tz})` : t("common:periods.allTime");
  console.log(`\n\u2500\u2500\u2500 ${t("cli:report.titleSessions", { period: periodLabel })} \u2500\u2500\u2500\n`);

  // Fetch per-session message totals for cost estimation
  const messageTotalsBySession = store.getMessageTotalsBySession(rows.map(r => r.session_id));
  const sessionCostMap = new Map<string, number>();
  for (const mt of messageTotalsBySession) {
    const prev = sessionCostMap.get(mt.session_id) ?? 0;
    const { cost } = estimateCost(mt.model, mt.input_tokens, mt.output_tokens, mt.cache_read_tokens, mt.cache_creation_tokens);
    sessionCostMap.set(mt.session_id, prev + cost);
  }

  const planFee = opts.planFee ?? 0;
  const showCost = sessionCostMap.size > 0;

  const header = showCost
    ? `${t("common:tableHeaders.session").padEnd(10)}  ${t("common:tableHeaders.started").padEnd(19)}  ${t("common:metrics.duration").padStart(8)}  ${t("common:metrics.prompts").padStart(7)}  ${t("common:metrics.input").padStart(8)}  ${t("common:metrics.output").padStart(8)}  ${t("common:metrics.cost").padStart(8)}  ${t("common:tableHeaders.model").padEnd(20)}`
    : `${t("common:tableHeaders.session").padEnd(10)}  ${t("common:tableHeaders.started").padEnd(19)}  ${t("common:metrics.duration").padStart(8)}  ${t("common:metrics.prompts").padStart(7)}  ${t("common:metrics.input").padStart(8)}  ${t("common:metrics.output").padStart(8)}  ${t("common:tableHeaders.model").padEnd(20)}`;
  console.log(header);
  console.log("\u2500".repeat(header.length));

  let totalPrompts = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;

  for (const row of rows) {
    const sid = row.session_id.slice(0, 6) + "\u2026";
    const started = row.first_timestamp
      ? new Date(row.first_timestamp).toISOString().slice(0, 16).replace("T", " ")
      : t("cli:report.unknownTime");
    const durationMs = (row.first_timestamp != null && row.last_timestamp != null)
      ? row.last_timestamp - row.first_timestamp
      : 0;
    const duration = formatDuration(durationMs);
    const models: string[] = JSON.parse(row.models) as string[];
    const modelStr = models.length > 0 ? models[0]! : "";
    const sessionCost = sessionCostMap.get(row.session_id) ?? 0;

    totalPrompts += row.prompt_count;
    totalInput += row.input_tokens;
    totalOutput += row.output_tokens;
    totalCost += sessionCost;

    if (showCost) {
      const costStr = sessionCost > 0 ? formatCost(sessionCost) : "";
      console.log(
        `${sid.padEnd(10)}  ${started.padEnd(19)}  ${duration.padStart(8)}  ${String(row.prompt_count).padStart(7)}  ${formatTokens(row.input_tokens).padStart(8)}  ${formatTokens(row.output_tokens).padStart(8)}  ${costStr.padStart(8)}  ${modelStr.padEnd(20)}`
      );
    } else {
      console.log(
        `${sid.padEnd(10)}  ${started.padEnd(19)}  ${duration.padStart(8)}  ${String(row.prompt_count).padStart(7)}  ${formatTokens(row.input_tokens).padStart(8)}  ${formatTokens(row.output_tokens).padStart(8)}  ${modelStr.padEnd(20)}`
      );
    }
  }

  console.log("\u2500".repeat(header.length));
  if (showCost) {
    const totalLine = `${t("cli:report.sessionSummary", { count: rows.length }).padEnd(10 + 2 + 19 + 2 + 8)}  ${String(totalPrompts).padStart(7)}  ${formatTokens(totalInput).padStart(8)}  ${formatTokens(totalOutput).padStart(8)}  ${formatCost(totalCost).padStart(8)}`;
    console.log(totalLine);
    if (planFee > 0 && totalCost > 0) {
      console.log(`  ${t("cli:report.planValueUsed", { planFee: formatCost(planFee), percent: (totalCost / planFee * 100).toFixed(1) })}`);
    }
  } else {
    console.log(
      `${t("cli:report.sessionSummary", { count: rows.length }).padEnd(10 + 2 + 19 + 2 + 8)}  ${String(totalPrompts).padStart(7)}  ${formatTokens(totalInput).padStart(8)}  ${formatTokens(totalOutput).padStart(8)}`
    );
  }
  console.log();
}

export function printSessionDetail(store: Store, sessionId: string, opts: ReportOptions = {}): void {
  const session = store.findSession(sessionId);
  if (!session) {
    console.log(t("cli:report.noSessionMatch", { sessionId }));
    return;
  }

  const messages = store.getSessionMessages(session.session_id);

  console.log(`\n\u2500\u2500\u2500 ${t("cli:report.titleSessionDetail", { sessionId: session.session_id.slice(0, 6) })} \u2500\u2500\u2500\n`);
  console.log(`${t("cli:report.labelProject").padEnd(9)}: ${session.project_path}`);
  if (session.git_branch) console.log(`${t("cli:report.labelBranch").padEnd(9)}: ${session.git_branch}`);
  if (session.first_timestamp) {
    console.log(`${t("cli:report.labelStarted").padEnd(9)}: ${new Date(session.first_timestamp).toISOString().slice(0, 19).replace("T", " ")}`);
  }
  if (session.first_timestamp != null && session.last_timestamp != null) {
    console.log(`${t("cli:report.labelDuration").padEnd(9)}: ${formatDuration(session.last_timestamp - session.first_timestamp)}`);
  }
  if (session.claude_version) console.log(`${t("cli:report.labelVersion").padEnd(9)}: ${session.claude_version}`);

  if (messages.length === 0) {
    console.log(`\n${t("cli:report.noMessages")}`);
    console.log();
    return;
  }

  console.log();
  const header = `${"#".padStart(3)}  ${t("common:tableHeaders.time").padEnd(5)}  ${t("common:tableHeaders.model").padEnd(16)}  ${t("common:metrics.input").padStart(8)}  ${t("common:metrics.output").padStart(8)}  ${t("common:metrics.cache").padStart(8)}  ${t("common:tableHeaders.stop").padEnd(12)}  ${t("common:tableHeaders.tools")}`;
  console.log(header);
  console.log("\u2500".repeat(header.length + 10));

  let totalInput = 0;
  let totalOutput = 0;
  let totalCache = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const num = String(i + 1).padStart(3);
    const time = msg.timestamp
      ? new Date(msg.timestamp).toISOString().slice(11, 16)
      : "     ";
    const model = msg.model ? msg.model.replace("claude-", "").slice(0, 16) : "";
    const cache = msg.cache_read_tokens + msg.cache_creation_tokens;
    const stop = msg.stop_reason ?? "";
    const tools: string[] = JSON.parse(msg.tools) as string[];
    const toolStr = tools.join(", ");

    totalInput += msg.input_tokens;
    totalOutput += msg.output_tokens;
    totalCache += cache;

    console.log(
      `${num}  ${time.padEnd(5)}  ${model.padEnd(16)}  ${formatTokens(msg.input_tokens).padStart(8)}  ${formatTokens(msg.output_tokens).padStart(8)}  ${formatTokens(cache).padStart(8)}  ${stop.padEnd(12)}  ${toolStr}`
    );
  }

  console.log("\u2500".repeat(header.length + 10));
  console.log(
    `${"".padStart(3)}  ${"".padEnd(5)}  ${t("cli:report.tableTotals").padEnd(16)}  ${formatTokens(totalInput).padStart(8)}  ${formatTokens(totalOutput).padStart(8)}  ${formatTokens(totalCache).padStart(8)}`
  );
  console.log();
}

export function printStatus(info: StatusInfo): void {
  console.log(`\n\u2500\u2500\u2500 ${t("cli:report.titleStatus")} \u2500\u2500\u2500\n`);
  console.log(`${t("cli:status.databaseSize").padEnd(16)}: ${formatBytes(info.dbSize)}`);
  console.log(`${t("cli:status.sessions").padEnd(16)}: ${info.sessionCount}`);
  console.log(`${t("cli:status.messages").padEnd(16)}: ${info.messageCount}`);
  console.log(`${t("cli:status.quarantined").padEnd(16)}: ${info.quarantineCount} ${t("cli:status.unparseableLines")}`);
  console.log(
    `${t("cli:status.lastCollected").padEnd(16)}: ${info.lastCollected ? new Date(info.lastCollected).toLocaleString() : t("cli:status.never")}`
  );
  console.log();
}
