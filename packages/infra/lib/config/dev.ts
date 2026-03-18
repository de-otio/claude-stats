import type { EnvironmentConfig } from './types.js';

export const devConfig: EnvironmentConfig = {
  envName: 'dev',
  account: process.env.CDK_DEV_ACCOUNT ?? '123456789012',
  region: process.env.CDK_DEV_REGION ?? 'us-east-1',

  // Auth — permissive for testing
  senderEmail: 'noreply@acme-dev.com',
  allowedEmailDomains: ['acme.com', 'acme.io', 'example.com'],
  magicLinkTtlMinutes: 60, // Longer TTL for dev convenience
  magicLinkMaxRequestsPerHour: 20,
  cognitoAccessTokenTtlMinutes: 60,
  cognitoRefreshTokenTtlDays: 30,

  // Data — disposable in dev
  dynamoDbEncryption: 'AWS_OWNED',
  dynamoDbPointInTimeRecovery: false,
  dynamoDbDeletionProtection: false,
  dynamoDbRemovalPolicy: 'DESTROY',

  // DNS & Frontend
  domainName: null, // Use CloudFront default URL
  parentZoneName: null,
  parentZoneId: null,

  // Branding
  branding: {
    primaryColor: 'indigo',
    accentColor: 'emerald',
    logoUrl: null,
    appTitle: 'Claude Stats (Dev)',
  },

  // MCP
  mcpEnabled: true,

  // Monitoring
  alarmEmailSsmPath: null, // No alerts in dev
  logRetentionDays: 7,

  // Cost protection
  monthlyBudgetUsd: 20,
  lambdaReservedConcurrency: { aggregateStats: 5 },

  // Secrets
  magicLinkHmacSecretArn: null, // Auto-generated in dev
};
