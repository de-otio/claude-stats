/**
 * HTML dashboard template renderer.
 * Produces a self-contained HTML page with Chart.js charts from DashboardData.
 * Charts are organized into tabs for easier navigation.
 */
import type { DashboardData } from "../dashboard/index.js";
import { PRICING, PRICING_VERIFIED_DATE } from "@claude-stats/core/pricing";
import { formatEnergy, formatCO2, REGIONS } from "@claude-stats/core/energy";

export { DashboardData };

/** Minimal translation function signature accepted by renderDashboard. */
export type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** Default passthrough translator — returns the key as-is (fallback for non-i18n callers). */
const defaultT: TranslateFn = (key: string) => key;

/**
 * Renders a complete self-contained HTML dashboard page.
 * @param t Optional translation function. When omitted, English keys are used via fallback.
 */
export function renderDashboard(data: DashboardData, t: TranslateFn = defaultT): string {
  const generatedDate = data.generated.slice(0, 10);
  const title = t("dashboard:pageTitle", { period: data.period, date: generatedDate });
  const jsonData = JSON.stringify(data);

  const formattedCost = `$${data.summary.estimatedCost.toFixed(2)}`;
  const cacheEff = `${data.summary.cacheEfficiency.toFixed(1)}%`;
  const planFee = data.summary.planFee;
  const showPlan = planFee > 0;
  const planMultiplierStr = data.summary.planMultiplier > 0
    ? `${data.summary.planMultiplier.toFixed(1)}×`
    : "";

  // Build pricing info rows for the cost-related panel
  const pricingRows = Object.entries(PRICING)
    .map(([model, p]) =>
      `<tr><td>${model}</td><td>$${p.inputPerMillion}</td><td>$${p.outputPerMillion}</td><td>$${p.cacheReadPerMillion}</td><td>$${p.cacheWritePerMillion}</td></tr>`)
    .join("\n            ");

  const periods = ["day", "week", "month", "all"] as const;
  const periodOptions = periods
    .map(
      (p) =>
        `<option value="${p}"${data.period === p ? " selected" : ""}>${
          p.charAt(0).toUpperCase() + p.slice(1)
        }</option>`
    )
    .join("\n          ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Courier New', Courier, monospace;
      background: #1a1a2e;
      color: #eee;
      padding: 1.5rem;
      min-height: 100vh;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: #a0c4ff;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }
    .toolbar label { font-size: 0.85rem; color: #aaa; }
    .toolbar select {
      background: #16213e; color: #eee; border: 1px solid #0f3460;
      border-radius: 4px; padding: 0.3rem 0.6rem; font-family: inherit; font-size: 0.85rem; cursor: pointer;
    }
    .toolbar button {
      background: #0f3460; color: #eee; border: 1px solid #1a508b;
      border-radius: 4px; padding: 0.3rem 0.8rem; font-family: inherit; font-size: 0.85rem; cursor: pointer;
    }
    .toolbar button:hover { background: #1a508b; }

    /* ── Tab bar ───────────────────────────────────────────── */
    .tab-bar {
      display: flex; gap: 0; margin-bottom: 1.5rem;
      border-bottom: 2px solid #0f3460;
    }
    .tab-btn {
      background: none; border: none; border-bottom: 2px solid transparent;
      color: #888; font-family: inherit; font-size: 0.8rem;
      padding: 0.5rem 1.2rem; cursor: pointer;
      text-transform: uppercase; letter-spacing: 0.05em;
      margin-bottom: -2px; transition: color 0.15s, border-color 0.15s;
    }
    .tab-btn:hover { color: #ccc; }
    .tab-btn.active { color: #a0c4ff; border-bottom-color: #a0c4ff; }

    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    /* ── Shared layout ────────────────────────────────────── */
    .summary-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 0.75rem; margin-bottom: 1.5rem;
    }
    .summary-card {
      background: #16213e; border: 1px solid #0f3460;
      border-radius: 6px; padding: 0.75rem; text-align: center;
    }
    .summary-card .label {
      font-size: 0.65rem; color: #888; text-transform: uppercase;
      letter-spacing: 0.05em; margin-bottom: 0.3rem;
    }
    .summary-card .value { font-size: 1.2rem; font-weight: 700; color: #a0c4ff; }
    .charts-grid {
      display: grid; grid-template-columns: repeat(2, 1fr); gap: 1.5rem;
    }
    @media (max-width: 768px) { .charts-grid { grid-template-columns: 1fr; } }
    .chart-card {
      background: #16213e; border: 1px solid #0f3460;
      border-radius: 6px; padding: 1rem;
    }
    .chart-card h2 {
      font-size: 0.8rem; text-transform: uppercase;
      letter-spacing: 0.07em; color: #888; margin-bottom: 0.75rem;
    }
    canvas { max-height: 280px; }

    /* ── Pricing info panel ──────────────────────────── */
    .pricing-panel {
      display: none;
      background: #16213e; border: 1px solid #0f3460;
      border-radius: 6px; padding: 0.75rem 1rem;
      margin-bottom: 1.5rem; font-size: 0.7rem;
    }
    .pricing-panel.visible { display: block; }
    .pricing-panel h3 {
      font-size: 0.75rem; color: #a0c4ff; margin-bottom: 0.5rem;
      font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    }
    .pricing-panel table {
      width: 100%; border-collapse: collapse;
    }
    .pricing-panel th, .pricing-panel td {
      padding: 0.25rem 0.5rem; text-align: right;
    }
    .pricing-panel th {
      color: #888; font-size: 0.6rem; text-transform: uppercase;
      letter-spacing: 0.04em; border-bottom: 1px solid #0f3460;
    }
    .pricing-panel td:first-child, .pricing-panel th:first-child {
      text-align: left;
    }
    .pricing-panel td { color: #ccc; }
    .pricing-panel .pricing-source {
      margin-top: 0.5rem; color: #666; font-size: 0.6rem;
    }
    .footer {
      margin-top: 1.5rem; font-size: 0.7rem; color: #555; text-align: center;
    }
  </style>
</head>
<body>
  <h1>${title}</h1>

  <div class="toolbar">
    <label for="period-select">${t("dashboard:toolbar.period")}</label>
    <select id="period-select" onchange="changePeriod(this.value)">
      ${periodOptions}
    </select>
    <button id="refresh-btn" onclick="doRefresh()">${t("dashboard:toolbar.refresh")}</button>
    <button id="autorefresh-btn" onclick="toggleRefresh()" style="font-size:0.75rem; padding:0.3rem 0.6rem;">${t("dashboard:toolbar.autoOff")}</button>
  </div>

  <div class="tab-bar">
    <button class="tab-btn active" data-tab="overview">${t("dashboard:tabs.overview")}</button>
    ${data.energy ? `<button class="tab-btn" data-tab="energy">${t("dashboard:tabs.energy")}</button>` : ""}
    ${data.spending ? `<button class="tab-btn" data-tab="spending">Spending</button>` : ""}
    <button class="tab-btn" data-tab="models">${t("dashboard:tabs.models")}</button>
    <button class="tab-btn" data-tab="projects">${t("dashboard:tabs.projects")}</button>
    <button class="tab-btn" data-tab="sessions">${t("dashboard:tabs.sessions")}</button>
    <button class="tab-btn" data-tab="plan">${t("dashboard:tabs.plan")}</button>
    ${data.contextAnalysis ? `<button class="tab-btn" data-tab="context">${t("dashboard:tabs.context")}</button>` : ""}
    ${data.modelEfficiency ? `<button class="tab-btn" data-tab="efficiency">${t("dashboard:tabs.efficiency")}</button>` : ""}
    <button class="tab-btn" data-tab="settings">${t("dashboard:tabs.settings")}</button>
  </div>

  <!-- ═══════════════ TAB: Overview ═══════════════ -->
  <div class="tab-panel active" id="tab-overview">
    <div class="summary-bar">
      <div class="summary-card" style="grid-column: 1 / -1; text-align: left; padding: 0.5rem 0.75rem;">
        <span style="font-size:0.7rem; color:#888;">${t("dashboard:toolbar.period")} </span>
        <span style="font-size:0.75rem; color:#a0c4ff;">${data.sinceIso ? t("dashboard:summary.periodRange", { start: data.sinceIso }) : t("dashboard:summary.allTime")}</span>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.sessions")}</div>
        <div class="value">${data.summary.sessions}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.prompts")}</div>
        <div class="value">${data.summary.prompts}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.inputTokens")}</div>
        <div class="value">${fmtNum(data.summary.inputTokens)}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.outputTokens")}</div>
        <div class="value">${fmtNum(data.summary.outputTokens)}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.cacheEfficiency")}</div>
        <div class="value">${cacheEff}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.estCost")}</div>
        <div class="value">${formattedCost}</div>
      </div>
      ${showPlan ? `
      <div class="summary-card" style="border-color:#59a14f;">
        <div class="label">${t("dashboard:summary.planValue")}</div>
        <div class="value" style="color:#59a14f;">${planMultiplierStr}</div>
        <div style="font-size:0.6rem;color:#888;margin-top:0.2rem;">${t("dashboard:summary.ofPlanFee", { fee: planFee.toFixed(0) })}</div>
      </div>
      ` : ""}
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.activeHours")}</div>
        <div class="value">${data.summary.totalActiveHours.toFixed(1)}h</div>
      </div>
      ${data.summary.costPerPrompt > 0 ? `
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.costPerPrompt")}</div>
        <div class="value">$${data.summary.costPerPrompt.toFixed(4)}</div>
      </div>
      ` : ""}
      ${data.summary.tokensPerMinute > 0 ? `
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.tokPerMin")}</div>
        <div class="value">${fmtNum(data.summary.tokensPerMinute)}</div>
      </div>
      ` : ""}
      ${data.summary.throttleEvents > 0 ? `
      <div class="summary-card" style="border-color:#e15759;">
        <div class="label">${t("dashboard:summary.throttleEvents")}</div>
        <div class="value" style="color:#e15759;">${data.summary.throttleEvents}</div>
      </div>
      ` : ""}
    </div>

    <div class="charts-grid">
      <div class="chart-card">
        <h2 id="chart-daily-title">${data.period === "day" ? t("dashboard:charts.hourlyTokenUsage") : t("dashboard:charts.dailyTokenUsage")}</h2>
        <canvas id="chart-daily"></canvas>
      </div>
      <div class="chart-card">
        <h2>${t("dashboard:charts.tokenBreakdown")}</h2>
        <canvas id="chart-token-breakdown"></canvas>
      </div>
      <div class="chart-card">
        <h2>${t("dashboard:charts.cacheUsage")}</h2>
        <canvas id="chart-cache"></canvas>
      </div>
      <div class="chart-card" style="grid-column: 1 / -1;">
        <h2>${t("dashboard:charts.cumulativeApiValue")}</h2>
        <canvas id="chart-cumulative"></canvas>
      </div>
    </div>
  </div>

  <!-- ═══════════════ TAB: Models ═══════════════ -->
  <div class="tab-panel" id="tab-models">
    <div class="charts-grid">
      <div class="chart-card">
        <h2>${t("dashboard:charts.tokensByModel")}</h2>
        <canvas id="chart-model"></canvas>
      </div>
      <div class="chart-card">
        <h2>${t("dashboard:charts.stopReasons")}</h2>
        <canvas id="chart-stops"></canvas>
      </div>
    </div>
  </div>

  <!-- ═══════════════ TAB: Projects ═══════════════ -->
  <div class="tab-panel" id="tab-projects">
    <div class="charts-grid">
      <div class="chart-card">
        <h2>${t("dashboard:charts.topProjects")}</h2>
        <canvas id="chart-project"></canvas>
      </div>
      <div class="chart-card">
        <h2>${t("dashboard:charts.sessionsByEntrypoint")}</h2>
        <canvas id="chart-entrypoint"></canvas>
      </div>
    </div>
  </div>

  <!-- ═══════════════ TAB: Sessions ═══════════════ -->
  <div class="tab-panel" id="tab-sessions">
    <div class="charts-grid">
      ${data.byWindow.length > 0 ? `
      <div class="chart-card" style="grid-column: 1 / -1;">
        <h2>${t("dashboard:charts.usageWindows")}</h2>
        <canvas id="chart-windows"></canvas>
      </div>
      ` : ""}
      ${data.byConversationCost.length > 0 ? `
      <div class="chart-card" style="grid-column: 1 / -1;">
        <h2>${t("dashboard:charts.topConversations")}</h2>
        <canvas id="chart-conv-cost"></canvas>
      </div>
      ` : ""}
    </div>
  </div>

  <!-- ═══════════════ TAB: Plan ═══════════════ -->
  <div class="tab-panel" id="tab-plan">
    ${data.planUtilization ? (() => {
      const pu = data.planUtilization!;
      const hasPlanBudget = pu.weeklyPlanBudget > 0;
      const verdictColor = pu.currentPlanVerdict === 'good-value' ? '#59a14f' : pu.currentPlanVerdict === 'underusing' ? '#f28e2b' : '#888';
      const verdictLabel = pu.currentPlanVerdict === 'good-value' ? t("dashboard:plan.goodValue") : pu.currentPlanVerdict === 'underusing' ? t("dashboard:plan.underusing") : t("dashboard:plan.noPlanDetected");
      const feeSource = showPlan ? t("dashboard:plan.feeManual", { fee: String(planFee) }) : hasPlanBudget ? t("dashboard:plan.feeAutoDetected", { fee: (pu.weeklyPlanBudget * 4.33).toFixed(0) }) : '';
      const multiAccount = pu.byAccount.length > 1;
      return `
    <div class="summary-bar" style="margin-bottom:1rem;">
      ${(() => {
        const planLabels: Record<string, string> = { pro: 'Pro', max_5x: 'Max 5x', max_20x: 'Max 20x', team_standard: 'Team Standard', team_premium: 'Team Premium' };
        // Always show accounts — prefer email over UUID
        const accounts = pu.byAccount.filter(a => a.accountId !== '(unknown)');
        if (accounts.length > 0) {
          return accounts.map(a => {
            const displayName = a.emailAddress || a.accountId;
            const planName = a.subscriptionType ? (planLabels[a.subscriptionType] || a.subscriptionType) : null;
            return `
      <div class="summary-card" style="border-color:#4e79a7;">
        <div class="label">${t("dashboard:plan.account")}</div>
        <div class="value" style="font-size:0.8rem;color:#4e79a7;">${displayName}</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${planName ? planName + (a.detectedPlanFee ? ` ($${a.detectedPlanFee}/mo)` : '') : t("dashboard:plan.planNotDetected")}</div>
      </div>`;
          }).join('');
        }
        // No known accounts — show inferred plan from fee if available
        if (hasPlanBudget) {
          const monthly = Math.round(pu.weeklyPlanBudget * 4.33);
          const feeMap: Record<number, string> = { 20: 'Pro', 25: 'Team Standard', 100: 'Max 5x', 125: 'Team Premium', 200: 'Max 20x' };
          const planName = feeMap[monthly] || 'Custom';
          return `
      <div class="summary-card" style="border-color:#4e79a7;">
        <div class="label">${t("dashboard:plan.currentPlan")}</div>
        <div class="value" style="font-size:0.85rem;color:#4e79a7;">${planName} ($${monthly}/mo)</div>
        ${feeSource ? `<div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${feeSource}</div>` : ''}
      </div>`;
        }
        return '';
      })()}
      <div class="summary-card" style="border-color:${verdictColor};">
        <div class="label">${t("dashboard:plan.planVerdict")}</div>
        <div class="value" style="font-size:0.95rem;color:${verdictColor};">${verdictLabel}</div>
        ${!hasPlanBudget ? `<div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${t("dashboard:plan.setPlanFee")}</div>` : ''}
      </div>
      ${pu.recommendedPlan ? `
      <div class="summary-card" style="border-color:#b07aa1;">
        <div class="label">${t("dashboard:plan.suggestedPlan")}</div>
        <div class="value" style="font-size:0.95rem;color:#b07aa1;">${t(`dashboard:plan.planNames.${pu.recommendedPlan!}`, { defaultValue: pu.recommendedPlan })}</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${t("dashboard:plan.basedOnAvg", { value: pu.avgWeeklyCost.toFixed(2) })}</div>
      </div>
      ` : ''}
      <div class="summary-card">
        <div class="label">${t("dashboard:plan.avgWeeklyValue")}</div>
        <div class="value">$${pu.avgWeeklyCost.toFixed(2)}</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${t("dashboard:plan.peakLabel", { value: pu.peakWeeklyCost.toFixed(2) })}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:plan.windowsPerWeek")}</div>
        <div class="value">${pu.windowsPerWeek.toFixed(1)}</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${t("dashboard:plan.totalWindows", { count: pu.totalWindows })}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:plan.avgWindowCost")}</div>
        <div class="value">$${pu.avgWindowCost.toFixed(2)}</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${t("dashboard:plan.medianLabel", { value: pu.medianWindowCost.toFixed(2) })}</div>
      </div>
      ${pu.throttledWindowPercent > 0 ? `
      <div class="summary-card" style="border-color:#e15759;">
        <div class="label">${t("dashboard:plan.throttledWindows")}</div>
        <div class="value" style="color:#e15759;">${pu.throttledWindowPercent}%</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${t("dashboard:plan.hittingLimits")}</div>
      </div>
      ` : ''}
    </div>

    ${multiAccount ? `
    <div class="summary-bar" style="margin-bottom:1rem;">
      <div class="summary-card" style="grid-column: 1 / -1; text-align: left; padding: 0.5rem 0.75rem;">
        <span style="font-size:0.7rem; color:#888;">${t("dashboard:plan.accounts")} </span>
        <span style="font-size:0.75rem; color:#a0c4ff;">${t("dashboard:plan.accountsDetected", { count: pu.byAccount.length })}</span>
      </div>
      ${pu.byAccount.map(acct => {
        const acctVerdictColor = acct.planVerdict === 'good-value' ? '#59a14f' : acct.planVerdict === 'underusing' ? '#f28e2b' : '#888';
        const acctDisplayName = acct.emailAddress || acct.accountId;
        return `
      <div class="summary-card" style="border-color:${acctVerdictColor};">
        <div class="label">${acctDisplayName}</div>
        <div class="value" style="font-size:0.85rem;">$${acct.estimatedCost.toFixed(2)}</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${acct.subscriptionType ?? t("dashboard:plan.unknownPlan")} &bull; ${acct.sessions} sessions${acct.detectedPlanFee ? ` &bull; $${acct.detectedPlanFee}/mo` : ''}</div>
        <div style="font-size:0.55rem;color:${acctVerdictColor};margin-top:0.1rem;">${acct.planVerdict === 'good-value' ? t("dashboard:plan.goodValue") : acct.planVerdict === 'underusing' ? t("dashboard:plan.underusing") : t("dashboard:plan.noPlan")}</div>
      </div>`;
      }).join('')}
    </div>
    ` : ''}

    <div class="charts-grid">
      ${data.byWindow.length > 0 ? `
      <div class="chart-card" style="grid-column: 1 / -1;">
        <h2>${t("dashboard:charts.windowLimitUsage")}</h2>
        <canvas id="chart-window-limit-pct"></canvas>
      </div>
      ` : ''}
      <div class="chart-card" style="grid-column: 1 / -1;">
        <h2>${t("dashboard:charts.weeklyActivity")}</h2>
        <canvas id="chart-weekly-activity"></canvas>
      </div>
      ${data.byWindow.length > 0 ? `
      <div class="chart-card">
        <h2>${t("dashboard:charts.windowsPerWeek")}</h2>
        <canvas id="chart-windows-per-week"></canvas>
      </div>
      ` : ''}
      ${hasPlanBudget ? `
      <div class="chart-card" style="grid-column: 1 / -1;">
        <h2>${t("dashboard:charts.weeklyPlanUtilization")}</h2>
        <canvas id="chart-weekly-util-rate"></canvas>
      </div>
      ` : ''}
    </div>
    `;
    })() : `
    <div class="summary-bar">
      <div class="summary-card" style="grid-column: 1 / -1;">
        <div class="label">${t("dashboard:plan.noData")}</div>
        <div class="value" style="font-size:0.85rem;">${t("dashboard:plan.notEnoughData")}</div>
      </div>
    </div>
    `}
  </div>

  <!-- ═══════════════ TAB: Context ═══════════════ -->
  ${data.contextAnalysis ? `
  <div class="tab-panel" id="tab-context">
    <div class="summary-bar" style="margin-bottom:1rem;">
      <div class="summary-card">
        <div class="label">${t("dashboard:context.avgPromptsPerSession")}</div>
        <div class="value">${data.contextAnalysis.avgPromptsPerSession}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:context.medianPrompts")}</div>
        <div class="value">${data.contextAnalysis.medianPromptsPerSession}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:context.compactionRate")}</div>
        <div class="value">${data.contextAnalysis.compactionRate}%</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:context.avgPeakInputTokens")}</div>
        <div class="value">${(data.contextAnalysis.avgPeakInputTokens / 1000).toFixed(0)}K</div>
      </div>
      <div class="summary-card" style="${data.contextAnalysis.sessionsNeedingCompaction > 0 ? 'border-color:#e15759;' : ''}">
        <div class="label">${t("dashboard:context.needCompaction")}</div>
        <div class="value" style="${data.contextAnalysis.sessionsNeedingCompaction > 0 ? 'color:#e15759;' : ''}">${data.contextAnalysis.sessionsNeedingCompaction}</div>
      </div>
    </div>

    <div class="charts-grid">
      <div class="chart-card">
        <h2>${t("dashboard:charts.conversationLengthDist")}</h2>
        <canvas id="chart-length-dist"></canvas>
      </div>
      <div class="chart-card">
        <h2>${t("dashboard:charts.contextGrowthCurve")}</h2>
        <canvas id="chart-context-growth"></canvas>
      </div>
      <div class="chart-card">
        <h2>${t("dashboard:charts.cacheEfficiencyByLength")}</h2>
        <canvas id="chart-cache-by-length"></canvas>
      </div>
      <div class="chart-card">
        <h2>${t("dashboard:charts.compactionEvents")}</h2>
        ${data.contextAnalysis.compactionEvents.length > 0 ? `
        <div style="text-align:center; padding:1.5rem 0;">
          <div style="font-size:2.5rem; font-weight:700; color:#4e79a7;">${data.contextAnalysis.compactionEvents.length}</div>
          <div style="font-size:0.75rem; color:#888; margin-top:0.25rem;">${t("dashboard:context.compactionsDetected", { count: new Set(data.contextAnalysis.compactionEvents.map(e => e.sessionId)).size })}</div>
        </div>
        ` : `<p style="color:#888; font-size:0.8rem; text-align:center; padding:2rem 0;">${t("dashboard:context.noCompactionEvents")}</p>`}
      </div>
    </div>

    ${data.contextAnalysis.longSessions.length > 0 ? `
    <div class="chart-card" style="margin-top:1.5rem;">
      <h2>${t("dashboard:charts.longSessions")}</h2>
      <div style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse; font-size:0.75rem;">
          <thead>
            <tr style="border-bottom:1px solid #0f3460;">
              <th style="text-align:left; padding:0.4rem; color:#888;">${t("dashboard:context.tableHeaders.project")}</th>
              <th style="text-align:right; padding:0.4rem; color:#888;">${t("dashboard:context.tableHeaders.prompts")}</th>
              <th style="text-align:right; padding:0.4rem; color:#888;">${t("dashboard:context.tableHeaders.duration")}</th>
              <th style="text-align:right; padding:0.4rem; color:#888;">${t("dashboard:context.tableHeaders.peakInput")}</th>
              <th style="text-align:center; padding:0.4rem; color:#888;">${t("dashboard:context.tableHeaders.compacted")}</th>
              <th style="text-align:right; padding:0.4rem; color:#888;">${t("dashboard:context.tableHeaders.cost")}</th>
            </tr>
          </thead>
          <tbody>
            ${data.contextAnalysis.longSessions.map(s => `
            <tr style="border-bottom:1px solid #0f346033;">
              <td style="padding:0.4rem; color:#ccc; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${s.projectPath}">${s.projectPath.split('/').slice(-2).join('/')}</td>
              <td style="text-align:right; padding:0.4rem; color:#a0c4ff;">${s.promptCount}</td>
              <td style="text-align:right; padding:0.4rem; color:#ccc;">${s.durationMinutes}m</td>
              <td style="text-align:right; padding:0.4rem; color:#ccc;">${(s.peakInputTokens / 1000).toFixed(0)}K</td>
              <td style="text-align:center; padding:0.4rem;">${s.compacted ? `<span style="color:#59a14f;">${t("dashboard:context.tableHeaders.yes")}</span>` : `<span style="color:#e15759;">${t("dashboard:context.tableHeaders.no")}</span>`}</td>
              <td style="text-align:right; padding:0.4rem; color:#f28e2b;">$${s.estimatedCost.toFixed(2)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}
  </div>
  ` : ''}

  <!-- ═══════════════ TAB: Efficiency ═══════════════ -->
  ${data.modelEfficiency ? `
  <div class="tab-panel" id="tab-efficiency">
    <div class="summary-bar" style="margin-bottom:1rem;">
      <div class="summary-card" style="border-color:#b07aa1;">
        <div class="label">${t("dashboard:efficiency.potentialSavings")}</div>
        <div class="value" style="color:#59a14f;">$${data.modelEfficiency.summary.potentialSavings.toFixed(2)}</div>
      </div>
      <div class="summary-card" style="border-color:#b07aa1;">
        <div class="label">${t("dashboard:efficiency.overuseRate")}</div>
        <div class="value" style="color:#e15759;">${data.modelEfficiency.summary.overusePercent}%</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${t("dashboard:efficiency.overuseDescription")}</div>
      </div>
      <div class="summary-card" style="border-color:#b07aa1;">
        <div class="label">${t("dashboard:efficiency.turnsAnalyzed")}</div>
        <div class="value">${data.modelEfficiency.summary.classifiedMessages}</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${t("dashboard:efficiency.ofTotalMessages", { count: data.modelEfficiency.summary.totalMessages })}</div>
      </div>
    </div>

    <div class="charts-grid">
      <div class="chart-card">
        <h2>${t("dashboard:charts.modelUsageByTier")}</h2>
        <canvas id="chart-efficiency-tiers"></canvas>
      </div>
      <div class="chart-card">
        <h2>${t("dashboard:charts.opusScoreDist")}</h2>
        <canvas id="chart-opus-scores"></canvas>
      </div>
      ${data.modelEfficiency.topOveruse.length > 0 ? `
      <div class="chart-card" style="grid-column: 1 / -1;">
        <h2>${t("dashboard:charts.topOveruse")}</h2>
        <canvas id="chart-overuse"></canvas>
      </div>
      ` : ""}
    </div>
  </div>
  ` : ""}

  <!-- ═══════════════ TAB: Spending ═══════════════ -->
  ${data.spending ? `
  <div class="tab-panel" id="tab-spending">
    <div class="summary-bar" style="margin-bottom:1rem;">
      <div class="summary-card" style="border-color:#e15759;">
        <div class="label">Cache Hit Rate</div>
        <div class="value">${data.spending.cacheEfficiency.overallHitRate}%</div>
      </div>
      <div class="summary-card" style="border-color:#59a14f;">
        <div class="label">Cache Savings</div>
        <div class="value" style="color:#59a14f;">$${data.spending.cacheEfficiency.estimatedSavings.toFixed(2)}</div>
      </div>
      ${data.spending.subagentOverhead.agentCount > 0 ? `
      <div class="summary-card" style="border-color:#f28e2b;">
        <div class="label">Subagent Overhead</div>
        <div class="value">${data.spending.subagentOverhead.agentCount} agents</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">~$${data.spending.subagentOverhead.totalCost.toFixed(2)}</div>
      </div>` : ""}
    </div>

    <div class="charts-grid">
      <div class="chart-card">
        <h2>Cost by Model</h2>
        <canvas id="chart-spending-models"></canvas>
      </div>
      <div class="chart-card">
        <h2>Top Tools by Cost</h2>
        <canvas id="chart-spending-tools"></canvas>
      </div>
    </div>

    ${data.spending.topSessionsByCost.length > 0 ? `
    <div class="chart-card" style="margin-top:1rem;">
      <h2>Top Sessions by Cost</h2>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.7rem;">
          <thead><tr style="border-bottom:1px solid #333;">
            <th style="text-align:left;padding:0.4rem;">Project</th>
            <th style="text-align:right;padding:0.4rem;">Cost</th>
            <th style="text-align:right;padding:0.4rem;">Prompts</th>
            <th style="text-align:left;padding:0.4rem;">Model</th>
          </tr></thead>
          <tbody>
            ${data.spending.topSessionsByCost.map(s => `
            <tr style="border-bottom:1px solid #222;">
              <td style="padding:0.4rem;" title="${s.projectPath}">${s.projectPath}</td>
              <td style="text-align:right;padding:0.4rem;color:#59a14f;">$${s.estimatedCost.toFixed(2)}</td>
              <td style="text-align:right;padding:0.4rem;">${s.promptCount}</td>
              <td style="padding:0.4rem;font-size:0.6rem;color:#888;">${s.dominantModel.replace("claude-", "")}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>` : ""}

    ${data.spending.expensivePrompts.length > 0 ? `
    <div class="chart-card" style="margin-top:1rem;">
      <h2>Expensive Prompts</h2>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.7rem;">
          <thead><tr style="border-bottom:1px solid #333;">
            <th style="text-align:left;padding:0.4rem;">Prompt</th>
            <th style="text-align:right;padding:0.4rem;">Tokens</th>
            <th style="text-align:right;padding:0.4rem;">Cost</th>
            <th style="text-align:right;padding:0.4rem;">x Avg</th>
            <th style="text-align:left;padding:0.4rem;">Flags</th>
          </tr></thead>
          <tbody>
            ${data.spending.expensivePrompts.map(p => `
            <tr style="border-bottom:1px solid #222;">
              <td style="padding:0.4rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.promptPreview || "(no text)"}</td>
              <td style="text-align:right;padding:0.4rem;">${(p.totalTokens / 1000).toFixed(0)}K</td>
              <td style="text-align:right;padding:0.4rem;color:#59a14f;">$${p.estimatedCost.toFixed(2)}</td>
              <td style="text-align:right;padding:0.4rem;color:#e15759;">${p.timesAvg}x</td>
              <td style="padding:0.4rem;">${p.flags.map(f => `<span style="background:#333;padding:0.1rem 0.3rem;border-radius:3px;font-size:0.6rem;margin-right:0.2rem;">${f}</span>`).join("")}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>` : ""}

    ${data.spending.mcpServerUsage && data.spending.mcpServerUsage.length > 0 ? `
    <div class="chart-card" style="margin-top:1rem;">
      <h2>MCP Server Token Usage</h2>
      <canvas id="chart-mcp-servers" style="margin-bottom:1rem;"></canvas>
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.7rem;">
          <thead><tr style="border-bottom:1px solid #333;">
            <th style="text-align:left;padding:0.4rem;">Server</th>
            <th style="text-align:right;padding:0.4rem;">Cost</th>
            <th style="text-align:right;padding:0.4rem;">Input</th>
            <th style="text-align:right;padding:0.4rem;">Output</th>
            <th style="text-align:right;padding:0.4rem;">Calls</th>
            <th style="text-align:right;padding:0.4rem;">Messages</th>
            <th style="text-align:left;padding:0.4rem;">Top Methods</th>
          </tr></thead>
          <tbody>
            ${data.spending.mcpServerUsage.map(s => `
            <tr style="border-bottom:1px solid #222;">
              <td style="padding:0.4rem;font-weight:600;">${s.server}</td>
              <td style="text-align:right;padding:0.4rem;color:#59a14f;">$${s.estimatedCost.toFixed(2)}</td>
              <td style="text-align:right;padding:0.4rem;">${s.inputTokens >= 1000000 ? (s.inputTokens/1000000).toFixed(1)+'M' : s.inputTokens >= 1000 ? Math.round(s.inputTokens/1000)+'K' : s.inputTokens}</td>
              <td style="text-align:right;padding:0.4rem;">${s.outputTokens >= 1000000 ? (s.outputTokens/1000000).toFixed(1)+'M' : s.outputTokens >= 1000 ? Math.round(s.outputTokens/1000)+'K' : s.outputTokens}</td>
              <td style="text-align:right;padding:0.4rem;">${s.callCount}</td>
              <td style="text-align:right;padding:0.4rem;">${s.messageCount}</td>
              <td style="padding:0.4rem;font-size:0.6rem;color:#aaa;">${s.tools.slice(0, 3).map(t => t.method + '(' + t.calls + ')').join(', ')}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>` : ""}
  </div>
  ` : ""}

  <!-- ═══════════════ TAB: Energy ═══════════════ -->
  ${data.energy ? `
  <div class="tab-panel" id="tab-energy">
    <div class="summary-bar">
      <div class="summary-card">
        <div class="label">${t("dashboard:energy.totalEnergy")}</div>
        <div class="value">${formatEnergy(data.energy.totalEnergyWh)}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:energy.totalCO2")}</div>
        <div class="value">${formatCO2(data.energy.totalCO2Grams)}</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${t("dashboard:energy.co2Range", { low: formatCO2(data.energy.co2GramsLow), high: formatCO2(data.energy.co2GramsHigh) })}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:energy.region")}</div>
        <div class="value" style="font-size:0.75rem;">${data.energy.region}</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${data.energy.gridIntensity} ${t("dashboard:energy.gCO2perKWh")}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:energy.cacheSaved")}</div>
        <div class="value" style="color:#59a14f;">${formatEnergy(data.energy.cacheImpact.energySavedWh)}</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${t("dashboard:energy.energySavedLabel")}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:energy.geoCoverage")}</div>
        <div class="value">${data.energy.inferenceGeo.coveragePct.toFixed(1)}%</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${t("dashboard:energy.geoCoverageHint")}</div>
      </div>
    </div>

    <!-- Environmental equivalents -->
    <div style="background:#1a1f3a;border-radius:6px;padding:1rem;margin-bottom:1rem;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin:0 0 0.75rem 0;">
        <h2 style="margin:0;font-size:0.85rem;color:#a0c4ff;">${t("dashboard:energy.equivalents")}</h2>
        <span style="font-size:0.65rem;color:#888;">${t("dashboard:energy.periodRange", { start: data.energy.periodStartIso, end: data.energy.periodEndIso, days: data.energy.periodDays })}</span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:1rem;">
        <div style="flex:1;min-width:140px;background:#0f1429;border-radius:4px;padding:0.6rem;text-align:center;">
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${data.energy.equivalents.gasolineLiters.toFixed(3)}</div>
          <div style="font-size:0.65rem;color:#888;">${t("dashboard:energy.gasolineLiters")}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#0f1429;border-radius:4px;padding:0.6rem;text-align:center;">
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${formatSolarArea(data.energy.equivalents.solarPanelM2)}<sup style="font-size:0.7rem;color:#8ec07c;">†</sup></div>
          <div style="font-size:0.65rem;color:#888;">${t("dashboard:energy.solarPanels")}</div>
          <div style="font-size:0.55rem;color:#666;margin-top:0.15rem;">${t("dashboard:energy.solarRegion", { region: REGIONS[data.energy.equivalents.solarRegionKey]?.name ?? data.energy.equivalents.solarRegionKey })}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#0f1429;border-radius:4px;padding:0.6rem;text-align:center;">
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${data.energy.equivalents.nuclearWasteMg.toFixed(2)}<sup style="font-size:0.7rem;color:#ffb347;">*</sup></div>
          <div style="font-size:0.65rem;color:#888;">${t("dashboard:energy.nuclearWaste")}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#0f1429;border-radius:4px;padding:0.6rem;text-align:center;">
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${data.energy.equivalents.coffeeCups.toFixed(2)}</div>
          <div style="font-size:0.65rem;color:#888;">${t("dashboard:energy.coffeeCups")}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#0f1429;border-radius:4px;padding:0.6rem;text-align:center;">
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${data.energy.equivalents.transitKm.toFixed(2)}</div>
          <div style="font-size:0.65rem;color:#888;">${t("dashboard:energy.transitKm")}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#0f1429;border-radius:4px;padding:0.6rem;text-align:center;">
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${data.energy.equivalents.trainKm.toFixed(2)}</div>
          <div style="font-size:0.65rem;color:#888;">${t("dashboard:energy.trainKm")}</div>
        </div>
      </div>
      <div style="margin-top:0.6rem;font-size:0.6rem;color:#888;line-height:1.35;">
        ${t("dashboard:energy.journeyAnchor", { name: t(`dashboard:energy.journeys.${data.energy.journeyAnchor.key}`), km: data.energy.journeyAnchor.km })}
      </div>
      <div style="margin-top:0.35rem;font-size:0.6rem;color:#888;line-height:1.35;">
        <span style="color:#8ec07c;">†</span> ${t("dashboard:energy.solarPanelsFootnote", { region: REGIONS[data.energy.equivalents.solarRegionKey]?.name ?? data.energy.equivalents.solarRegionKey })}
      </div>
      <div style="margin-top:0.35rem;font-size:0.6rem;color:#888;line-height:1.35;">
        <span style="color:#ffb347;">*</span> ${t("dashboard:energy.nuclearWasteFootnote")}
      </div>
    </div>

    <!-- Charts: daily energy + energy by model -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:1rem;margin-bottom:1rem;">
      <div style="background:#1a1f3a;border-radius:6px;padding:1rem;">
        <h2 style="margin:0 0 0.5rem 0;font-size:0.85rem;color:#a0c4ff;">${t("dashboard:energy.byDay")}</h2>
        <canvas id="energy-day-chart" height="180"></canvas>
      </div>
      <div style="background:#1a1f3a;border-radius:6px;padding:1rem;">
        <h2 style="margin:0 0 0.5rem 0;font-size:0.85rem;color:#a0c4ff;">${t("dashboard:energy.byModel")}</h2>
        <canvas id="energy-model-chart" height="180"></canvas>
      </div>
    </div>

    <!-- By project table -->
    ${data.energy.byProject.length > 0 ? `
    <div style="background:#1a1f3a;border-radius:6px;padding:1rem;margin-bottom:1rem;">
      <h2 style="margin:0 0 0.75rem 0;font-size:0.85rem;color:#a0c4ff;">${t("dashboard:energy.byProject")}</h2>
      <table style="width:100%;border-collapse:collapse;font-size:0.75rem;">
        <thead><tr>
          <th style="text-align:left;padding:0.4rem;color:#888;">Project</th>
          <th style="text-align:right;padding:0.4rem;color:#888;">Energy</th>
          <th style="text-align:right;padding:0.4rem;color:#888;">CO₂</th>
        </tr></thead>
        <tbody>
          ${data.energy.byProject.slice(0, 10).map((p, i) => `
          <tr style="${i % 2 === 0 ? "background:#0f1429;" : ""}">
            <td style="padding:0.4rem;color:#ccc;overflow:hidden;text-overflow:ellipsis;max-width:240px;white-space:nowrap;">${p.project}</td>
            <td style="padding:0.4rem;text-align:right;color:#fff;">${formatEnergy(p.energyWh)}</td>
            <td style="padding:0.4rem;text-align:right;color:#aaa;">${formatCO2(p.co2Grams)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>` : ""}

    <!-- Data sources -->
    <div style="background:#1a1f3a;border-radius:6px;padding:1rem;margin-top:1rem;">
      <h2 style="margin:0 0 0.6rem 0;font-size:0.85rem;color:#a0c4ff;">${t("dashboard:energy.sources.title")}</h2>
      <ul style="list-style:none;padding:0;margin:0;font-size:0.65rem;color:#aaa;line-height:1.5;">
        ${[
          "methodology", "pue", "gridIntensity", "solarYield",
          "carKm", "transit", "train", "tree", "gasoline", "coffee", "nuclearWaste",
        ].map(k => `<li style="padding:0.15rem 0;"><span style="color:#a0c4ff;font-weight:600;">${t(`dashboard:energy.sources.items.${k}.label`)}:</span> ${t(`dashboard:energy.sources.items.${k}.value`)}</li>`).join("")}
      </ul>
    </div>

    <!-- Disclaimer -->
    <p style="font-size:0.6rem;color:#666;text-align:center;margin-top:0.5rem;">${t("dashboard:energy.disclaimer")}</p>
  </div>
  ` : ""}

  <!-- ═══════════════ TAB: Settings ═══════════════ -->
  <div class="tab-panel" id="tab-settings">
    <div class="summary-bar" style="margin-bottom:1rem;">
      <div class="summary-card" style="grid-column: 1 / -1; text-align: left; padding: 1rem;">
        <h2 style="margin:0 0 0.75rem 0; font-size:1rem; color:#a0c4ff;">${t("dashboard:settings.configuration")}</h2>
        <p style="font-size:0.75rem; color:#aaa; margin:0 0 1rem 0;">${t("dashboard:settings.settingsPath")}</p>

        <form id="settings-form" style="display:flex; flex-direction:column; gap:1rem; max-width:400px;">
          <div>
            <label style="display:block; font-size:0.75rem; color:#ccc; margin-bottom:0.3rem;">${t("dashboard:settings.planType")}</label>
            <select id="cfg-plan-type" style="width:100%; padding:0.4rem; background:#16213e; color:#eee; border:1px solid #0f3460; border-radius:4px; font-size:0.8rem;">
              <option value="">${t("dashboard:settings.notSetAutoDetect")}</option>
              <option value="pro">${t("dashboard:settings.planOptions.pro")}</option>
              <option value="max_5x">${t("dashboard:settings.planOptions.max_5x")}</option>
              <option value="max_20x">${t("dashboard:settings.planOptions.max_20x")}</option>
              <option value="team_standard">${t("dashboard:settings.planOptions.team_standard")}</option>
              <option value="team_premium">${t("dashboard:settings.planOptions.team_premium")}</option>
              <option value="custom">${t("dashboard:settings.planOptions.custom")}</option>
            </select>
            <div style="font-size:0.6rem; color:#999; margin-top:0.2rem;">${t("dashboard:settings.planAutoDetectHint")}</div>
          </div>
          <div>
            <label style="display:block; font-size:0.75rem; color:#ccc; margin-bottom:0.3rem;">${t("dashboard:settings.monthlyFee")}</label>
            <input id="cfg-monthly-fee" type="number" min="0" step="1" placeholder="${t("dashboard:settings.monthlyFeePlaceholder")}" style="width:100%; padding:0.4rem; background:#16213e; color:#eee; border:1px solid #0f3460; border-radius:4px; font-size:0.8rem; box-sizing:border-box;">
            <div style="font-size:0.6rem; color:#999; margin-top:0.2rem;">${t("dashboard:settings.monthlyFeeHint")}</div>
          </div>

          <div style="border-top:1px solid #2a2a4a; padding-top:1rem; margin-top:0.5rem;">
            <label style="display:block; font-size:0.75rem; color:#ccc; margin-bottom:0.5rem;">${t("dashboard:settings.costAlertThresholds")}</label>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:0.5rem;">
              <div>
                <label style="display:block; font-size:0.65rem; color:#aaa; margin-bottom:0.2rem;">${t("dashboard:settings.daily")}</label>
                <input id="cfg-threshold-day" type="number" min="0" step="0.01" placeholder="—" style="width:100%; padding:0.3rem; background:#16213e; color:#eee; border:1px solid #0f3460; border-radius:4px; font-size:0.75rem; box-sizing:border-box;">
              </div>
              <div>
                <label style="display:block; font-size:0.65rem; color:#aaa; margin-bottom:0.2rem;">${t("dashboard:settings.weekly")}</label>
                <input id="cfg-threshold-week" type="number" min="0" step="0.01" placeholder="—" style="width:100%; padding:0.3rem; background:#16213e; color:#eee; border:1px solid #0f3460; border-radius:4px; font-size:0.75rem; box-sizing:border-box;">
              </div>
              <div>
                <label style="display:block; font-size:0.65rem; color:#aaa; margin-bottom:0.2rem;">${t("dashboard:settings.monthly")}</label>
                <input id="cfg-threshold-month" type="number" min="0" step="0.01" placeholder="—" style="width:100%; padding:0.3rem; background:#16213e; color:#eee; border:1px solid #0f3460; border-radius:4px; font-size:0.75rem; box-sizing:border-box;">
              </div>
            </div>
          </div>

          <div style="display:flex; align-items:center; gap:0.75rem; margin-top:0.5rem;">
            <button type="submit" style="padding:0.5rem 1.5rem; background:#4e79a7; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:0.8rem;">${t("dashboard:settings.save")}</button>
            <span id="settings-status" style="font-size:0.75rem; color:#59a14f; opacity:0;"></span>
          </div>
        </form>
      </div>
    </div>
  </div>

  <div class="pricing-panel" id="pricing-panel">
    <h3>${t("dashboard:pricing.title")}</h3>
    <table>
      <thead>
        <tr><th>${t("dashboard:pricing.model")}</th><th>${t("dashboard:pricing.input")}</th><th>${t("dashboard:pricing.output")}</th><th>${t("dashboard:pricing.cacheRead")}</th><th>${t("dashboard:pricing.cacheWrite")}</th></tr>
      </thead>
      <tbody>
        ${pricingRows}
      </tbody>
    </table>
    <div class="pricing-source">${t("dashboard:pricing.source", { date: PRICING_VERIFIED_DATE })}</div>
  </div>

  <div class="footer">${t("dashboard:footer.generated", { timestamp: data.generated, timezone: data.timezone })}</div>

  <script>window.__DASHBOARD__ = ${jsonData};</script>
  <script>
    (function () {
      var d = window.__DASHBOARD__;
      var COLORS = [
        '#4e79a7','#f28e2b','#e15759','#76b7b2',
        '#59a14f','#edc948','#b07aa1','#ff9da7',
        '#9c755f','#bab0ac'
      ];

      // ── Helpers ──────────────────────────────────────────────────────────
      function urlParam(name) {
        return new URLSearchParams(window.location.search).get(name);
      }
      function setUrlParam(name, value) {
        var url = new URL(window.location.href);
        if (value === null) url.searchParams.delete(name);
        else url.searchParams.set(name, value);
        return url.toString();
      }
      function fmtTokens(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
        return String(n);
      }

      // ── Period selector ──────────────────────────────────────────────────
      window.changePeriod = function (val) { window.location.href = setUrlParam('period', val); };
      window.doRefresh = function () { location.reload(); };

      // ── Auto-refresh toggle ───────────────────────────────────────────────
      var refreshSecs = parseInt(urlParam('refresh') || '0', 10);
      var autoBtn = document.getElementById('autorefresh-btn');
      if (refreshSecs > 0) {
        if (autoBtn) autoBtn.textContent = '${t("dashboard:toolbar.autoOn", { seconds: "__SECS__" })}'.replace('__SECS__', refreshSecs);
        setTimeout(function () { location.reload(); }, refreshSecs * 1000);
      }
      window.toggleRefresh = function () {
        window.location.href = refreshSecs > 0 ? setUrlParam('refresh', null) : setUrlParam('refresh', '30');
      };

      // ── Tab navigation ────────────────────────────────────────────────────
      var initialized = {};
      var tabBtns = document.querySelectorAll('.tab-btn');
      var tabPanels = document.querySelectorAll('.tab-panel');

      var pricingPanel = document.getElementById('pricing-panel');
      function switchTab(tabId) {
        tabBtns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === tabId); });
        tabPanels.forEach(function (p) { p.classList.toggle('active', p.id === 'tab-' + tabId); });
        if (pricingPanel) pricingPanel.classList.toggle('visible', tabId === 'overview');
        window.location.hash = tabId;
        if (!initialized[tabId]) {
          initialized[tabId] = true;
          initTab(tabId);
        }
      }

      tabBtns.forEach(function (btn) {
        btn.addEventListener('click', function () { switchTab(this.getAttribute('data-tab')); });
      });

      // ── Chart defaults ───────────────────────────────────────────────────
      Chart.defaults.color = '#aaa';
      Chart.defaults.borderColor = '#2a2a4a';
      var chartOpts = {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { labels: { color: '#ccc', font: { size: 11 } } } }
      };

      // ── Lazy chart initialization per tab ─────────────────────────────────
      function initTab(tabId) {
        switch (tabId) {
          case 'overview': initOverview(); break;
          case 'models': initModels(); break;
          case 'projects': initProjects(); break;
          case 'sessions': initSessions(); break;
          case 'plan': initPlan(); break;
          case 'context': initContext(); break;
          case 'efficiency': initEfficiency(); break;
          case 'energy': initEnergy(); break;
          case 'spending': initSpending(); break;
          case 'settings': initSettings(); break;
        }
      }

      // ═══════════════ OVERVIEW CHARTS ═══════════════
      function initOverview() {
        // 1. Daily/Hourly stacked bar
        (function () {
          var ctx = document.getElementById('chart-daily').getContext('2d');
          var isHourly = d.period === 'day' && d.byHour && d.byHour.length > 0;
          var src = isHourly ? d.byHour : d.byDay;
          var labels = isHourly
            ? d.byHour.map(function (r) { return r.hour + ':00'; })
            : d.byDay.map(function (r) { return r.date; });
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [
                { label: 'Output', data: src.map(function (r) { return r.outputTokens; }), backgroundColor: '#f28e2b' },
                { label: 'Input (non-cached)', data: src.map(function (r) { return r.inputTokens; }), backgroundColor: '#4e79a7' },
                { label: 'Cache Read', data: src.map(function (r) { return r.cacheReadTokens; }), backgroundColor: '#59a14f' },
                { label: 'Cache Creation', data: src.map(function (r) { return r.cacheCreationTokens; }), backgroundColor: '#e15759' }
              ]
            },
            options: Object.assign({}, chartOpts, {
              scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: 'Tokens', color: '#888' }, ticks: { callback: function(v) { return fmtTokens(v); } } } }
            })
          });
        }());

        // 2. Token breakdown doughnut
        (function () {
          var ctx = document.getElementById('chart-token-breakdown').getContext('2d');
          var values = [d.summary.outputTokens, d.summary.inputTokens, d.summary.cacheReadTokens, d.summary.cacheCreationTokens];
          new Chart(ctx, {
            type: 'doughnut',
            data: {
              labels: ['Output (' + fmtTokens(values[0]) + ')', 'Input (' + fmtTokens(values[1]) + ')', 'Cache Read (' + fmtTokens(values[2]) + ')', 'Cache Creation (' + fmtTokens(values[3]) + ')'],
              datasets: [{ data: values, backgroundColor: ['#f28e2b', '#4e79a7', '#59a14f', '#e15759'] }]
            },
            options: chartOpts
          });
        }());

        // 3. Cache doughnut
        (function () {
          var ctx = document.getElementById('chart-cache').getContext('2d');
          var cacheRead = d.summary.cacheReadTokens;
          var cacheCreate = d.summary.cacheCreationTokens;
          var nonCached = d.summary.inputTokens;
          var eff = d.summary.cacheEfficiency.toFixed(1);
          new Chart(ctx, {
            type: 'doughnut',
            data: {
              labels: ['Cache Read (' + fmtTokens(cacheRead) + ', ' + eff + '%)', 'Cache Creation (' + fmtTokens(cacheCreate) + ')', 'Non-cached Input (' + fmtTokens(nonCached) + ')'],
              datasets: [{ data: [cacheRead, cacheCreate, nonCached], backgroundColor: ['#59a14f', '#e15759', '#4e79a7'] }]
            },
            options: chartOpts
          });
        }());

        // 4. Cumulative API value vs plan fee
        (function () {
          var el = document.getElementById('chart-cumulative');
          if (!el || !d.byDay || d.byDay.length === 0) return;
          var ctx = el.getContext('2d');
          var labels = d.byDay.map(function (r) { return r.date; });
          var cumulative = []; var running = 0;
          for (var i = 0; i < d.byDay.length; i++) { running += d.byDay[i].estimatedCost; cumulative.push(Math.round(running * 100) / 100); }
          var datasets = [{ label: 'Cumulative API Value ($)', data: cumulative, borderColor: '#4e79a7', backgroundColor: 'rgba(78,121,167,0.15)', fill: true, tension: 0.3, pointRadius: 2 }];
          var planFee = d.summary.planFee;
          if (planFee > 0) {
            datasets.push({ label: 'Monthly Plan Fee ($' + planFee.toFixed(0) + ')', data: labels.map(function () { return planFee; }), borderColor: '#59a14f', borderDash: [6, 3], pointRadius: 0, fill: false });
          }
          new Chart(ctx, {
            type: 'line', data: { labels: labels, datasets: datasets },
            options: Object.assign({}, chartOpts, { scales: { y: { title: { display: true, text: 'USD ($)', color: '#888' }, ticks: { callback: function(v) { return '$' + v.toFixed(2); } } } } })
          });
        }());
      }

      // ═══════════════ MODELS CHARTS ═══════════════
      function initModels() {
        // Tokens by model
        (function () {
          var ctx = document.getElementById('chart-model').getContext('2d');
          var labels = d.byModel.map(function (r) { return r.model; });
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [
                { label: 'Output', data: d.byModel.map(function (r) { return r.outputTokens; }), backgroundColor: '#f28e2b' },
                { label: 'Input', data: d.byModel.map(function (r) { return r.inputTokens; }), backgroundColor: '#4e79a7' }
              ]
            },
            options: Object.assign({}, chartOpts, {
              scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: 'Tokens', color: '#888' }, ticks: { callback: function(v) { return fmtTokens(v); } } } }
            })
          });
        }());

        // Stop reasons
        (function () {
          var ctx = document.getElementById('chart-stops').getContext('2d');
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: d.stopReasons.map(function (r) { return r.reason; }),
              datasets: [{ label: 'Count', data: d.stopReasons.map(function (r) { return r.count; }), backgroundColor: '#59a14f' }]
            },
            options: chartOpts
          });
        }());
      }

      // ═══════════════ PROJECTS CHARTS ═══════════════
      function initProjects() {
        // Top projects
        (function () {
          var ctx = document.getElementById('chart-project').getContext('2d');
          var top10 = d.byProject.slice(0, 10);
          var labels = top10.map(function (r) { var parts = r.projectPath.replace(/\\\\/g, '/').split('/').filter(Boolean); return parts.length >= 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || r.projectPath; });
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [
                { label: 'Output', data: top10.map(function (r) { return r.outputTokens; }), backgroundColor: '#f28e2b' },
                { label: 'Input', data: top10.map(function (r) { return r.inputTokens; }), backgroundColor: '#4e79a7' }
              ]
            },
            options: Object.assign({}, chartOpts, {
              indexAxis: 'y',
              scales: { x: { stacked: true, title: { display: true, text: 'Tokens', color: '#888' }, ticks: { callback: function(v) { return fmtTokens(v); } } }, y: { stacked: true } }
            })
          });
        }());

        // Entrypoint pie
        (function () {
          var ctx = document.getElementById('chart-entrypoint').getContext('2d');
          new Chart(ctx, {
            type: 'pie',
            data: {
              labels: d.byEntrypoint.map(function (r) { return r.entrypoint; }),
              datasets: [{ data: d.byEntrypoint.map(function (r) { return r.sessions; }), backgroundColor: COLORS }]
            },
            options: chartOpts
          });
        }());
      }

      // ═══════════════ SESSIONS CHARTS ═══════════════
      function initSessions() {
        // Usage windows (stacked by model, showing tokens)
        (function () {
          var el = document.getElementById('chart-windows');
          if (!el || !d.byWindow || d.byWindow.length === 0) return;
          var ctx = el.getContext('2d');
          var windows = d.byWindow.slice(0, 30).reverse();
          var labels = windows.map(function (w) { return new Date(w.windowStart).toISOString().slice(0, 16).replace('T', ' '); });
          // Collect all unique model names across windows
          var modelSet = {};
          for (var i = 0; i < windows.length; i++) {
            var tbm = windows[i].tokensByModel || {};
            for (var m in tbm) { if (tbm.hasOwnProperty(m)) modelSet[m] = true; }
          }
          var models = Object.keys(modelSet).sort();
          if (models.length === 0) {
            // Fallback: no per-model data, show total tokens from prompt count estimate
            return;
          }
          var datasets = [];
          for (var mi = 0; mi < models.length; mi++) {
            var model = models[mi];
            // Shorten model name for legend (e.g. "claude-sonnet-4-20250514" -> "sonnet-4")
            var short = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
            var data = windows.map(function (w) {
              var tbm = w.tokensByModel || {};
              return tbm[model] || 0;
            });
            datasets.push({
              label: short,
              data: data,
              backgroundColor: COLORS[mi % COLORS.length]
            });
          }
          new Chart(ctx, {
            type: 'bar',
            data: { labels: labels, datasets: datasets },
            options: Object.assign({}, chartOpts, {
              plugins: Object.assign({}, chartOpts.plugins, {
                tooltip: { callbacks: { afterTitle: function(items) { var w = windows[items[0].dataIndex]; return w && w.throttled ? '⚠ Throttled' : ''; } } }
              }),
              scales: {
                x: { stacked: true, ticks: { maxRotation: 45, font: { size: 9 } } },
                y: { stacked: true, title: { display: true, text: 'Tokens', color: '#888' }, ticks: { callback: function(v) { return v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v; } } }
              }
            })
          });
        }());

        // Top conversations by cost
        (function () {
          var el = document.getElementById('chart-conv-cost');
          if (!el || !d.byConversationCost || d.byConversationCost.length === 0) return;
          var ctx = el.getContext('2d');
          var top = d.byConversationCost.slice(0, 15);
          var labels = top.map(function (c) { var parts = (c.projectPath || '').replace(/\\\\/g, '/').split('/'); var proj = parts[parts.length - 1] || c.projectPath; return proj + ' (' + c.sessionId.slice(0, 6) + ')'; });
          var costs = top.map(function (c) { return c.estimatedCost; });
          var bgColors = top.map(function (_, i) { return COLORS[i % COLORS.length]; });
          new Chart(ctx, {
            type: 'bar',
            data: { labels: labels, datasets: [{ label: 'Est. API Cost ($)', data: costs, backgroundColor: bgColors }] },
            options: Object.assign({}, chartOpts, {
              indexAxis: 'y',
              plugins: Object.assign({}, chartOpts.plugins, {
                tooltip: { callbacks: { afterLabel: function(ctx) { var c = top[ctx.dataIndex]; var lines = ['Prompts: ' + c.promptCount]; if (c.percentOfPlanFee > 0) lines.push(c.percentOfPlanFee.toFixed(1) + '% of plan fee'); if (c.dominantModel) lines.push('Model: ' + c.dominantModel); return lines; } } }
              }),
              scales: { x: { title: { display: true, text: 'API Value ($)', color: '#888' }, ticks: { callback: function(v) { return '$' + v.toFixed(3); } } } }
            })
          });
        }());
      }

      // ═══════════════ PLAN CHARTS ═══════════════
      function initPlan() {
        if (!d.planUtilization || !d.byWeek || d.byWeek.length === 0) return;
        var pu = d.planUtilization;

        // 1. Weekly Activity (sessions + prompts)
        (function () {
          var el = document.getElementById('chart-weekly-activity');
          if (!el) return;
          var ctx = el.getContext('2d');
          var labels = d.byWeek.map(function (w) { return w.week; });
          var sessions = d.byWeek.map(function (w) { return w.sessions; });
          var prompts = d.byWeek.map(function (w) { return w.prompts; });
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [
                { label: 'Sessions', data: sessions, backgroundColor: '#4e79a7', yAxisID: 'y' },
                { label: 'Prompts', data: prompts, backgroundColor: '#76b7b2', yAxisID: 'y1' }
              ]
            },
            options: Object.assign({}, chartOpts, {
              scales: {
                y: { position: 'left', title: { display: true, text: 'Sessions', color: '#888' }, beginAtZero: true },
                y1: { position: 'right', title: { display: true, text: 'Prompts', color: '#888' }, beginAtZero: true, grid: { drawOnChartArea: false } },
                x: { ticks: { maxRotation: 45, font: { size: 9 } } }
              }
            })
          });
        }());

        // 1b. Window Limit Usage % (per-window usage as % of estimated limit)
        (function () {
          var el = document.getElementById('chart-window-limit-pct');
          if (!el || !d.byWindow || d.byWindow.length === 0) return;
          var limit = pu.estimatedWindowLimit;
          if (!limit || limit <= 0) {
            // Fallback: use max observed window cost as 100%
            var maxObs = 0;
            for (var i = 0; i < d.byWindow.length; i++) {
              if (d.byWindow[i].totalCostEquivalent > maxObs) maxObs = d.byWindow[i].totalCostEquivalent;
            }
            limit = maxObs > 0 ? maxObs : 1;
          }
          var ctx = el.getContext('2d');
          // Sort windows chronologically (oldest first)
          var sorted = d.byWindow.slice().sort(function (a, b) { return a.windowStart - b.windowStart; });
          var labels = sorted.map(function (w) { return new Date(w.windowStart).toISOString().slice(5, 16).replace('T', ' '); });
          var pcts = sorted.map(function (w) { return Math.round((w.totalCostEquivalent / limit) * 1000) / 10; });
          var bgColors = sorted.map(function (w) { return w.throttled ? '#e15759' : pcts[sorted.indexOf(w)] >= 80 ? '#f28e2b' : '#4e79a7'; });
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [{ label: 'Usage %', data: pcts, backgroundColor: bgColors }]
            },
            options: Object.assign({}, chartOpts, {
              plugins: Object.assign({}, chartOpts.plugins, {
                legend: { display: false },
                title: { display: true, text: limit === pu.estimatedWindowLimit ? 'Per-window usage vs estimated limit ($' + limit.toFixed(2) + ')' : 'Per-window usage (relative to peak)', color: '#888', font: { size: 10 } },
                tooltip: { callbacks: { label: function(ctx) { return ctx.parsed.y.toFixed(1) + '% of window limit'; } } }
              }),
              scales: {
                x: { ticks: { maxRotation: 45, font: { size: 9 } } },
                y: { title: { display: true, text: 'Usage %', color: '#888' }, ticks: { callback: function(v) { return v + '%'; } } }
              }
            })
          });
        }());

        // 2. Windows per week trend
        (function () {
          var el = document.getElementById('chart-windows-per-week');
          if (!el) return;
          var ctx = el.getContext('2d');
          var labels = d.byWeek.map(function (w) { return w.week; });
          var windowCounts = d.byWeek.map(function (w) { return w.windowCount; });
          var throttledCounts = d.byWeek.map(function (w) { return w.throttledWindows; });
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [
                { label: 'Normal Windows', data: windowCounts.map(function (c, i) { return c - throttledCounts[i]; }), backgroundColor: '#4e79a7' },
                { label: 'Throttled Windows', data: throttledCounts, backgroundColor: '#e15759' }
              ]
            },
            options: Object.assign({}, chartOpts, {
              scales: {
                x: { stacked: true, ticks: { maxRotation: 45, font: { size: 9 } } },
                y: { stacked: true, title: { display: true, text: 'Windows', color: '#888' } }
              }
            })
          });
        }());

        // 4. Weekly utilization rate (% of plan budget used per week)
        (function () {
          var el = document.getElementById('chart-weekly-util-rate');
          if (!el || !pu.weeklyPlanBudget || pu.weeklyPlanBudget <= 0) return;
          var ctx = el.getContext('2d');
          var labels = d.byWeek.map(function (w) { return w.week; });
          var rates = d.byWeek.map(function (w) { return Math.round((w.estimatedCost / pu.weeklyPlanBudget) * 1000) / 10; });
          var bgColors = rates.map(function (r) { return r >= 100 ? '#59a14f' : r >= 50 ? '#f28e2b' : '#e15759'; });
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [{
                label: 'Plan Utilization %',
                data: rates,
                backgroundColor: bgColors
              }]
            },
            options: Object.assign({}, chartOpts, {
              plugins: Object.assign({}, chartOpts.plugins, {
                legend: { display: false },
                title: { display: true, text: 'Green = getting full value (>=100%), Orange = moderate (50-99%), Red = underusing (<50%)', color: '#666', font: { size: 10 } },
                tooltip: { callbacks: { label: function(ctx) { return ctx.parsed.y.toFixed(1) + '% of weekly plan budget ($' + pu.weeklyPlanBudget.toFixed(2) + ')'; } } }
              }),
              scales: {
                x: { ticks: { maxRotation: 45, font: { size: 9 } } },
                y: {
                  title: { display: true, text: 'Utilization %', color: '#888' },
                  ticks: { callback: function(v) { return v + '%'; } }
                }
              },
              annotation: undefined
            })
          });
          // Add 100% reference line if annotation plugin is available
        }());
      }

      // ═══════════════ CONTEXT CHARTS ═══════════════
      function initContext() {
        if (!d.contextAnalysis) return;
        var ctx = d.contextAnalysis;

        // 1. Conversation Length Distribution
        (function () {
          var el = document.getElementById('chart-length-dist');
          if (!el) return;
          var c = el.getContext('2d');
          new Chart(c, {
            type: 'bar',
            data: {
              labels: ctx.lengthDistribution.map(function (b) { return b.bucket; }),
              datasets: [{
                label: 'Sessions',
                data: ctx.lengthDistribution.map(function (b) { return b.count; }),
                backgroundColor: '#4e79a7',
                borderRadius: 3,
              }]
            },
            options: {
              responsive: true,
              plugins: {
                legend: { display: false },
                tooltip: {
                  callbacks: {
                    label: function (t) { return t.raw + ' sessions'; }
                  }
                }
              },
              scales: {
                x: { title: { display: true, text: 'Prompts per Session', color: '#888' }, ticks: { color: '#aaa' }, grid: { color: '#0f346040' } },
                y: { title: { display: true, text: 'Sessions', color: '#888' }, ticks: { color: '#aaa' }, grid: { color: '#0f346040' }, beginAtZero: true }
              }
            }
          });
        })();

        // 2. Context Growth Curve
        (function () {
          var el = document.getElementById('chart-context-growth');
          if (!el || ctx.contextGrowthCurve.length === 0) return;
          var c = el.getContext('2d');
          new Chart(c, {
            type: 'line',
            data: {
              labels: ctx.contextGrowthCurve.map(function (p) { return '#' + p.promptNumber; }),
              datasets: [{
                label: 'Avg Input Tokens',
                data: ctx.contextGrowthCurve.map(function (p) { return p.avgInputTokens; }),
                borderColor: '#f28e2b',
                backgroundColor: 'rgba(242,142,43,0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 2,
              }]
            },
            options: {
              responsive: true,
              plugins: {
                legend: { display: false },
                tooltip: {
                  callbacks: {
                    label: function (t) {
                      var pt = ctx.contextGrowthCurve[t.dataIndex];
                      return (t.raw / 1000).toFixed(1) + 'K tokens (n=' + pt.sessionCount + ' sessions)';
                    }
                  }
                }
              },
              scales: {
                x: { title: { display: true, text: 'Prompt Position in Conversation', color: '#888' }, ticks: { color: '#aaa' }, grid: { color: '#0f346040' } },
                y: { title: { display: true, text: 'Avg Input Tokens', color: '#888' }, ticks: { color: '#aaa', callback: function (v) { return (v / 1000).toFixed(0) + 'K'; } }, grid: { color: '#0f346040' }, beginAtZero: true }
              }
            }
          });
        })();

        // 3. Cache Efficiency by Conversation Length
        (function () {
          var el = document.getElementById('chart-cache-by-length');
          if (!el) return;
          var c = el.getContext('2d');
          new Chart(c, {
            type: 'bar',
            data: {
              labels: ctx.cacheByLength.map(function (b) { return b.bucket; }),
              datasets: [{
                label: 'Cache Efficiency',
                data: ctx.cacheByLength.map(function (b) { return b.cacheEfficiency; }),
                backgroundColor: ctx.cacheByLength.map(function (b) {
                  return b.cacheEfficiency >= 60 ? '#59a14f' : b.cacheEfficiency >= 30 ? '#f28e2b' : '#e15759';
                }),
                borderRadius: 3,
              }]
            },
            options: {
              responsive: true,
              plugins: {
                legend: { display: false },
                tooltip: {
                  callbacks: {
                    label: function (t) {
                      var b = ctx.cacheByLength[t.dataIndex];
                      return t.raw + '% cache reads (' + b.sessionCount + ' sessions)';
                    }
                  }
                }
              },
              scales: {
                x: { ticks: { color: '#aaa' }, grid: { color: '#0f346040' } },
                y: { title: { display: true, text: 'Cache Read %', color: '#888' }, ticks: { color: '#aaa' }, grid: { color: '#0f346040' }, beginAtZero: true, max: 100 }
              }
            }
          });
        })();

      }

      // ═══════════════ EFFICIENCY CHARTS ═══════════════
      function initEfficiency() {
        if (!d.modelEfficiency) return;
        var eff = d.modelEfficiency;

        // Model usage by complexity tier
        (function () {
          var el = document.getElementById('chart-efficiency-tiers');
          if (!el) return;
          var ctx = el.getContext('2d');
          var modelSet = {};
          for (var i = 0; i < eff.byModelAndTier.length; i++) {
            var r = eff.byModelAndTier[i];
            if (!modelSet[r.model]) modelSet[r.model] = { haiku: 0, sonnet: 0, opus: 0 };
            modelSet[r.model][r.tier] += r.count;
          }
          var models = Object.keys(modelSet);
          var tierColors = { haiku: '#59a14f', sonnet: '#4e79a7', opus: '#e15759' };
          var tiers = ['haiku', 'sonnet', 'opus'];
          var datasets = tiers.map(function (tier) {
            return { label: tier.charAt(0).toUpperCase() + tier.slice(1) + '-level', data: models.map(function (m) { return modelSet[m][tier]; }), backgroundColor: tierColors[tier] };
          });
          new Chart(ctx, {
            type: 'bar', data: { labels: models, datasets: datasets },
            options: Object.assign({}, chartOpts, {
              scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: 'Turns', color: '#888' } } },
              plugins: Object.assign({}, chartOpts.plugins, {
                tooltip: { callbacks: { afterBody: function(items) {
                  var model = models[items[0].dataIndex];
                  var total = tiers.reduce(function(s, t) { return s + modelSet[model][t]; }, 0);
                  var haikuPct = total > 0 ? ((modelSet[model].haiku / total) * 100).toFixed(0) : 0;
                  var sonnetPct = total > 0 ? ((modelSet[model].sonnet / total) * 100).toFixed(0) : 0;
                  return haikuPct + '% could use Haiku, ' + sonnetPct + '% could use Sonnet';
                } } }
              })
            })
          });
        }());

        // Opus complexity score distribution
        (function () {
          var el = document.getElementById('chart-opus-scores');
          if (!el) return;
          var ctx = el.getContext('2d');
          var dist = eff.opusScoreDistribution;
          if (!dist || dist.length === 0) return;
          var labels = dist.map(function (r) { return r.bucket; });
          var values = dist.map(function (r) { return r.count; });
          var bgColors = values.map(function (_, i) {
            if (i < 2) return '#59a14f';  // haiku-level (0-20)
            if (i < 4) return '#4e79a7';  // sonnet-level (20-40)
            return '#e15759';              // opus-level (40+)
          });
          new Chart(ctx, {
            type: 'bar',
            data: { labels: labels, datasets: [{ label: 'Opus Turns', data: values, backgroundColor: bgColors }] },
            options: Object.assign({}, chartOpts, {
              plugins: Object.assign({}, chartOpts.plugins, { legend: { display: false } }),
              scales: {
                x: { title: { display: true, text: 'Complexity Score', color: '#888' } },
                y: { title: { display: true, text: 'Turns', color: '#888' } }
              }
            })
          });
        }());

        // Top overuse
        (function () {
          var el = document.getElementById('chart-overuse');
          if (!el) return;
          var ctx = el.getContext('2d');
          var top = eff.topOveruse;
          if (!top || top.length === 0) return;
          var labels = top.map(function (c) { var p = c.promptPreview || '(no text)'; return p.length > 60 ? p.slice(0, 57) + '...' : p; });
          var savings = top.map(function (c) { return c.savings; });
          var bgColors = top.map(function (c) { return c.tier === 'haiku' ? '#59a14f' : '#4e79a7'; });
          new Chart(ctx, {
            type: 'bar',
            data: { labels: labels, datasets: [{ label: 'Savings ($)', data: savings, backgroundColor: bgColors }] },
            options: Object.assign({}, chartOpts, {
              indexAxis: 'y',
              plugins: Object.assign({}, chartOpts.plugins, {
                legend: { display: false },
                tooltip: { callbacks: { afterLabel: function(ctx) { var c = top[ctx.dataIndex]; return ['Classified: ' + c.tier + '-level', 'Actual cost: $' + c.cost.toFixed(4), 'Tier cost: $' + c.tierCost.toFixed(4), 'Model: ' + c.model]; } } }
              }),
              scales: {
                x: { title: { display: true, text: 'Potential Savings ($)', color: '#888' }, ticks: { callback: function(v) { return '$' + v.toFixed(4); } } },
                y: { ticks: { font: { size: 9 }, maxRotation: 0 } }
              }
            })
          });
        }());
      }

      // ═══════════════ SETTINGS ═══════════════

      // Config I/O abstraction: uses postMessage in VS Code webview, fetch in browser
      var _configCallbacks = {};
      var _configCallbackId = 0;

      function loadConfigAsync(callback) {
        if (typeof window.__vscodeApi !== 'undefined') {
          var id = ++_configCallbackId;
          _configCallbacks[id] = callback;
          window.__vscodeApi.postMessage({ command: 'getConfig', callbackId: id });
        } else {
          fetch('/api/config')
            .then(function (r) { return r.json(); })
            .then(function (cfg) { callback(null, cfg); })
            .catch(function (err) { callback(err); });
        }
      }

      function saveConfigAsync(config, callback) {
        if (typeof window.__vscodeApi !== 'undefined') {
          var id = ++_configCallbackId;
          _configCallbacks[id] = callback;
          window.__vscodeApi.postMessage({ command: 'saveConfig', config: config, callbackId: id });
        } else {
          fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
          })
          .then(function (r) { return r.json(); })
          .then(function (result) { callback(null, result); })
          .catch(function (err) { callback(err); });
        }
      }

      // Handle responses from VS Code extension
      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (msg && msg.command === 'configResult' && msg.callbackId) {
          var cb = _configCallbacks[msg.callbackId];
          delete _configCallbacks[msg.callbackId];
          if (cb) cb(msg.error || null, msg.data);
        }
      });

      function populateSettingsForm(cfg) {
        var planType = document.getElementById('cfg-plan-type');
        var monthlyFee = document.getElementById('cfg-monthly-fee');
        var threshDay = document.getElementById('cfg-threshold-day');
        var threshWeek = document.getElementById('cfg-threshold-week');
        var threshMonth = document.getElementById('cfg-threshold-month');

        if (cfg.plan && cfg.plan.type) planType.value = cfg.plan.type;
        if (cfg.plan && cfg.plan.monthly_fee != null) monthlyFee.value = cfg.plan.monthly_fee;
        if (cfg.costThresholds) {
          if (cfg.costThresholds.day != null) threshDay.value = cfg.costThresholds.day;
          if (cfg.costThresholds.week != null) threshWeek.value = cfg.costThresholds.week;
          if (cfg.costThresholds.month != null) threshMonth.value = cfg.costThresholds.month;
        }
      }

      // ═══════════════ ENERGY CHARTS ═══════════════
      function initEnergy() {
        if (!d.energy) return;
        var en = d.energy;

        // Daily energy bar chart
        (function () {
          var el = document.getElementById('energy-day-chart');
          if (!el || !en.byDay || !en.byDay.length) return;
          var ctx = el.getContext('2d');
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: en.byDay.map(function (d) { return d.date; }),
              datasets: [
                {
                  label: 'Energy (kWh)',
                  data: en.byDay.map(function (d) { return d.energyWh / 1000; }),
                  backgroundColor: '#4e79a7',
                  yAxisID: 'y'
                },
                {
                  label: 'CO₂ (g)',
                  data: en.byDay.map(function (d) { return d.co2Grams; }),
                  backgroundColor: '#e15759',
                  yAxisID: 'y2',
                  type: 'line',
                  borderColor: '#e15759',
                  borderWidth: 1.5,
                  pointRadius: 2,
                  fill: false
                }
              ]
            },
            options: Object.assign({}, chartOpts, {
              scales: {
                x: Object.assign({}, chartOpts.scales && chartOpts.scales.x),
                y: { position: 'left', ticks: { color: '#4e79a7', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
                y2: { position: 'right', ticks: { color: '#e15759', font: { size: 10 } }, grid: { drawOnChartArea: false } }
              }
            })
          });
        })();

        // Energy by model — horizontal bar chart
        (function () {
          var el = document.getElementById('energy-model-chart');
          if (!el || !en.byModel || !en.byModel.length) return;
          var ctx = el.getContext('2d');
          var palette = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1'];
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: en.byModel.map(function (m) { return m.model; }),
              datasets: [{
                label: 'Energy (kWh)',
                data: en.byModel.map(function (m) { return m.energyWh / 1000; }),
                backgroundColor: en.byModel.map(function (_, i) { return palette[i % palette.length]; })
              }]
            },
            options: Object.assign({}, chartOpts, {
              indexAxis: 'y',
              plugins: Object.assign({}, chartOpts.plugins, {
                legend: { display: false }
              })
            })
          });
        })();
      }

      // ═══════════════ SPENDING CHARTS ═══════════════
      function initSpending() {
        if (!d.spending) return;
        var sp = d.spending;

        // Cost by Model — donut chart
        (function () {
          var el = document.getElementById('chart-spending-models');
          if (!el || !sp.costByModel.length) return;
          var ctx = el.getContext('2d');
          var palette = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7'];
          new Chart(ctx, {
            type: 'doughnut',
            data: {
              labels: sp.costByModel.map(function(m) { return m.model.replace('claude-',''); }),
              datasets: [{
                data: sp.costByModel.map(function(m) { return m.estimatedCost; }),
                backgroundColor: palette.slice(0, sp.costByModel.length)
              }]
            },
            options: {
              responsive: true,
              plugins: {
                legend: { position: 'right', labels: { color: '#ccc', font: { size: 11 } } },
                tooltip: { callbacks: { label: function(ctx) { return ctx.label + ': $' + ctx.parsed.toFixed(2) + ' (' + sp.costByModel[ctx.dataIndex].percentage + '%)'; } } }
              }
            }
          });
        }());

        // Top Tools — horizontal bar chart
        (function () {
          var el = document.getElementById('chart-spending-tools');
          if (!el || !sp.topToolsByCost.length) return;
          var ctx = el.getContext('2d');
          var items = sp.topToolsByCost.slice(0, 8);
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: items.map(function(t) { return t.tool; }),
              datasets: [{
                label: 'Cost ($)',
                data: items.map(function(t) { return t.estimatedCost; }),
                backgroundColor: items.map(function(t) { return t.isMcp ? '#f28e2b' : '#4e79a7'; })
              }]
            },
            options: Object.assign({}, chartOpts, {
              indexAxis: 'y',
              plugins: Object.assign({}, chartOpts.plugins, {
                legend: { display: false },
                tooltip: { callbacks: { label: function(ctx) { return '$' + ctx.parsed.x.toFixed(2) + ' (' + items[ctx.dataIndex].invocationCount + ' calls)'; } } }
              }),
              scales: {
                x: { title: { display: true, text: 'Estimated Cost ($)', color: '#888' } },
                y: { ticks: { font: { size: 9 }, color: '#ccc' } }
              }
            })
          });
        }());

        // MCP Server Usage — stacked horizontal bar chart (tokens per server)
        (function () {
          var el = document.getElementById('chart-mcp-servers');
          if (!el || !sp.mcpServerUsage || !sp.mcpServerUsage.length) return;
          var ctx = el.getContext('2d');
          var servers = sp.mcpServerUsage;
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: servers.map(function(s) { return s.server; }),
              datasets: [
                {
                  label: 'Input',
                  data: servers.map(function(s) { return Math.round(s.inputTokens / 1000); }),
                  backgroundColor: '#4e79a7'
                },
                {
                  label: 'Output',
                  data: servers.map(function(s) { return Math.round(s.outputTokens / 1000); }),
                  backgroundColor: '#f28e2b'
                },
                {
                  label: 'Cache Read',
                  data: servers.map(function(s) { return Math.round(s.cacheReadTokens / 1000); }),
                  backgroundColor: '#59a14f'
                }
              ]
            },
            options: Object.assign({}, chartOpts, {
              indexAxis: 'y',
              plugins: Object.assign({}, chartOpts.plugins, {
                legend: { labels: { color: '#ccc', font: { size: 10 } } },
                tooltip: { callbacks: { label: function(c) { return c.dataset.label + ': ' + c.parsed.x.toLocaleString() + 'K tokens ($' + servers[c.dataIndex].estimatedCost.toFixed(2) + ' total)'; } } }
              }),
              scales: {
                x: { stacked: true, title: { display: true, text: 'Tokens (K)', color: '#888' } },
                y: { stacked: true, ticks: { font: { size: 10 }, color: '#ccc' } }
              }
            })
          });
        }());
      }

      function initSettings() {
        loadConfigAsync(function (err, cfg) {
          if (!err && cfg) populateSettingsForm(cfg);
        });

        document.getElementById('settings-form').addEventListener('submit', function (e) {
          e.preventDefault();
          var planType = document.getElementById('cfg-plan-type').value;
          var monthlyFee = document.getElementById('cfg-monthly-fee').value;
          var threshDay = document.getElementById('cfg-threshold-day').value;
          var threshWeek = document.getElementById('cfg-threshold-week').value;
          var threshMonth = document.getElementById('cfg-threshold-month').value;

          var config = {};
          config.plan = {};
          if (planType) config.plan.type = planType;
          if (monthlyFee) config.plan.monthly_fee = parseFloat(monthlyFee);
          config.costThresholds = {};
          if (threshDay) config.costThresholds.day = parseFloat(threshDay);
          if (threshWeek) config.costThresholds.week = parseFloat(threshWeek);
          if (threshMonth) config.costThresholds.month = parseFloat(threshMonth);

          var statusEl = document.getElementById('settings-status');
          saveConfigAsync(config, function (err, result) {
            if (err) {
              statusEl.textContent = '${t("dashboard:settings.networkError")}';
              statusEl.style.color = '#e15759';
              statusEl.style.opacity = '1';
              return;
            }
            if (result && result.ok) {
              statusEl.textContent = '${t("dashboard:settings.savedReload")}';
              statusEl.style.color = '#59a14f';
            } else {
              statusEl.textContent = '${t("dashboard:settings.errorSaving")}';
              statusEl.style.color = '#e15759';
            }
            statusEl.style.opacity = '1';
            setTimeout(function () { statusEl.style.opacity = '0'; }, 3000);
          });
        });
      }

      // ── Initialize first tab + restore from hash ──────────────────────────
      var startTab = window.__ACTIVE_TAB__ || (window.location.hash || '').replace('#', '') || 'overview';
      var validTabs = Array.from(tabBtns).map(function (b) { return b.getAttribute('data-tab'); });
      if (validTabs.indexOf(startTab) === -1) startTab = 'overview';
      switchTab(startTab);
    }());
  </script>
</body>
</html>`;
}

/** Format a solar-panel area: cm² when <1 m², m² otherwise. */
function formatSolarArea(m2: number): string {
  if (m2 < 1) return `${Math.round(m2 * 10000)} cm²`;
  if (m2 < 10) return `${m2.toFixed(2)} m²`;
  return `${m2.toFixed(1)} m²`;
}

/** Format a large number with k/M suffix for display in summary bar. */
function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
