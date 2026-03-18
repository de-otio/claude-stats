import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambdaRuntime from "aws-cdk-lib/aws-lambda";
import * as kms from "aws-cdk-lib/aws-kms";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";
import { putParam, getParam } from "../ssm-params.js";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface AuthStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
}

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly spaClient: cognito.UserPoolClient;
  public readonly mcpClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, { ...props, description: "Claude Stats auth — Cognito user pool, magic-link Lambdas, SES email identity" });

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
      enableKeyRotation: false,
      removalPolicy:
        config.envName === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      alias: `alias/${prefix}-magic-link-hmac`,
    });

    // ---------- SES Configuration Set ----------

    const configSet = new ses.ConfigurationSet(this, "SesConfigSet", {
      configurationSetName: `${prefix}-email`,
      reputationMetrics: true,
      sendingEnabled: true,
    });

    // ---------- SES Email Identity ----------

    const sesFromEmail = config.senderEmail;

    // Always create an email identity. If it doesn't exist in SES yet, SES will
    // automatically send a verification email to the address. The identity must
    // be verified (by clicking the link in that email) before magic-link emails
    // can be sent.
    const emailIdentity = new ses.EmailIdentity(this, "SesEmailIdentity", {
      identity: ses.Identity.email(sesFromEmail),
      configurationSet: configSet,
    });

    // ---------- SES Bounce & Complaint SNS Topic (prod) ----------

    let sesNotificationTopic: sns.Topic | undefined;

    if (config.envName === "prod") {
      sesNotificationTopic = new sns.Topic(this, "SesNotificationTopic", {
        topicName: `${prefix}-ses-notifications`,
        displayName: `${prefix} SES Bounce & Complaint Notifications`,
      });

      configSet.addEventDestination("BounceComplaint", {
        destination: ses.EventDestination.snsTopic(sesNotificationTopic),
        events: [
          ses.EmailSendingEvent.BOUNCE,
          ses.EmailSendingEvent.COMPLAINT,
          ses.EmailSendingEvent.REJECT,
        ],
        configurationSetEventDestinationName: `${prefix}-bounce-complaint`,
      });
    }

    // ---------- Shared Lambda configuration ----------

    const lambdaDir = path.join(__dirname, "../../../lambda/auth");

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
          SES_FROM_EMAIL: sesFromEmail,
          SES_CONFIGURATION_SET: configSet.configurationSetName,
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

    // Grant SES send — scoped to the verified identity and configuration set
    createChallengeFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: [
          emailIdentity.emailIdentityArn,
          `arn:aws:ses:${this.region}:${this.account}:configuration-set/${configSet.configurationSetName}`,
        ],
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

    // Cognito domain prefixes must be lowercase alphanumeric + hyphens
    const cognitoDomainPrefix = prefix.toLowerCase();
    const cognitoDomain = userPool.addDomain("CognitoDomain", {
      cognitoDomain: {
        domainPrefix: cognitoDomainPrefix,
      },
    });

    this.userPool = userPool;
    this.spaClient = spaClient;
    this.mcpClient = mcpClient;

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
    putParam(
      this,
      prefix,
      "auth/ses-configuration-set",
      configSet.configurationSetName,
    );

    if (sesNotificationTopic) {
      putParam(
        this,
        prefix,
        "auth/ses-notification-topic-arn",
        sesNotificationTopic.topicArn,
      );
    }

    // ---------- SES Outputs ----------

    new cdk.CfnOutput(this, "SesSenderEmail", {
      value: sesFromEmail,
      description: "Sender email address for magic-link emails",
    });

    new cdk.CfnOutput(this, "SesVerificationRequired", {
      value: [
        `Email identity created for ${sesFromEmail}.`,
        `If this is the first deployment, SES has sent a verification email to ${sesFromEmail} — click the link to confirm.`,
        `Emails will not be delivered until the identity is verified.`,
        `NOTE: If your users' email domain is managed by Microsoft Exchange Online / Microsoft 365,`,
        `ensure the sender address is on a DIFFERENT domain than the users' email domain.`,
        `Exchange may silently drop or quarantine emails that appear to come from within its own domain.`,
      ].join(" "),
      description: "SES email verification instructions",
    });
  }
}
