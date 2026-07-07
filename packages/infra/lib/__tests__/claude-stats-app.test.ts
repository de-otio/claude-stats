/**
 * Trivial synth test — proves the `lib/__tests__` vitest harness is wired
 * (own vitest project, offline synth, no coverage thresholds on stack
 * bodies). Real behavioral coverage of individual stacks lands alongside
 * their feature work (see plans/backend-deployment/IMPLEMENTATION.md §B1/B2).
 *
 * Imports the **compiled** `dist/` build, not the `.ts` source: AuthStack's
 * Lambda entry-path resolution (`lib/stacks/auth-stack.ts`) is
 * `__dirname`-relative and assumes the compiled `dist/lib/stacks/` nesting
 * depth — the same assumption the `synth-cdk` CI job and every real
 * `cdk synth` invocation make (they all build first). `pretest` runs the
 * build so this stays current.
 */
import { describe, test, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ClaudeStatsApp } from "../../dist/lib/claude-stats-app.js";

describe("ClaudeStatsApp", () => {
  test("synthesizes a Data stack containing DynamoDB tables", () => {
    const app = new cdk.App();
    const claudeStats = new ClaudeStatsApp(app, "ClaudeStats-test", {
      account: "111111111111",
      region: "eu-central-1",
      senderEmail: "noreply@example.com",
      allowedEmailDomains: ["example.com"],
    });

    const template = Template.fromStack(claudeStats.data);

    const tables = template.findResources("AWS::DynamoDB::Table");
    expect(Object.keys(tables).length).toBeGreaterThan(0);
  });
});
