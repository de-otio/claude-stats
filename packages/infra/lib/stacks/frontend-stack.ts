import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";
import { getParam, putParam } from "../ssm-params.js";
import { renderConfigJs } from "../config-js.js";
import { buildContentSecurityPolicy } from "../content-security-policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface FrontendStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
  /**
   * ACM certificate for the custom domain, created in CertificateStack
   * (us-east-1) and passed as a construct via cross-region references. Passed
   * directly (not via SSM) because a param written in us-east-1 is not readable
   * from the app region. Present iff `config.domainName` is set.
   */
  certificate?: acm.ICertificate;
}

export class FrontendStack extends cdk.Stack {
  public readonly siteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, { ...props, description: "Claude Stats frontend — S3 SPA bucket, CloudFront distribution, security headers" });

    const { config } = props;
    const prefix = `ClaudeStats-${config.envName}`;

    // ----------------------------------------------------------------
    // Read SSM parameters from upstream stacks
    // ----------------------------------------------------------------
    const graphqlEndpoint = getParam(this, prefix, "api/graphql-endpoint");
    const userPoolId = getParam(this, prefix, "auth/user-pool-id");
    const spaClientId = getParam(this, prefix, "auth/spa-client-id");
    const teamLogosCdnUrl = getParam(this, prefix, "api/team-logos-cdn-url");

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

      // Cross-region certificate construct from CertificateStack (us-east-1),
      // passed in by ClaudeStatsApp rather than re-imported from an SSM ARN.
      certificate = props.certificate;
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
    const securityHeadersBehavior: cloudfront.ResponseSecurityHeadersBehavior = {
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
      contentSecurityPolicy: {
        override: true,
        contentSecurityPolicy: buildContentSecurityPolicy(config),
      },
    };

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeaders",
      {
        responseHeadersPolicyName: `${prefix}-security-headers`,
        securityHeadersBehavior,
      },
    );

    // Dedicated headers policy for /config.js: same security headers, plus a
    // Cache-Control override forcing revalidation. Needed because /config.js
    // carries live endpoint/pool identifiers — the default behavior's
    // long-lived CloudFront caching (and browser HTTP caching) would let a
    // rotated Cognito pool / AppSync endpoint keep serving a stale config
    // until the next `/*` invalidation, which degrades to silent auth-off
    // rather than a visible failure (security review F4/F5).
    const configJsHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "ConfigJsHeaders",
      {
        responseHeadersPolicyName: `${prefix}-config-js-headers`,
        securityHeadersBehavior,
        customHeadersBehavior: {
          customHeaders: [
            {
              header: "Cache-Control",
              value: "no-cache, max-age=0, must-revalidate",
              override: true,
            },
          ],
        },
      },
    );

    // Dedicated CloudFront cache policy for /config.js: TTLs pinned to zero
    // so CloudFront always revalidates with the S3 origin instead of
    // serving a cached copy from a prior deployment.
    const configJsCachePolicy = new cloudfront.CachePolicy(
      this,
      "ConfigJsCachePolicy",
      {
        cachePolicyName: `${prefix}-config-js-no-cache`,
        defaultTtl: cdk.Duration.seconds(0),
        minTtl: cdk.Duration.seconds(0),
        maxTtl: cdk.Duration.seconds(0),
        enableAcceptEncodingGzip: true,
        enableAcceptEncodingBrotli: true,
      },
    );

    // ----------------------------------------------------------------
    // CloudFront distribution
    // ----------------------------------------------------------------
    const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(siteBucket);

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: siteOrigin,
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy,
      },
      // Dedicated no-cache behavior for /config.js — see
      // `configJsCachePolicy`/`configJsHeadersPolicy` above.
      additionalBehaviors: {
        "/config.js": {
          origin: siteOrigin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: configJsCachePolicy,
          responseHeadersPolicy: configJsHeadersPolicy,
        },
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

    this.siteBucket = siteBucket;
    this.distribution = distribution;

    // ----------------------------------------------------------------
    // Deploy SPA assets to S3
    // ----------------------------------------------------------------
    // `config.frontendDistPath` lets consumers ship a prebuilt SPA `dist/`
    // from anywhere (e.g. the twin repo, or CI build output) instead of the
    // in-monorepo default. Unset falls back to the current behavior.
    const frontendDistPath =
      config.frontendDistPath ?? path.join(__dirname, "../../../../frontend/dist");

    // `Source.asset()`'s own error on a missing/empty path is an opaque
    // "Cannot find asset at <path>" thrown deep inside aws-s3-assets with no
    // pointer back to `frontendDistPath` — fail here instead with a message
    // that names the config knob and how to fix it.
    if (!fs.existsSync(frontendDistPath)) {
      throw new Error(
        `FrontendStack: SPA dist directory not found at "${frontendDistPath}". ` +
          "Build the frontend first (npm run build -w @claude-stats/frontend), " +
          "or set config.frontendDistPath (via configOverrides) to a prebuilt dist directory.",
      );
    }

    // Runtime config injected as a sibling file, loaded via a classic
    // <script src="/config.js"> tag in index.html (see
    // packages/frontend/index.html) — NOT inlined, so a pool/endpoint
    // rotation only requires re-deploying this one small file, and so the
    // dedicated no-cache CloudFront behavior above actually has something
    // scoped to invalidate.
    const configJs = renderConfigJs({
      appSyncEndpoint: graphqlEndpoint,
      cognitoUserPoolId: userPoolId,
      cognitoClientId: spaClientId,
      teamLogosCdnUrl,
      branding: config.branding,
    });

    new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [
        s3deploy.Source.asset(frontendDistPath),
        s3deploy.Source.data("config.js", configJs),
      ],
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
