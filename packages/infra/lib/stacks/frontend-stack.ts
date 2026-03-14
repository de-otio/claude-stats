import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";
import { getParam, putParam } from "../ssm-params.js";

interface FrontendStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
}

export class FrontendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const { config } = props;
    const prefix = `ClaudeStats-${config.envName}`;

    // ----------------------------------------------------------------
    // Read SSM parameters from upstream stacks
    // ----------------------------------------------------------------
    const graphqlEndpoint = getParam(this, prefix, "api/graphql-endpoint");
    const userPoolId = getParam(this, prefix, "auth/user-pool-id");
    const spaClientId = getParam(this, prefix, "auth/spa-client-id");

    // ----------------------------------------------------------------
    // S3 bucket for static SPA assets
    // ----------------------------------------------------------------
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ----------------------------------------------------------------
    // CloudFront Origin Access Control
    // ----------------------------------------------------------------
    const oac = new cloudfront.CfnOriginAccessControl(this, "OAC", {
      originAccessControlConfig: {
        name: `${prefix}-frontend-oac`,
        originAccessControlOriginType: "s3",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      },
    });

    // ----------------------------------------------------------------
    // Optional custom domain from DnsStack
    // ----------------------------------------------------------------
    let domainNames: string[] | undefined;
    let certificate: acm.ICertificate | undefined;
    let hostedZone: route53.IHostedZone | undefined;

    if (config.domainName) {
      const hostedZoneId = getParam(this, prefix, "dns/hosted-zone-id");
      const certificateArn = getParam(this, prefix, "dns/certificate-arn");

      certificate = acm.Certificate.fromCertificateArn(
        this,
        "Certificate",
        certificateArn,
      );
      domainNames = [config.domainName];

      hostedZone = route53.HostedZone.fromHostedZoneAttributes(
        this,
        "HostedZone",
        {
          hostedZoneId,
          zoneName: config.domainName,
        },
      );
    }

    // ----------------------------------------------------------------
    // Security response headers policy
    // ----------------------------------------------------------------
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeaders",
      {
        responseHeadersPolicyName: `${prefix}-security-headers`,
        securityHeadersBehavior: {
          strictTransportSecurity: {
            override: true,
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            preload: true,
          },
          contentTypeOptions: {
            override: true,
          },
          frameOptions: {
            override: true,
            frameOption: cloudfront.HeadersFrameOption.DENY,
          },
          referrerPolicy: {
            override: true,
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          },
        },
      },
    );

    // ----------------------------------------------------------------
    // CloudFront distribution
    // ----------------------------------------------------------------
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy,
      },
      defaultRootObject: "index.html",
      domainNames,
      certificate,
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // ----------------------------------------------------------------
    // Route 53 alias records (if custom domain)
    // ----------------------------------------------------------------
    if (hostedZone && config.domainName) {
      new route53.ARecord(this, "AliasA", {
        zone: hostedZone,
        recordName: config.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53targets.CloudFrontTarget(distribution),
        ),
      });

      new route53.AaaaRecord(this, "AliasAAAA", {
        zone: hostedZone,
        recordName: config.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53targets.CloudFrontTarget(distribution),
        ),
      });
    }

    // ----------------------------------------------------------------
    // Deploy SPA assets to S3
    // ----------------------------------------------------------------
    new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [s3deploy.Source.asset("../../frontend/dist")],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    // ----------------------------------------------------------------
    // Publish SSM parameters
    // ----------------------------------------------------------------
    const distributionUrl = config.domainName
      ? `https://${config.domainName}`
      : `https://${distribution.distributionDomainName}`;

    putParam(this, prefix, "frontend/distribution-url", distributionUrl);
    putParam(
      this,
      prefix,
      "frontend/distribution-id",
      distribution.distributionId,
    );

    // ----------------------------------------------------------------
    // Stack outputs (for convenience)
    // ----------------------------------------------------------------
    new cdk.CfnOutput(this, "DistributionUrl", { value: distributionUrl });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    });
    new cdk.CfnOutput(this, "GraphqlEndpoint", { value: graphqlEndpoint });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPoolId });
    new cdk.CfnOutput(this, "SpaClientId", { value: spaClientId });
  }
}
