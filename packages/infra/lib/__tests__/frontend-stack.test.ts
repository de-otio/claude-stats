/**
 * Template-assertion tests for `FrontendStack` (see `vitest.config.ts` for
 * why: synth template assertions are the behavioral gate for declarative
 * CDK stack code, not line coverage). Imports the **compiled** `dist/`
 * build — `pretest` builds first, matching every real `cdk synth`.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { FrontendStack } from "../../dist/lib/stacks/frontend-stack.js";
import type { EnvironmentConfig } from "../../dist/lib/config/types.js";

/** A self-contained fixture dist dir — tests never depend on the real,
 * separately-built `packages/frontend/dist`. */
let fixtureDistPath: string;

beforeAll(() => {
  fixtureDistPath = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-stack-test-"));
  fs.writeFileSync(path.join(fixtureDistPath, "index.html"), "<!doctype html><html></html>");
});

afterAll(() => {
  fs.rmSync(fixtureDistPath, { recursive: true, force: true });
});

const baseConfig: EnvironmentConfig = {
  envName: "dev",
  account: "111111111111",
  region: "eu-central-1",
  senderEmail: "noreply@acme-dev.com",
  allowedEmailDomains: ["acme.com"],
  magicLinkTtlMinutes: 15,
  magicLinkMaxRequestsPerHour: 5,
  cognitoAccessTokenTtlMinutes: 60,
  cognitoRefreshTokenTtlDays: 30,
  dynamoDbEncryption: "AWS_OWNED",
  dynamoDbPointInTimeRecovery: false,
  dynamoDbDeletionProtection: false,
  dynamoDbRemovalPolicy: "DESTROY",
  domainName: null,
  parentZoneName: null,
  parentZoneId: null,
  branding: {
    primaryColor: "indigo",
    accentColor: "emerald",
    logoUrl: null,
    appTitle: "Claude Stats",
  },
  alarmEmailSsmPath: null,
  logRetentionDays: 7,
  monthlyBudgetUsd: 50,
  lambdaReservedConcurrency: { aggregateStats: 5 },
};

function synth(config: Partial<EnvironmentConfig> = {}): Template {
  const app = new cdk.App();
  const stack = new FrontendStack(app, "TestFrontend", {
    config: { ...baseConfig, frontendDistPath: fixtureDistPath, ...config },
  });
  return Template.fromStack(stack);
}

describe("FrontendStack — runtime config.js injection", () => {
  test("BucketDeployment carries two sources (SPA asset + config.js data)", () => {
    const template = synth();
    template.resourceCountIs("Custom::CDKBucketDeployment", 1);
    const deployments = template.findResources("Custom::CDKBucketDeployment");
    const [deployment] = Object.values(deployments);
    expect(deployment.Properties.SourceObjectKeys).toHaveLength(2);
  });
});

describe("FrontendStack — custom domain vs default domain", () => {
  test("default domain: no Route53 records, no distribution domainNames/certificate", () => {
    const template = synth({ domainName: null });
    template.resourceCountIs("AWS::Route53::RecordSet", 0);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: Match.absent(),
      }),
    });
  });

  test("custom domain: A/AAAA alias records + distribution aliases present", () => {
    const template = synth({
      domainName: "stats.acme.com",
      parentZoneName: "acme.com",
      parentZoneId: "Z0PLACEHOLDER0000",
    });
    template.resourceCountIs("AWS::Route53::RecordSet", 2);
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "A",
      Name: "stats.acme.com.",
    });
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "AAAA",
      Name: "stats.acme.com.",
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["stats.acme.com"],
      }),
    });
  });
});

describe("FrontendStack — frontendDistPath", () => {
  test("a custom frontendDistPath fixture synthesizes successfully", () => {
    expect(() => synth({ frontendDistPath: fixtureDistPath })).not.toThrow();
  });

  test("a missing frontendDistPath fails synth with a clear, actionable error", () => {
    const missingPath = path.join(fixtureDistPath, "does-not-exist");
    expect(() => synth({ frontendDistPath: missingPath })).toThrow(
      /SPA dist directory not found.*does-not-exist.*frontendDistPath/s,
    );
  });

  test("unset frontendDistPath falls back to the in-monorepo default path", () => {
    // Passing `undefined` overrides the fixture default set by `synth()`
    // and exercises the real fallback resolution (packages/frontend/dist
    // relative to the compiled stack file) — assert it resolves to a path
    // ending in packages/frontend/dist, whether or not that directory
    // happens to exist in this environment.
    const app = new cdk.App();
    let thrown: Error | undefined;
    try {
      new FrontendStack(app, "TestFrontendDefault", {
        config: { ...baseConfig, frontendDistPath: undefined },
      });
    } catch (err) {
      thrown = err as Error;
    }
    if (thrown) {
      expect(thrown.message).toContain(path.join("packages", "frontend", "dist"));
    }
  });
});

describe("FrontendStack — /config.js cache behavior", () => {
  test("a dedicated, no-cache CloudFront behavior exists for /config.js", () => {
    const template = synth();
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: "/config.js" }),
        ]),
      }),
    });

    // The /config.js behavior must use the AWS-MANAGED CachingDisabled
    // policy (id 4135ea2d-6df8-44a3-9df3-4b5a84be39ad). A custom zero-TTL
    // policy is rejected by the live CloudFront API when the accept-encoding
    // flags are set ("EnableAcceptEncodingGzip is invalid for policy with
    // caching disabled") — this broke the first prod deploy, so pin the
    // managed-policy id and assert no custom zero-TTL policy sneaks back in.
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "/config.js",
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
          }),
        ]),
      }),
    });
    expect(
      Object.keys(template.findResources("AWS::CloudFront::CachePolicy")),
    ).toHaveLength(0);

    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        CustomHeadersConfig: {
          Items: Match.arrayWith([
            Match.objectLike({
              Header: "Cache-Control",
              Value: Match.stringLikeRegexp("no-cache"),
            }),
          ]),
        },
      }),
    });
  });
});

describe("FrontendStack — Content-Security-Policy", () => {
  test("the security headers policy carries a CSP restricting to self + AWS service hosts", () => {
    const template = synth();
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: Match.objectLike({
            ContentSecurityPolicy: Match.stringLikeRegexp(
              "default-src 'self'.*script-src 'self'.*connect-src.*cognito-idp\\.eu-central-1\\.amazonaws\\.com.*object-src 'none'.*frame-ancestors 'none'",
            ),
          }),
        }),
      }),
    });
  });
});
