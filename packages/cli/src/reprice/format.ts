/**
 * Text rendering of a `RepriceResult` for `claude-stats reprice`. Pure
 * formatting over an already built result, like `printCostPerTask`: every word
 * goes through `t()`, including the equal-token-volume label.
 */
import { formatCost } from "@claude-stats/core/pricing";
import type { RepriceResult, RepriceUnpricedReason, UnpricedByReason } from "@claude-stats/core/repricing";
import { t } from "../i18n.js";

const REASON_KEY: Record<RepriceUnpricedReason, string> = {
  "fast-unpriced": "cli:reprice.reason.fastUnpriced",
  "speed-unknown": "cli:reprice.reason.speedUnknown",
  "unknown-model": "cli:reprice.reason.unknownModel",
};

function reasonsText(by: UnpricedByReason): string {
  return (Object.entries(by) as Array<[RepriceUnpricedReason, number]>)
    .map(([reason, rows]) => `${t(REASON_KEY[reason])}: ${rows}`)
    .join(", ");
}

/** The equal-token-volume label: one translated string for CLI, MCP and JSON. */
export function equalTokenVolumeNote(): string {
  return t("common:reprice.equalTokenVolumeNote");
}

export function printReprice(
  result: RepriceResult,
  window: { from: string; to: string },
  out: NodeJS.WritableStream = process.stdout,
  opts: { json?: boolean } = {},
): void {
  if (opts.json) {
    out.write(JSON.stringify({ window, ...result, equalTokenVolumeNote: equalTokenVolumeNote() }, null, 2) + "\n");
    return;
  }
  const write = (line: string) => out.write(line + "\n");
  const { model, asModel } = result;

  write("");
  write(`─── ${t("cli:reprice.title", { model, asModel, from: window.from, to: window.to })} ───`);
  write("");
  if (result.rows === 0) {
    write(t("cli:reprice.noRows", { model }));
    write("");
    return;
  }

  const money = (n: number): string => formatCost(n).padStart(12);
  const colRepriced = t("cli:reprice.colRepriced", { asModel });
  const repricedWidth = Math.max(colRepriced.length, 14) + 2;
  const lines: Array<[string, number, number]> = [
    [t("cli:reprice.input"), result.actual.input, result.counterfactual.input],
    [t("cli:reprice.output"), result.actual.output, result.counterfactual.output],
    [t("cli:reprice.cacheWrite5m"), result.actual.cacheWrite5m, result.counterfactual.cacheWrite5m],
    [t("cli:reprice.cacheWrite1h"), result.actual.cacheWrite1h, result.counterfactual.cacheWrite1h],
    [t("cli:reprice.cacheRead"), result.actual.cacheRead, result.counterfactual.cacheRead],
    [t("cli:reprice.total"), result.actual.total, result.counterfactual.total],
  ];
  // Width follows the longest label so a long translation cannot misalign the table.
  const labelWidth = Math.max(t("cli:reprice.colCategory").length, ...lines.map(([label]) => label.length)) + 2;
  write(t("cli:reprice.colCategory").padEnd(labelWidth) + t("cli:reprice.colActual").padStart(12) + colRepriced.padStart(repricedWidth));
  for (const [label, actual, repriced] of lines) {
    write(label.padEnd(labelWidth) + money(actual) + formatCost(repriced).padStart(repricedWidth));
  }
  write("");
  write(t("cli:reprice.rowsLine", { rows: result.rows, model }));
  if (result.cacheWriteUnattributedTokens > 0) {
    write(t("cli:reprice.unattributedWrite", { tokens: result.cacheWriteUnattributedTokens }));
  }
  if (result.unpriced.counterfactual.rows > 0) {
    write(
      t("cli:reprice.unpricedCounterfactual", {
        rows: result.unpriced.counterfactual.rows,
        asModel,
        reasons: reasonsText(result.unpriced.counterfactual.byReason),
        actualCost: formatCost(result.unpriced.counterfactual.actualCost),
      }),
    );
  }
  if (result.unpriced.actual.rows > 0) {
    write(
      t("cli:reprice.unpricedActual", {
        rows: result.unpriced.actual.rows,
        reasons: reasonsText(result.unpriced.actual.byReason),
      }),
    );
  }
  if (result.unpriced.counterfactual.rows > 0 || result.unpriced.actual.rows > 0) {
    write(
      t("cli:reprice.comparable", {
        asModel,
        actual: formatCost(result.comparable.actualTotal),
        repriced: formatCost(result.comparable.counterfactualTotal),
      }),
    );
  }
  write("");
  write(equalTokenVolumeNote());
  write("");
}
