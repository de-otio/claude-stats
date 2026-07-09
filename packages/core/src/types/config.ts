/**
 * Environment configuration types.
 * Derived from doc/analysis/team-app/12-environments.md.
 */

export interface BrandingConfig {
  primaryColor: string;
  accentColor: string;
  logoUrl: string | null;
  appTitle: string;
}

export interface EnvironmentConfig {
  envName: "dev" | "prod";
  account: string;
  region: string;

  // Auth
  senderEmail: string;
  allowedEmailDomains: string[];
  /**
   * Cognito `sub`s and/or email addresses granted the "superadmin" group
   * claim by the PreTokenGeneration trigger. Superadmin gates the admin-only
   * allowedDomains / updateAllowedDomains resolvers. Empty/unset → nobody.
   * AUTH-CRITICAL: any value here grants org-wide superadmin.
   */
  superadminSubs?: string[];
  magicLinkTtlMinutes: number;
  magicLinkMaxRequestsPerHour: number;
  cognitoAccessTokenTtlMinutes: number;
  cognitoRefreshTokenTtlDays: number;

  // Data
  dynamoDbEncryption: "AWS_OWNED" | "CUSTOMER_MANAGED";
  dynamoDbPointInTimeRecovery: boolean;
  dynamoDbDeletionProtection: boolean;
  dynamoDbRemovalPolicy: "RETAIN" | "DESTROY";

  // DNS & Frontend
  domainName: string | null;
  parentZoneName: string | null;
  parentZoneId: string | null;
  /**
   * Absolute path to a prebuilt SPA `dist/` directory. Default (unset): the
   * in-monorepo `packages/frontend/dist` (current behavior).
   */
  frontendDistPath?: string;
  /**
   * IAM role ARN in the parent-zone account granting
   * `route53:ChangeResourceRecordSets` for NS delegation. When set, DnsStack
   * must not assume the parent zone is in-account. Default `null`.
   */
  parentZoneDelegationRoleArn?: string | null;
  /**
   * SES identity mode: `"email"` (default, current behavior) verifies a
   * single sender address; `"domain"` creates an SES domain identity on the
   * app hosted zone with Route53 DKIM auto-created.
   */
  sesIdentityMode?: "email" | "domain";

  // Branding
  branding: BrandingConfig;

  // Monitoring
  alarmEmailSsmPath: string | null;
  logRetentionDays: number;

  // Cost protection
  monthlyBudgetUsd: number;
  lambdaReservedConcurrency: {
    aggregateStats: number;
  };
}
