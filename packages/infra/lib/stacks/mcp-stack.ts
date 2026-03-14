import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config/types.js";
import { putParam, getParam } from "../ssm-params.js";

interface McpStackProps extends cdk.StackProps {
  config: EnvironmentConfig;
}

export class McpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: McpStackProps) {
    super(scope, id, props);
    const { config } = props;
    const prefix = `ClaudeStats-${config.envName}`;

    // ── Read SSM parameters from upstream stacks ──────────────────────

    const graphqlEndpoint = getParam(this, prefix, "api/graphql-endpoint");
    const graphqlApiArn = getParam(this, prefix, "api/graphql-api-arn");
    const cognitoDomain = getParam(this, prefix, "auth/cognito-domain");
    const mcpClientId = getParam(this, prefix, "auth/mcp-client-id");

    // ── ECR Repository ────────────────────────────────────────────────

    const repository = new ecr.Repository(this, "McpRepository", {
      repositoryName: `claude-stats-${config.envName}-mcp`,
      removalPolicy:
        config.envName === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          description: "Keep last 10 images",
          maxImageCount: 10,
        },
      ],
    });

    // ── IAM Role ──────────────────────────────────────────────────────

    const mcpRole = new iam.Role(this, "McpRole", {
      roleName: `${prefix}-McpRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole",
        ),
      ],
    });

    // AppSync query + mutation access only — no direct DynamoDB access
    mcpRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["appsync:GraphQL"],
        resources: [
          `${graphqlApiArn}/*`,
        ],
      }),
    );

    // ── Lambda Function (Docker image from ECR) ───────────────────────

    const mcpFn = new lambda.DockerImageFunction(this, "McpFunction", {
      functionName: `${prefix}-McpGateway`,
      description: "MCP server gateway — exposes Claude Stats GraphQL via MCP protocol",
      code: lambda.DockerImageCode.fromEcr(repository, {
        tag: "latest",
      }),
      role: mcpRole,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        GRAPHQL_ENDPOINT: graphqlEndpoint,
        COGNITO_DOMAIN: cognitoDomain,
        MCP_CLIENT_ID: mcpClientId,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
      },
    });

    // ── Lambda Function URL (AWS_IAM auth, CORS enabled) ──────────────

    const fnUrl = mcpFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      cors: {
        allowedOrigins: ["*"],
        allowedHeaders: ["*"],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowCredentials: false,
        maxAge: cdk.Duration.hours(1),
      },
    });

    // ── SSM Parameters ────────────────────────────────────────────────

    putParam(this, prefix, "mcp/gateway-url", fnUrl.url);

    // ── Outputs ───────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "McpGatewayUrl", {
      value: fnUrl.url,
      description: "MCP Gateway Lambda Function URL",
    });

    new cdk.CfnOutput(this, "McpEcrRepository", {
      value: repository.repositoryUri,
      description: "ECR repository URI for the MCP server Docker image",
    });
  }
}
