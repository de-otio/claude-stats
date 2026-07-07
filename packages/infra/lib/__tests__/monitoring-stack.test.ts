/**
 * MonitoringStack behavioral tests — prod alarm synthesis.
 *
 * Regression pin for the DynamoDB throttle alarm: CloudWatch caps an alarm's
 * math expression at 10 individual metrics, and TABLE_NAMES has more tables
 * than that. Alarms are prod-only, so ONLY a prod-config synth constructs the
 * expression — which is exactly why the bug stayed latent until the first
 * prod synth. This test IS that prod synth.
 *
 * Imports the **compiled** `dist/` build (house pattern — see the harness
 * test). All fixture values are generic placeholders (public repo).
 */
import { describe, test, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { MonitoringStack } from "../../dist/lib/stacks/monitoring-stack.js";
import { defaultConfig } from "../../dist/lib/config/defaults.js";

function prodMonitoringTemplate(): Template {
  const app = new cdk.App();
  const stack = new MonitoringStack(app, "ClaudeStats-prod-Monitoring", {
    env: { account: "111111111111", region: "eu-central-1" },
    config: {
      ...defaultConfig,
      envName: "prod",
      account: "111111111111",
      region: "eu-central-1",
      senderEmail: "noreply@stats.acme.com",
      allowedEmailDomains: ["acme.com"],
      alarmEmailSsmPath: "/claude-stats/prod/alarm-email",
    },
  });
  return Template.fromStack(stack);
}

describe("MonitoringStack prod alarms", () => {
  test("prod synth succeeds and every alarm math expression stays within the 10-metric limit", () => {
    const template = prodMonitoringTemplate();
    const alarms = template.findResources("AWS::CloudWatch::Alarm");
    expect(Object.keys(alarms).length).toBeGreaterThan(0);

    for (const [logicalId, alarm] of Object.entries(alarms)) {
      const metrics = (alarm.Properties?.Metrics ?? []) as Array<{
        MetricStat?: unknown;
      }>;
      // Entries carrying a MetricStat are the "individual metrics" CloudWatch
      // counts against the 10-per-expression limit (the expression entry
      // itself does not count).
      const individual = metrics.filter((m) => m.MetricStat !== undefined);
      expect(
        individual.length,
        `${logicalId} exceeds the CloudWatch 10-metric alarm limit`,
      ).toBeLessThanOrEqual(10);
    }
  });

  test("throttle coverage is chunked, not truncated: every table is summed by exactly one throttle alarm", () => {
    const template = prodMonitoringTemplate();
    const alarms = template.findResources("AWS::CloudWatch::Alarm");
    const throttleAlarms = Object.values(alarms).filter((a) =>
      String(a.Properties?.AlarmName ?? "").includes("DynamoDB-Throttled"),
    );
    // 11 tables at a chunk size of 10 ⇒ two alarms (silent truncation to one
    // alarm would drop a table from alerting).
    expect(throttleAlarms.length).toBe(2);
    const totalSummedTables = throttleAlarms.reduce((sum, a) => {
      const metrics = (a.Properties?.Metrics ?? []) as Array<{
        MetricStat?: unknown;
      }>;
      return sum + metrics.filter((m) => m.MetricStat !== undefined).length;
    }, 0);
    expect(totalSummedTables).toBe(11);
  });
});
