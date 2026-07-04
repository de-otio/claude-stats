/**
 * `plan-advisor` CLI logic — parsing flag strings and formatting
 * `sizeSeats()` output into printable lines.
 *
 * The thin command wrapper lives in `cli/plan-advisor-commands.ts` (`cli/**`
 * is excluded from coverage); this module holds everything worth covering.
 * Pure: no I/O, no console, no `Date.now()` — every function here takes its
 * inputs and returns a value.
 */
import {
  sizeSeats,
  SeatSizingError,
  TEAM_SEAT_RANGE,
  type SeatScenarioTable,
  type TierMix,
} from "@claude-stats/core/planMechanics";
import { t } from "./i18n.js";

/** Raw (still-string) flags as commander hands them to the command action. */
export interface PlanAdvisorFlags {
  readonly headcount: string;
  readonly technicalFraction: string;
  readonly tierMix?: string;
  readonly compliance?: boolean;
}

export type PlanAdvisorOutcome =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Parse `--headcount`. Non-numeric input becomes `NaN`, which `sizeSeats`
 * rejects with `headcount-invalid` — no separate parse-failure path needed.
 */
export function parseHeadcountFlag(raw: string): number {
  return Number(raw);
}

/**
 * Parse `--technical-fraction`. Accepts either a fraction in [0, 1] or a
 * percentage (a trailing "%" is stripped; any parsed value greater than 1 is
 * treated as a percentage and divided by 100), so "0.5", "50", and "50%" all
 * mean the same thing. Non-numeric input becomes `NaN`, which `sizeSeats`
 * rejects with `fraction-invalid`.
 */
export function parseTechnicalFractionFlag(raw: string): number {
  const trimmed = raw.trim();
  const stripped = trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed;
  const n = Number(stripped);
  if (!Number.isFinite(n)) return NaN;
  return n > 1 ? n / 100 : n;
}

/**
 * Parse `--tier-mix light,typical,power`. A missing or non-numeric segment
 * becomes `NaN` for that field, which `sizeSeats` rejects with
 * `tiermix-invalid` — no separate structural-validation path needed.
 */
export function parseTierMixFlag(raw: string): TierMix {
  const parts = raw.split(",").map((p) => p.trim());
  return {
    light: Number(parts[0]),
    typical: Number(parts[1]),
    power: Number(parts[2]),
  };
}

/** Render a [0, 1] fraction as a percentage string, e.g. 0.5 -> "50". */
function formatPercent(fraction: number): string {
  return (Math.round(fraction * 1000) / 10).toString();
}

/**
 * Format a `SeatScenarioTable` into printable lines. `compliance` surfaces
 * the compliance open question prominently near the top — it never changes
 * a number or picks a plan; `sizeSeats()` never returns a verdict either way.
 */
export function formatPlanAdvisorReport(
  table: SeatScenarioTable,
  compliance: boolean,
): readonly string[] {
  const lines: string[] = [];

  lines.push(t("cli:planAdvisor.title"));
  lines.push(
    t("cli:planAdvisor.inputSummary", {
      headcount: table.headcount,
      fraction: formatPercent(table.technicalFraction),
      population: table.technicalPopulation,
    }),
  );
  lines.push(
    t("cli:planAdvisor.tierMixLine", {
      source:
        table.tierMixSource === "measured"
          ? t("cli:planAdvisor.tierMixSourceMeasured")
          : t("cli:planAdvisor.tierMixSourceBenchmark"),
      light: formatPercent(table.tierMix.light),
      typical: formatPercent(table.tierMix.typical),
      power: formatPercent(table.tierMix.power),
    }),
  );
  lines.push(t("cli:planAdvisor.seatRanges"));

  if (compliance) {
    lines.push("");
    lines.push(t("cli:planAdvisor.complianceHeader"));
    lines.push(`  ${t("cli:planAdvisor.openQuestions.compliance")}`);
  }

  lines.push("");
  lines.push(
    [
      t("cli:planAdvisor.col.adoption"),
      t("cli:planAdvisor.col.seats"),
      t("cli:planAdvisor.col.fitsTeam"),
      t("cli:planAdvisor.col.procurement"),
      t("cli:planAdvisor.col.teamCost"),
      t("cli:planAdvisor.col.enterpriseCost"),
    ].join("  |  "),
  );

  let ceilingExceeded = false;
  for (const row of table.rows) {
    if (row.seats > TEAM_SEAT_RANGE.max) ceilingExceeded = true;
    lines.push(
      [
        `${formatPercent(row.adoptionFraction)}%`,
        String(row.seats),
        row.fitsTeamRange ? t("cli:planAdvisor.yes") : t("cli:planAdvisor.no"),
        t(`cli:planAdvisor.motion.${row.procurementMotion}`),
        `$${row.teamMonthlyCost.value}`,
        `$${row.enterpriseTotalMonthly.value}`,
      ].join("  |  "),
    );
  }

  lines.push("");
  lines.push(t("cli:planAdvisor.enterpriseCostHint"));
  lines.push(t("cli:planAdvisor.estimateNote"));

  if (ceilingExceeded) {
    lines.push("");
    lines.push(t("cli:planAdvisor.ceilingExceeded"));
  }

  lines.push("");
  lines.push(t("cli:planAdvisor.openQuestionsHeader"));
  // Render the localized open questions for human output; the core
  // SEAT_SIZING_OPEN_QUESTIONS array stays English for the MCP/agent path.
  for (const id of ["compliance", "spendLimit", "timing"] as const) {
    lines.push(`  - ${t(`cli:planAdvisor.openQuestions.${id}`)}`);
  }

  lines.push("");
  lines.push(t("cli:planAdvisor.staleNote", { warning: table.staleWarning }));

  return lines;
}

/**
 * Already-parsed input for `sizeSeats`, plus the presentation flag.
 * `tierMixMeasured` should be `true` whenever the caller actually supplied
 * `--tier-mix` (a user-supplied split is a measurement, not the benchmark
 * default).
 */
export interface PlanAdvisorInput {
  readonly headcount: number;
  readonly technicalFraction: number;
  readonly tierMix?: TierMix;
  readonly tierMixMeasured?: boolean;
  readonly compliance: boolean;
}

/**
 * Run the seat-sizing math and format the result, or format a translated
 * error message on invalid input. Never throws — `SeatSizingError` is caught
 * and mapped to `cli:planAdvisor.errors.<code>`.
 */
export function runPlanAdvisor(input: PlanAdvisorInput): PlanAdvisorOutcome {
  let table: SeatScenarioTable;
  try {
    table = sizeSeats({
      headcount: input.headcount,
      technicalFraction: input.technicalFraction,
      tierMix: input.tierMix,
      tierMixMeasured: input.tierMixMeasured,
    });
  } catch (err) {
    if (err instanceof SeatSizingError) {
      return { ok: false, message: t(`cli:planAdvisor.errors.${err.code}`) };
    }
    throw err;
  }
  return { ok: true, lines: formatPlanAdvisorReport(table, input.compliance) };
}
