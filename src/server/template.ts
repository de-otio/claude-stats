/**
 * HTML dashboard template renderer.
 * Produces a self-contained HTML page with Chart.js charts from DashboardData.
 */
import type { DashboardData } from "../dashboard/index.js";

export { DashboardData };

/**
 * Renders a complete self-contained HTML dashboard page.
 */
export function renderDashboard(data: DashboardData): string {
  const generatedDate = data.generated.slice(0, 10); // YYYY-MM-DD portion
  const title = `Claude Stats — ${data.period} (${generatedDate})`;
  const jsonData = JSON.stringify(data);

  const formattedCost = `$${data.summary.estimatedCost.toFixed(2)}`;
  const cacheEff = `${data.summary.cacheEfficiency.toFixed(1)}%`;
  const planFee = data.summary.planFee;
  const showPlan = planFee > 0;
  const planMultiplierStr = data.summary.planMultiplier > 0
    ? `${data.summary.planMultiplier.toFixed(1)}×`
    : "";

  // Period selector: which option should be pre-selected
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
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }
    .toolbar label {
      font-size: 0.85rem;
      color: #aaa;
    }
    .toolbar select {
      background: #16213e;
      color: #eee;
      border: 1px solid #0f3460;
      border-radius: 4px;
      padding: 0.3rem 0.6rem;
      font-family: inherit;
      font-size: 0.85rem;
      cursor: pointer;
    }
    .toolbar button {
      background: #0f3460;
      color: #eee;
      border: 1px solid #1a508b;
      border-radius: 4px;
      padding: 0.3rem 0.8rem;
      font-family: inherit;
      font-size: 0.85rem;
      cursor: pointer;
    }
    .toolbar button:hover { background: #1a508b; }
    .summary-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 0.75rem;
      margin-bottom: 1.5rem;
    }
    .summary-card {
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 6px;
      padding: 0.75rem;
      text-align: center;
    }
    .summary-card .label {
      font-size: 0.65rem;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.3rem;
    }
    .summary-card .value {
      font-size: 1.2rem;
      font-weight: 700;
      color: #a0c4ff;
    }
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 1.5rem;
    }
    @media (max-width: 768px) {
      .charts-grid { grid-template-columns: 1fr; }
    }
    .chart-card {
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 6px;
      padding: 1rem;
    }
    .chart-card h2 {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: #888;
      margin-bottom: 0.75rem;
    }
    canvas { max-height: 280px; }
    .footer {
      margin-top: 1.5rem;
      font-size: 0.7rem;
      color: #555;
      text-align: center;
    }
  </style>
