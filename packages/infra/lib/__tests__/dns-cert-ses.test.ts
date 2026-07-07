/**
 * B2 — DNS / certificate / SES identity / app-wiring behavioral tests.
 *
 * Synth **template assertions** (the house pattern), not line-counted coverage.
 * Two topologies are exercised end-to-end through `ClaudeStatsApp`:
 *
 *   A. cross-account delegation + SES **domain** identity
 *   B. same-account delegation  + SES **email** identity (defaults)
 *
 * Imports the **compiled** `dist/` build (same reason as the harness test:
 * AuthStack's Lambda entry paths are `__dirname`-relative to `dist/lib/...`).
 *
 * All fixture values are generic placeholders only (`acme.com`, account
 * `111111111111`, zone id `Z0PLACEHOLDER0000`, a `parent-zone-delegation`
 * role) — these snapshots land in a PUBLIC repo, so never real org values.
 */
import { describe, test, expect, beforeAll } from "vitest";
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { ClaudeStatsApp } from "../../dist/lib/claude-stats-app.js";
import { AuthStack } from "../../dist/lib/stacks/auth-stack.js";

const APP_REGION = "eu-central-1";
const ACCOUNT = "111111111111";
const DOMAIN = "stats.acme.com";
const SENDER = "noreply@stats.acme.com";
const ZONE_ID = "Z0PLACEHOLDER0000";
const DELEGATION_ROLE_ARN =
  "arn:aws:iam::111111111111:role/parent-zone-delegation";

const baseProps = {
  account: ACCOUNT,
  region: APP_REGION,
  senderEmail: SENDER,
  allowedEmailDomains: ["acme.com"],
  domainName: DOMAIN,
  parentZoneName: "acme.com",
  parentZoneId: ZONE_ID,
};

// A — cross-account delegation + SES domain identity
function crossAccountDomainApp() {
  const app = new cdk.App();
  const claudeStats = new ClaudeStatsApp(app, "ClaudeStats", {
    ...baseProps,
    configOverrides: {
      parentZoneDelegationRoleArn: DELEGATION_ROLE_ARN,
      sesIdentityMode: "domain",
    },
  });
  return claudeStats;
}

// B — same-account delegation + SES email identity (defaults)
function sameAccountEmailApp() {
  const app = new cdk.App();
  const claudeStats = new ClaudeStatsApp(app, "ClaudeStats", { ...baseProps });
  return claudeStats;
}

describe("B2 — app wiring / deploy order", () => {
  let a: ReturnType<typeof crossAccountDomainApp>;
  let b: ReturnType<typeof sameAccountEmailApp>;

  beforeAll(() => {
    a = crossAccountDomainApp();
    b = sameAccountEmailApp();
  });

  test("CertificateStack is pinned to us-east-1 regardless of app region", () => {
    expect(a.certificate).toBeDefined();
    expect(a.certificate!.region).toBe("us-east-1");
    // The app itself is in a different region — proving the cert is NOT
    // co-located with the rest of the stacks (the wrong-region-cert guard).
    expect(a.frontend.region).toBe(APP_REGION);
    expect(a.certificate!.region).not.toBe(a.frontend.region);
  });

  test("certificate depends on dns; frontend depends on certificate and api", () => {
    expect(a.certificate!.dependencies).toContain(a.dns);
    expect(a.frontend.dependencies).toContain(a.certificate);
    expect(a.frontend.dependencies).toContain(a.api);
  });

  test("domain mode: auth depends on dns (needs the zone for the identity)", () => {
    expect(a.auth.dependencies).toContain(a.dns);
  });

  test("email mode: auth does NOT depend on dns", () => {
    expect(b.dns).toBeDefined();
    expect(b.auth.dependencies).not.toContain(b.dns);
  });
});

