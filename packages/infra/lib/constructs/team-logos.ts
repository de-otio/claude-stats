import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";
import { putParam } from "../ssm-params.js";

interface TeamLogosProps {
  config: EnvironmentConfig;
  prefix: string;
}

export class TeamLogos extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly cdnUrl: string;

  constructor(scope: Construct, id: string, props: TeamLogosProps) {
    super(scope, id);

    const { config, prefix } = props;

    const removalPolicy =
      config.dynamoDbRemovalPolicy === "RETAIN"
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY;

    // --- S3 Bucket for team logos ---
    // S3 bucket names must be lowercase
    this.bucket = new s3.Bucket(this, "Bucket", {
      bucketName: `${prefix.toLowerCase()}-team-logos`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy,
      autoDeleteObjects: removalPolicy === cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          id: "expire-orphan-logos",
          expiration: cdk.Duration.days(365),
        },
      ],
    });

    // --- CloudFront Distribution with OAC ---
    const oac = new cloudfront.S3OriginAccessControl(this, "OAC", {
      signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
    });

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
          originAccessControl: oac,
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      },
    });

    this.cdnUrl = `https://${this.distribution.distributionDomainName}`;

    // --- SSM Parameters ---
    const stack = cdk.Stack.of(this);

    putParam(stack, prefix, "api/team-logos-bucket", this.bucket.bucketName);
    putParam(stack, prefix, "api/team-logos-cdn-url", this.cdnUrl);
  }
}