</head>
<body>
  <h1>${title}</h1>

  <div class="toolbar">
    <label for="period-select">Period:</label>
    <select id="period-select" onchange="changePeriod(this.value)">
      ${periodOptions}
    </select>
    <button id="refresh-btn" onclick="doRefresh()">Refresh</button>
    <button id="autorefresh-btn" onclick="toggleRefresh()" style="font-size:0.75rem; padding:0.3rem 0.6rem;">Auto: off</button>
  </div>

  <div class="summary-bar">
    <div class="summary-card" style="grid-column: 1 / -1; text-align: left; padding: 0.5rem 0.75rem;">
      <span style="font-size:0.7rem; color:#888;">Period: </span>
      <span style="font-size:0.75rem; color:#a0c4ff;">${data.sinceIso ? `${data.sinceIso} → today` : "All time"}</span>
    </div>
    <div class="summary-card">
      <div class="label">Sessions</div>
      <div class="value">${data.summary.sessions}</div>
    </div>
    <div class="summary-card">
      <div class="label">Prompts</div>
      <div class="value">${data.summary.prompts}</div>
    </div>
    <div class="summary-card">
      <div class="label">Input Tokens</div>
      <div class="value">${fmtNum(data.summary.inputTokens)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Output Tokens</div>
      <div class="value">${fmtNum(data.summary.outputTokens)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Cache Read</div>
      <div class="value">${fmtNum(data.summary.cacheReadTokens)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Cache Created</div>
      <div class="value">${fmtNum(data.summary.cacheCreationTokens)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Cache Efficiency</div>
      <div class="value">${cacheEff}</div>
    </div>
    <div class="summary-card">
      <div class="label">Est. Cost</div>
      <div class="value">${formattedCost}</div>
    </div>
    ${showPlan ? `
    <div class="summary-card" style="border-color:#59a14f;">
      <div class="label">Plan Value</div>
      <div class="value" style="color:#59a14f;">${planMultiplierStr}</div>
      <div style="font-size:0.6rem;color:#888;margin-top:0.2rem;">of $${planFee.toFixed(0)}/mo</div>
    </div>
    ` : ""}
    <div class="summary-card">
      <div class="label">Active Hours</div>
      <div class="value">${data.summary.totalActiveHours.toFixed(1)}h</div>
    </div>
    ${data.summary.costPerPrompt > 0 ? `
    <div class="summary-card">
      <div class="label">Cost / Prompt</div>
      <div class="value">$${data.summary.costPerPrompt.toFixed(4)}</div>
    </div>
    ` : ""}
    ${data.summary.tokensPerMinute > 0 ? `
    <div class="summary-card">
      <div class="label">Tok / Min</div>
      <div class="value">${fmtNum(data.summary.tokensPerMinute)}</div>
    </div>
    ` : ""}
    ${data.summary.throttleEvents > 0 ? `
    <div class="summary-card" style="border-color:#e15759;">
      <div class="label">Throttle Events</div>
      <div class="value" style="color:#e15759;">${data.summary.throttleEvents}</div>
    </div>
    ` : ""}
  </div>

  <div class="charts-grid">
    <div class="chart-card">
      <h2 id="chart-daily-title">${data.period === "day" ? "Hourly Token Usage" : "Daily Token Usage"}</h2>
      <canvas id="chart-daily"></canvas>
    </div>
    <div class="chart-card">
      <h2>Token Breakdown</h2>
      <canvas id="chart-token-breakdown"></canvas>
    </div>
    <div class="chart-card">
      <h2>Tokens by Model</h2>
      <canvas id="chart-model"></canvas>
    </div>
    <div class="chart-card">
      <h2>Top Projects</h2>
      <canvas id="chart-project"></canvas>
    </div>
    <div class="chart-card">
      <h2>Sessions by Entrypoint</h2>
      <canvas id="chart-entrypoint"></canvas>
    </div>
    <div class="chart-card">
      <h2>Stop Reasons</h2>
      <canvas id="chart-stops"></canvas>
    </div>
    <div class="chart-card">
      <h2>Cache Usage</h2>
      <canvas id="chart-cache"></canvas>
    </div>
    <div class="chart-card" style="grid-column: 1 / -1;">
      <h2>Cumulative API Value vs Plan Fee</h2>
      <canvas id="chart-cumulative"></canvas>
    </div>
    ${data.byWindow.length > 0 ? `
    <div class="chart-card" style="grid-column: 1 / -1;">
      <h2>5-Hour Usage Windows</h2>
      <canvas id="chart-windows"></canvas>
    </div>
    ` : ""}
    ${data.byConversationCost.length > 0 ? `
    <div class="chart-card" style="grid-column: 1 / -1;">
      <h2>Top Conversations by API Cost</h2>
      <canvas id="chart-conv-cost"></canvas>
    </div>
    ` : ""}
  </div>

  <div class="footer">Generated ${data.generated} &bull; Timezone: ${data.timezone}</div>

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
        if (value === null) {
          url.searchParams.delete(name);
        } else {
          url.searchParams.set(name, value);
        }
        return url.toString();
      }

      function fmtTokens(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
        return String(n);
      }

      // ── Period selector ──────────────────────────────────────────────────
      function changePeriod(val) {
        window.location.href = setUrlParam('period', val);
      }
      window.changePeriod = changePeriod;

      // ── Manual refresh ────────────────────────────────────────────────────
      function doRefresh() {
        location.reload();
      }
      window.doRefresh = doRefresh;

      // ── Auto-refresh toggle ───────────────────────────────────────────────
      var refreshSecs = parseInt(urlParam('refresh') || '0', 10);
      var autoBtn = document.getElementById('autorefresh-btn');
      if (refreshSecs > 0) {
        if (autoBtn) autoBtn.textContent = 'Auto: on (' + refreshSecs + 's)';
        setTimeout(function () { location.reload(); }, refreshSecs * 1000);
      }
      function toggleRefresh() {
        if (refreshSecs > 0) {
          window.location.href = setUrlParam('refresh', null);
        } else {
          window.location.href = setUrlParam('refresh', '30');
        }
      }
      window.toggleRefresh = toggleRefresh;

      // ── Chart defaults ───────────────────────────────────────────────────
      Chart.defaults.color = '#aaa';
      Chart.defaults.borderColor = '#2a2a4a';

      var chartOpts = {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { labels: { color: '#ccc', font: { size: 11 } } } }
      };

      // ── 1. Daily/Hourly stacked bar chart (input/output/cache) ───────────
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
              {
                label: 'Output',
                data: src.map(function (r) { return r.outputTokens; }),
                backgroundColor: '#f28e2b'
              },
              {
                label: 'Input (non-cached)',
                data: src.map(function (r) { return r.inputTokens; }),
                backgroundColor: '#4e79a7'
              },
              {
                label: 'Cache Read',
                data: src.map(function (r) { return r.cacheReadTokens; }),
                backgroundColor: '#59a14f'
              },
              {
                label: 'Cache Creation',
                data: src.map(function (r) { return r.cacheCreationTokens; }),
                backgroundColor: '#e15759'
              }
            ]
          },
          options: Object.assign({}, chartOpts, {
            scales: {
              x: { stacked: true },
              y: {
                stacked: true,
                title: { display: true, text: 'Tokens', color: '#888' },
                ticks: { callback: function(v) { return fmtTokens(v); } }
              }
            }
          })
        });
      }());

      // ── 2. Token breakdown doughnut ────────────────────────────────────
      (function () {
        var ctx = document.getElementById('chart-token-breakdown').getContext('2d');
        var values = [
          d.summary.outputTokens,
          d.summary.inputTokens,
          d.summary.cacheReadTokens,
          d.summary.cacheCreationTokens
        ];
        new Chart(ctx, {
          type: 'doughnut',
          data: {
            labels: [
              'Output (' + fmtTokens(values[0]) + ')',
              'Input (' + fmtTokens(values[1]) + ')',
              'Cache Read (' + fmtTokens(values[2]) + ')',
              'Cache Creation (' + fmtTokens(values[3]) + ')'
            ],
            datasets: [{ data: values, backgroundColor: ['#f28e2b', '#4e79a7', '#59a14f', '#e15759'] }]
          },
          options: chartOpts
        });
      }());

      // ── 3. Model stacked bar (input vs output per model) ───────────────
      (function () {
        var ctx = document.getElementById('chart-model').getContext('2d');
        var labels = d.byModel.map(function (r) { return r.model; });
        new Chart(ctx, {
          type: 'bar',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Output',
                data: d.byModel.map(function (r) { return r.outputTokens; }),
                backgroundColor: '#f28e2b'
              },
              {
                label: 'Input',
                data: d.byModel.map(function (r) { return r.inputTokens; }),
                backgroundColor: '#4e79a7'
              }
            ]
          },
          options: Object.assign({}, chartOpts, {
            scales: {
              x: { stacked: true },
              y: {
                stacked: true,
                title: { display: true, text: 'Tokens', color: '#888' },
                ticks: { callback: function(v) { return fmtTokens(v); } }
              }
            }
          })
        });
      }());

      // ── 4. Project horizontal bar (top 10) ───────────────────────────────
      (function () {
        var ctx = document.getElementById('chart-project').getContext('2d');
        var top10 = d.byProject.slice(0, 10);
        var labels = top10.map(function (r) {
          var parts = r.projectPath.replace(/\\\\/g, '/').split('/');
          return parts[parts.length - 1] || r.projectPath;
        });
        new Chart(ctx, {
          type: 'bar',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Output',
                data: top10.map(function (r) { return r.outputTokens; }),
                backgroundColor: '#f28e2b'
              },
              {
                label: 'Input',
                data: top10.map(function (r) { return r.inputTokens; }),
                backgroundColor: '#4e79a7'
              }
            ]
          },
          options: Object.assign({}, chartOpts, {
            indexAxis: 'y',
            scales: {
              x: {
                stacked: true,
                title: { display: true, text: 'Tokens', color: '#888' },
                ticks: { callback: function(v) { return fmtTokens(v); } }
              },
              y: { stacked: true }
            }
          })
        });
      }());

      // ── 5. Entrypoint pie ────────────────────────────────────────────────
      (function () {
        var ctx = document.getElementById('chart-entrypoint').getContext('2d');
        var labels = d.byEntrypoint.map(function (r) { return r.entrypoint; });
        var values = d.byEntrypoint.map(function (r) { return r.sessions; });
        new Chart(ctx, {
          type: 'pie',
          data: {
            labels: labels,
            datasets: [{ data: values, backgroundColor: COLORS }]
          },
          options: chartOpts
        });
      }());

      // ── 6. Stop reasons bar ──────────────────────────────────────────────
      (function () {
        var ctx = document.getElementById('chart-stops').getContext('2d');
        var labels = d.stopReasons.map(function (r) { return r.reason; });
        var values = d.stopReasons.map(function (r) { return r.count; });
        new Chart(ctx, {
          type: 'bar',
          data: {
            labels: labels,
            datasets: [{ label: 'Count', data: values, backgroundColor: '#59a14f' }]
          },
          options: chartOpts
        });
      }());

      // ── 7. Cache doughnut ────────────────────────────────────────────────
      (function () {
        var ctx = document.getElementById('chart-cache').getContext('2d');
        var cacheRead = d.summary.cacheReadTokens;
        var cacheCreate = d.summary.cacheCreationTokens;
        var nonCached = d.summary.inputTokens;
        var eff = d.summary.cacheEfficiency.toFixed(1);
        new Chart(ctx, {
          type: 'doughnut',
          data: {
            labels: [
              'Cache Read (' + fmtTokens(cacheRead) + ', ' + eff + '%)',
              'Cache Creation (' + fmtTokens(cacheCreate) + ')',
              'Non-cached Input (' + fmtTokens(nonCached) + ')'
            ],
            datasets: [{
              data: [cacheRead, cacheCreate, nonCached],
              backgroundColor: ['#59a14f', '#e15759', '#4e79a7']
            }]
          },
          options: chartOpts
        });
      }());

      // ── 8. Cumulative API value vs plan fee ──────────────────────────────
      (function () {
        var el = document.getElementById('chart-cumulative');
        if (!el || !d.byDay || d.byDay.length === 0) return;
        var ctx = el.getContext('2d');
        var labels = d.byDay.map(function (r) { return r.date; });
        var cumulative = [];
        var running = 0;
        for (var i = 0; i < d.byDay.length; i++) {
          running += d.byDay[i].estimatedCost;
          cumulative.push(Math.round(running * 100) / 100);
        }
        var datasets = [{
          label: 'Cumulative API Value ($)',
          data: cumulative,
          borderColor: '#4e79a7',
          backgroundColor: 'rgba(78,121,167,0.15)',
          fill: true,
          tension: 0.3,
          pointRadius: 2
        }];
        var planFee = d.summary.planFee;
        if (planFee > 0) {
          datasets.push({
            label: 'Monthly Plan Fee ($' + planFee.toFixed(0) + ')',
            data: labels.map(function () { return planFee; }),
            borderColor: '#59a14f',
            borderDash: [6, 3],
            pointRadius: 0,
            fill: false
          });
        }
        new Chart(ctx, {
          type: 'line',
          data: { labels: labels, datasets: datasets },
          options: Object.assign({}, chartOpts, {
            scales: {
              y: {
                title: { display: true, text: 'USD ($)', color: '#888' },
                ticks: { callback: function(v) { return '$' + v.toFixed(2); } }
              }
            }
          })
        });
      }());

      // ── 9. 5-hour usage windows ──────────────────────────────────────────
      (function () {
        var el = document.getElementById('chart-windows');
        if (!el || !d.byWindow || d.byWindow.length === 0) return;
        var ctx = el.getContext('2d');
        var windows = d.byWindow.slice(0, 30).reverse(); // oldest first
        var labels = windows.map(function (w) {
          return new Date(w.windowStart).toISOString().slice(0, 16).replace('T', ' ');
        });
        var costs = windows.map(function (w) { return Math.round(w.totalCostEquivalent * 100) / 100; });
        var bgColors = windows.map(function (w) { return w.throttled ? '#e15759' : '#4e79a7'; });
        new Chart(ctx, {
          type: 'bar',
          data: {
            labels: labels,
            datasets: [{
              label: 'API Value ($)',
              data: costs,
              backgroundColor: bgColors,
            }]
          },
          options: Object.assign({}, chartOpts, {
            plugins: Object.assign({}, chartOpts.plugins, {
              legend: Object.assign({}, chartOpts.plugins.legend, {
                display: false
              }),
              tooltip: {
                callbacks: {
                  afterLabel: function(ctx) {
                    var w = windows[ctx.dataIndex];
                    return w && w.throttled ? '⚠ Throttled' : '';
                  }
                }
              }
            }),
            scales: {
              y: {
                title: { display: true, text: 'API Value ($)', color: '#888' },
                ticks: { callback: function(v) { return '$' + v.toFixed(2); } }
              },
              x: { ticks: { maxRotation: 45, font: { size: 9 } } }
            }
          })
        });
      }());

      // ── 10. Top conversations by cost ─────────────────────────────────────
      (function () {
        var el = document.getElementById('chart-conv-cost');
        if (!el || !d.byConversationCost || d.byConversationCost.length === 0) return;
        var ctx = el.getContext('2d');
        var top = d.byConversationCost.slice(0, 15);
        var labels = top.map(function (c) {
          var parts = (c.projectPath || '').replace(/\\\\/g, '/').split('/');
          var proj = parts[parts.length - 1] || c.projectPath;
          return proj + ' (' + c.sessionId.slice(0, 6) + ')';
        });
        var costs = top.map(function (c) { return c.estimatedCost; });
        var bgColors = top.map(function (_, i) { return COLORS[i % COLORS.length]; });
        new Chart(ctx, {
          type: 'bar',
          data: {
            labels: labels,
            datasets: [{
              label: 'Est. API Cost ($)',
              data: costs,
              backgroundColor: bgColors
            }]
          },
          options: Object.assign({}, chartOpts, {
            indexAxis: 'y',
            plugins: Object.assign({}, chartOpts.plugins, {
              tooltip: {
                callbacks: {
                  afterLabel: function(ctx) {
                    var c = top[ctx.dataIndex];
                    var lines = ['Prompts: ' + c.promptCount];
                    if (c.percentOfPlanFee > 0) lines.push(c.percentOfPlanFee.toFixed(1) + '% of plan fee');
                    if (c.dominantModel) lines.push('Model: ' + c.dominantModel);
                    return lines;
                  }
                }
              }
            }),
            scales: {
              x: {
                title: { display: true, text: 'API Value ($)', color: '#888' },
                ticks: { callback: function(v) { return '$' + v.toFixed(3); } }
              }
            }
          })
        });
      }());
    }());
  </script>
</body>
</html>`;
}

/** Format a large number with k/M suffix for display in summary bar. */
function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
