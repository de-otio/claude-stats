import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaRuntime from "aws-cdk-lib/aws-lambda";
import * as kms from "aws-cdk-lib/aws-kms";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";
import { putParam, getParam } from "../ssm-params.js";
import * as path from "path";

interface AuthStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
}

export class AuthStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const { config } = props;
    const prefix = `ClaudeStats-${config.envName}`;

    // ---------- SSM lookups ----------

    const magicLinkTokensTableArn = getParam(
      this,
      prefix,
      "data/table-arns/magicLinkTokens",
    );
    const magicLinkTokensTableName = getParam(
      this,
      prefix,
      "data/table-names/magicLinkTokens",
    );
    const teamMembershipsTableName = getParam(
      this,
      prefix,
      "data/table-names/teamMemberships",
    );
    const teamMembershipsTableArn = getParam(
      this,
      prefix,
      "data/table-arns/teamMemberships",
    );

    // ---------- KMS key for magic link HMAC signing ----------

    const hmacKey = new kms.Key(this, "MagicLinkHmacKey", {
      description: `Magic link HMAC signing key (${config.envName})`,
      keySpec: kms.KeySpec.HMAC_256,
      keyUsage: kms.KeyUsage.GENERATE_VERIFY_MAC,
      enableKeyRotation: true,
      removalPolicy:
        config.envName === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      alias: `alias/claude-stats-${config.envName}-magic-link-hmac`,
    });

    // ---------- Shared Lambda configuration ----------

    const lambdaDir = path.join(__dirname, "../../lambda/auth");

    const commonLambdaProps: Partial<lambda.NodejsFunctionProps> = {
      runtime: lambdaRuntime.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
      },
    };

    // ---------- DefineAuthChallenge Lambda ----------

    const defineChallengeFn = new lambda.NodejsFunction(
      this,
      "DefineChallengeFn",
      {
        ...commonLambdaProps,
        entry: path.join(lambdaDir, "define-challenge.ts"),
        handler: "handler",
        functionName: `${prefix}-DefineAuthChallenge`,
        description: "Orchestrates Cognito custom auth challenge sequence",
      },
    );

    // ---------- CreateAuthChallenge Lambda ----------

    const appUrl = config.domainName
      ? `https://${config.domainName}`
      : "http://localhost:5173";

    const createChallengeFn = new lambda.NodejsFunction(
      this,
      "CreateChallengeFn",
      {
        ...commonLambdaProps,
        entry: path.join(lambdaDir, "create-challenge.ts"),
        handler: "handler",
        functionName: `${prefix}-CreateAuthChallenge`,
        description:
          "Generates magic link token, rate-limits, sends email via SES",
        environment: {
          TABLE_NAME: magicLinkTokensTableName,
          KMS_KEY_ID: hmacKey.keyId,
          SES_FROM_EMAIL: `noreply@${config.domainName ?? "claude-stats.dev"}`,
          APP_URL: appUrl,
          MAGIC_LINK_TTL_MINUTES: String(config.magicLinkTtlMinutes),
          MAX_REQUESTS_PER_HOUR: String(config.magicLinkMaxRequestsPerHour),
        },
      },
    );

    // Grant DynamoDB read/write on MagicLinkTokens
    const magicLinkTokensTable = dynamodb.Table.fromTableAttributes(
      this,
      "MagicLinkTokensTable",
      {
        tableArn: magicLinkTokensTableArn,
      },
    );
    magicLinkTokensTable.grantReadWriteData(createChallengeFn);

    // Grant KMS sign
    hmacKey.grant(createChallengeFn, "kms:GenerateMac");

    // Grant SES send
    createChallengeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail"],
        resources: ["*"],
      }),
    );

    // ---------- VerifyAuthChallenge Lambda ----------

    const verifyChallengeFn = new lambda.NodejsFunction(
      this,
      "VerifyChallengeFn",
      {
        ...commonLambdaProps,
        entry: path.join(lambdaDir, "verify-challenge.ts"),
        handler: "handler",
        functionName: `${prefix}-VerifyAuthChallenge`,
        description:
          "Validates magic link token via HMAC, checks expiry, marks used",
        environment: {
          TABLE_NAME: magicLinkTokensTableName,
          KMS_KEY_ID: hmacKey.keyId,
        },
      },
    );

    magicLinkTokensTable.grantReadWriteData(verifyChallengeFn);
    hmacKey.grant(verifyChallengeFn, "kms:VerifyMac");

    // ---------- PreSignUp Lambda ----------

    const preSignUpFn = new lambda.NodejsFunction(this, "PreSignUpFn", {
      ...commonLambdaProps,
      entry: path.join(lambdaDir, "pre-signup.ts"),
      handler: "handler",
      functionName: `${prefix}-PreSignUp`,
      description: "Enforces allowed email domain restriction on signup",
      environment: {
        SSM_ALLOWED_DOMAINS_PATH: `/${prefix}/auth/allowed-domains`,
      },
    });

    preSignUpFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/${prefix}/auth/allowed-domains`,
        ],
      }),
    );

    // Store allowed domains in SSM for the PreSignUp Lambda to read
    putParam(
      this,
      prefix,
      "auth/allowed-domains",
      config.allowedEmailDomains.join(","),
    );

    // ---------- PreTokenGeneration Lambda ----------

    const preTokenGenerationFn = new lambda.NodejsFunction(
      this,
      "PreTokenGenerationFn",
      {
        ...commonLambdaProps,
        entry: path.join(lambdaDir, "pre-token-generation.ts"),
        handler: "handler",
        functionName: `${prefix}-PreTokenGeneration`,
        description: "Injects team membership group claims into JWT",
        environment: {
          TABLE_NAME: teamMembershipsTableName,
        },
      },
    );

    const teamMembershipsTable = dynamodb.Table.fromTableAttributes(
      this,
      "TeamMembershipsTable",
      {
        tableArn: teamMembershipsTableArn,
      },
    );
    teamMembershipsTable.grantReadData(preTokenGenerationFn);

    // ---------- Cognito User Pool ----------

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `${prefix}-UserPool`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
      },
      customAttributes: {},
      passwordPolicy: {
        // Passwordless — these are set but irrelevant since only CUSTOM_AUTH is allowed
        minLength: 99,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy:
        config.envName === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      advancedSecurityMode: config.cognitoAdvancedSecurity
        ? cognito.AdvancedSecurityMode.ENFORCED
        : cognito.AdvancedSecurityMode.OFF,
      lambdaTriggers: {
        defineAuthChallenge: defineChallengeFn,
        createAuthChallenge: createChallengeFn,
        verifyAuthChallengeResponse: verifyChallengeFn,
        preSignUp: preSignUpFn,
        preTokenGeneration: preTokenGenerationFn,
      },
    });

    // ---------- SPA User Pool Client ----------

    const spaClient = userPool.addClient("SpaClient", {
      userPoolClientName: `${prefix}-SpaClient`,
      authFlows: {
        custom: true,
        userPassword: false,
        userSrp: false,
      },
      accessTokenValidity: cdk.Duration.minutes(
        config.cognitoAccessTokenTtlMinutes,
      ),
      idTokenValidity: cdk.Duration.minutes(
        config.cognitoAccessTokenTtlMinutes,
      ),
      refreshTokenValidity: cdk.Duration.days(
        config.cognitoRefreshTokenTtlDays,
      ),
      preventUserExistenceErrors: true,
      generateSecret: false, // SPA client — no secret
    });

    // ---------- MCP User Pool Client ----------

    const mcpCallbackUrls = config.domainName
      ? [`https://${config.domainName}/mcp/callback`]
      : ["http://localhost:5173/mcp/callback"];

    const mcpClient = userPool.addClient("McpClient", {
      userPoolClientName: `${prefix}-McpClient`,
      authFlows: {
        custom: true,
        userPassword: false,
        userSrp: false,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: mcpCallbackUrls,
      },
      accessTokenValidity: cdk.Duration.minutes(
        config.cognitoAccessTokenTtlMinutes,
      ),
      idTokenValidity: cdk.Duration.minutes(
        config.cognitoAccessTokenTtlMinutes,
      ),
      refreshTokenValidity: cdk.Duration.days(
        config.cognitoRefreshTokenTtlDays,
      ),
      preventUserExistenceErrors: true,
      generateSecret: true, // MCP client is confidential
    });

    // ---------- Cognito Domain ----------

    const cognitoDomainPrefix = `claude-stats-${config.envName}`;
    const cognitoDomain = userPool.addDomain("CognitoDomain", {
      cognitoDomain: {
        domainPrefix: cognitoDomainPrefix,
      },
    });

    // ---------- WAF WebACL ----------

    const wafAcl = new wafv2.CfnWebACL(this, "AuthWafAcl", {
      defaultAction: { allow: {} },
      scope: "REGIONAL",
      name: `${prefix}-AuthWaf`,
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${prefix}-AuthWaf`,
        sampledRequestsEnabled: true,
      },
      rules: [
        // Rate limit on SignUp
        {
          name: "RateLimitSignup",
          priority: 1,
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${prefix}-RateLimitSignup`,
            sampledRequestsEnabled: true,
          },
          statement: {
            rateBasedStatement: {
              limit: config.wafRateLimitSignup,
              aggregateKeyType: "IP",
              evaluationWindowSec: 300,
              scopeDownStatement: {
                byteMatchStatement: {
                  searchString: "SignUp",
                  fieldToMatch: { body: { oversizeHandling: "MATCH" } },
                  textTransformations: [
                    { priority: 0, type: "NONE" },
                  ],
                  positionalConstraint: "CONTAINS",
                },
              },
            },
          },
        },
        // Rate limit on InitiateAuth
        {
          name: "RateLimitAuth",
          priority: 2,
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${prefix}-RateLimitAuth`,
            sampledRequestsEnabled: true,
          },
          statement: {
            rateBasedStatement: {
              limit: config.wafRateLimitAuth,
              aggregateKeyType: "IP",
              evaluationWindowSec: 300,
              scopeDownStatement: {
                byteMatchStatement: {
                  searchString: "InitiateAuth",
                  fieldToMatch: { body: { oversizeHandling: "MATCH" } },
                  textTransformations: [
                    { priority: 0, type: "NONE" },
                  ],
                  positionalConstraint: "CONTAINS",
                },
              },
            },
          },
        },
        // AWS Managed IP reputation list
        {
          name: "AWSManagedIPReputation",
          priority: 3,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${prefix}-IPReputation`,
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesAmazonIpReputationList",
            },
          },
        },
        // AWS Managed known bots
        {
          name: "AWSManagedBotControl",
          priority: 4,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `${prefix}-BotControl`,
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesBotControlRuleSet",
            },
          },
        },
      ],
    });

    // Associate WAF with Cognito User Pool
    new wafv2.CfnWebACLAssociation(this, "WafCognitoAssociation", {
      resourceArn: userPool.userPoolArn,
      webAclArn: wafAcl.attrArn,
    });

    // ---------- SSM Parameters ----------

    putParam(this, prefix, "auth/user-pool-id", userPool.userPoolId);
    putParam(this, prefix, "auth/user-pool-arn", userPool.userPoolArn);
    putParam(this, prefix, "auth/spa-client-id", spaClient.userPoolClientId);
    putParam(this, prefix, "auth/mcp-client-id", mcpClient.userPoolClientId);
    putParam(
      this,
      prefix,
      "auth/cognito-domain",
      `${cognitoDomainPrefix}.auth.${this.region}.amazoncognito.com`,
    );
  }
}