describe("B2 — DnsStack NS delegation", () => {
  test("cross-account: CrossAccountZoneDelegation custom resource with the role ARN, no direct NS record", () => {
    const dns = crossAccountDomainApp().dns!;
    const t = Template.fromStack(dns);

    t.resourceCountIs("Custom::CrossAccountZoneDelegation", 1);
    // No same-account NS RecordSet is written — the NS record is created in the
    // parent account by the custom resource instead.
    t.resourceCountIs("AWS::Route53::RecordSet", 0);
    expect(JSON.stringify(t.toJSON())).toContain(DELEGATION_ROLE_ARN);
  });

  test("same-account: a direct NS RecordSet, no cross-account custom resource", () => {
    const dns = sameAccountEmailApp().dns!;
    const t = Template.fromStack(dns);

    t.resourceCountIs("Custom::CrossAccountZoneDelegation", 0);
    t.hasResourceProperties(
      "AWS::Route53::RecordSet",
      Match.objectLike({ Type: "NS", Name: `${DOMAIN}.` }),
    );
  });

  test("cross-account DnsStack snapshot", () => {
    const t = Template.fromStack(crossAccountDomainApp().dns!);
    expect(t.toJSON()).toMatchSnapshot();
  });

  test("same-account DnsStack snapshot", () => {
    const t = Template.fromStack(sameAccountEmailApp().dns!);
    expect(t.toJSON()).toMatchSnapshot();
  });
});

describe("B2 — CertificateStack", () => {
  test("DNS-validated ACM cert for the domain lives in the cert stack", () => {
    const t = Template.fromStack(crossAccountDomainApp().certificate!);
    t.hasResourceProperties(
      "AWS::CertificateManager::Certificate",
      Match.objectLike({
        DomainName: DOMAIN,
        ValidationMethod: "DNS",
      }),
    );
  });

  test("CertificateStack snapshot", () => {
    const t = Template.fromStack(crossAccountDomainApp().certificate!);
    expect(t.toJSON()).toMatchSnapshot();
  });
});

describe("B2 — SES identity mode", () => {
  test("domain mode: SES domain identity on the zone, DKIM CNAMEs auto-created, FromAddress condition on send", () => {
    const t = Template.fromStack(crossAccountDomainApp().auth);

    // Domain identity — the EmailIdentity is the domain, not the address.
    t.hasResourceProperties(
      "AWS::SES::EmailIdentity",
      Match.objectLike({ EmailIdentity: DOMAIN }),
    );
    // publicHostedZone() auto-creates DKIM CNAME records in the zone.
    t.hasResourceProperties(
      "AWS::Route53::RecordSet",
      Match.objectLike({ Type: "CNAME" }),
    );
    // Send policy pins ses:FromAddress so a compromised Lambda can't send as
    // arbitrary @domain senders.
    t.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["ses:SendEmail", "ses:SendRawEmail"]),
              Condition: {
                StringEquals: { "ses:FromAddress": SENDER },
              },
            }),
          ]),
        }),
      }),
    );
  });

  test("email mode: single-address SES identity, no zone records, no FromAddress condition", () => {
    const t = Template.fromStack(sameAccountEmailApp().auth);

    t.hasResourceProperties(
      "AWS::SES::EmailIdentity",
      Match.objectLike({ EmailIdentity: SENDER }),
    );
    // Email mode creates no DNS records in the auth stack.
    t.resourceCountIs("AWS::Route53::RecordSet", 0);
    // And byte-identical to the original send policy — no FromAddress pin.
    expect(JSON.stringify(t.toJSON())).not.toContain("ses:FromAddress");
  });

  test("domain mode without a hosted zone throws (fail-fast, not a silent misconfig)", () => {
    const config = crossAccountDomainApp().config; // sesIdentityMode: "domain"
    const app = new cdk.App();
    expect(
      () =>
        new AuthStack(app, "AuthNoZone", {
          env: { account: ACCOUNT, region: APP_REGION },
          config,
          // hostedZone intentionally omitted
        }),
    ).toThrow(/domain.*hosted zone/i);
  });
});
