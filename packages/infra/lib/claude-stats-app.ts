import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config/types.js";
import type { ClaudeStatsAppProps } from "./config/types.js";
import { defaultConfig } from "./config/defaults.js";
import { DataStack } from "./stacks/data-stack.js";
import { AuthStack } from "./stacks/auth-stack.js";
import { ApiStack } from "./stacks/api-stack.js";
import { DnsStack } from "./stacks/dns-stack.js";
import { CertificateStack } from "./stacks/certificate-stack.js";
import { FrontendStack } from "./stacks/frontend-stack.js";
import { MonitoringStack } from "./stacks/monitoring-stack.js";

/**
 * All-in-one construct that deploys the full Claude Stats infrastructure.
 *
 * Usage:
 * ```ts
 * import * as cdk from "aws-cdk-lib";
 * import { ClaudeStatsApp } from "@de-otio/claude-stats-infra";
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
  public readonly certificate?: CertificateStack;
  public readonly frontend: FrontendStack;
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
      domainName: props.domainName ?? defaultConfig.domainName,
      parentZoneName: props.parentZoneName ?? defaultConfig.parentZoneName,
      parentZoneId: props.parentZoneId ?? defaultConfig.parentZoneId,
    };
    this.config = config;

    const env = { account: config.account, region: config.region };
    const domainMode = config.sesIdentityMode === "domain";

    // Stacks are children of scope (the App), not this construct,
    // because CDK stacks must be direct children of an App.
    //
    // Deploy order: Data → Dns → Auth → Api → Certificate → Frontend →
    // Monitoring. Dns is created BEFORE Auth so that in domain-SES mode the
    // domain identity can validate against the app hosted zone.

    this.data = new DataStack(scope, `${id}-Data`, { env, config });

    // DNS first. `crossRegionReferences` is enabled because the app hosted
    // zone is consumed by the us-east-1 CertificateStack (cross-region).
    if (config.domainName && config.parentZoneName) {
      this.dns = new DnsStack(scope, `${id}-Dns`, {
        env,
        config,
        crossRegionReferences: true,
      });
    }
    const hostedZone = this.dns?.hostedZone;

    // Auth. In domain mode it needs the zone to create the SES domain identity
    // and must deploy after DnsStack.
    this.auth = new AuthStack(scope, `${id}-Auth`, {
      env,
      config,
      hostedZone: domainMode ? hostedZone : undefined,
    });
    this.auth.addDependency(this.data);
    if (domainMode && this.dns) {
      this.auth.addDependency(this.dns);
    }

    this.api = new ApiStack(scope, `${id}-Api`, { env, config });
    this.api.addDependency(this.auth);
    this.api.addDependency(this.data);

    // Certificate in us-east-1 (CloudFront requirement), DNS-validated against
    // the app hosted zone via cross-region references. Both this stack and its
    // producers/consumers need `crossRegionReferences: true` and a concrete env.
    if (config.domainName && this.dns && hostedZone) {
      this.certificate = new CertificateStack(scope, `${id}-Certificate`, {
        env: { account: config.account, region: "us-east-1" },
        crossRegionReferences: true,
        config,
        hostedZone,
      });
      this.certificate.addDependency(this.dns);
    }

    // Frontend consumes the us-east-1 cert cross-region.
    this.frontend = new FrontendStack(scope, `${id}-Frontend`, {
      env,
      config,
      crossRegionReferences: true,
      certificate: this.certificate?.certificate,
    });
    this.frontend.addDependency(this.api);
    if (this.certificate) {
      this.frontend.addDependency(this.certificate);
    }

    this.monitoring = new MonitoringStack(scope, `${id}-Monitoring`, { env, config });
    this.monitoring.addDependency(this.api);
    this.monitoring.addDependency(this.data);
    this.monitoring.addDependency(this.auth);
  }
}
