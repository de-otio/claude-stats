import * as logs from "aws-cdk-lib/aws-logs";

/**
 * The set of retention periods CloudWatch Logs actually accepts, mirrored from
 * `logs.RetentionDays`. A group's `retentionInDays` MUST be one of these — any
 * other value is rejected by the CloudWatch API at deploy time (a live-API
 * rule template assertions cannot catch), so we validate at synth instead.
 */
const VALID_RETENTION_DAYS: readonly number[] = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827,
  2192, 2557, 2922, 3288, 3653,
];

/**
 * Map a plain day count (from `EnvironmentConfig.logRetentionDays`) to the
 * `logs.RetentionDays` enum. Throws at synth if the number is not a value
 * CloudWatch supports — a loud, early failure beats a `cdk deploy` that fails
 * halfway or, worse, a log group that silently falls back to never-expire.
 */
export function toRetentionDays(days: number): logs.RetentionDays {
  if (!VALID_RETENTION_DAYS.includes(days)) {
    throw new Error(
      `Invalid logRetentionDays=${days}. CloudWatch Logs only accepts: ` +
        VALID_RETENTION_DAYS.join(", "),
    );
  }
  // The enum's numeric values ARE these day counts, so the cast is sound once
  // membership is verified above.
  return days as logs.RetentionDays;
}
