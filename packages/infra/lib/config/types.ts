// Re-export from core to make it convenient for infra consumers
export type { EnvironmentConfig, BrandingConfig } from "@claude-stats/core/types/config";

import type { EnvironmentConfig } from "@claude-stats/core/types/config";

/**
 * Props for the ClaudeStatsApp orchestrator construct.
 *
 * Only `account`, `region`, and `allowedEmailDomains` are required.
 * Everything else falls back to sensible defaults (see `defaultConfig`).
 */
export interface ClaudeStatsAppProps {
  /** Environment name — affects resource naming and prod-mode behaviors. Default: "dev". */
  envName?: "dev" | "prod";
  /** AWS account ID. */
  account: string;
  /** AWS region. */
  region: string;
  /**
   * Email address used to send magic-link emails (e.g. "noreply@example.com").
   *
   * This address must be verified in Amazon SES before emails can be sent.
   * On first deployment, CDK will create the identity automatically and SES
   * will send a verification email to this address — click the link to confirm.
   *
   * **Warning:** If your users sign in with email addresses on a domain managed
   * by Microsoft Exchange Online / Microsoft 365, avoid using a sender address
   * on the *same* domain (e.g. noreply@yourcompany.com when users are
   * user@yourcompany.com). Exchange may silently drop or quarantine these
   * emails because it suspects internal-domain spoofing / phishing. Use a
   * different domain for the sender address instead (e.g. noreply@yourcompany-notifications.com).
   */
  senderEmail: string;
  /** Email domains allowed to sign up. */
  allowedEmailDomains: string[];
  /** Custom domain name, e.g. "stats.mycompany.com". */
  domainName?: string | null;
  /** Parent Route53 zone name for DNS delegation. */
  parentZoneName?: string | null;
  /** Parent Route53 hosted zone ID. */
  parentZoneId?: string | null;
  /** Override any EnvironmentConfig field not covered by top-level props. */
  configOverrides?: Partial<Omit<EnvironmentConfig, "account" | "region" | "envName" | "allowedEmailDomains" | "domainName" | "parentZoneName" | "parentZoneId">>;
}
