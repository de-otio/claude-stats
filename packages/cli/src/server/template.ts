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
  // Escape `<` in the JSON payload so attacker-controlled string values
  // containing `</script>` cannot break out of the surrounding <script> block.
  // Also neutralize `-->` in case the JSON ever ends up inside an HTML comment.
  // Both replacements preserve JSON validity (escaped as < / > inside
  // string literals) and are reversed transparently by JSON.parse at runtime.
  const jsonData = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/-->/g, "--\\u003e");

  const formattedCost = `$${data.summary.estimatedCost.toFixed(2)}`;
  const cacheEff = `${data.summary.cacheEfficiency.toFixed(1)}%`;
  const planFee = data.summary.planFee;
  const showPlan = planFee > 0;
  const planMultiplierStr = data.summary.planMultiplier > 0
    ? `${data.summary.planMultiplier.toFixed(1)}×`
    : "";

  const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  // Escape a string for safe embedding inside a single-quoted JS string
  // literal in the inline <script> block. Translations routinely contain
  // apostrophes ("haven't", French "l'autre", Ukrainian "прив'язано") — left
  // unescaped, one terminates the literal early and breaks the whole script,
  // silently killing every chart on the page. Every `'${t(...)}'` call site
  // must wrap the translation in this.
  const jsStr = (s: string) => s
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/<\/script/gi, "<\\/script");
  const sevColor: Record<string, string> = { critical: "#e15759", warning: "#f28e2b", info: "#4e79a7", success: "#59a14f" };
  const sevIcon: Record<string, string> = { critical: "!", warning: "!", info: "i", success: "\u2713" };
  const recs = data.recommendations ?? [];
  const actions = recs.filter(r => r.severity !== "success");
  const positives = recs.filter(r => r.severity === "success");
  const renderRec = (r: typeof recs[number]) => `
    <div style="display:flex;gap:0.75rem;padding:0.5rem 0;border-top:1px solid #2a3552;align-items:flex-start;">
      <div style="flex:0 0 1.25rem;width:1.25rem;height:1.25rem;border-radius:50%;background:${sevColor[r.severity]};color:#16213e;font-weight:bold;font-size:0.75rem;display:flex;align-items:center;justify-content:center;margin-top:0.1rem;">${sevIcon[r.severity]}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:0.85rem;color:#e8e8e8;font-weight:600;">${escapeHtml(r.title)}${r.impact ? ` <span style="font-size:0.7rem;font-weight:500;color:#59a14f;background:#1e3a2a;padding:0.05rem 0.4rem;border-radius:3px;margin-left:0.4rem;">${escapeHtml(r.impact)}</span>` : ""}</div>
        <div style="font-size:0.75rem;color:#b0b0b0;margin-top:0.2rem;line-height:1.4;">${escapeHtml(r.body)}</div>
      </div>
    </div>
  `;
  const actionsHtml = actions.length > 0 ? `
    <div class="recommendations-panel" style="margin-bottom:1rem;background:#16213e;border:1px solid #2a3552;border-radius:6px;padding:0.75rem 1rem;">
      <div style="font-size:0.75rem;color:#a0c4ff;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem;">Suggested actions</div>
      ${actions.map(renderRec).join("")}
    </div>` : "";
  const positivesHtml = positives.length > 0 ? `
    <div class="recommendations-panel" style="margin-bottom:1rem;background:#14291e;border:1px solid #2b5238;border-radius:6px;padding:0.75rem 1rem;">
      <div style="font-size:0.75rem;color:#8ec07c;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem;">What you're doing well</div>
      ${positives.map(renderRec).join("")}
    </div>` : "";
  const recsHtml = actionsHtml + positivesHtml;

  // ── Cost per successful task (read-only card) ──
  const cpt = data.costPerTask;
  const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
  const fmtPct0 = (x: number) => `${Math.round(x * 100)}%`;
  const cptBadge = (text: string, color = "#9aa3c0") =>
    `<span style="font-size:0.65rem;color:${color};background:#0f1830;border:1px solid #2a3552;border-radius:3px;padding:0.1rem 0.45rem;">${text}</span>`;
  // Per-task labelling control button. Rendered only when costPerTask.tasks is
  // present, which only the VS Code webview sets (the serve path leaves it off).
  // The webview bridge reads data-cpt-index into __DASHBOARD__.costPerTask.tasks.
  const cptBtn = (i: number, val: string, glyph: string, active: boolean) =>
    `<button data-cpt-index="${i}" data-cpt-value="${val}" title="${t("dashboard:costPerTask.mark." + val)}" style="cursor:pointer;background:${active ? "#2b5238" : "#0f1830"};color:#cfd8ea;border:1px solid #2a3552;border-radius:3px;padding:0.05rem 0.35rem;font-size:0.7rem;line-height:1.1;">${glyph}</button>`;
  const costPerTaskHtml = (cpt && cpt.tasksTotal > 0) ? `
    <div class="cpt-card" style="margin-bottom:1rem;background:#16213e;border:1px solid #2a3552;border-radius:6px;padding:0.75rem 1rem;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.5rem;">
        <span style="font-size:0.75rem;color:#a0c4ff;text-transform:uppercase;letter-spacing:0.05em;">${t("dashboard:costPerTask.title")}</span>
        <span style="font-size:0.65rem;color:#666;">${t(`dashboard:costPerTask.period.${cpt.period}`)}</span>
      </div>
      ${cpt.coverage < 0.2 ? `<div style="font-size:0.7rem;color:#f28e2b;margin-bottom:0.5rem;">⚠ ${t("dashboard:costPerTask.lowCoverage", { coverage: fmtPct0(cpt.coverage) })}</div>` : ""}
      <div style="display:flex;flex-wrap:wrap;gap:1.5rem;align-items:baseline;">
        <div>
          <div style="font-size:1.6rem;font-weight:bold;color:#fff;">${cpt.costPerSuccessfulTask !== null ? fmtUsd(cpt.costPerSuccessfulTask) : t("dashboard:costPerTask.na")}</div>
          <div style="font-size:0.65rem;color:#888;">${t("dashboard:costPerTask.headline")}</div>
        </div>
        ${(cpt.meanCostPerAttempt !== null && cpt.successRate !== null) ? `
        <div style="font-size:0.78rem;color:#b0b0b0;">${t("dashboard:costPerTask.decomp", { mean: fmtUsd(cpt.meanCostPerAttempt), rate: fmtPct0(cpt.successRate) })}</div>` : ""}
      </div>
      <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.6rem;">
        ${cptBadge(t("dashboard:costPerTask.coverageBadge", { observable: cpt.observable, total: cpt.tasksTotal, coverage: fmtPct0(cpt.coverage) }))}
        ${cptBadge(t("dashboard:costPerTask.labelledBadge", { labelled: cpt.labelledCount, observable: cpt.observable }))}
        ${cptBadge(`${cpt.successCount} ${t("dashboard:costPerTask.success")}`, "#8ec07c")}
        ${cptBadge(`${cpt.failedCount} ${t("dashboard:costPerTask.failed")}`, "#e15759")}
        ${cptBadge(`${cpt.inFlightCount} ${t("dashboard:costPerTask.inFlight")}`)}
        ${cptBadge(`${cpt.unobservableCount} ${t("dashboard:costPerTask.unobservable")}`)}
      </div>
      ${cpt.byModel.length > 0 ? `
      <table style="width:100%;margin-top:0.7rem;font-size:0.72rem;border-collapse:collapse;">
        <thead><tr style="color:#888;text-align:left;">
          <th style="padding:0.2rem 0.4rem;">${t("dashboard:costPerTask.model")}</th>
          <th style="padding:0.2rem 0.4rem;text-align:right;">${t("dashboard:costPerTask.perSuccess")}</th>
          <th style="padding:0.2rem 0.4rem;text-align:right;">${t("dashboard:costPerTask.successRate")}</th>
          <th style="padding:0.2rem 0.4rem;text-align:right;">${t("dashboard:costPerTask.observableCol")}</th>
        </tr></thead>
        <tbody>
          ${cpt.byModel.map(m => `<tr style="border-top:1px solid #2a3552;">
            <td style="padding:0.2rem 0.4rem;color:#e8e8e8;">${escapeHtml(m.model.replace(/^claude-/, ""))}</td>
            <td style="padding:0.2rem 0.4rem;text-align:right;color:#fff;">${m.costPerSuccessfulTask !== null ? fmtUsd(m.costPerSuccessfulTask) : t("dashboard:costPerTask.na")}</td>
            <td style="padding:0.2rem 0.4rem;text-align:right;color:#b0b0b0;">${m.successRate !== null ? fmtPct0(m.successRate) : t("dashboard:costPerTask.insufficient")}</td>
            <td style="padding:0.2rem 0.4rem;text-align:right;color:#b0b0b0;">${m.tasksObservable}</td>
          </tr>`).join("")}
        </tbody>
      </table>` : ""}
      ${(cpt.tasks && cpt.tasks.length > 0) ? `
      <div style="margin-top:0.7rem;">
        <div style="font-size:0.65rem;color:#888;margin-bottom:0.3rem;">${t("dashboard:costPerTask.labelTasksHeading")}</div>
        ${cpt.tasks.map((task, i) => {
          const o = task.outcome;
          const lab = task.labelled;
          return `<div style="display:flex;align-items:center;gap:0.5rem;padding:0.25rem 0;border-top:1px solid #2a3552;font-size:0.72rem;">
            <span style="flex:1;min-width:0;color:#e8e8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(task.title)} <span style="color:#666;">· ${escapeHtml(task.project.split("/").pop() ?? task.project)}</span></span>
            <span style="color:#888;font-size:0.6rem;white-space:nowrap;">${lab ? t("dashboard:costPerTask.labelledTag") : t("dashboard:costPerTask.outcomeShort." + o)}</span>
            <span style="display:flex;gap:0.2rem;flex:0 0 auto;">
              ${cptBtn(i, "success", "✓", lab && o === "success")}
              ${cptBtn(i, "partial", "~", lab && o === "in_flight")}
              ${cptBtn(i, "fail", "✗", lab && o === "failed")}
              ${cptBtn(i, "clear", "⌫", false)}
            </span>
          </div>`;
        }).join("")}
      </div>` : ""}
      <div style="font-size:0.6rem;color:#666;margin-top:0.5rem;line-height:1.4;">${t("dashboard:costPerTask.proxyNote")}</div>
    </div>` : "";

  // ── Calibration + signal-activation (VS Code webview only — data.calibration
  //    is null elsewhere). Shows how well the signals agree with the user's
  //    labels and lets them flip the signals on for the live rate. ──
  const cal = data.calibration;
  const fmtPctNa = (x: number | null) => (x === null ? t("dashboard:calibration.na") : fmtPct0(x));
  const fmtBrier = (x: number | null) => (x === null ? t("dashboard:calibration.na") : x.toFixed(3));
  const signalsOn = data.experimentalSignalsEnabled;
  const floorPct = cal ? fmtPct0(cal.floor) : "";
  const calibrationHtml = cal ? `
    <div class="cpt-card" style="margin-bottom:1rem;background:#16213e;border:1px solid #2a3552;border-radius:6px;padding:0.75rem 1rem;">
      <div style="font-size:0.75rem;color:#a0c4ff;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem;">${t("dashboard:calibration.title")}</div>
      ${cal.n === 0 ? `
      <div style="font-size:0.78rem;color:#b0b0b0;line-height:1.5;">${t("dashboard:calibration.noLabels")}</div>` : `
      <table style="width:100%;font-size:0.72rem;border-collapse:collapse;">
        <thead><tr style="color:#888;text-align:left;">
          <th style="padding:0.2rem 0.4rem;"></th>
          <th style="padding:0.2rem 0.4rem;text-align:right;">${t("dashboard:calibration.colProxy")}</th>
          <th style="padding:0.2rem 0.4rem;text-align:right;">${t("dashboard:calibration.colSignals")}</th>
        </tr></thead>
        <tbody>
          <tr style="border-top:1px solid #2a3552;"><td style="padding:0.2rem 0.4rem;color:#e8e8e8;">${t("dashboard:calibration.failedPrecision")}</td><td style="padding:0.2rem 0.4rem;text-align:right;color:#fff;">${fmtPctNa(cal.proxyOnly.failedPrecision)}</td><td style="padding:0.2rem 0.4rem;text-align:right;color:#fff;">${fmtPctNa(cal.withSignals.failedPrecision)}</td></tr>
          <tr style="border-top:1px solid #2a3552;"><td style="padding:0.2rem 0.4rem;color:#e8e8e8;">${t("dashboard:calibration.accuracy")}</td><td style="padding:0.2rem 0.4rem;text-align:right;color:#b0b0b0;">${fmtPctNa(cal.proxyOnly.accuracy)}</td><td style="padding:0.2rem 0.4rem;text-align:right;color:#b0b0b0;">${fmtPctNa(cal.withSignals.accuracy)}</td></tr>
          <tr style="border-top:1px solid #2a3552;"><td style="padding:0.2rem 0.4rem;color:#e8e8e8;">${t("dashboard:calibration.brier")}</td><td style="padding:0.2rem 0.4rem;text-align:right;color:#b0b0b0;">${fmtBrier(cal.proxyOnly.brier)}</td><td style="padding:0.2rem 0.4rem;text-align:right;color:#b0b0b0;">${fmtBrier(cal.withSignals.brier)}</td></tr>
        </tbody>
      </table>
      <div style="font-size:0.72rem;margin-top:0.5rem;color:${cal.withSignals.meetsFailedFloor ? "#8ec07c" : "#f28e2b"};">
        ${cal.withSignals.meetsFailedFloor ? t("dashboard:calibration.ready", { floor: floorPct }) : t("dashboard:calibration.notReady", { floor: floorPct })}
      </div>
      <div style="font-size:0.65rem;color:#888;margin-top:0.2rem;">${t("dashboard:calibration.labelled", { n: cal.n })}</div>`}
      <label style="display:flex;align-items:center;gap:0.5rem;margin-top:0.7rem;font-size:0.78rem;color:#cfd8ea;cursor:pointer;">
        <input type="checkbox" id="signals-toggle"${signalsOn ? " checked" : ""}>
        ${t("dashboard:calibration.toggle")}
      </label>
      <div style="font-size:0.65rem;color:${signalsOn ? "#8ec07c" : "#888"};margin-top:0.2rem;">${signalsOn ? t("dashboard:calibration.enabledNote") : t("dashboard:calibration.disabledNote")}</div>
    </div>` : "";

  // ── Cost-efficiency frontier panel (value-per-cost Phase 1) ──
  // Shown beside the cost-per-task headline on the Spending tab whenever
  // the report carries an efficiency block. Human text for Lever.kind is
  // rendered here from the enum; the payload never carries free text (plan §1).
  const eff = cpt?.efficiency;
  const leverKindText = (kind: string): string =>
    t(`dashboard:costEfficiency.leverKind.${kind}`);
  const costEfficiencyHtml = (eff && cpt && cpt.tasksTotal > 0) ? `
    <div class="cpt-card" style="margin-bottom:1rem;background:#16213e;border:1px solid #2a3552;border-radius:6px;padding:0.75rem 1rem;">
      <div style="font-size:0.75rem;color:#a0c4ff;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem;">${t("dashboard:costEfficiency.title")}</div>
      ${eff.realisedCost <= 0 ? `
      <div style="font-size:0.78rem;color:#b0b0b0;">${t("dashboard:costEfficiency.insufficient")}</div>` : `
      <div style="display:flex;flex-wrap:wrap;gap:1.5rem;align-items:baseline;margin-bottom:0.5rem;">
        <div>
          <div style="font-size:1.1rem;font-weight:bold;color:#fff;">${fmtUsd(eff.realisedCost)}</div>
          <div style="font-size:0.65rem;color:#888;">${t("dashboard:costEfficiency.realised")}</div>
        </div>
        <div>
          <div style="font-size:1.1rem;font-weight:bold;color:#59a14f;">${fmtUsd(eff.frontierCost)}</div>
          <div style="font-size:0.65rem;color:#888;">${t("dashboard:costEfficiency.frontier")}</div>
        </div>
        <div>
          <div style="font-size:1.1rem;font-weight:bold;color:#f28e2b;">${fmtUsd(eff.recoverableWaste)}</div>
          <div style="font-size:0.65rem;color:#888;">${t("dashboard:costEfficiency.recoverable")}</div>
        </div>
      </div>`}
      ${eff.realisedCost > 0 && eff.levers.length > 0 ? `
      <div style="margin-top:0.4rem;">
        ${eff.levers.slice(0, 3).map(lv => `
        <div style="font-size:0.75rem;color:#cfd8ea;padding:0.2rem 0;border-top:1px solid #2a3552;">
          <span style="color:#a0c4ff;margin-right:0.3rem;">&#9656;</span>${leverKindText(lv.kind)}${lv.estSavingUsd != null ? ` <span style="color:#59a14f;font-size:0.7rem;">(~${fmtUsd(lv.estSavingUsd)})</span>` : ""}
        </div>`).join("")}
      </div>` : ""}
      <div style="font-size:0.6rem;color:#666;margin-top:0.5rem;">${t("dashboard:costEfficiency.basisNote")}</div>
    </div>` : "";

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

  // ── Subscription fee by project (server-rendered; all user data escaped) ──
  const fmtMoney = (n: number, currency: string): string => {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n);
    } catch {
      return `${currency} ${n.toFixed(2)}`;
    }
  };
  const projShort = (p: string): string => {
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join("/") : (parts[parts.length - 1] ?? p);
  };
  // Largest-remainder rounding so displayed slices sum to the displayed total (M5).
  const roundShares = (amounts: number[]): number[] => {
    const cents = amounts.map((a) => Math.floor(a * 100));
    const target = Math.round(amounts.reduce((s, a) => s + a, 0) * 100);
    const residual = target - cents.reduce((s, c) => s + c, 0);
    const order = amounts
      .map((a, i) => ({ i, frac: a * 100 - Math.floor(a * 100) }))
      .sort((x, y) => y.frac - x.frac);
    for (let k = 0; k < residual && k < order.length; k++) cents[order[k]!.i]!++;
    return cents.map((c) => c / 100);
  };
  const fee = data.feeAttribution;
  let feeByProjectHtml = "";
  if (!fee || !fee.configured) {
    feeByProjectHtml = `
      <div class="chart-card" style="grid-column: 1 / -1;">
        <h2>${escapeHtml(t("dashboard:fees.title"))}</h2>
        <p style="font-size:0.78rem;color:#b0b0b0;margin:0.3rem 0 0 0;">${escapeHtml(t("dashboard:fees.notConfigured"))}</p>
      </div>`;
  } else {
    const blocks = fee.byCurrency
      .map((b, blockIdx) => {
        const rounded = roundShares(b.perProject.map((p) => p.amount));
        // Numeric detail lives in real DOM text (the pie's table-view twin) —
        // never only in the canvas, which screen readers/copy-paste can't reach.
        const listRows = b.perProject
          .map((p, i) => {
            const pct = Math.max(0, Math.min(100, p.percentOfTotal));
            return `
            <div style="display:flex;align-items:center;gap:0.5rem;padding:0.2rem 0;font-size:0.72rem;">
              <span style="flex:1;color:#e8e8e8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(p.projectPath)}">${escapeHtml(projShort(p.projectPath))}</span>
              <span style="flex:0 0 5rem;text-align:right;color:#fff;">${escapeHtml(fmtMoney(rounded[i] ?? 0, b.currency))}</span>
              <span style="flex:0 0 3rem;text-align:right;color:#888;">${Math.round(pct)}%</span>
            </div>`;
          })
          .join("");
        const idleRows = b.idle
          .map(
            (it) => `
            <div style="display:flex;align-items:center;gap:0.5rem;padding:0.2rem 0;font-size:0.72rem;color:#888;border-top:1px dashed #2a3552;">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(t("dashboard:fees.idle", { label: it.label }))}</span>
              <span style="flex:0 0 5rem;text-align:right;">${escapeHtml(fmtMoney(it.amount, b.currency))}</span>
              <span style="flex:0 0 3rem;"></span>
            </div>`
          )
          .join("");
        return `
          <div style="margin-bottom:0.75rem;">
            <div style="font-size:0.7rem;color:#a0c4ff;margin-bottom:0.3rem;">${escapeHtml(
              t("dashboard:fees.currencyHeader", {
                period: fmtMoney(b.periodTotal, b.currency),
                monthly: fmtMoney(b.monthlyTotal, b.currency),
              })
            )}</div>
            <div style="max-width:15rem;margin:0 auto 0.5rem auto;">
              <canvas id="chart-fees-${blockIdx}"></canvas>
            </div>
            ${listRows}
            ${idleRows}
            <div style="font-size:0.6rem;color:#666;margin-top:0.3rem;">${escapeHtml(
              t("dashboard:fees.reconcile", { attributed: fmtMoney(b.attributed, b.currency) })
            )}</div>
          </div>`;
      })
      .join("");
    feeByProjectHtml = `
      <div class="chart-card" style="grid-column: 1 / -1;">
        <h2>${escapeHtml(t("dashboard:fees.title"))}</h2>
        ${blocks}
      </div>`;
  }

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
    ${data.availableAccounts.length > 1 ? `
    <label for="account-select" style="margin-left:0.5rem;">${t("dashboard:toolbar.account")}</label>
    <select id="account-select" onchange="changeAccount(this.value)">
      <option value=""${data.selectedAccountUuid === null ? " selected" : ""}>${t("dashboard:toolbar.accountAll", { count: data.availableAccounts.length })}</option>
      ${data.availableAccounts.map(a => {
        const label = a.emailAddress
          ? `${escapeHtml(a.emailAddress)}${a.isCurrent ? " " + t("dashboard:toolbar.accountCurrent") : ""}`
          : `${escapeHtml(a.accountUuid.slice(0, 8))}…${a.isCurrent ? " " + t("dashboard:toolbar.accountCurrent") : ""}`;
        return `<option value="${escapeHtml(a.accountUuid)}"${data.selectedAccountUuid === a.accountUuid ? " selected" : ""}>${label}</option>`;
      }).join("")}
    </select>
    ` : ""}
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
    <button class="tab-btn" data-tab="classify">${t("dashboard:tabs.classify")}</button>
    <button class="tab-btn" data-tab="settings">${t("dashboard:tabs.settings")}</button>
  </div>

  <!-- ═══════════════ TAB: Overview ═══════════════ -->
  <div class="tab-panel active" id="tab-overview">
    ${recsHtml}
    <div class="summary-bar">
      <div class="summary-card" style="grid-column: 1 / -1; text-align: left; padding: 0.5rem 0.75rem;">
        <span style="font-size:0.7rem; color:#888;">${t("dashboard:toolbar.period")} </span>
        <span style="font-size:0.75rem; color:#a0c4ff;">${data.sinceIso ? t("dashboard:summary.periodRange", { start: data.sinceIso }) : t("dashboard:summary.allTime")}</span>
      </div>
      ${data.summary.sessions === 0 ? `
      <div class="summary-card" style="grid-column: 1 / -1; text-align: left; padding: 0.5rem 0.75rem; border-color:#e0a458; background:rgba(224,164,88,0.08);">
        <span style="font-size:0.75rem; color:#e0a458;">${t("dashboard:summary.emptyPeriodHint")}</span>
      </div>
      ` : ""}
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.sessions")}</div>
        <div class="value">${data.summary.sessions}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.prompts")}</div>
        <div class="value">${data.summary.prompts}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.totalInput")}</div>
        <div class="value">${fmtNum(data.summary.inputTokens + data.summary.cacheReadTokens + data.summary.cacheCreationTokens)}</div>
        <div style="font-size:0.6rem;color:#888;margin-top:0.2rem;">${t("dashboard:summary.totalInputHint")}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.inputTokens")}</div>
        <div class="value">${fmtNum(data.summary.inputTokens)}</div>
        <div style="font-size:0.6rem;color:#888;margin-top:0.2rem;">${t("dashboard:summary.inputTokensHint")}</div>
      </div>
      <div class="summary-card">
        <div class="label">${t("dashboard:summary.cacheReads")}</div>
        <div class="value">${fmtNum(data.summary.cacheReadTokens)}</div>
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
      ${(cpt && cpt.tasksTotal > 0 && cpt.costPerSuccessfulTask !== null) ? `
      <div class="summary-card">
        <div class="label">${t("dashboard:costPerTask.title")}</div>
        <div class="value">${fmtUsd(cpt.costPerSuccessfulTask)}</div>
        <div style="font-size:0.6rem;color:#888;margin-top:0.2rem;">${t("dashboard:costPerTask.summaryHint")}</div>
      </div>
      ` : ""}
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
      ${data.summary.truncatedOutputs > 0 ? `
      <div class="summary-card" style="border-color:#f28e2b;">
        <div class="label">${t("dashboard:summary.truncatedOutputs")}</div>
        <div class="value" style="color:#f28e2b;">${data.summary.truncatedOutputs}</div>
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
      ${feeByProjectHtml}
      <div class="chart-card">
        <h2>${t("dashboard:charts.topProjects")}</h2>
        <canvas id="chart-project"></canvas>
      </div>
      <div class="chart-card">
        <h2>${t("dashboard:charts.tokensByProject")}</h2>
        <canvas id="chart-project-tokens"></canvas>
      </div>
      ${data.energy && data.energy.byProject.length > 0 ? `
      <div class="chart-card">
        <h2>${t("dashboard:charts.energyByProject")}</h2>
        <canvas id="chart-project-energy"></canvas>
      </div>` : ""}
      <div class="chart-card">
        <h2>${t("dashboard:charts.thinkingIntensity")}</h2>
        <canvas id="chart-project-thinking"></canvas>
      </div>
      <div class="chart-card" style="grid-column: 1 / -1;">
        <h2>${t("dashboard:charts.natureOfWork")}</h2>
        <canvas id="chart-work-profile"></canvas>
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
        <canvas id="chart-conv-cost" height="420"></canvas>
      </div>
      ` : ""}
      <div class="chart-card">
        <h2>${t("dashboard:charts.sessionsByEntrypoint")}</h2>
        <canvas id="chart-entrypoint"></canvas>
      </div>
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
        <div class="value" style="font-size:0.8rem;color:#4e79a7;">${escapeHtml(displayName)}</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${planName ? escapeHtml(planName) + (a.detectedPlanFee ? ` ($${a.detectedPlanFee}/mo)` : '') : t("dashboard:plan.planNotDetected")}</div>
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
      ${pu.truncatedOutputWindowPercent > 0 ? `
      <div class="summary-card" style="border-color:#f28e2b;">
        <div class="label">${t("dashboard:plan.truncatedOutputWindows")}</div>
        <div class="value" style="color:#f28e2b;">${pu.truncatedOutputWindowPercent}%</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${t("dashboard:plan.truncatedOutputWindowsHint")}</div>
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
        <div class="label">${escapeHtml(acctDisplayName)}</div>
        <div class="value" style="font-size:0.85rem;">$${acct.estimatedCost.toFixed(2)}</div>
        <div style="font-size:0.55rem;color:#888;margin-top:0.15rem;">${acct.subscriptionType ? escapeHtml(acct.subscriptionType) : t("dashboard:plan.unknownPlan")} &bull; ${acct.sessions} sessions${acct.detectedPlanFee ? ` &bull; $${acct.detectedPlanFee}/mo` : ''}</div>
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
              <td style="padding:0.4rem; color:#ccc; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(s.projectPath)}">${escapeHtml(s.projectPath.split('/').slice(-2).join('/'))}</td>
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

    ${costPerTaskHtml}

    ${costEfficiencyHtml}

    ${calibrationHtml}

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
              <td style="padding:0.4rem;" title="${escapeHtml(s.projectPath)}">${escapeHtml(s.projectPath)}</td>
              <td style="text-align:right;padding:0.4rem;color:#59a14f;">$${s.estimatedCost.toFixed(2)}</td>
              <td style="text-align:right;padding:0.4rem;">${s.promptCount}</td>
              <td style="padding:0.4rem;font-size:0.6rem;color:#888;">${escapeHtml(s.dominantModel.replace("claude-", ""))}</td>
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
              <td style="padding:0.4rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.promptPreview ? escapeHtml(p.promptPreview) : "(no text)"}</td>
              <td style="text-align:right;padding:0.4rem;">${(p.totalTokens / 1000).toFixed(0)}K</td>
              <td style="text-align:right;padding:0.4rem;color:#59a14f;">$${p.estimatedCost.toFixed(2)}</td>
              <td style="text-align:right;padding:0.4rem;color:#e15759;">${p.timesAvg}x</td>
              <td style="padding:0.4rem;">${p.flags.map(f => `<span style="background:#333;padding:0.1rem 0.3rem;border-radius:3px;font-size:0.6rem;margin-right:0.2rem;">${escapeHtml(f)}</span>`).join("")}</td>
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
              <td style="padding:0.4rem;font-weight:600;">${escapeHtml(s.server)}</td>
              <td style="text-align:right;padding:0.4rem;color:#59a14f;">$${s.estimatedCost.toFixed(2)}</td>
              <td style="text-align:right;padding:0.4rem;">${s.inputTokens >= 1000000 ? (s.inputTokens/1000000).toFixed(1)+'M' : s.inputTokens >= 1000 ? Math.round(s.inputTokens/1000)+'K' : s.inputTokens}</td>
              <td style="text-align:right;padding:0.4rem;">${s.outputTokens >= 1000000 ? (s.outputTokens/1000000).toFixed(1)+'M' : s.outputTokens >= 1000 ? Math.round(s.outputTokens/1000)+'K' : s.outputTokens}</td>
              <td style="text-align:right;padding:0.4rem;">${s.callCount}</td>
              <td style="text-align:right;padding:0.4rem;">${s.messageCount}</td>
              <td style="padding:0.4rem;font-size:0.6rem;color:#aaa;">${escapeHtml(s.tools.slice(0, 3).map(t => t.method + '(' + t.calls + ')').join(', '))}</td>
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
        <div class="value" style="font-size:0.75rem;">${escapeHtml(data.energy.region)}</div>
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
          <div style="font-size:1.6rem;line-height:1;">🔥</div>
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${formatNaturalGasVolume(data.energy.equivalents.naturalGasM3)}<sup style="font-size:0.7rem;color:#ff9966;">¶</sup></div>
          <div style="font-size:0.8rem;color:#d0d8f0;">${t("dashboard:energy.naturalGasM3")}</div>
          <div style="font-size:0.65rem;color:#9aa3c0;margin-top:0.15rem;">${t("dashboard:energy.naturalGasRef")}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#0f1429;border-radius:4px;padding:0.6rem;text-align:center;">
          <div style="font-size:1.6rem;line-height:1;">☀️</div>
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${formatSolarArea(data.energy.equivalents.solarPanelM2)}<sup style="font-size:0.7rem;color:#8ec07c;">†</sup></div>
          <div style="font-size:0.8rem;color:#d0d8f0;">${t("dashboard:energy.solarPanels")}</div>
          <div style="font-size:0.65rem;color:#9aa3c0;margin-top:0.15rem;">${t("dashboard:energy.solarRegion", { region: REGIONS[data.energy.equivalents.solarRegionKey]?.name ?? data.energy.equivalents.solarRegionKey })}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#0f1429;border-radius:4px;padding:0.6rem;text-align:center;">
          <div style="font-size:1.6rem;line-height:1;">🌬️</div>
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${data.energy.equivalents.windRotations.toFixed(1)}<sup style="font-size:0.7rem;color:#7ec4e8;">‡</sup></div>
          <div style="font-size:0.8rem;color:#d0d8f0;">${t("dashboard:energy.windRotations")}</div>
          <div style="font-size:0.65rem;color:#9aa3c0;margin-top:0.15rem;">${t("dashboard:energy.windTurbineRef")}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#0f1429;border-radius:4px;padding:0.6rem;text-align:center;">
          <div style="font-size:1.6rem;line-height:1;">💧</div>
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${formatWaterVolume(data.energy.equivalents.hydroTurbineLiters)}<sup style="font-size:0.7rem;color:#6ec1e4;">§</sup></div>
          <div style="font-size:0.8rem;color:#d0d8f0;">${t("dashboard:energy.hydroTurbineLiters")}</div>
          <div style="font-size:0.65rem;color:#9aa3c0;margin-top:0.15rem;">${t("dashboard:energy.hydroTurbineRef")}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#0f1429;border-radius:4px;padding:0.6rem;text-align:center;">
          <div style="font-size:1.6rem;line-height:1;">☢️</div>
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${formatNuclearVolume(data.energy.equivalents.nuclearWasteMl)}<sup style="font-size:0.7rem;color:#ffb347;">*</sup></div>
          <div style="font-size:0.8rem;color:#d0d8f0;">${t("dashboard:energy.nuclearWaste")}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#0f1429;border-radius:4px;padding:0.6rem;text-align:center;">
          <div style="font-size:1.6rem;line-height:1;">🚇</div>
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${data.energy.equivalents.transitKm.toFixed(2)}</div>
          <div style="font-size:0.8rem;color:#d0d8f0;">${t("dashboard:energy.transitKm")}</div>
        </div>
        <div style="flex:1;min-width:140px;background:#0f1429;border-radius:4px;padding:0.6rem;text-align:center;">
          <div style="font-size:1.6rem;line-height:1;">🚄</div>
          <div style="font-size:1.2rem;font-weight:bold;color:#fff;">${data.energy.equivalents.trainKm.toFixed(2)}</div>
          <div style="font-size:0.8rem;color:#d0d8f0;">${t("dashboard:energy.trainKm")}</div>
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
      <div style="margin-top:0.35rem;font-size:0.6rem;color:#888;line-height:1.35;">
        <span style="color:#7ec4e8;">‡</span> ${t("dashboard:energy.windRotationsFootnote", {
          minutes: (data.energy.totalEnergyWh / 17500).toFixed(1),
          ratedMinutes: (data.energy.totalEnergyWh / 50000).toFixed(2),
        })}
      </div>
      <div style="margin-top:0.35rem;font-size:0.6rem;color:#888;line-height:1.35;">
        <span style="color:#6ec1e4;">§</span> ${t("dashboard:energy.hydroTurbineFootnote")}
      </div>
      <div style="margin-top:0.35rem;font-size:0.6rem;color:#888;line-height:1.35;">
        <span style="color:#ff9966;">¶</span> ${t("dashboard:energy.naturalGasFootnote")}
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
            <td style="padding:0.4rem;color:#ccc;overflow:hidden;text-overflow:ellipsis;max-width:240px;white-space:nowrap;">${escapeHtml(p.project)}</td>
            <td style="padding:0.4rem;text-align:right;color:#fff;">${formatEnergy(p.energyWh)}</td>
            <td style="padding:0.4rem;text-align:right;color:#aaa;">${formatCO2(p.co2Grams)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>` : ""}

    <!-- Calculation transparency -->
    <details style="background:#1a1f3a;border-radius:6px;padding:1rem;margin-top:1rem;">
      <summary style="cursor:pointer;font-size:0.85rem;color:#a0c4ff;font-weight:600;list-style:none;display:flex;justify-content:space-between;align-items:center;">
        <span>${t("dashboard:energy.calc.title")}</span>
        <span style="font-size:0.6rem;color:#888;font-weight:400;">${t("dashboard:energy.calc.clickToExpand")}</span>
      </summary>
      <div style="margin-top:0.75rem;font-size:0.7rem;color:#ccc;line-height:1.55;">
        <p style="margin:0 0 0.5rem 0;">${t("dashboard:energy.calc.intro")}</p>
        <div style="background:#0f1429;border-radius:4px;padding:0.75rem;margin:0.5rem 0;font-family:ui-monospace,monospace;font-size:0.65rem;color:#a0c4ff;white-space:pre;overflow-x:auto;">energy_Wh = (output_tokens / 1K) × output_rate
          + (input_tokens  / 1K) × input_rate
          + (cache_write   / 1K) × input_rate  × 1.15
          + (cache_read    / 1K) × output_rate × 0.03

