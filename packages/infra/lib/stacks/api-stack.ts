import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";
import { putParam, getParam } from "../ssm-params.js";
import { TeamLogos } from "../constructs/team-logos.js";
import { toRetentionDays } from "../log-retention.js";

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
  "userAggregates",
  "teamStats",
  "achievements",
  "challenges",
  "interTeamChallenges",
] as const;

export class ApiStack extends cdk.Stack {
  public readonly graphqlApi: appsync.GraphqlApi;
  public readonly dlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, { ...props, description: "Claude Stats API — AppSync GraphQL, DynamoDB data sources, team logos CDN" });
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

    // DynamoDB CMK (CUSTOMER_MANAGED envs). Imported so the table imports below
    // carry it as `encryptionKey` — that is what makes the AppSync data-source
    // role grant also include the KMS actions (Decrypt / GenerateDataKey) that
    // reading & writing a CMK-encrypted table requires. Without it every
    // resolver AccessDenies on kms:Decrypt at runtime.
    const dataEncryptionKey =
      config.dynamoDbEncryption === "CUSTOMER_MANAGED"
        ? kms.Key.fromKeyArn(
            this,
            "DataEncryptionKey",
            getParam(this, prefix, "data/encryption-key-arn"),
          )
        : undefined;

    // ── AppSync GraphQL API ──────────────────────────────────────────

    const userPool = cognito.UserPool.fromUserPoolId(
      this,
      "UserPool",
      userPoolId,
    );

    const api = new appsync.GraphqlApi(this, "Api", {
      name: `${prefix}-Api`,
      definition: appsync.Definition.fromFile(
        path.join(__dirname, "../../../graphql/schema.graphql"),
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
        retention: toRetentionDays(config.logRetentionDays),
      },
      xrayEnabled: true,
    });

    // ── DynamoDB data sources ────────────────────────────────────────

    const dataSources: Record<string, appsync.DynamoDbDataSource> = {};

    for (const name of TABLE_NAMES) {
      const table = dynamodb.Table.fromTableAttributes(this, `${name}Table`, {
        tableArn: tableArns[name],
        encryptionKey: dataEncryptionKey,
      });
      dataSources[name] = api.addDynamoDbDataSource(
        `${name}DS`,
        table,
      );
    }

    // ── Resolvers ────────────────────────────────────────────────────
    //
    // AppSync JS (APPSYNC_JS) resolvers live in graphql/resolvers/js/*.js.
    // They are attached here, table-driven so later phases add spec rows.
    //
    // Batch/transact resolvers hardcode PascalCase logical table-name strings
    // in their source (e.g. `table: "UserAggregates"`); AppSync addresses
    // tables by their *physical* name, so those strings are rewritten to the
    // env-prefixed physical name — a deterministic synth-time string,
    // `${prefix}-<key>` (config.envName is a plain string, not a token).

    const resolverDir = path.join(__dirname, "../../../graphql/resolvers/js");
    const physicalName = (key: string) => `${prefix}-${key}`;
    const jsRuntime = appsync.FunctionRuntime.JS_1_0_0;

    /** Read a resolver file, applying logical→physical table-name subs. */
    const loadCode = (
      file: string,
      subs: Record<string, string> = {},
    ): appsync.Code => {
      let src = fs.readFileSync(path.join(resolverDir, file), "utf-8");
      for (const [logical, physical] of Object.entries(subs)) {
        src = src.split(`"${logical}"`).join(`"${physical}"`);
      }
      return appsync.Code.fromInline(src);
    };

    const noneDs = api.addNoneDataSource("NoneDS");

    interface UnitResolverSpec {
      typeName: "Query" | "Mutation";
      field: string;
      dataSource: appsync.BaseDataSource;
      /** logical→physical table-name substitutions for batch/transact ops */
      subs?: Record<string, string>;
    }

    // ── P0: personal-dashboard critical path + the aggregate sync write ──
    const unitResolvers: UnitResolverSpec[] = [
      { typeName: "Query", field: "me", dataSource: dataSources.userProfiles },
      { typeName: "Query", field: "myStats", dataSource: dataSources.userAggregates },
      { typeName: "Query", field: "myProjects", dataSource: dataSources.userAggregates },
      { typeName: "Query", field: "myAggregates", dataSource: dataSources.userAggregates },
      { typeName: "Query", field: "myAchievements", dataSource: dataSources.achievements },
      { typeName: "Query", field: "availableAchievements", dataSource: noneDs },
      {
        typeName: "Mutation",
        field: "syncAggregate",
        dataSource: dataSources.userAggregates,
        subs: { UserAggregates: physicalName("userAggregates") },
      },
    ];

    for (const r of unitResolvers) {
      r.dataSource.createResolver(`${r.field}Resolver`, {
        typeName: r.typeName,
        fieldName: r.field,
        runtime: jsRuntime,
        code: loadCode(`${r.field}.js`, r.subs),
      });
    }

    // ── Aggregate-stats DLQ (SQS) ────────────────────────────────────

    const dlq = new sqs.Queue(this, "AggregateStatsDLQ", {
      queueName: `${prefix}-aggregate-stats-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.graphqlApi = api;
    this.dlq = dlq;

    // ── Team Logos construct ─────────────────────────────────────────

    new TeamLogos(this, "TeamLogos", { config, prefix });

    // ── SSM Parameters ───────────────────────────────────────────────

    putParam(this, prefix, "api/graphql-endpoint", api.graphqlUrl);
    putParam(this, prefix, "api/graphql-api-id", api.apiId);
    putParam(this, prefix, "api/graphql-api-arn", api.arn);
    putParam(this, prefix, "api/dlq-url", dlq.queueUrl);
  }
}
