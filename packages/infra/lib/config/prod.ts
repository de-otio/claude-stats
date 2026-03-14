import type { EnvironmentConfig } from "./types.js";

export const prodConfig: EnvironmentConfig = {
  envName: "prod",
  account: process.env.CDK_PROD_ACCOUNT ?? "987654321098",
  region: process.env.CDK_PROD_REGION ?? "us-east-1",

  // Auth — strict
  allowedEmailDomains: ["acme.com"],
  magicLinkTtlMinutes: 15,
  magicLinkMaxRequestsPerHour: 3,
  cognitoAdvancedSecurity: true,
  cognitoAccessTokenTtlMinutes: 60,
  cognitoRefreshTokenTtlDays: 30,

  // WAF — strict
  wafRateLimitSignup: 5,
  wafRateLimitAuth: 10,
  wafRateLimitJoinTeam: 10,
  wafGeoRestriction: [], // Configure if needed

  // Data — protected
  dynamoDbEncryption: "CUSTOMER_MANAGED",
  dynamoDbPointInTimeRecovery: true,
  dynamoDbDeletionProtection: true,
  dynamoDbRemovalPolicy: "RETAIN",

  // DNS & Frontend
  domainName: "stats.acme.com",
  parentZoneName: "acme.com",
  parentZoneId: "Z0123456789ABCDEFGHIJ", // Hosted zone ID of acme.com

  // Branding
  branding: {
    primaryColor: "indigo",
    accentColor: "emerald",
    logoUrl: "https://cdn.acme.com/logo.svg", // Organization logo for nav bar
    appTitle: "Acme Claude Stats",
  },

  // MCP
  mcpEnabled: true,

  // Monitoring
  alarmEmailSsmPath: "/claude-stats/prod/alarm-email",
  logRetentionDays: 90,

  // Cost protection
  monthlyBudgetUsd: 50,
  lambdaReservedConcurrency: { aggregateStats: 10 },

  // Secrets
  magicLinkHmacSecretArn:
    "arn:aws:secretsmanager:us-east-1:987654321098:secret:claude-stats/magic-link-hmac",
};
