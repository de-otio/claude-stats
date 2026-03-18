import type { EnvironmentConfig } from "./types.js";

/**
 * Sensible defaults for all EnvironmentConfig fields except account and region.
 * Consumers override only what they need via ClaudeStatsAppProps.
 */
export const defaultConfig: Omit<EnvironmentConfig, "account" | "region" | "senderEmail"> = {
  envName: "dev",

  // Auth
  allowedEmailDomains: [],
  magicLinkTtlMinutes: 15,
  magicLinkMaxRequestsPerHour: 5,
  cognitoAccessTokenTtlMinutes: 60,
  cognitoRefreshTokenTtlDays: 30,

  // Data
  dynamoDbEncryption: "AWS_OWNED",
  dynamoDbPointInTimeRecovery: false,
  dynamoDbDeletionProtection: false,
  dynamoDbRemovalPolicy: "DESTROY",

  // DNS & Frontend
  domainName: null,
  parentZoneName: null,
  parentZoneId: null,

  // Branding
  branding: {
    primaryColor: "indigo",
    accentColor: "emerald",
    logoUrl: null,
    appTitle: "Claude Stats",
  },

  // MCP
  mcpEnabled: true,

  // Monitoring
  alarmEmailSsmPath: null,
  logRetentionDays: 7,

  // Cost protection
  monthlyBudgetUsd: 50,
  lambdaReservedConcurrency: { aggregateStats: 5 },

  // Secrets
  magicLinkHmacSecretArn: null,
};
