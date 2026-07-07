import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";
import { putParam } from "../ssm-params.js";

interface DnsStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
}

export class DnsStack extends cdk.Stack {
  public readonly hostedZone?: route53.PublicHostedZone;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, { ...props, description: "Claude Stats DNS — Route53 hosted zone, NS delegation (same- or cross-account)" });

    const { config } = props;
    const prefix = `ClaudeStats-${config.envName}`;

    if (!config.domainName || !config.parentZoneId || !config.parentZoneName) {
      return;
    }

    // App hosted zone: e.g. "stats.acme.com"
    const hostedZone = new route53.PublicHostedZone(this, "HostedZone", {
      zoneName: config.domainName,
      comment: `Hosted zone for claude-stats ${config.envName}`,
    });

    // ---------- NS delegation in the parent zone ----------
    if (config.parentZoneDelegationRoleArn) {
      // Cross-account delegation: the parent zone lives in a different account.
      // CrossAccountZoneDelegationRecord assumes the given role (which must
      // grant route53:ChangeResourceRecordSets on the parent zone) and writes
      // the NS record there. Do NOT assume the parent zone is in-account.
      const delegationRole = iam.Role.fromRoleArn(
        this,
        "ParentZoneDelegationRole",
        config.parentZoneDelegationRoleArn,
      );

      new route53.CrossAccountZoneDelegationRecord(this, "CrossAccountNsDelegation", {
        delegatedZone: hostedZone,
        parentHostedZoneId: config.parentZoneId,
        delegationRole,
        ttl: cdk.Duration.hours(48),
      });
    } else {
      // Same-account delegation: the parent zone is in this account, so we can
      // write the NS record directly.
      const parentZone = route53.HostedZone.fromHostedZoneAttributes(
        this,
        "ParentZone",
        {
          hostedZoneId: config.parentZoneId,
          zoneName: config.parentZoneName,
        },
      );

      new route53.NsRecord(this, "NsDelegation", {
        zone: parentZone,
        recordName: config.domainName,
        values: hostedZone.hostedZoneNameServers!,
        ttl: cdk.Duration.hours(48),
      });
    }

    this.hostedZone = hostedZone;

    // SSM parameters. The ACM certificate now lives in CertificateStack
    // (us-east-1) and is passed to FrontendStack as a construct via
    // cross-region references, so no `dns/certificate-arn` param is written.
    putParam(this, prefix, "dns/hosted-zone-id", hostedZone.hostedZoneId);
    putParam(this, prefix, "dns/hosted-zone-name", hostedZone.zoneName);
  }
}
