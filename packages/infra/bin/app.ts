#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import type { EnvironmentConfig } from "../lib/config/types.js";
import { devConfig } from "../lib/config/dev.js";
import { prodConfig } from "../lib/config/prod.js";
import { DataStack } from "../lib/stacks/data-stack.js";
import { AuthStack } from "../lib/stacks/auth-stack.js";
import { ApiStack } from "../lib/stacks/api-stack.js";
import { DnsStack } from "../lib/stacks/dns-stack.js";
import { FrontendStack } from "../lib/stacks/frontend-stack.js";
import { MonitoringStack } from "../lib/stacks/monitoring-stack.js";
import { McpStack } from "../lib/stacks/mcp-stack.js";

const app = new cdk.App();
const envName =
  (app.node.tryGetContext("env") as "dev" | "prod") ?? "dev";
const config: EnvironmentConfig =
  envName === "prod" ? prodConfig : devConfig;

const env = { account: config.account, region: config.region };
const prefix = `ClaudeStats-${config.envName}`;

const data = new DataStack(app, `${prefix}-Data`, { env, config });

const auth = new AuthStack(app, `${prefix}-Auth`, { env, config });
auth.addDependency(data); // Auth Lambda needs MagicLinkTokens table ARN from SSM

const api = new ApiStack(app, `${prefix}-Api`, { env, config });
api.addDependency(auth); // Needs user-pool-id for AppSync auth
api.addDependency(data); // Needs table ARNs for data sources + stream ARN

if (config.domainName && config.parentZoneName) {
  new DnsStack(app, `${prefix}-Dns`, { env, config });
}

const frontend = new FrontendStack(app, `${prefix}-Frontend`, { env, config });
frontend.addDependency(api); // Needs graphql-endpoint, user-pool-id, spa-client-id from SSM

const mcp = new McpStack(app, `${prefix}-Mcp`, { env, config });
mcp.addDependency(api);  // Needs api/graphql-endpoint + api/graphql-api-arn from SSM
mcp.addDependency(auth); // Needs auth/cognito-domain + auth/mcp-client-id from SSM

const monitoring = new MonitoringStack(app, `${prefix}-Monitoring`, { env, config });
monitoring.addDependency(api);   // Needs api/* SSM params
monitoring.addDependency(data);  // Needs data/table-names/* for CloudWatch dimensions
