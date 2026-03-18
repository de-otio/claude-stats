import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
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

    const encryption =
      config.dynamoDbEncryption === "CUSTOMER_MANAGED"
        ? dynamodb.TableEncryption.CUSTOMER_MANAGED
        : dynamodb.TableEncryption.DEFAULT;

    const removalPolicy =
      config.dynamoDbRemovalPolicy === "RETAIN"
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY;

    const commonProps = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption,
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

    // ---------- SyncedSessions ----------

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

    // ---------- SyncedMessages ----------

    const syncedMessages = new dynamodb.Table(this, "SyncedMessages", {
      ...commonProps,
      tableName: `${prefix}-syncedMessages`,
      partitionKey: { name: "sessionId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "uuid", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expiresAt",
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

    putParam(
      this,
      prefix,
      "data/synced-sessions-stream-arn",
      syncedSessions.tableStreamArn!,
    );
  }
}
