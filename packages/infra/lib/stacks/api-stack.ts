import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaRuntime from "aws-cdk-lib/aws-lambda";
import {
  DynamoEventSource,
  SqsDlq,
} from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
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
    const userAggregatesStreamArn = getParam(
      this,
      prefix,
      "data/user-aggregates-stream-arn",
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
    const tables: Record<string, dynamodb.ITable> = {};

    for (const name of TABLE_NAMES) {
      const table = dynamodb.Table.fromTableAttributes(this, `${name}Table`, {
        tableArn: tableArns[name],
        encryptionKey: dataEncryptionKey,
        globalIndexes: TABLE_INDEXES[name] ?? [],
      });
      tables[name] = table;
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

    // ── SSM HTTP data source (admin allowed-domains) ─────────────────
    // The allowedDomains / updateAllowedDomains resolvers call the SSM REST
    // API directly (SigV4-signed) rather than via a Lambda. AppSync signs
    // outbound requests with this data source's service role, so the grant
    // below is what authorizes GetParameter/PutParameter on the one param.
    const ssmDs = api.addHttpDataSource(
      "SsmDS",
      `https://ssm.${config.region}.amazonaws.com`,
      {
        name: "SsmDS",
        description: "SSM Parameter Store (allowed email domains)",
        authorizationConfig: {
          signingRegion: config.region,
          signingServiceName: "ssm",
        },
      },
    );
    const allowedDomainsParamName = `/${prefix}/auth/allowed-domains`;
    ssmDs.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${allowedDomainsParamName}`,
        ],
      }),
    );

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
      // IAM-only mutation the aggregate-stats worker fires after writing
      // TeamStats; a local (NONE) resolver just echoes the update so the
      // onTeamStatsUpdated subscription fans out to connected clients.
      { typeName: "Mutation", field: "refreshTeamStats", dataSource: noneDs },
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
      // ── P2: single-function mutation writes (ownership-scoped) ──
      // (updateProfile deferred to P2 chunk 2 — its nested preferences.* update
      //  needs a get-merge pipeline; the ddb.update helper mishandles dotted paths.)
      { typeName: "Mutation", field: "linkAccount", dataSource: dataSources.userProfiles },
      { typeName: "Mutation", field: "updateMembership", dataSource: dataSources.teamMemberships },
      // ── P3b: intra-team challenge CRUD (challenges table; scoring worker deferred) ──
      // joinChallenge/completeChallenge derive teamId from the caller's team-group
      // claims (table PK is teamId but the field args carry only challengeId).
      { typeName: "Mutation", field: "createChallenge", dataSource: dataSources.challenges },
      { typeName: "Mutation", field: "joinChallenge", dataSource: dataSources.challenges },
      { typeName: "Mutation", field: "completeChallenge", dataSource: dataSources.challenges },
      { typeName: "Query", field: "activeChallenge", dataSource: dataSources.challenges },
      { typeName: "Query", field: "challengeHistory", dataSource: dataSources.challenges },
      // ── P3c: inter-team challenge reads (writes are pipelines below) ──
      { typeName: "Query", field: "activeInterTeamChallenges", dataSource: dataSources.interTeamChallenges },
      { typeName: "Query", field: "interTeamChallengeHistory", dataSource: dataSources.interTeamChallenges },
      // ── P4b: team logo delete (clears logoUrl; S3 object expires via lifecycle) ──
      { typeName: "Mutation", field: "deleteTeamLogo", dataSource: dataSources.teams },
      // ── P4a: superadmin allowed-domains admin (SSM-backed, HTTP data source) ──
      // Both resolvers gate on the "superadmin" cognito:groups claim (granted
      // by the Auth-stack PreTokenGeneration trigger via SUPERADMIN_SUBS). The
      // __ALLOWED_DOMAINS_PARAM__ placeholder is substituted to the env-scoped
      // SSM path the PreSignUp Lambda reads — one param, one source of truth.
      {
        typeName: "Query",
        field: "allowedDomains",
        dataSource: ssmDs,
        subs: { __ALLOWED_DOMAINS_PARAM__: allowedDomainsParamName },
      },
      {
        typeName: "Mutation",
        field: "updateAllowedDomains",
        dataSource: ssmDs,
        subs: { __ALLOWED_DOMAINS_PARAM__: allowedDomainsParamName },
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
      // ── P2: multi-step mutation writes ──
      // Split cross-table writes into per-table steps so each step binds to a
      // data source that already has write grants (default readWrite) — no
      // BatchPut/TransactWrite cross-table IAM. Non-atomic by design (a mid-
      // pipeline failure can leave partial state); acceptable for this app.
      {
        typeName: "Mutation",
        field: "createTeam",
        steps: [
          { file: "createTeam.js", dataSource: dataSources.teams },
          { file: "createTeamStep2.js", dataSource: dataSources.teamMemberships },
        ],
      },
      {
        typeName: "Mutation",
        field: "unlinkAccount",
        steps: [
          { file: "unlinkAccount.js", dataSource: dataSources.userProfiles },
          { file: "unlinkAccountStep2.js", dataSource: dataSources.userProfiles },
        ],
      },
      {
        typeName: "Mutation",
        field: "updateAccountSharing",
        steps: [
          { file: "updateAccountSharing.js", dataSource: dataSources.userProfiles },
          { file: "updateAccountSharingStep2.js", dataSource: dataSources.userProfiles },
        ],
      },
      {
        typeName: "Mutation",
        field: "updateTeamSettings",
        steps: [
          { file: "updateTeamSettings.js", dataSource: dataSources.teamMemberships },
          { file: "updateTeamSettingsStep2.js", dataSource: dataSources.teams },
        ],
      },
      {
        typeName: "Mutation",
        field: "regenerateInviteCode",
        steps: [
          { file: "regenerateInviteCode.js", dataSource: dataSources.teamMemberships },
          { file: "regenerateInviteCodeStep2.js", dataSource: dataSources.teams },
        ],
      },
      {
        typeName: "Mutation",
        field: "promoteMember",
        steps: [
          { file: "promoteMember.js", dataSource: dataSources.teamMemberships },
          { file: "promoteMemberStep2.js", dataSource: dataSources.teamMemberships },
        ],
      },
      // ── P2 chunk 2: membership lifecycle + updateProfile ──
      {
        typeName: "Mutation",
        field: "updateProfile",
        steps: [
          { file: "updateProfile.js", dataSource: dataSources.userProfiles },
          { file: "updateProfileStep2.js", dataSource: dataSources.userProfiles },
        ],
      },
      {
        typeName: "Mutation",
        field: "joinTeam",
        steps: [
          { file: "joinTeam.js", dataSource: dataSources.teams },
          { file: "joinTeamStep2.js", dataSource: dataSources.teamMemberships },
          { file: "joinTeamStep3.js", dataSource: dataSources.teams },
        ],
      },
      {
        typeName: "Mutation",
        field: "leaveTeam",
        steps: [
          { file: "leaveTeam.js", dataSource: dataSources.teamMemberships },
          { file: "leaveTeamStep2.js", dataSource: dataSources.teamMemberships },
          { file: "leaveTeamStep3.js", dataSource: dataSources.teams },
        ],
      },
      {
        typeName: "Mutation",
        field: "removeMember",
        steps: [
          { file: "removeMember.js", dataSource: dataSources.teamMemberships },
          { file: "removeMemberStep2.js", dataSource: dataSources.teamMemberships },
          // Step 3 (decrement memberCount) shares leaveTeamStep3 — both key off stash.teamId.
          { file: "leaveTeamStep3.js", dataSource: dataSources.teams },
        ],
      },
      {
        typeName: "Mutation",
        field: "deleteTeam",
        steps: [
          { file: "deleteTeam.js", dataSource: dataSources.teamMemberships },
          { file: "deleteTeamStep2.js", dataSource: dataSources.teamMemberships },
          {
            file: "deleteTeamStep3.js",
            dataSource: dataSources.teamMemberships,
            subs: { __TABLE_MEMBERSHIPS__: physicalName("teamMemberships") },
          },
          { file: "deleteTeamStep4.js", dataSource: dataSources.teams },
        ],
      },
      // ── P3c: inter-team challenge writes (cross-table per-step pipelines) ──
      // create: verify admin (memberships) → read creating team (teams) → put challenge.
      {
        typeName: "Mutation",
        field: "createInterTeamChallenge",
        steps: [
          { file: "createInterTeamChallenge.js", dataSource: dataSources.teamMemberships },
          { file: "createInterTeamChallengeStep2.js", dataSource: dataSources.teams },
          { file: "createInterTeamChallengeStep3.js", dataSource: dataSources.interTeamChallenges },
        ],
      },
      // join: verify admin (memberships) → read joining team (teams) → find challenge by
      // inviteCode (interTeamChallenges) → append team (interTeamChallenges).
      {
        typeName: "Mutation",
        field: "joinInterTeamChallenge",
        steps: [
          { file: "joinInterTeamChallenge.js", dataSource: dataSources.teamMemberships },
          { file: "joinInterTeamChallengeStep2.js", dataSource: dataSources.teams },
          { file: "joinInterTeamChallengeStep3.js", dataSource: dataSources.interTeamChallenges },
          { file: "joinInterTeamChallengeStep4.js", dataSource: dataSources.interTeamChallenges },
        ],
      },
      // complete: load challenge (interTeamChallenges) → verify admin of creatingTeamId
      // (memberships) → set status completed (interTeamChallenges).
      {
        typeName: "Mutation",
        field: "completeInterTeamChallenge",
        steps: [
          { file: "completeInterTeamChallenge.js", dataSource: dataSources.interTeamChallenges },
          { file: "completeInterTeamChallengeStep2.js", dataSource: dataSources.teamMemberships },
          { file: "completeInterTeamChallengeStep3.js", dataSource: dataSources.interTeamChallenges },
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

    // ── Lambda-backed resolvers ──────────────────────────────────────
    //
    // Some mutations need cross-table work or an AWS API call that a VTL/JS
    // resolver can't express (here: cascading GDPR deletion + a Cognito
    // AdminDeleteUser). They run as NodejsFunctions behind a Lambda data
    // source; the thin JS resolver just forwards `ctx.identity` and returns
    // the Lambda result.
    const lambdaDir = path.join(__dirname, "../../../lambda/api");
    const logRetention = toRetentionDays(config.logRetentionDays);
    const makeLogGroup = (functionName: string): logs.LogGroup =>
      new logs.LogGroup(this, `${functionName}LogGroup`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logRetention,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    const commonLambdaProps = {
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      bundling: { minify: true, sourceMap: true, target: "node22" },
    };

    // deleteMyAccount — cascading deletion across every table + the Cognito
    // user. Reads only the caller identity; never trusts client args.
    const deleteAccountFn = new lambda.NodejsFunction(this, "DeleteAccountFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "delete-account.ts"),
      handler: "handler",
      functionName: `${prefix}-delete-account`,
      description: "Cascading account deletion (GDPR): purges all tables + Cognito user",
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      logGroup: makeLogGroup(`${prefix}-delete-account`),
      environment: {
        USER_PROFILES_TABLE: physicalName("userProfiles"),
        TEAM_MEMBERSHIPS_TABLE: physicalName("teamMemberships"),
        SYNCED_SESSIONS_TABLE: physicalName("syncedSessions"),
        SYNCED_MESSAGES_TABLE: physicalName("syncedMessages"),
        USER_AGGREGATES_TABLE: physicalName("userAggregates"),
        TEAM_STATS_TABLE: physicalName("teamStats"),
        ACHIEVEMENTS_TABLE: physicalName("achievements"),
        CHALLENGES_TABLE: physicalName("challenges"),
        INTER_TEAM_CHALLENGES_TABLE: physicalName("interTeamChallenges"),
        USER_POOL_ID: userPoolId,
      },
    });

    // The handler deletes across all tables (and their GSIs); grant readWrite
    // on each — this also grants the CMK actions because the imported tables
    // carry `encryptionKey`.
    for (const name of TABLE_NAMES) {
      tables[name].grantReadWriteData(deleteAccountFn);
    }
    // Cognito AdminDeleteUser on this env's user pool.
    deleteAccountFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminDeleteUser"],
        resources: [
          `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${userPoolId}`,
        ],
      }),
    );

    const deleteAccountDs = api.addLambdaDataSource(
      "DeleteAccountDS",
      deleteAccountFn,
    );
    deleteAccountDs.createResolver("deleteMyAccountResolver", {
      typeName: "Mutation",
      fieldName: "deleteMyAccount",
      runtime: jsRuntime,
      code: loadCode("deleteMyAccount.js"),
    });

    // ── Aggregate-stats DLQ (SQS) ────────────────────────────────────

    const dlq = new sqs.Queue(this, "AggregateStatsDLQ", {
      queueName: `${prefix}-aggregate-stats-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.graphqlApi = api;
    this.dlq = dlq;

    // ── Aggregate-stats worker (org-plane fan-in) ────────────────────
    //
    // Consumes the UserAggregates stream; rolls each per-user/day aggregate
    // into weekly per-member TeamStats rows (read-recompute-write). This is
    // the writer for every TeamStats reader (teamMemberStats / teamProjects /
    // teamDashboardAsReader / teamsComparison). Poison records land in the DLQ.
    const aggregateStatsFn = new lambda.NodejsFunction(this, "AggregateStatsFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "aggregate-stats.ts"),
      handler: "handler",
      functionName: `${prefix}-aggregate-stats`,
      description:
        "Rolls UserAggregates day-rows into weekly per-member TeamStats (DynamoDB-stream triggered)",
      timeout: cdk.Duration.seconds(90),
      memorySize: 512,
      logGroup: makeLogGroup(`${prefix}-aggregate-stats`),
      environment: {
        USER_AGGREGATES_TABLE: physicalName("userAggregates"),
        TEAM_MEMBERSHIPS_TABLE: physicalName("teamMemberships"),
        TEAM_STATS_TABLE: physicalName("teamStats"),
        APPSYNC_ENDPOINT: api.graphqlUrl,
      },
    });

    // Read the source aggregates + memberships; write the derived TeamStats.
    tables.userAggregates.grantReadData(aggregateStatsFn);
    tables.teamMemberships.grantReadData(aggregateStatsFn);
    tables.teamStats.grantWriteData(aggregateStatsFn);
    // Fire the refreshTeamStats mutation (IAM auth) to drive subscriptions.
    api.grantMutation(aggregateStatsFn, "refreshTeamStats");

    // Bind the DynamoDB-stream event source. The base imports above don't carry
    // the stream ARN, so import the table once more WITH it; grantStreamRead
    // (done by DynamoEventSource) then also covers the CMK when present.
    const userAggregatesStreamTable = dynamodb.Table.fromTableAttributes(
      this,
      "UserAggregatesStreamTable",
      {
        tableArn: tableArns.userAggregates,
        tableStreamArn: userAggregatesStreamArn,
        encryptionKey: dataEncryptionKey,
      },
    );
    aggregateStatsFn.addEventSource(
      new DynamoEventSource(userAggregatesStreamTable, {
        startingPosition: lambdaRuntime.StartingPosition.TRIM_HORIZON,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(30),
        retryAttempts: 3,
        bisectBatchOnError: true,
        onFailure: new SqsDlq(dlq),
      }),
    );

    // ── Team Logos construct ─────────────────────────────────────────

    const teamLogos = new TeamLogos(this, "TeamLogos", { config, prefix });

    // ── Logo upload / validation Lambdas (P4b) ───────────────────────
    // requestTeamLogoUpload: the JS resolver admin-checks then Invokes this
    // Lambda, which presigns an S3 PUT URL for logos/{teamId}/logo.png.
    const requestLogoUploadFn = new lambda.NodejsFunction(this, "RequestLogoUploadFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "request-logo-upload.ts"),
      handler: "handler",
      functionName: `${prefix}-request-logo-upload`,
      description: "Presigns an S3 PUT URL for a team logo upload (admin-gated in the resolver)",
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      logGroup: makeLogGroup(`${prefix}-request-logo-upload`),
      // @aws-sdk/s3-request-presigner is NOT provided by the Lambda runtime, so
      // it must be bundled; the large @aws-sdk/client-s3 stays external (runtime).
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node22",
        externalModules: ["@aws-sdk/client-s3"],
      },
      environment: {
        LOGOS_BUCKET: teamLogos.bucket.bucketName,
        CDN_URL: teamLogos.cdnUrl,
      },
    });
    teamLogos.bucket.grantPut(requestLogoUploadFn, "logos/*");
    const requestLogoUploadDs = api.addLambdaDataSource(
      "RequestLogoUploadDS",
      requestLogoUploadFn,
    );
    requestLogoUploadDs.createResolver("requestTeamLogoUploadResolver", {
      typeName: "Mutation",
      fieldName: "requestTeamLogoUpload",
      runtime: jsRuntime,
      code: loadCode("requestTeamLogoUpload.js"),
    });

    // validate-logo: S3 ObjectCreated (prefix logos/) → validate size/type →
    // set teams.logoUrl to the CDN URL, or delete the object if invalid.
    const validateLogoFn = new lambda.NodejsFunction(this, "ValidateLogoFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "validate-logo.ts"),
      handler: "handler",
      functionName: `${prefix}-validate-logo`,
      description: "Validates uploaded team logos and sets teams.logoUrl (S3-triggered)",
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      logGroup: makeLogGroup(`${prefix}-validate-logo`),
      environment: {
        TEAMS_TABLE: physicalName("teams"),
        CDN_URL: teamLogos.cdnUrl,
      },
    });
    teamLogos.bucket.grantReadWrite(validateLogoFn, "logos/*");
    tables.teams.grantWriteData(validateLogoFn);
    teamLogos.bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(validateLogoFn),
      { prefix: "logos/" },
    );

    // ── SSM Parameters ───────────────────────────────────────────────

    putParam(this, prefix, "api/graphql-endpoint", api.graphqlUrl);
    putParam(this, prefix, "api/graphql-api-id", api.apiId);
    putParam(this, prefix, "api/graphql-api-arn", api.arn);
    putParam(this, prefix, "api/dlq-url", dlq.queueUrl);
  }
}
