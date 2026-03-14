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
  allowedEmailDomains: string[];
  magicLinkTtlMinutes: number;
  magicLinkMaxRequestsPerHour: number;
  cognitoAdvancedSecurity: boolean;
  cognitoAccessTokenTtlMinutes: number;
  cognitoRefreshTokenTtlDays: number;

  // WAF
  wafRateLimitSignup: number;
  wafRateLimitAuth: number;
  wafRateLimitJoinTeam: number;
  wafGeoRestriction: string[];

  // Data
  dynamoDbEncryption: "AWS_OWNED" | "CUSTOMER_MANAGED";
  dynamoDbPointInTimeRecovery: boolean;
  dynamoDbDeletionProtection: boolean;
  dynamoDbRemovalPolicy: "RETAIN" | "DESTROY";

  // DNS & Frontend
  domainName: string | null;
  parentZoneName: string | null;
  parentZoneId: string | null;

  // Branding
  branding: BrandingConfig;

  // MCP
  mcpEnabled: boolean;

  // Monitoring
  alarmEmailSsmPath: string | null;
  logRetentionDays: number;

  // Cost protection
  monthlyBudgetUsd: number;
  lambdaReservedConcurrency: {
    aggregateStats: number;
  };

  // Secrets
  magicLinkHmacSecretArn: string | null;
}
