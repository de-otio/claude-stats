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

/**
 * GSI names per table (must mirror DataStack). Passed to
 * `fromTableAttributes` so the data-source grants include `arn/index/*` —
 * without this an imported table reports `hasIndex=false` and resolvers
 * that Query a GSI get AccessDenied at runtime.
 */
const TABLE_INDEXES: Record<string, string[]> = {
  teams: ["TeamsBySlug", "TeamsByVisibility"],
  teamMemberships: ["MembershipsByUser"],
  syncedSessions: ["SessionsByTimestamp", "SessionsByAccount", "SessionsByProject"],
  userAggregates: ["AggregatesByAccount", "AggregatesByProject"],
  teamStats: ["StatsByPeriod"],
  interTeamChallenges: ["InterTeamChallengesByStatus"],
};

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
        globalIndexes: TABLE_INDEXES[name] ?? [],
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
      /** "Query" | "Mutation" | a nested object type (e.g. "Team") */
      typeName: string;
      field: string;
      dataSource: appsync.BaseDataSource;
      /** logical→physical table-name substitutions for batch/transact ops */
      subs?: Record<string, string>;
      /** resolver file when it differs from `${field}.js` (nested fields) */
      file?: string;
    }

    const unitResolvers: UnitResolverSpec[] = [
      // ── P0: personal-dashboard critical path + the aggregate sync write ──
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
      // ── P1a: team read path (complete + clean unit resolvers) ──
      { typeName: "Query", field: "team", dataSource: dataSources.teams },
      { typeName: "Query", field: "teamMembers", dataSource: dataSources.teamMemberships },
      // ── P1b: nested field resolvers ──
      // Team.members — roster, gated to team members (also hides members on
      // the reader-dashboard path). User.achievements — e.g. `me { achievements }`.
      // TeamMember.stats — per-member snapshot from TeamStats (writer = P3).
      {
        typeName: "Team",
        field: "members",
        dataSource: dataSources.teamMemberships,
        file: "teamMembersField.js",
      },
      {
        typeName: "User",
        field: "achievements",
        dataSource: dataSources.achievements,
        file: "userAchievementsField.js",
      },
      {
        typeName: "TeamMember",
        field: "stats",
        dataSource: dataSources.teamStats,
        file: "teamMemberStatsField.js",
      },
    ];

    for (const r of unitResolvers) {
      // Field names are unique across all specs, so `${field}Resolver` stays
      // a stable construct id (renaming would delete+recreate live resolvers).
      r.dataSource.createResolver(`${r.field}Resolver`, {
        typeName: r.typeName,
        fieldName: r.field,
        runtime: jsRuntime,
        code: loadCode(r.file ?? `${r.field}.js`, r.subs),
      });
    }

    // ── Pipeline resolvers ───────────────────────────────────────────
    // Each step is an AppSync function bound to its own data source; the
    // resolver itself is a thin before/after pass-through.
    const pipelinePassthrough = appsync.Code.fromInline(
      "export function request() { return {}; }\n" +
        "export function response(ctx) { return ctx.prev.result; }\n",
    );

    interface PipelineStep {
      file: string;
      dataSource: appsync.BaseDataSource;
      subs?: Record<string, string>;
    }
    interface PipelineResolverSpec {
      typeName: "Query" | "Mutation";
      field: string;
      steps: PipelineStep[];
    }

    const pipelineResolvers: PipelineResolverSpec[] = [
      {
        typeName: "Query",
        field: "teamProjectInsights",
        steps: [
          { file: "teamProjectInsights.js", dataSource: dataSources.teamMemberships },
          { file: "teamProjectInsightsStep2.js", dataSource: dataSources.teamStats },
        ],
      },
      {
        typeName: "Query",
        field: "teamProjects",
        steps: [
          { file: "teamProjects.js", dataSource: dataSources.teamMemberships },
          { file: "teamProjectsStep2.js", dataSource: dataSources.teamStats },
        ],
      },
      {
        typeName: "Query",
        field: "teamDashboardAsReader",
        steps: [
          { file: "teamDashboardAsReader.js", dataSource: dataSources.teams },
          { file: "teamDashboardAsReaderStep2.js", dataSource: dataSources.teamStats },
        ],
      },
      {
        typeName: "Query",
        field: "teamsComparison",
        steps: [
          { file: "teamsComparison.js", dataSource: dataSources.teams },
          { file: "teamsComparisonStep2.js", dataSource: dataSources.teams },
          {
            file: "teamsComparisonStep3.js",
            dataSource: dataSources.teamStats,
            subs: { __TABLE_TEAMSTATS__: physicalName("teamStats") },
          },
        ],
      },
      // ── P1b: myTeams / teamBySlug hydration (Team read path, teams-only) ──
      // Step 1 finds teamIds (GSI); Step 2 batch-gets / gets the full Team(s).
      {
        typeName: "Query",
        field: "myTeams",
        steps: [
          { file: "myTeams.js", dataSource: dataSources.teamMemberships },
          {
            file: "myTeamsStep2.js",
            dataSource: dataSources.teams,
            subs: { __TABLE_TEAMS__: physicalName("teams") },
          },
        ],
      },
      {
        typeName: "Query",
        field: "teamBySlug",
        steps: [
          { file: "teamBySlug.js", dataSource: dataSources.teams },
          { file: "teamBySlugStep2.js", dataSource: dataSources.teams },
        ],
      },
    ];

    for (const r of pipelineResolvers) {
      const fns = r.steps.map((s, i) =>
        s.dataSource.createFunction(`${r.field}Fn${i + 1}`, {
          name: `${r.field}Fn${i + 1}`,
          runtime: jsRuntime,
          code: loadCode(s.file, s.subs),
        }),
      );
      api.createResolver(`${r.field}Resolver`, {
        typeName: r.typeName,
        fieldName: r.field,
        runtime: jsRuntime,
        code: pipelinePassthrough,
        pipelineConfig: fns,
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
