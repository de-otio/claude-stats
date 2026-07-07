import type { EnvironmentConfig } from "./config/types.js";

/**
 * Build the frontend's Content-Security-Policy header value.
 *
 * The SPA only ever talks to AWS-managed endpoints (Cognito, AppSync, the
 * team-logos CloudFront distribution) whose exact hostnames are CDK
 * deploy-time tokens (SSM `Ref`s) unavailable at synth time — see
 * `getParam` in `ssm-params.ts`. So instead of the literal per-deployment
 * hostname, directives use the AWS *service domain pattern* for
 * `config.region`, which IS a synth-time literal:
 *  - Cognito's IDP endpoint is always `cognito-idp.<region>.amazonaws.com`.
 *  - An AppSync GraphQL API endpoint is always
 *    `<api-id>.appsync-api.<region>.amazonaws.com` — wildcarded on the
 *    api-id, which is only known at deploy time.
 *  - The team-logos CDN is a CloudFront distribution, always
 *    `<distribution-id>.cloudfront.net` — wildcarded the same way.
 * This keeps the policy generic across OSS deployments (derived purely
 * from `config`, no hardcoded account/org-specific hosts) while staying
 * tighter than a blanket `https:` allowance.
 */
export function buildContentSecurityPolicy(config: EnvironmentConfig): string {
  const region = config.region;

  const connectSrc = [
    "'self'",
    `https://cognito-idp.${region}.amazonaws.com`,
    `https://*.appsync-api.${region}.amazonaws.com`,
  ].join(" ");

  const imgSrc = ["'self'", "data:", "https://*.cloudfront.net"].join(" ");

  return [
    "default-src 'self'",
    "script-src 'self'",
    `connect-src ${connectSrc}`,
    `img-src ${imgSrc}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
