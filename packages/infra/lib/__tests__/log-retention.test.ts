/**
 * Log-retention behavioral tests.
 *
 * 1. toRetentionDays: valid day counts map, invalid ones fail LOUDLY at synth
 *    (a bad value is otherwise rejected only by the live CloudWatch API mid-deploy).
 * 2. AuthStack: every Lambda gets an explicit retention-bounded log group, so
 *    no function auto-creates a never-expire `/aws/lambda/*` group on first
 *    invocation. Template assertion (house pattern) against the compiled dist/.
 */
import { describe, test, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { toRetentionDays } from "../../dist/lib/log-retention.js";
import { ClaudeStatsApp } from "../../dist/lib/claude-stats-app.js";

describe("toRetentionDays", () => {
  test("maps valid CloudWatch day counts to the enum value", () => {
    expect(toRetentionDays(7)).toBe(7);
    expect(toRetentionDays(90)).toBe(90);
    expect(toRetentionDays(365)).toBe(365);
  });

  test("throws at synth on a value CloudWatch does not accept", () => {
    // 45 is a plausible-looking but INVALID retention; must fail loudly.
    expect(() => toRetentionDays(45)).toThrow(/Invalid logRetentionDays=45/);
    expect(() => toRetentionDays(0)).toThrow();
  });
});

describe("AuthStack log-group retention", () => {
  function authTemplate(retentionDays: number): Template {
    const app = new cdk.App();
    const stats = new ClaudeStatsApp(app, "ClaudeStats-prod", {
      account: "111111111111",
      region: "eu-central-1",
      senderEmail: "noreply@stats.acme.com",
      allowedEmailDomains: ["acme.com"],
      domainName: "stats.acme.com",
      parentZoneName: "acme.com",
      parentZoneId: "Z0PLACEHOLDER0000",
      configOverrides: {
        logRetentionDays: retentionDays,
        frontendDistPath: undefined,
      },
    });
    return Template.fromStack(stats.auth);
  }

  test("creates one retention-bounded log group per auth Lambda (none never-expire)", () => {
    const template = authTemplate(90);

    const functions = template.findResources("AWS::Lambda::Function");
    const logGroups = template.findResources("AWS::Logs::LogGroup");

    // Five custom-auth Lambdas, five explicit log groups.
    expect(Object.keys(functions).length).toBe(5);
    expect(Object.keys(logGroups).length).toBe(5);

    // EVERY log group carries a finite retention — never `undefined`
    // (which is CloudFormation for never-expire).
    for (const [id, lg] of Object.entries(logGroups)) {
      expect(
        lg.Properties?.RetentionInDays,
        `${id} has no RetentionInDays (would never expire)`,
      ).toBe(90);
    }

    // Every function references an explicit LoggingConfig (its own group),
    // so none falls back to an auto-created never-expire group.
    for (const [id, fn] of Object.entries(functions)) {
      expect(
        fn.Properties?.LoggingConfig?.LogGroup,
        `${id} has no explicit log group`,
      ).toBeDefined();
    }
  });

  test("honours the configured retention period", () => {
    const template = authTemplate(30);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      RetentionInDays: 30,
    });
    // And none is left never-expire.
    const logGroups = template.findResources("AWS::Logs::LogGroup");
    for (const lg of Object.values(logGroups)) {
      expect(lg.Properties?.RetentionInDays).toBe(30);
    }
    // Log groups are disposable telemetry — DESTROY, never RETAIN.
    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Delete",
    });
  });
});
