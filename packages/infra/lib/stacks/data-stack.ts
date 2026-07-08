import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";
import { putParam } from "../ssm-params.js";

interface DataStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
}

export class DataStack extends cdk.Stack {
  public readonly tables: Record<string, dynamodb.Table>;
  public readonly syncedSessionsStreamArn: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, { ...props, description: "Claude Stats data layer — DynamoDB tables, GSIs, and streams" });
    const { config } = props;
    const prefix = `ClaudeStats-${config.envName}`;

    // ---------- shared table settings ----------

    const removalPolicy =
      config.dynamoDbRemovalPolicy === "RETAIN"
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY;

    // Customer-managed KMS key (review N2): when CUSTOMER_MANAGED encryption
    // is selected, use an explicit key with rotation enabled rather than
    // relying on CDK's implicit auto-created key, which does NOT enable
    // rotation by default. Shared across the data tables (one CMK, not one
    // per table) to keep KMS API cost bounded.
    const tableEncryptionKey =
      config.dynamoDbEncryption === "CUSTOMER_MANAGED"
        ? new kms.Key(this, "DataEncryptionKey", {
            description: `Claude Stats DynamoDB customer-managed key (${config.envName})`,
            enableKeyRotation: true,
            removalPolicy,
            alias: `alias/${prefix}-data`,
          })
        : undefined;

    const encryption =
      config.dynamoDbEncryption === "CUSTOMER_MANAGED"
        ? dynamodb.TableEncryption.CUSTOMER_MANAGED
        : dynamodb.TableEncryption.DEFAULT;

    const commonProps = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption,
      encryptionKey: tableEncryptionKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: config.dynamoDbPointInTimeRecovery },
      deletionProtection: config.dynamoDbDeletionProtection,
      removalPolicy,
    };

    // ---------- UserProfiles ----------

    const userProfiles = new dynamodb.Table(this, "UserProfiles", {
      ...commonProps,
      tableName: `${prefix}-userProfiles`,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
    });

    // ---------- Teams ----------

    const teams = new dynamodb.Table(this, "Teams", {
      ...commonProps,
      tableName: `${prefix}-teams`,
      partitionKey: { name: "teamId", type: dynamodb.AttributeType.STRING },
    });

    teams.addGlobalSecondaryIndex({
      indexName: "TeamsBySlug",
      partitionKey: { name: "teamSlug", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    teams.addGlobalSecondaryIndex({
      indexName: "TeamsByVisibility",
      partitionKey: {
        name: "crossTeamVisibility",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: "teamId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ["teamName", "teamSlug", "logoUrl", "memberCount"],
    });

    // ---------- TeamMemberships ----------

    const teamMemberships = new dynamodb.Table(this, "TeamMemberships", {
      ...commonProps,
      tableName: `${prefix}-teamMemberships`,
      partitionKey: { name: "teamId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "userId", type: dynamodb.AttributeType.STRING },
    });

    teamMemberships.addGlobalSecondaryIndex({
      indexName: "MembershipsByUser",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "teamId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ["role", "joinedAt", "displayName"],
    });

    // ---------- SyncedSessions / SyncedMessages ----------
    //
    // NOTE (review F9/S6, scoped down): these tables and their downstream
    // DynamoDB-Streams consumer (`lambda/api/aggregate-stats.ts`, which
    // groups per-session stream records into TeamStats by ISO week) are
    // left untouched here — restructuring their key schema cascades into
    // that Lambda's business logic and its test suite, both out of this
    // phase's file scope. The structural fix for the aggregate-only
    // invariant is applied at the schema/resolver layer instead: no
    // GraphQL operation reads or writes these tables' per-session/per-
    // message shape any more (`mySessions`/`sessionMessages`/
    // `syncSessions`/`syncMessages` are deleted from `schema.graphql`).
    // These tables become dead infrastructure once undeployed writers stop;
    // migrating `aggregate-stats.ts` onto the new `UserAggregates` table
    // below (and retiring these two) is follow-up work for whoever wires
    // the DynamoDB-Streams pipeline end-to-end.

    const syncedSessions = new dynamodb.Table(this, "SyncedSessions", {
      ...commonProps,
      tableName: `${prefix}-syncedSessions`,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    syncedSessions.addGlobalSecondaryIndex({
      indexName: "SessionsByTimestamp",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: {
        name: "firstTimestamp",
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "accountId",
        "projectId",
        "updatedAt",
        "sessionId",
        "promptCount",
        "estimatedCost",
      ],
    });

    syncedSessions.addGlobalSecondaryIndex({
      indexName: "SessionsByAccount",
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      sortKey: {
        name: "firstTimestamp",
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "userId",
        "projectId",
        "updatedAt",
        "sessionId",
        "promptCount",
        "estimatedCost",
      ],
    });

    syncedSessions.addGlobalSecondaryIndex({
      indexName: "SessionsByProject",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: {
        name: "firstTimestamp",
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "userId",
        "accountId",
        "sessionId",
        "promptCount",
        "inputTokens",
        "outputTokens",
        "estimatedCost",
      ],
    });

    const syncedMessages = new dynamodb.Table(this, "SyncedMessages", {
      ...commonProps,
      tableName: `${prefix}-syncedMessages`,
      partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "uuid", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expiresAt",
    });

    // ---------- UserAggregates (aggregate-only, review F9/S6) ----------
    //
    // The org backend's actual sync target: one row per (userId, period)
    // client-computed, client-minimized aggregate bucket. There is no
    // per-session or per-message field here, ever — the mutation/query
    // surface for this table (`syncAggregate`/`myAggregates`/`myStats`/
    // `myProjects` resolvers) is the only sync path exposed by the schema.

    const userAggregates = new dynamodb.Table(this, "UserAggregates", {
      ...commonProps,
      tableName: `${prefix}-userAggregates`,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "period", type: dynamodb.AttributeType.STRING },
    });

    userAggregates.addGlobalSecondaryIndex({
      indexName: "AggregatesByAccount",
      partitionKey: { name: "accountId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "period", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "userId",
        "projectId",
        "updatedAt",
        "sessionCount",
        "promptCount",
        "estimatedCost",
      ],
    });

    userAggregates.addGlobalSecondaryIndex({
      indexName: "AggregatesByProject",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "period", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "userId",
        "accountId",
        "sessionCount",
        "promptCount",
        "inputTokens",
        "outputTokens",
        "estimatedCost",
      ],
    });

    // ---------- TeamStats ----------

    const teamStats = new dynamodb.Table(this, "TeamStats", {
      ...commonProps,
      tableName: `${prefix}-teamStats`,
      partitionKey: { name: "teamId", type: dynamodb.AttributeType.STRING },
      sortKey: {
        name: "period#userId",
        type: dynamodb.AttributeType.STRING,
      },
      timeToLiveAttribute: "expiresAt",
    });

    teamStats.addGlobalSecondaryIndex({
      indexName: "StatsByPeriod",
      partitionKey: { name: "period", type: dynamodb.AttributeType.STRING },
      sortKey: {
        name: "teamId#userId",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ["stats", "displayName", "shareLevel"],
    });

    // ---------- Achievements ----------

    const achievements = new dynamodb.Table(this, "Achievements", {
      ...commonProps,
      tableName: `${prefix}-achievements`,
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: {
        name: "achievementId",
        type: dynamodb.AttributeType.STRING,
      },
    });

    // ---------- Challenges ----------

    const challenges = new dynamodb.Table(this, "Challenges", {
      ...commonProps,
      tableName: `${prefix}-challenges`,
      partitionKey: { name: "teamId", type: dynamodb.AttributeType.STRING },
      sortKey: {
        name: "challengeId",
        type: dynamodb.AttributeType.STRING,
      },
      timeToLiveAttribute: "expiresAt",
    });

    // ---------- InterTeamChallenges ----------

    const interTeamChallenges = new dynamodb.Table(
      this,
      "InterTeamChallenges",
      {
        ...commonProps,
        tableName: `${prefix}-interTeamChallenges`,
        partitionKey: {
          name: "challengeId",
          type: dynamodb.AttributeType.STRING,
        },
        timeToLiveAttribute: "expiresAt",
      },
    );

    interTeamChallenges.addGlobalSecondaryIndex({
      indexName: "InterTeamChallengesByStatus",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "endTime", type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ["name", "metric", "teams", "creatingTeamId"],
    });

    // ---------- MagicLinkTokens ----------

    const magicLinkTokens = new dynamodb.Table(this, "MagicLinkTokens", {
      ...commonProps,
      tableName: `${prefix}-magicLinkTokens`,
      partitionKey: { name: "email", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expiresAt",
    });

    // ---------- SSM Parameters ----------

    const tables: Record<string, dynamodb.Table> = {
      userProfiles,
      teams,
      teamMemberships,
      syncedSessions,
      syncedMessages,
      userAggregates,
      teamStats,
      achievements,
      challenges,
      interTeamChallenges,
      magicLinkTokens,
    };

    this.tables = tables;
    this.syncedSessionsStreamArn = syncedSessions.tableStreamArn!;

    for (const [name, table] of Object.entries(tables)) {
      putParam(this, prefix, `data/table-arns/${name}`, table.tableArn);
      putParam(this, prefix, `data/table-names/${name}`, table.tableName);
    }

    // Export the DynamoDB CMK ARN so consumer stacks (e.g. AuthStack) can grant
    // their Lambda roles KMS access to it. A table imported by ARN alone does
    // NOT carry its encryption key, so `grantReadWriteData` on the import only
    // grants DynamoDB actions — writers then AccessDenied on kms:Decrypt /
    // GenerateDataKey against a CUSTOMER_MANAGED table. Only present when a CMK
    // exists (CUSTOMER_MANAGED); AWS-owned encryption needs no grant.
    if (tableEncryptionKey) {
      putParam(this, prefix, "data/encryption-key-arn", tableEncryptionKey.keyArn);
    }

    putParam(
      this,
      prefix,
      "data/synced-sessions-stream-arn",
      syncedSessions.tableStreamArn!,
    );
  }
}
