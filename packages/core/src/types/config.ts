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
