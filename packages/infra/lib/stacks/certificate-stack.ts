import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";

interface CertificateStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
  /**
   * App hosted zone (created by DnsStack, in the app region). Route53 is
   * global, so this zone object crosses regions fine — the ACM cert here in
   * us-east-1 DNS-validates against it. Requires `crossRegionReferences: true`
   * on both this stack and DnsStack, and a concrete `env` on both.
   */
  hostedZone: route53.IPublicHostedZone;
}

/**
 * ACM certificate for the frontend CloudFront distribution.
 *
 * CloudFront requires its viewer certificate to live in **us-east-1**,
 * regardless of where the rest of the app is deployed. This stack is therefore
 * always pinned to `us-east-1` (set by the caller via `env`) and the cert is
 * consumed cross-region by FrontendStack via `crossRegionReferences: true`.
 *
 * The old SSM handoff (writing the cert ARN and re-importing it in the
 * frontend stack) breaks when the writer (us-east-1) and reader (app region)
 * differ — an SSM parameter written in us-east-1 is not readable from the app
 * region. Passing the certificate construct across stacks with cross-region
 * references is the doc-verified pattern for aws-cdk-lib 2.261.
 */
export class CertificateStack extends cdk.Stack {
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: CertificateStackProps) {
    super(scope, id, {
      ...props,
      description:
        "Claude Stats certificate — us-east-1 ACM cert for the CloudFront distribution (DNS-validated)",
    });

    const { config, hostedZone } = props;

    // DNS-validated against the app hosted zone. CDK writes the validation
    // CNAME records into that zone; Route53 is global so this works from
    // us-east-1 even though the zone is defined in the app-region DnsStack.
    this.certificate = new acm.Certificate(this, "Certificate", {
      domainName: config.domainName!,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // Informational output only — no SSM param: a param written here in
    // us-east-1 would not be readable from the app region, which is exactly
    // why the cert is passed as a construct rather than via SSM.
    new cdk.CfnOutput(this, "CertificateArn", {
      value: this.certificate.certificateArn,
      description: "ARN of the us-east-1 ACM certificate for CloudFront",
    });
  }
}
