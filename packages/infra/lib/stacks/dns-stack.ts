import * as cdk from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";
import { putParam } from "../ssm-params.js";

interface DnsStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
}

export class DnsStack extends cdk.Stack {
  public readonly hostedZone?: route53.PublicHostedZone;
  public readonly certificate?: acm.Certificate;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, { ...props, description: "Claude Stats DNS — Route53 hosted zone, NS delegation, ACM certificate" });

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

    // NS delegation in parent zone
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

    this.hostedZone = hostedZone;

    // ACM certificate (DNS-validated, must be in us-east-1 for CloudFront)
    const certificate = new acm.Certificate(this, "Certificate", {
      domainName: config.domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    this.certificate = certificate;

    // SSM parameters
    putParam(this, prefix, "dns/hosted-zone-id", hostedZone.hostedZoneId);
    putParam(this, prefix, "dns/hosted-zone-name", hostedZone.zoneName);
    putParam(this, prefix, "dns/certificate-arn", certificate.certificateArn);
  }
}
