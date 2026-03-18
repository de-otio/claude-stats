import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config/types.js";
import type { ClaudeStatsAppProps } from "./config/types.js";
import { defaultConfig } from "./config/defaults.js";
import { DataStack } from "./stacks/data-stack.js";
import { AuthStack } from "./stacks/auth-stack.js";
import { ApiStack } from "./stacks/api-stack.js";
import { DnsStack } from "./stacks/dns-stack.js";
import { FrontendStack } from "./stacks/frontend-stack.js";
import { MonitoringStack } from "./stacks/monitoring-stack.js";
import { McpStack } from "./stacks/mcp-stack.js";

/**
 * All-in-one construct that deploys the full Claude Stats infrastructure.
 *
 * Usage:
 * ```ts
 * import * as cdk from "aws-cdk-lib";
 * import { ClaudeStatsApp } from "@deotio/claude-stats-infra";
 *
 * const app = new cdk.App();
 * new ClaudeStatsApp(app, "MyCompanyStats", {
 *   account: "111111111111",
 *   region: "us-west-2",
 *   senderEmail: "noreply@mycompany-notifications.com",
 *   allowedEmailDomains: ["mycompany.com"],
 * });
 * ```
 */
export class ClaudeStatsApp extends Construct {
  public readonly config: EnvironmentConfig;
  public readonly data: DataStack;
  public readonly auth: AuthStack;
  public readonly api: ApiStack;
  public readonly dns?: DnsStack;
  public readonly frontend: FrontendStack;
  public readonly mcp?: McpStack;
  public readonly monitoring: MonitoringStack;

  constructor(scope: Construct, id: string, props: ClaudeStatsAppProps) {
    super(scope, id);

    const config: EnvironmentConfig = {
      ...defaultConfig,
      ...props.configOverrides,
      envName: props.envName ?? defaultConfig.envName,
      account: props.account,
      region: props.region,
      senderEmail: props.senderEmail,
      allowedEmailDomains: props.allowedEmailDomains,
      mcpEnabled: props.enableMcp ?? defaultConfig.mcpEnabled,
      domainName: props.domainName ?? defaultConfig.domainName,
      parentZoneName: props.parentZoneName ?? defaultConfig.parentZoneName,
      parentZoneId: props.parentZoneId ?? defaultConfig.parentZoneId,
    };
    this.config = config;

    const env = { account: config.account, region: config.region };

    // Stacks are children of scope (the App), not this construct,
    // because CDK stacks must be direct children of an App.

    this.data = new DataStack(scope, `${id}-Data`, { env, config });

    this.auth = new AuthStack(scope, `${id}-Auth`, { env, config });
    this.auth.addDependency(this.data);

    this.api = new ApiStack(scope, `${id}-Api`, { env, config });
    this.api.addDependency(this.auth);
    this.api.addDependency(this.data);

    if (config.domainName && config.parentZoneName) {
      this.dns = new DnsStack(scope, `${id}-Dns`, { env, config });
    }

    this.frontend = new FrontendStack(scope, `${id}-Frontend`, { env, config });
    this.frontend.addDependency(this.api);

    if (props.enableMcp) {
      this.mcp = new McpStack(scope, `${id}-Mcp`, { env, config });
      this.mcp.addDependency(this.api);
      this.mcp.addDependency(this.auth);
    }

    this.monitoring = new MonitoringStack(scope, `${id}-Monitoring`, { env, config });
    this.monitoring.addDependency(this.api);
    this.monitoring.addDependency(this.data);
    this.monitoring.addDependency(this.auth);
  }
}
