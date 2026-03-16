import * as path from "path";
import { fileURLToPath } from "url";
import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";
import { putParam, getParam } from "../ssm-params.js";
import { TeamLogos } from "../constructs/team-logos.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ApiStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
}

/** Table names matching the keys used in DataStack SSM parameters. */
const TABLE_NAMES = [
  "userProfiles",
  "teams",
  "teamMemberships",
  "syncedSessions",
  "syncedMessages",
  "teamStats",
  "achievements",
  "challenges",
  "interTeamChallenges",
] as const;

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { config } = props;
    const prefix = `ClaudeStats-${config.envName}`;

    // ── Read SSM parameters from upstream stacks ──────────────────────

    const userPoolId = getParam(this, prefix, "auth/user-pool-id");
    const syncedSessionsStreamArn = getParam(
      this,
      prefix,
      "data/synced-sessions-stream-arn",
    );

    const tableArns: Record<string, string> = {};
    for (const name of TABLE_NAMES) {
      tableArns[name] = getParam(this, prefix, `data/table-arns/${name}`);
    }

    // ── AppSync GraphQL API ──────────────────────────────────────────

    const userPool = cognito.UserPool.fromUserPoolId(
      this,
      "UserPool",
      userPoolId,
    );

    const api = new appsync.GraphqlApi(this, "Api", {
      name: `${prefix}-Api`,
      definition: appsync.Definition.fromFile(
        path.join(__dirname, "../../graphql/schema.graphql"),
      ),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool },
        },
        additionalAuthorizationModes: [
          { authorizationType: appsync.AuthorizationType.IAM },
        ],
      },
      logConfig: {
        fieldLogLevel: appsync.FieldLogLevel.ERROR,
        retention: config.logRetentionDays,
      },
      xrayEnabled: true,
    });

    // ── DynamoDB data sources ────────────────────────────────────────

    const dataSources: Record<string, appsync.DynamoDbDataSource> = {};

    for (const name of TABLE_NAMES) {
      const table = dynamodb.Table.fromTableArn(
        this,
        `${name}Table`,
        tableArns[name],
      );
      dataSources[name] = api.addDynamoDbDataSource(
        `${name}DS`,
        table,
      );
    }

    // ── Aggregate-stats DLQ (SQS) ────────────────────────────────────

    const dlq = new sqs.Queue(this, "AggregateStatsDLQ", {
      queueName: `${prefix}-aggregate-stats-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // ── Team Logos construct ─────────────────────────────────────────

    new TeamLogos(this, "TeamLogos", { config, prefix });

    // ── SSM Parameters ───────────────────────────────────────────────

    putParam(this, prefix, "api/graphql-endpoint", api.graphqlUrl);
    putParam(this, prefix, "api/graphql-api-id", api.apiId);
    putParam(this, prefix, "api/graphql-api-arn", api.arn);
    putParam(this, prefix, "api/dlq-url", dlq.queueUrl);
  }
}
