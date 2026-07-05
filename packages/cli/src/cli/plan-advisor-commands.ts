/**
 * `plan-advisor` command registration.
 *
 * Thin command layer (`cli/**` is excluded from coverage — logic lives in
 * the covered `../plan-advisor.js` module): parse flags, call
 * `runPlanAdvisor`, print the result.
 *
 *   plan-advisor --headcount <n> --technical-fraction <pct>
 *                [--tier-mix light,typical,power] [--compliance]
 *
 * i18n namespace: cli:planAdvisor.*
 */
import type { Command } from "commander";
import {
  parseHeadcountFlag,
  parseTechnicalFractionFlag,
  parseTierMixFlag,
  runPlanAdvisor,
} from "../plan-advisor.js";
import { t } from "../i18n.js";

export function registerPlanAdvisorCommands(program: Command): void {
  program
    .command("plan-advisor")
    .description(t("cli:planAdvisor.description"))
    .requiredOption("--headcount <n>", t("cli:planAdvisor.headcountFlag"))
    .requiredOption(
      "--technical-fraction <pct>",
      t("cli:planAdvisor.technicalFractionFlag"),
    )
    .option("--tier-mix <light,typical,power>", t("cli:planAdvisor.tierMixFlag"))
    .option("--compliance", t("cli:planAdvisor.complianceFlag"))
    .action(
      (opts: {
        headcount: string;
        technicalFraction: string;
        tierMix?: string;
        compliance?: boolean;
      }) => {
        const result = runPlanAdvisor({
          headcount: parseHeadcountFlag(opts.headcount),
          technicalFraction: parseTechnicalFractionFlag(opts.technicalFraction),
          tierMix: opts.tierMix ? parseTierMixFlag(opts.tierMix) : undefined,
          tierMixMeasured: opts.tierMix !== undefined,
          compliance: opts.compliance ?? false,
        });

        if (!result.ok) {
          console.error(result.message);
          process.exitCode = 1;
          return;
        }
        for (const line of result.lines) {
          console.log(line);
        }
      },
    );
}