total_kWh = energy_Wh × PUE / 1000
CO₂_grams = total_kWh × grid_intensity</div>
        <p style="margin:0.5rem 0;"><strong style="color:#a0c4ff;">${t("dashboard:energy.calc.ratesHeader")}</strong></p>
        <table style="width:100%;border-collapse:collapse;font-size:0.65rem;margin:0.25rem 0;">
          <thead><tr style="color:#888;text-align:right;">
            <th style="text-align:left;padding:0.2rem 0.4rem;">${t("dashboard:energy.calc.col.class")}</th>
            <th style="padding:0.2rem 0.4rem;">${t("dashboard:energy.calc.col.inputRate")}</th>
            <th style="padding:0.2rem 0.4rem;">${t("dashboard:energy.calc.col.outputRate")}</th>
          </tr></thead>
          <tbody>${data.energy.byClass.map(c => `
            <tr style="color:#ddd;text-align:right;">
              <td style="text-align:left;padding:0.2rem 0.4rem;text-transform:capitalize;">${c.cls}</td>
              <td style="padding:0.2rem 0.4rem;">${c.inputWhPer1K.toFixed(3)} Wh/1K</td>
              <td style="padding:0.2rem 0.4rem;">${c.outputWhPer1K.toFixed(3)} Wh/1K</td>
            </tr>`).join("")}
          </tbody>
        </table>
        <p style="margin:0.75rem 0 0.25rem 0;"><strong style="color:#a0c4ff;">${t("dashboard:energy.calc.periodHeader", { start: data.energy.periodStartIso, end: data.energy.periodEndIso })}</strong></p>
        <div style="overflow-x:auto;">
        <table style="width:100%;min-width:600px;border-collapse:collapse;font-size:0.65rem;margin:0.25rem 0;">
          <thead><tr style="color:#888;text-align:right;">
            <th style="text-align:left;padding:0.2rem 0.4rem;">${t("dashboard:energy.calc.col.class")}</th>
            <th style="padding:0.2rem 0.4rem;">${t("dashboard:energy.calc.col.msgs")}</th>
            <th style="padding:0.2rem 0.4rem;">${t("dashboard:energy.calc.col.output")}</th>
            <th style="padding:0.2rem 0.4rem;">${t("dashboard:energy.calc.col.input")}</th>
            <th style="padding:0.2rem 0.4rem;">${t("dashboard:energy.calc.col.cacheWrite")}</th>
            <th style="padding:0.2rem 0.4rem;">${t("dashboard:energy.calc.col.cacheRead")}</th>
            <th style="padding:0.2rem 0.4rem;">${t("dashboard:energy.calc.col.rawEnergy")}</th>
          </tr></thead>
          <tbody>${data.energy.byClass.map(c => `
            <tr style="color:#ddd;text-align:right;">
              <td style="text-align:left;padding:0.2rem 0.4rem;text-transform:capitalize;">${c.cls}</td>
              <td style="padding:0.2rem 0.4rem;">${fmtNum(c.msgs)}</td>
              <td style="padding:0.2rem 0.4rem;">${fmtNum(c.outputTokens)}</td>
              <td style="padding:0.2rem 0.4rem;">${fmtNum(c.inputTokens)}</td>
              <td style="padding:0.2rem 0.4rem;">${fmtNum(c.cacheWriteTokens)}</td>
              <td style="padding:0.2rem 0.4rem;">${fmtNum(c.cacheReadTokens)}</td>
              <td style="padding:0.2rem 0.4rem;color:#fff;">${(c.rawEnergyWh / 1000).toFixed(2)} kWh</td>
            </tr>`).join("")}
          </tbody>
          <tfoot>
            <tr style="color:#a0c4ff;text-align:right;font-weight:600;border-top:1px solid #2a2f4f;">
              <td style="text-align:left;padding:0.3rem 0.4rem;">${t("dashboard:energy.calc.col.rawTotal")}</td>
              <td colspan="5"></td>
              <td style="padding:0.3rem 0.4rem;">${(data.energy.byClass.reduce((s, c) => s + c.rawEnergyWh, 0) / 1000).toFixed(2)} kWh</td>
            </tr>
          </tfoot>
        </table>
        </div>
        <p style="margin:0.5rem 0;">${t("dashboard:energy.calc.totals", {
          raw: (data.energy.byClass.reduce((s, c) => s + c.rawEnergyWh, 0) / 1000).toFixed(2),
          pue: data.energy.pue.toFixed(2),
          totalKwh: (data.energy.totalEnergyWh / 1000).toFixed(2),
          region: REGIONS[data.energy.region]?.name ?? data.energy.region,
          gridIntensity: data.energy.gridIntensity,
          co2Kg: (data.energy.totalCO2Grams / 1000).toFixed(2),
        })}</p>
        <p style="margin:0.75rem 0 0.25rem 0;"><strong style="color:#a0c4ff;">${t("dashboard:energy.calc.equivHeader")}</strong></p>
        <ul style="list-style:none;padding:0;margin:0.25rem 0;font-size:0.65rem;color:#ccc;line-height:1.55;">
          <li>${t("dashboard:energy.calc.eq.naturalGas", { totalKwh: (data.energy.totalEnergyWh / 1000).toFixed(2), value: formatNaturalGasVolume(data.energy.equivalents.naturalGasM3) })}</li>
          <li>${t("dashboard:energy.calc.eq.train", { co2Kg: (data.energy.totalCO2Grams / 1000).toFixed(2), value: data.energy.equivalents.trainKm.toFixed(2) })}</li>
          <li>${t("dashboard:energy.calc.eq.transit", { co2Kg: (data.energy.totalCO2Grams / 1000).toFixed(2), value: data.energy.equivalents.transitKm.toFixed(2) })}</li>
          <li>${t("dashboard:energy.calc.eq.nuclearWaste", { totalKwh: (data.energy.totalEnergyWh / 1000).toFixed(2), value: formatNuclearVolume(data.energy.equivalents.nuclearWasteMl) })}</li>
          <li>${t("dashboard:energy.calc.eq.wind", { totalKwh: (data.energy.totalEnergyWh / 1000).toFixed(2), value: data.energy.equivalents.windRotations.toFixed(1), minutes: (data.energy.totalEnergyWh / 17500).toFixed(1) })}</li>
          <li>${t("dashboard:energy.calc.eq.hydro", { totalKwh: (data.energy.totalEnergyWh / 1000).toFixed(2), value: formatWaterVolume(data.energy.equivalents.hydroTurbineLiters) })}</li>
          <li>${t("dashboard:energy.calc.eq.solar", {
            totalKwh: (data.energy.totalEnergyWh / 1000).toFixed(2),
            regionYield: REGIONS[data.energy.equivalents.solarRegionKey]?.solarYield ?? 210,
            region: REGIONS[data.energy.equivalents.solarRegionKey]?.name ?? data.energy.equivalents.solarRegionKey,
            periodDays: data.energy.periodDays,
            value: (data.energy.equivalents.solarPanelM2 >= 1 ? `${data.energy.equivalents.solarPanelM2.toFixed(2)} m²` : `${Math.round(data.energy.equivalents.solarPanelM2 * 10000)} cm²`),
          })}</li>
        </ul>
      </div>
    </details>

    <!-- Data sources -->
    <div style="background:#1a1f3a;border-radius:6px;padding:1rem;margin-top:1rem;">
      <h2 style="margin:0 0 0.6rem 0;font-size:0.85rem;color:#a0c4ff;">${t("dashboard:energy.sources.title")}</h2>
      <ul style="list-style:none;padding:0;margin:0;font-size:0.65rem;color:#aaa;line-height:1.5;">
        ${[
          "methodology", "pue", "gridIntensity", "solarYield", "windTurbine",
          "hydroTurbine", "carKm", "transit", "train", "tree", "naturalGas", "nuclearWaste",
        ].map(k => `<li style="padding:0.15rem 0;"><span style="color:#a0c4ff;font-weight:600;">${t(`dashboard:energy.sources.items.${k}.label`)}:</span> ${t(`dashboard:energy.sources.items.${k}.value`)}</li>`).join("")}
      </ul>
    </div>

    <!-- Disclaimer -->
    <p style="font-size:0.6rem;color:#666;text-align:center;margin-top:0.5rem;">${t("dashboard:energy.disclaimer")}</p>
  </div>
  ` : ""}

  <!-- ═══════════════ TAB: Settings ═══════════════ -->
  <div class="tab-panel" id="tab-classify">
    <div class="summary-bar" style="margin-bottom:1rem;">
      <div class="summary-card" style="grid-column: 1 / -1; text-align: left; padding: 1rem;">
        <h2 style="margin:0 0 0.35rem 0; font-size:1rem; color:#a0c4ff;">${t("dashboard:classify.title")}</h2>
        <p style="font-size:0.75rem; color:#aaa; margin:0 0 0.75rem 0;">${t("dashboard:classify.intro")}</p>
        <div id="classify-coverage" style="font-size:0.8rem; color:#ccc; margin-bottom:0.75rem;"></div>
        <div id="classify-empty" style="display:none; font-size:0.8rem; color:#888;">${t("dashboard:classify.empty")}</div>
        <div id="classify-vscode-only" style="display:none; font-size:0.8rem; color:#888;">${t("dashboard:classify.vscodeOnly")}</div>
        <div id="classify-no-accounts" style="display:none; font-size:0.8rem; color:#888;">${t("dashboard:classify.noAccounts")}</div>
        <div id="classify-unlinked-hint" style="display:none; font-size:0.65rem; color:#e0af68; margin-bottom:0.75rem; line-height:1.4;">${t("dashboard:classify.unlinkedHint")}</div>
        <div id="classify-list"></div>
        <div style="display:flex; align-items:center; gap:0.75rem; margin-top:1rem;">
          <button type="button" id="classify-apply" disabled style="padding:0.5rem 1.5rem; background:#4e79a7; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:0.8rem; opacity:0.5;">${t("dashboard:classify.apply")}</button>
          <span id="classify-status" style="font-size:0.75rem; color:#59a14f;"></span>
        </div>
        <div style="font-size:0.65rem; color:#777; margin-top:0.75rem; line-height:1.5;">${t("dashboard:classify.splitHint")}</div>
      </div>
    </div>
  </div>

  <div class="tab-panel" id="tab-settings">
    <div class="summary-bar" style="margin-bottom:1rem;">
      <div class="summary-card" style="grid-column: 1 / -1; text-align: left; padding: 1rem;">
        <h2 style="margin:0 0 0.75rem 0; font-size:1rem; color:#a0c4ff;">${t("dashboard:settings.configuration")}</h2>
        <p style="font-size:0.75rem; color:#aaa; margin:0 0 1rem 0;">${t("dashboard:settings.settingsPath")}</p>

        <form id="settings-form" style="display:flex; flex-direction:column; gap:1rem; max-width:400px;">
          <div>
            <label style="display:block; font-size:0.75rem; color:#ccc; margin-bottom:0.3rem;">${t("dashboard:settings.subscriptions")}</label>
            <div style="font-size:0.6rem; color:#999; margin-bottom:0.5rem;">${t("dashboard:settings.subscriptionsHint")}</div>
            <div style="font-size:0.6rem; color:#777; margin-bottom:0.5rem;">${t("dashboard:settings.subscriptionsAutoDetectHint")}</div>
            <div id="account-fees-rows"></div>
            <div id="account-fees-empty" style="font-size:0.7rem; color:#888; display:none;">${t("dashboard:settings.noAccounts")}</div>
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
      // ── Account selector ─────────────────────────────────────────────────
      // Empty value means "all accounts combined"; drop the param so the URL
      // stays clean and the server treats it as the default.
      window.changeAccount = function (val) {
        var url = new URL(window.location.href);
        if (!val) url.searchParams.delete('account');
        else url.searchParams.set('account', val);
        window.location.href = url.toString();
      };
      window.doRefresh = function () { location.reload(); };

      // ── Auto-refresh toggle ───────────────────────────────────────────────
      var refreshSecs = parseInt(urlParam('refresh') || '0', 10);
      var autoBtn = document.getElementById('autorefresh-btn');
      if (refreshSecs > 0) {
        if (autoBtn) autoBtn.textContent = '${jsStr(t("dashboard:toolbar.autoOn", { seconds: "__SECS__" }))}'.replace('__SECS__', refreshSecs);
        setTimeout(function () { location.reload(); }, refreshSecs * 1000);
      }
      window.toggleRefresh = function () {
        window.location.href = refreshSecs > 0 ? setUrlParam('refresh', null) : setUrlParam('refresh', '120');
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
          case 'classify': initClassify(); break;
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
        // Subscription fee by project — one pie per currency block. Idle
        // (unattributed) pools are folded into a single gray "Idle" slice so
        // the pie still sums to the full period total, not just the
        // attributed portion.
        (function () {
          var fee = d.feeAttribution;
          if (!fee || !fee.configured) return;
          function fmtCurrency(n, currency) {
            try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency }).format(n); }
            catch (e) { return currency + ' ' + n.toFixed(2); }
          }
          fee.byCurrency.forEach(function (block, blockIdx) {
            var el = document.getElementById('chart-fees-' + blockIdx);
            if (!el) return;
            var ctx = el.getContext('2d');
            var idleTotal = block.idle.reduce(function (s, it) { return s + it.amount; }, 0);
            var hasIdle = idleTotal > 0;
            var maxProjects = hasIdle ? COLORS.length - 1 : COLORS.length;
            var top = block.perProject.slice(0, maxProjects);
            var labels = top.map(function (p) {
              var parts = p.projectPath.replace(/\\\\/g, '/').split('/').filter(Boolean);
              return parts.length >= 2 ? parts.slice(-2).join('/') : (parts[parts.length - 1] || p.projectPath);
            });
            var values = top.map(function (p) { return p.amount; });
            var colors = COLORS.slice(0, top.length);
            if (hasIdle) {
              labels.push('${jsStr(t("dashboard:fees.idleSliceLabel"))}');
              values.push(idleTotal);
              colors.push('#bab0ac');
            }
            var grand = block.periodTotal;
            new Chart(ctx, {
              type: 'doughnut',
              data: { labels: labels, datasets: [{ data: values, backgroundColor: colors }] },
              options: Object.assign({}, chartOpts, {
                plugins: {
                  legend: chartOpts.plugins.legend,
                  tooltip: {
                    callbacks: {
                      label: function (context) {
                        var val = context.parsed;
                        var pct = grand > 0 ? ((val / grand) * 100).toFixed(1) : '0.0';
                        return ' ' + fmtCurrency(val, block.currency) + ' (' + pct + '%)';
                      }
                    }
                  }
                }
              })
            });
          });
        }());

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

        // Token share pie
        (function () {
          var ctx = document.getElementById('chart-project-tokens').getContext('2d');
          var top10 = d.byProject.slice(0, 10);
          var labels = top10.map(function (r) { var parts = r.projectPath.replace(/\\\\/g, '/').split('/').filter(Boolean); return parts.length >= 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || r.projectPath; });
          var totals = top10.map(function (r) { return r.inputTokens + r.outputTokens; });
          var grand = totals.reduce(function (a, b) { return a + b; }, 0);
          new Chart(ctx, {
            type: 'doughnut',
            data: {
              labels: labels,
              datasets: [{ data: totals, backgroundColor: COLORS }]
            },
            options: Object.assign({}, chartOpts, {
              plugins: {
                tooltip: {
                  callbacks: {
                    label: function (context) {
                      var val = context.parsed;
                      var pct = grand > 0 ? ((val / grand) * 100).toFixed(1) : '0.0';
                      return ' ' + fmtTokens(val) + ' (' + pct + '%)';
                    }
                  }
                }
              }
            })
          });
        }());

        // Energy share pie
        (function () {
          var el = document.getElementById('chart-project-energy');
          if (!el || !d.energy || !d.energy.byProject || d.energy.byProject.length === 0) return;
          var ctx = el.getContext('2d');
          var top10 = d.energy.byProject.slice(0, 10);
          var labels = top10.map(function (r) { var parts = r.project.replace(/\\\\/g, '/').split('/').filter(Boolean); return parts.length >= 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || r.project; });
          var values = top10.map(function (r) { return r.energyWh; });
          var grandWh = values.reduce(function (a, b) { return a + b; }, 0);
          var fmtWh = function (wh) {
            if (wh >= 1000) return (wh / 1000).toFixed(2) + ' kWh';
            if (wh >= 10) return wh.toFixed(1) + ' Wh';
            if (wh >= 1) return wh.toFixed(2) + ' Wh';
            return (wh * 1000).toFixed(1) + ' mWh';
          };
          new Chart(ctx, {
            type: 'doughnut',
            data: {
              labels: labels,
              datasets: [{ data: values, backgroundColor: COLORS }]
            },
            options: Object.assign({}, chartOpts, {
              plugins: {
                tooltip: {
                  callbacks: {
                    label: function (context) {
                      var val = context.parsed;
                      var pct = grandWh > 0 ? ((val / grandWh) * 100).toFixed(1) : '0.0';
                      return ' ' + fmtWh(val) + ' (' + pct + '%)';
                    }
                  }
                }
              }
            })
          });
        }());

        // Thinking intensity (thinking blocks per prompt by project)
        (function () {
          var ctx = document.getElementById('chart-project-thinking').getContext('2d');
          var top10 = d.byProject.slice(0, 10).filter(function (r) { return r.prompts > 0; });
          var labels = top10.map(function (r) { var parts = r.projectPath.replace(/\\\\/g, '/').split('/').filter(Boolean); return parts.length >= 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || r.projectPath; });
          var intensity = top10.map(function (r) { return Math.round((r.thinkingBlocks / r.prompts) * 100) / 100; });
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [{
                label: 'Thinking blocks / prompt',
                data: intensity,
                backgroundColor: top10.map(function (_, i) { return COLORS[i % COLORS.length]; })
              }]
            },
            options: Object.assign({}, chartOpts, {
              indexAxis: 'y',
              scales: {
                x: { title: { display: true, text: 'Thinking blocks per prompt', color: '#888' }, beginAtZero: true },
                y: {}
              },
              plugins: {
                tooltip: {
                  callbacks: {
                    afterLabel: function (context) {
                      var p = top10[context.dataIndex];
                      return p.thinkingBlocks + ' blocks across ' + p.prompts + ' prompts';
                    }
                  }
                }
              }
            })
          });
        }());

        // Nature of work (stacked bar of work categories per project)
        (function () {
          var ctx = document.getElementById('chart-work-profile').getContext('2d');
          var top10 = d.byProject.slice(0, 10).filter(function (r) {
            var wp = r.workProfile;
            return wp && (wp.exploring + wp.editing + wp.running + wp.researching + wp.planning) > 0;
          });
          if (top10.length === 0) return;
          var labels = top10.map(function (r) { var parts = r.projectPath.replace(/\\\\/g, '/').split('/').filter(Boolean); return parts.length >= 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || r.projectPath; });
          // Compute percentages
          var pcts = top10.map(function (r) {
            var wp = r.workProfile;
            var total = wp.exploring + wp.editing + wp.running + wp.researching + wp.planning;
            if (total === 0) return { exploring: 0, editing: 0, running: 0, researching: 0, planning: 0 };
            return {
              exploring: (wp.exploring / total) * 100,
              editing: (wp.editing / total) * 100,
              running: (wp.running / total) * 100,
              researching: (wp.researching / total) * 100,
              planning: (wp.planning / total) * 100
            };
          });
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [
                { label: 'Exploring', data: pcts.map(function (p) { return p.exploring; }), backgroundColor: '#4e79a7' },
                { label: 'Editing', data: pcts.map(function (p) { return p.editing; }), backgroundColor: '#59a14f' },
                { label: 'Running', data: pcts.map(function (p) { return p.running; }), backgroundColor: '#f28e2b' },
                { label: 'Researching', data: pcts.map(function (p) { return p.researching; }), backgroundColor: '#b07aa1' },
                { label: 'Planning', data: pcts.map(function (p) { return p.planning; }), backgroundColor: '#76b7b2' }
              ]
            },
            options: Object.assign({}, chartOpts, {
              indexAxis: 'y',
              scales: {
                x: { stacked: true, max: 100, ticks: { callback: function(v) { return v + '%'; } } },
                y: { stacked: true }
              },
              plugins: {
                tooltip: {
                  callbacks: {
                    label: function (context) {
                      return ' ' + context.dataset.label + ': ' + context.parsed.x.toFixed(1) + '%';
                    }
                  }
                }
              }
            })
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
                tooltip: { callbacks: { afterTitle: function(items) { var w = windows[items[0].dataIndex]; return w && w.throttled ? '⚠ Contains truncated output' : ''; } } }
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
          var labels = top.map(function (c) {
            var parts = (c.projectPath || '').replace(/\\\\/g, '/').split('/').filter(Boolean);
            var proj = parts.length >= 2 ? parts[parts.length - 2] + '/' + parts[parts.length - 1] : (parts[parts.length - 1] || c.projectPath);
            return proj + ' (' + c.sessionId.slice(0, 6) + ')';
          });
          var costs = top.map(function (c) { return c.estimatedCost; });
          var bgColors = top.map(function (_, i) { return COLORS[i % COLORS.length]; });
          new Chart(ctx, {
            type: 'bar',
            data: { labels: labels, datasets: [{ label: 'Est. API Cost ($)', data: costs, backgroundColor: bgColors }] },
            options: Object.assign({}, chartOpts, {
              indexAxis: 'y',
              maintainAspectRatio: false,
              layout: { padding: { left: 4 } },
              plugins: Object.assign({}, chartOpts.plugins, {
                tooltip: { callbacks: { afterLabel: function(ctx) { var c = top[ctx.dataIndex]; var lines = ['Prompts: ' + c.promptCount]; if (c.percentOfPlanFee > 0) lines.push(c.percentOfPlanFee.toFixed(1) + '% of plan fee'); if (c.dominantModel) lines.push('Model: ' + c.dominantModel); return lines; } } }
              }),
              scales: {
                x: { title: { display: true, text: 'API Value ($)', color: '#888' }, ticks: { callback: function(v) { return '$' + v.toFixed(3); } } },
                y: {
                  ticks: {
                    autoSkip: false,
                    font: { size: 10 },
                    crossAlign: 'far',
                    callback: function(_, i) { return labels[i]; }
                  },
                  afterFit: function(scale) { scale.width = Math.min(360, Math.max(180, scale.chart.width * 0.40)); }
                }
              }
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

        // 1b. Per-window API-equivalent cost.
        // We don't have a reliable rate-limit signal from the JSONL, so we show absolute
        // cost per window rather than a fabricated "% of limit" value.
        (function () {
          var el = document.getElementById('chart-window-limit-pct');
          if (!el || !d.byWindow || d.byWindow.length === 0) return;
          var ctx = el.getContext('2d');
          var sorted = d.byWindow.slice().sort(function (a, b) { return a.windowStart - b.windowStart; });
          var labels = sorted.map(function (w) { return new Date(w.windowStart).toISOString().slice(5, 16).replace('T', ' '); });
          var costs = sorted.map(function (w) { return Math.round(w.totalCostEquivalent * 1000) / 1000; });
          var costColors = sorted.map(function (w) { return w.throttled ? '#f28e2b' : '#4e79a7'; });
          new Chart(ctx, {
            type: 'bar',
            data: { labels: labels, datasets: [{ label: 'API Cost ($)', data: costs, backgroundColor: costColors }] },
            options: Object.assign({}, chartOpts, {
              plugins: Object.assign({}, chartOpts.plugins, {
                legend: { display: false },
                title: { display: true, text: 'API-equivalent cost per 5-hour window (orange = window contained a truncated output)', color: '#888', font: { size: 10 } },
                tooltip: { callbacks: { label: function(ctx) { return '$' + ctx.parsed.y.toFixed(3) + ' API-equivalent'; } } }
              }),
              scales: {
                x: { ticks: { maxRotation: 45, font: { size: 9 } } },
                y: { title: { display: true, text: 'Cost ($)', color: '#888' }, ticks: { callback: function(v) { return '$' + v; } } }
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
          var truncatedCounts = d.byWeek.map(function (w) { return w.windowsWithTruncatedOutput; });
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [
                { label: 'Normal Windows', data: windowCounts.map(function (c, i) { return c - truncatedCounts[i]; }), backgroundColor: '#4e79a7' },
                { label: 'Windows w/ Truncated Output', data: truncatedCounts, backgroundColor: '#f28e2b' }
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

      // Handle responses from VS Code extension (config + cluster I/O share the
      // callbackId map — both resolve a pending request by its id).
      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (msg && (msg.command === 'configResult' || msg.command === 'clustersResult') && msg.callbackId) {
          var cb = _configCallbacks[msg.callbackId];
          delete _configCallbacks[msg.callbackId];
          if (cb) cb(msg.error || null, msg.data);
        }
      });

      // Cluster I/O for the Classify tab. getClustersAsync mirrors
      // loadConfigAsync (request/response over the callbackId map);
      // applyClassificationAsync is fire-and-forget — the host reattributes and
      // triggers a full refresh, so there is no response to await. Both are
      // VS Code-only: the read-only served dashboard has no write channel.
      function getClustersAsync(callback) {
        if (typeof window.__vscodeApi !== 'undefined') {
          var id = ++_configCallbackId;
          _configCallbacks[id] = callback;
          window.__vscodeApi.postMessage({ command: 'getClusters', callbackId: id });
        } else {
          callback(new Error('unavailable'));
        }
      }
      function applyClassificationAsync(assignments) {
        if (typeof window.__vscodeApi !== 'undefined') {
          window.__vscodeApi.postMessage({ command: 'applyClassification', assignments: assignments });
        }
      }

      function populateSettingsForm(cfg) {
        var threshDay = document.getElementById('cfg-threshold-day');
        var threshWeek = document.getElementById('cfg-threshold-week');
        var threshMonth = document.getElementById('cfg-threshold-month');

        if (cfg.costThresholds) {
          if (cfg.costThresholds.day != null) threshDay.value = cfg.costThresholds.day;
          if (cfg.costThresholds.week != null) threshWeek.value = cfg.costThresholds.week;
          if (cfg.costThresholds.month != null) threshMonth.value = cfg.costThresholds.month;
        }
        renderAccountFees(cfg);
      }

      // Per-account plan types + their default monthly fee (USD). Labels are
      // localized server-side; the fee map mirrors core/pricing PLAN_FEES so
      // selecting a type auto-fills its default amount.
      var PLAN_OPTIONS = [
        { value: '', label: '${jsStr(t("dashboard:settings.notSetAutoDetect"))}' },
        { value: 'pro', label: '${jsStr(t("dashboard:settings.planOptions.pro"))}' },
        { value: 'max_5x', label: '${jsStr(t("dashboard:settings.planOptions.max_5x"))}' },
        { value: 'max_20x', label: '${jsStr(t("dashboard:settings.planOptions.max_20x"))}' },
        { value: 'team_standard', label: '${jsStr(t("dashboard:settings.planOptions.team_standard"))}' },
        { value: 'team_premium', label: '${jsStr(t("dashboard:settings.planOptions.team_premium"))}' },
        { value: 'custom', label: '${jsStr(t("dashboard:settings.planOptions.custom"))}' }
      ];
      var PLAN_FEE_DEFAULTS = { pro: 20, max_5x: 100, max_20x: 200, team_standard: 25, team_premium: 125 };

      // Static USD-based FX rates for converting a plan's default fee into the
      // account's selected currency. This dashboard makes no runtime network
      // calls (fully local/offline tool), so these are approximate, point-in-
      // time figures — refresh them occasionally rather than treating them as
      // exact. Unlisted currencies fall back to a 1:1 rate.
      var FX_RATES_FROM_USD = { USD: 1, EUR: 0.92, GBP: 0.79, CAD: 1.36, AUD: 1.52, JPY: 150, CHF: 0.88, SEK: 10.3 };

      // Default fee for a plan type, converted to the given currency and
      // rounded to match the amount input's step="1" granularity.
      function planFeeDefaultInCurrency(planTypeValue, currencyCode) {
        var usd = PLAN_FEE_DEFAULTS[planTypeValue];
        if (usd == null) return null;
        var rate = FX_RATES_FROM_USD[currencyCode] || 1;
        return Math.round(usd * rate);
      }

      // Best-effort map of a telemetry subscriptionType string to a plan-type
      // option value (normalises case/separators); '' when it doesn't match.
      function normalizePlanType(sub) {
        if (!sub) return '';
        var k = String(sub).toLowerCase().replace(/[- ]/g, '_');
        if (PLAN_FEE_DEFAULTS[k] != null) return k;
        for (var key in PLAN_FEE_DEFAULTS) {
          if (k.indexOf(key) === 0) return key;
        }
        return '';
      }

      // Build one fee row per account from cfg.accounts. Uses createElement +
      // textContent/value (never innerHTML) so account labels/UUIDs can't inject.
      var FEE_CURRENCIES = ['USD','EUR','GBP','CAD','AUD','JPY','CHF','SEK'];
      function renderAccountFees(cfg) {
        var rows = document.getElementById('account-fees-rows');
        var empty = document.getElementById('account-fees-empty');
        if (!rows) return;
        rows.textContent = '';
        var accounts = (cfg && cfg.accounts) || [];
        var fees = (cfg && cfg.accountFees) || {};
        if (!accounts.length) { if (empty) empty.style.display = 'block'; return; }
        if (empty) empty.style.display = 'none';
        accounts.forEach(function (a) {
          var fee = fees[a.accountUuid] || {};
          var row = document.createElement('div');
          row.className = 'account-fee-row';
          row.setAttribute('data-account', a.accountUuid);
          row.style.cssText = 'display:grid; grid-template-columns:1fr 5rem 4rem; gap:0.4rem; align-items:center; margin-bottom:0.6rem;';

          var name = document.createElement('div');
          name.style.cssText = 'grid-column:1 / -1; font-size:0.72rem; color:#e8e8e8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
          name.textContent = a.email || (a.accountUuid.slice(0, 8) + '…');
          // Use the derived plan label (e.g. "Max 20x") rather than the raw
          // subscription type string. planLabel is always populated by
          // buildAccountsForConfig and never exposes raw tier/billing data.
          name.title = a.accountUuid + ' · ' + (a.planLabel || a.subscriptionType || '') + ' · ' + a.sessionCount + ' sessions';
          row.appendChild(name);

          if (!a.email) {
            var unlinkedHint = document.createElement('div');
            unlinkedHint.style.cssText = 'grid-column:1 / -1; font-size:0.62rem; color:#e0af68; line-height:1.3;';
            unlinkedHint.textContent = '${jsStr(t("dashboard:settings.unlinkedAccountHint"))}';
            row.appendChild(unlinkedHint);
          }

          // Per-account plan type. Default: explicitly-saved type, else the
          // telemetry-detected subscription type, else "auto".
          var planType = document.createElement('select');
          planType.className = 'acct-fee-type';
          planType.style.cssText = 'width:100%; padding:0.3rem; background:#16213e; color:#eee; border:1px solid #0f3460; border-radius:4px; font-size:0.75rem; box-sizing:border-box;';
          var selectedType = fee.type || normalizePlanType(a.subscriptionType);
          PLAN_OPTIONS.forEach(function (o) {
            var opt = document.createElement('option');
            opt.value = o.value; opt.textContent = o.label;
            if (o.value === selectedType) opt.selected = true;
            planType.appendChild(opt);
          });
          row.appendChild(planType);

          // Resolved before the amount input so the initial pre-fill (below)
          // converts into the account's already-selected currency.
          var selectedCurrency = (fee.currency || 'USD').toUpperCase();

          var amount = document.createElement('input');
          amount.type = 'number'; amount.min = '0'; amount.step = '1';
          amount.className = 'acct-fee-amount';
          amount.style.cssText = 'width:100%; padding:0.3rem; background:#16213e; color:#eee; border:1px solid #0f3460; border-radius:4px; font-size:0.75rem; box-sizing:border-box;';
          if (fee.monthlyFee != null) {
            amount.value = fee.monthlyFee;
          } else {
            // No saved fee yet, but a plan is already selected (saved type or
            // telemetry-detected) — pre-fill its default, converted to the
            // selected currency, so the field isn't blank on first render;
            // still a plain editable number input.
            var initialDefault = planFeeDefaultInCurrency(selectedType, selectedCurrency);
            if (initialDefault != null) amount.value = initialDefault;
          }
          amount.placeholder = '${jsStr(t("dashboard:settings.feePlaceholder"))}';
          row.appendChild(amount);

          // Selecting a known plan type fills its default fee, converted to
          // whatever currency is currently selected (still editable).
          planType.addEventListener('change', function () {
            var def = planFeeDefaultInCurrency(planType.value, currency.value);
            if (def != null) amount.value = def;
          });

          var currency = document.createElement('select');
          currency.className = 'acct-fee-currency';
          currency.style.cssText = 'width:100%; padding:0.3rem; background:#16213e; color:#eee; border:1px solid #0f3460; border-radius:4px; font-size:0.75rem; box-sizing:border-box;';
          if (FEE_CURRENCIES.indexOf(selectedCurrency) === -1) FEE_CURRENCIES.push(selectedCurrency);
          FEE_CURRENCIES.forEach(function (code) {
            var opt = document.createElement('option');
            opt.value = code; opt.textContent = code;
            if (code === selectedCurrency) opt.selected = true;
            currency.appendChild(opt);
          });
          row.appendChild(currency);

          var labelInput = document.createElement('input');
          labelInput.type = 'text'; labelInput.maxLength = 100;
          labelInput.className = 'acct-fee-label';
          labelInput.style.cssText = 'grid-column:1 / -1; width:100%; padding:0.3rem; background:#16213e; color:#eee; border:1px solid #0f3460; border-radius:4px; font-size:0.7rem; box-sizing:border-box;';
          labelInput.placeholder = '${jsStr(t("dashboard:settings.labelPlaceholder"))}';
          if (fee.label) labelInput.value = fee.label;
          row.appendChild(labelInput);

          rows.appendChild(row);
        });
      }

      function collectAccountFees() {
        var out = {};
        var rowEls = document.querySelectorAll('#account-fees-rows .account-fee-row');
        for (var i = 0; i < rowEls.length; i++) {
          var row = rowEls[i];
          var uuid = row.getAttribute('data-account');
          var type = row.querySelector('.acct-fee-type').value;
          var amt = row.querySelector('.acct-fee-amount').value;
          var num = (amt === '' || amt == null) ? null : parseFloat(amt);
          var hasFee = num != null && isFinite(num) && num >= 0;
          // Keep a row that carries a fee OR a non-custom plan type (the type
          // implies a default fee server-side). A bare "auto"/custom row with no
          // fee is dropped.
          if (!hasFee && (type === '' || type === 'custom')) continue;
          var entry = {};
          if (hasFee) entry.monthlyFee = num;
          if (type) entry.type = type;
          var cur = row.querySelector('.acct-fee-currency').value;
          if (cur) entry.currency = cur;
          var lbl = row.querySelector('.acct-fee-label').value;
          if (lbl) entry.label = lbl;
          out[uuid] = entry;
        }
        return out;
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

      // ═══════════════ CLASSIFY (cost-ownership) ═══════════════
      // VS Code webview only. Shows cost-ranked project clusters; the user
      // assigns each to a subscription or split. Assignments batch into a
      // pending map and apply in one message; the host reattributes + refreshes.
      function initClassify() {
        var listEl = document.getElementById('classify-list');
        var coverageEl = document.getElementById('classify-coverage');
        var emptyEl = document.getElementById('classify-empty');
        var vscodeOnlyEl = document.getElementById('classify-vscode-only');
        var noAcctEl = document.getElementById('classify-no-accounts');
        var unlinkedHintEl = document.getElementById('classify-unlinked-hint');
        var applyBtn = document.getElementById('classify-apply');
        var statusEl = document.getElementById('classify-status');
        if (!listEl) return;

        // Classification needs the write channel; the served dashboard is
        // read-only. Show a note and stop.
        if (typeof window.__vscodeApi === 'undefined') {
          if (vscodeOnlyEl) vscodeOnlyEl.style.display = 'block';
          if (applyBtn) applyBtn.style.display = 'none';
          return;
        }

        var LBL_UNASSIGNED = '${jsStr(t("dashboard:classify.optionUnassigned"))}';
        var LBL_SPLIT = '${jsStr(t("dashboard:classify.optionSplit"))}';
        var COVERAGE_TMPL = '${jsStr(t("dashboard:classify.coverage"))}';
        var PENDING_TMPL = '${jsStr(t("dashboard:classify.pending"))}';
        var SESSIONS_TMPL = '${jsStr(t("dashboard:classify.sessions"))}';
        var PROJECTS_TMPL = '${jsStr(t("dashboard:classify.projects"))}';
        var REMOTE_BADGE = '${jsStr(t("dashboard:classify.remoteBadge"))}';
        var PATH_BADGE = '${jsStr(t("dashboard:classify.pathBadge"))}';
        var APPLYING_MSG = '${jsStr(t("dashboard:classify.applying"))}';
        var UNLINKED_HINT = '${jsStr(t("dashboard:classify.unlinkedHint"))}';
        var SPLIT_VALUE = '__split__';

        var pending = {}; // clusterKey -> { suggestedMatcher, target }

        function fmtMoney(n) { return '$' + (n || 0).toFixed(2); }
        function targetValue(tt) {
          if (!tt) return '';
          if (tt.kind === 'split') return SPLIT_VALUE;
          if (tt.kind === 'account') return tt.accountUuid;
          return '';
        }
        function valueToTarget(v) {
          if (!v) return null;
          if (v === SPLIT_VALUE) return { kind: 'split' };
          return { kind: 'account', accountUuid: v };
        }
        function updateApplyState() {
          var count = Object.keys(pending).length;
          if (applyBtn) {
            applyBtn.disabled = count === 0;
            applyBtn.style.opacity = count === 0 ? '0.5' : '1';
          }
          if (statusEl) {
            statusEl.style.color = '#e0af68';
            statusEl.textContent = count === 0 ? '' : PENDING_TMPL.replace('__COUNT__', String(count));
          }
        }

        function render(data) {
          var clusters = (data && data.clusters) || [];
          var accounts = (data && data.accounts) || [];
          listEl.textContent = '';
          if (noAcctEl) noAcctEl.style.display = accounts.length === 0 ? 'block' : 'none';
          if (unlinkedHintEl) {
            var hasUnlinked = accounts.some(function (a) { return !a.email; });
            unlinkedHintEl.style.display = hasUnlinked ? 'block' : 'none';
          }
          if (!clusters.length) {
            if (emptyEl) emptyEl.style.display = 'block';
            if (coverageEl) coverageEl.textContent = '';
            return;
          }
          if (emptyEl) emptyEl.style.display = 'none';

          var total = (data && data.totalCost) || 0;
          var classified = (data && data.classifiedCost) || 0;
          var pct = total > 0 ? Math.round((classified / total) * 100) : 0;
          if (coverageEl) {
            coverageEl.style.color = '#ccc';
            coverageEl.textContent = COVERAGE_TMPL
              .replace('__CLASSIFIED__', classified.toFixed(2))
              .replace('__TOTAL__', total.toFixed(2))
              .replace('__PERCENT__', String(pct));
          }

          clusters.forEach(function (c) {
            var row = document.createElement('div');
            row.style.cssText = 'display:grid; grid-template-columns:1fr auto 12rem; gap:0.6rem; align-items:center; padding:0.5rem 0; border-top:1px solid #2a2a4a;';

            var left = document.createElement('div');
            left.style.cssText = 'min-width:0;';
            var name = document.createElement('div');
            name.style.cssText = 'font-size:0.8rem; color:#e8e8e8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            name.textContent = c.label;
            name.title = (c.projectPaths || []).join('\\n');
            left.appendChild(name);
            var sub = document.createElement('div');
            sub.style.cssText = 'font-size:0.65rem; color:#999;';
            var subParts = [SESSIONS_TMPL.replace('__COUNT__', String(c.sessionCount))];
            if ((c.projectPaths || []).length > 1) {
              subParts.push(PROJECTS_TMPL.replace('__COUNT__', String(c.projectPaths.length)));
            }
            subParts.push(c.kind === 'remote' ? REMOTE_BADGE : PATH_BADGE);
            sub.textContent = subParts.join(' · ');
            left.appendChild(sub);
            row.appendChild(left);

            var cost = document.createElement('div');
            cost.style.cssText = 'font-size:0.8rem; color:#a0c4ff; text-align:right; font-variant-numeric:tabular-nums;';
            cost.textContent = fmtMoney(c.estimatedCost);
            row.appendChild(cost);

            var sel = document.createElement('select');
            sel.style.cssText = 'width:100%; padding:0.3rem; background:#16213e; color:#eee; border:1px solid #0f3460; border-radius:4px; font-size:0.72rem; box-sizing:border-box;';
            var optNone = document.createElement('option');
            optNone.value = ''; optNone.textContent = LBL_UNASSIGNED;
            sel.appendChild(optNone);
            accounts.forEach(function (a) {
              var opt = document.createElement('option');
              opt.value = a.accountUuid;
              var label = a.email || a.planLabel || (a.accountUuid.slice(0, 8) + '…');
              if (!a.email) {
                label += ' (' + a.accountUuid.slice(0, 8) + '…)';
                opt.title = UNLINKED_HINT;
              }
              opt.textContent = label;
              sel.appendChild(opt);
            });
            var optSplit = document.createElement('option');
            optSplit.value = SPLIT_VALUE; optSplit.textContent = LBL_SPLIT;
            sel.appendChild(optSplit);

            var currentVal = targetValue(c.currentTarget);
            // If the current owner is an account not in the dropdown (e.g. from a
            // CLI rule for an account with no recorded sessions), add it so the
            // select reflects the real value instead of silently resetting.
            if (currentVal && currentVal !== SPLIT_VALUE && !accounts.some(function (a) { return a.accountUuid === currentVal; })) {
              var optUnknown = document.createElement('option');
              optUnknown.value = currentVal; optUnknown.textContent = currentVal.slice(0, 8) + '…';
              sel.appendChild(optUnknown);
            }
            sel.value = currentVal;

            sel.addEventListener('change', function () {
              var origVal = targetValue(c.currentTarget);
              if (sel.value === origVal) delete pending[c.key];
              else pending[c.key] = { suggestedMatcher: c.suggestedMatcher, target: valueToTarget(sel.value) };
              updateApplyState();
            });
            row.appendChild(sel);

            listEl.appendChild(row);
          });
        }

        if (applyBtn) {
          applyBtn.addEventListener('click', function () {
            var assignments = Object.keys(pending).map(function (k) { return pending[k]; });
            if (!assignments.length) return;
            applyBtn.disabled = true;
            applyBtn.style.opacity = '0.5';
            if (statusEl) { statusEl.style.color = '#888'; statusEl.textContent = APPLYING_MSG; }
            // Fire-and-forget: the host reattributes then triggers a full
            // refresh() that re-renders this tab with the new attribution.
            applyClassificationAsync(assignments);
          });
        }

        getClustersAsync(function (err, data) {
          if (err) {
            if (coverageEl) { coverageEl.style.color = '#e15759'; coverageEl.textContent = String(err.message || err); }
            return;
          }
          pending = {};
          render(data);
          updateApplyState();
        });
      }

      function initSettings() {
        loadConfigAsync(function (err, cfg) {
          if (!err && cfg) populateSettingsForm(cfg);
        });

        document.getElementById('settings-form').addEventListener('submit', function (e) {
          e.preventDefault();
          var threshDay = document.getElementById('cfg-threshold-day').value;
          var threshWeek = document.getElementById('cfg-threshold-week').value;
          var threshMonth = document.getElementById('cfg-threshold-month').value;

          var config = {};
          config.costThresholds = {};
          if (threshDay) config.costThresholds.day = parseFloat(threshDay);
          if (threshWeek) config.costThresholds.week = parseFloat(threshWeek);
          if (threshMonth) config.costThresholds.month = parseFloat(threshMonth);
          config.accountFees = collectAccountFees();

          var statusEl = document.getElementById('settings-status');
          saveConfigAsync(config, function (err, result) {
            if (err) {
              statusEl.textContent = '${jsStr(t("dashboard:settings.networkError"))}';
              statusEl.style.color = '#e15759';
              statusEl.style.opacity = '1';
              return;
            }
            if (result && result.ok) {
              statusEl.textContent = '${jsStr(t("dashboard:settings.savedReload"))}';
              statusEl.style.color = '#59a14f';
            } else {
              statusEl.textContent = '${jsStr(t("dashboard:settings.errorSaving"))}';
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

/** Format a nuclear-waste volume: mm³ when <1 mL, mL when <1000, L otherwise. */
function formatNuclearVolume(ml: number): string {
  if (ml < 1) return `${Math.round(ml * 1000)} mm³`;
  if (ml < 1000) return `${ml.toFixed(1)} mL`;
  return `${(ml / 1000).toFixed(2)} L`;
}

/** Format a hydro-turbine water volume: L when <1000, m³ when <1,000,000, ML (megaliters) otherwise. */
function formatWaterVolume(liters: number): string {
  if (liters < 1000) return `${Math.round(liters)} L`;
  if (liters < 1_000_000) return `${(liters / 1000).toFixed(1)} m³`;
  return `${(liters / 1_000_000).toFixed(2)} ML`;
}

/** Format a natural-gas volume stored in m³: mL when <1 L, L when <1 m³, m³ otherwise. */
function formatNaturalGasVolume(m3: number): string {
  const liters = m3 * 1000;
  if (liters < 1) return `${(liters * 1000).toFixed(0)} mL`;
  if (liters < 1000) return `${liters.toFixed(1)} L`;
  return `${m3.toFixed(2)} m³`;
}

/** Format a large number with k/M suffix for display in summary bar. */
function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
