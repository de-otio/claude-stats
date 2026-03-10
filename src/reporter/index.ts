/**
 * Reporter — formats and prints usage summaries.
 * Timestamps are stored as UTC; timezone conversion happens here at report time.
 * See doc/analysis/02-collection-strategy.md — Timezone Handling.
 */
import type { Store, SessionRow, MessageRow, StatusInfo } from "../store/index.js";
import type { SearchResult } from "../history/index.js";
import { estimateCost, formatCost } from "../pricing.js";

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
  console.log(`\n─── ${title} ───\n`);
  const header = `${"".padEnd(labelWidth)}  ${"Sess".padStart(5)}  ${"Prompts".padStart(7)}  ${"Input".padStart(8)}  ${"Output".padStart(8)}`;
  console.log(header);
  console.log("─".repeat(header.length));
  for (const [label, t] of entries) {
    const name = label.length > labelWidth ? "…" + label.slice(-(labelWidth - 1)) : label;
    console.log(
      `${name.padEnd(labelWidth)}  ${String(t.sessions).padStart(5)}  ${String(t.prompts).padStart(7)}  ${formatTokens(t.input).padStart(8)}  ${formatTokens(t.output).padStart(8)}`
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
      const label = `${dateFmt.format(new Date(weekStart))} – ${dateFmt.format(new Date(lastDay))}`;
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
    console.log("No sessions found.");
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
  for (const t of bucketTotals.values()) {
    grandTotal.sessions += t.sessions;
    grandTotal.input += t.input;
    grandTotal.output += t.output;
    grandTotal.prompts += t.prompts;
  }

  // Determine label column header
  const columnLabel = period === "week" ? "Day" : period === "month" ? "Week" : "Month";
  const periodLabel = period === "week" ? "Weekly" : period === "month" ? "Monthly" : "All-Time";

  console.log(`\n─── ${periodLabel} Trend (${tz}) ───\n`);

  // Find max label width
  const labelWidth = Math.max(columnLabel.length, ...buckets.map(b => b.label.length), 5);

  const header = `${columnLabel.padEnd(labelWidth)}  ${"Sessions".padStart(8)}  ${"Prompts".padStart(7)}  ${"Input".padStart(8)}  ${"Output".padStart(8)}`;
  console.log(header);
  console.log("─".repeat(header.length));

  for (const bucket of buckets) {
    const t = bucketTotals.get(bucket)!;
    console.log(
      `${bucket.label.padEnd(labelWidth)}  ${String(t.sessions).padStart(8)}  ${String(t.prompts).padStart(7)}  ${formatTokens(t.input).padStart(8)}  ${formatTokens(t.output).padStart(8)}`
    );
  }

  console.log("─".repeat(header.length));
  console.log(
    `${"Total".padEnd(labelWidth)}  ${String(grandTotal.sessions).padStart(8)}  ${String(grandTotal.prompts).padStart(7)}  ${formatTokens(grandTotal.input).padStart(8)}  ${formatTokens(grandTotal.output).padStart(8)}`
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
    console.log("No sessions found for the given filters.");
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
      ? `${row.account_uuid.slice(0, 8)}… (${row.subscription_type ?? "unknown"})`
      : "(no account data)";
    const at = accountTotals.get(acctKey) ?? makeTotals();
    addRow(at, row);
    accountTotals.set(acctKey, at);

    const ep = row.entrypoint ?? "unknown";
    entrypointCounts.set(ep, (entrypointCounts.get(ep) ?? 0) + 1);

    const models: string[] = JSON.parse(row.models) as string[];
    for (const m of models) modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1);

    const tools: Array<{ name: string; count: number }> = JSON.parse(row.tool_use_counts) as Array<{ name: string; count: number }>;
    for (const t of tools) toolCounts.set(t.name, (toolCounts.get(t.name) ?? 0) + t.count);
  }

  const totalLogicalInput = totalInput + totalCacheCreate + totalCacheRead;
  const cacheEfficiency = totalLogicalInput > 0
    ? ((totalCacheRead / totalLogicalInput) * 100).toFixed(1)
    : "0.0";

  const periodLabel = opts.period
    ? `${opts.period} (${tz})`
    : "all time";

  console.log(`\n─── Claude Stats — ${periodLabel} ───\n`);
  const durationSuffix = totalDurationMs > 0 ? ` (${formatDuration(totalDurationMs)} total)` : "";
  console.log(`Sessions : ${rows.length}${durationSuffix}`);
  console.log(`Prompts  : ${totalPrompts}`);
  console.log(`Input    : ${formatTokens(totalInput)}`);
  console.log(`Output   : ${formatTokens(totalOutput)}`);
  console.log(`Cache    : ${formatTokens(totalCacheRead)} read, ${formatTokens(totalCacheCreate)} created (${cacheEfficiency}% efficiency)`);

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
  let costLine = `Cost     : ~${formatCost(totalCost)} (equivalent API cost)`;
  if (unknownTokens > 0) {
    costLine += ` (${formatTokens(unknownTokens)} tokens from unknown models excluded)`;
  }
  console.log(costLine);

  // Plan ROI — only shown when a plan fee is configured
  const planFee = opts.planFee ?? 0;
  if (planFee > 0) {
    const multiplier = totalCost / planFee;
    console.log(`Plan ROI : ${formatCost(planFee)}/mo plan → ${multiplier.toFixed(1)}× API value received`);
    if (totalPrompts > 0) {
      console.log(`         : ${formatCost(planFee / totalPrompts)}/prompt   ${formatCost(planFee / rows.length)}/session`);
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
    console.log(`Velocity : ${formatTokens(tokPerMin)} tok/min   ${promptsPerHour} prompts/hr   ${formatTokens(outputPerPrompt)} output/prompt`);
  }

  // Throttle events across all sessions
  const totalThrottleEvents = rows.reduce((sum, r) => sum + (r.throttle_events ?? 0), 0);
  if (totalThrottleEvents > 0) {
    console.log(`Throttled: ${totalThrottleEvents} suspected usage-limit truncations detected`);
  }

  if (modelCounts.size > 0) {
    const models = Array.from(modelCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([m, c]) => `${m} (${c})`)
      .join(", ");
    console.log(`Models   : ${models}`);
  }

  if (entrypointCounts.size > 0) {
    const sources = Array.from(entrypointCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([ep, c]) => `${formatEntrypoint(ep)} (${c})`)
      .join(", ");
    console.log(`Source   : ${sources}`);
  }

  if (toolCounts.size > 0) {
    const topTools = Array.from(toolCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([t, c]) => `${t}:${c}`)
      .join("  ");
    console.log(`Top tools: ${topTools}`);
  }

  const sessionIds = rows.map(r => r.session_id);
  const stopReasons = store.getStopReasonCounts(sessionIds);
  if (stopReasons.size > 0) {
    const stops = Array.from(stopReasons.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}:${count}`)
      .join("  ");
    console.log(`Stops    : ${stops}`);
    const maxTokensCount = stopReasons.get("max_tokens") ?? 0;
    if (maxTokensCount > 0) {
      console.log(`  \u26A0  ${maxTokensCount} responses were truncated (max_tokens)`);
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
    console.log(`Thinking : ${totalThinkingBlocks} blocks (${pct}% of sessions)`);
  }

  // By Account: shown when there are multiple accounts and no account filter is active
  if (!opts.accountUuid && accountTotals.size > 1) {
    const sorted = Array.from(accountTotals.entries()).sort((a, b) => b[1].input - a[1].input);
    printTable("By Account", sorted, 50);
  }

  // By Repo: shown when there are multiple repos and no repo filter is active
  if (!opts.repoUrl && repoTotals.size > 1) {
    const sorted = Array.from(repoTotals.entries()).sort((a, b) => b[1].input - a[1].input);
    printTable("By Repo", sorted, 50);
  }

  // By Project: shown when there are multiple projects and no project filter is active
  if (!opts.projectPath && projectTotals.size > 1) {
    const sorted = Array.from(projectTotals.entries()).sort((a, b) => b[1].input - a[1].input);
    printTable("By Project", sorted, 40);
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
    console.log(`No results found for "${query}".`);
    return;
  }

  console.log(`\n\u2500\u2500\u2500 Search: "${query}" \u2500\u2500\u2500\n`);

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

  console.log(`${results.length} results found.`);
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
    console.log("No sessions found for the given filters.");
    return;
  }

  const periodLabel = opts.period ? `${opts.period} (${tz})` : "all time";
  console.log(`\n─── Sessions — ${periodLabel} ───\n`);

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
    ? `${"Session".padEnd(10)}  ${"Started".padEnd(19)}  ${"Duration".padStart(8)}  ${"Prompts".padStart(7)}  ${"Input".padStart(8)}  ${"Output".padStart(8)}  ${"Cost".padStart(8)}  ${"Model".padEnd(20)}`
    : `${"Session".padEnd(10)}  ${"Started".padEnd(19)}  ${"Duration".padStart(8)}  ${"Prompts".padStart(7)}  ${"Input".padStart(8)}  ${"Output".padStart(8)}  ${"Model".padEnd(20)}`;
  console.log(header);
  console.log("─".repeat(header.length));

  let totalPrompts = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;

  for (const row of rows) {
    const sid = row.session_id.slice(0, 6) + "\u2026";
    const started = row.first_timestamp
      ? new Date(row.first_timestamp).toISOString().slice(0, 16).replace("T", " ")
      : "unknown";
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

  console.log("─".repeat(header.length));
  if (showCost) {
    const totalLine = `${(rows.length + " sessions").padEnd(10 + 2 + 19 + 2 + 8)}  ${String(totalPrompts).padStart(7)}  ${formatTokens(totalInput).padStart(8)}  ${formatTokens(totalOutput).padStart(8)}  ${formatCost(totalCost).padStart(8)}`;
    console.log(totalLine);
    if (planFee > 0 && totalCost > 0) {
      console.log(`  Plan: ${formatCost(planFee)}/mo → ${(totalCost / planFee * 100).toFixed(1)}% of plan value used this period`);
    }
  } else {
    console.log(
      `${(rows.length + " sessions").padEnd(10 + 2 + 19 + 2 + 8)}  ${String(totalPrompts).padStart(7)}  ${formatTokens(totalInput).padStart(8)}  ${formatTokens(totalOutput).padStart(8)}`
    );
  }
  console.log();
}

export function printSessionDetail(store: Store, sessionId: string, opts: ReportOptions = {}): void {
  const session = store.findSession(sessionId);
  if (!session) {
    console.log(`No session found matching "${sessionId}".`);
    return;
  }

  const messages = store.getSessionMessages(session.session_id);

  console.log(`\n─── Session ${session.session_id.slice(0, 6)} ───\n`);
  console.log(`Project  : ${session.project_path}`);
  if (session.git_branch) console.log(`Branch   : ${session.git_branch}`);
  if (session.first_timestamp) {
    console.log(`Started  : ${new Date(session.first_timestamp).toISOString().slice(0, 19).replace("T", " ")}`);
  }
  if (session.first_timestamp != null && session.last_timestamp != null) {
    console.log(`Duration : ${formatDuration(session.last_timestamp - session.first_timestamp)}`);
  }
  if (session.claude_version) console.log(`Version  : ${session.claude_version}`);

  if (messages.length === 0) {
    console.log("\nNo messages recorded for this session.");
    console.log();
    return;
  }

  console.log();
  const header = `${"#".padStart(3)}  ${"Time".padEnd(5)}  ${"Model".padEnd(16)}  ${"Input".padStart(8)}  ${"Output".padStart(8)}  ${"Cache".padStart(8)}  ${"Stop".padEnd(12)}  Tools`;
  console.log(header);
  console.log("─".repeat(header.length + 10));

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

  console.log("─".repeat(header.length + 10));
  console.log(
    `${"".padStart(3)}  ${"".padEnd(5)}  ${"Totals".padEnd(16)}  ${formatTokens(totalInput).padStart(8)}  ${formatTokens(totalOutput).padStart(8)}  ${formatTokens(totalCache).padStart(8)}`
  );
  console.log();
}

export function printStatus(info: StatusInfo): void {
  console.log("\n─── Claude Stats Status ───\n");
  console.log(`Database size   : ${formatBytes(info.dbSize)}`);
  console.log(`Sessions        : ${info.sessionCount}`);
  console.log(`Messages        : ${info.messageCount}`);
  console.log(`Quarantined     : ${info.quarantineCount} unparseable lines`);
  console.log(
    `Last collected  : ${info.lastCollected ? new Date(info.lastCollected).toLocaleString() : "never"}`
  );
  console.log();
}
