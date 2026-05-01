/**
 * Mutation.updateAllowedDomains — Write allowed email domains to SSM Parameter Store.
 * Superadmin only: checks for "superadmin" in ctx.identity.groups.
 *
 * Uses an HTTP datasource to call SSM PutParameter via AWS REST API.
 * Stores domains as a JSON array string in the SSM parameter.
 *
 * Args:
 *   domains: [String!]!
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  // Superadmin authorization check
  const groups = ctx.identity.groups || [];
  if (!groups.includes("superadmin")) {
    util.error("Not authorized. Superadmin access required.", "UnauthorizedError");
  }

  const { domains } = ctx.args;

  // Validate domains format
  for (const domain of domains) {
    if (!domain || domain.length > 253) {
      util.error(`Invalid domain: ${domain}`, "ValidationError");
    }
    // Basic domain format check
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(domain)) {
      util.error(`Invalid domain format: ${domain}`, "ValidationError");
    }
  }

  return {
    method: "POST",
    resourcePath: "/",
    params: {
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AmazonSSM.PutParameter",
      },
      body: JSON.stringify({
        Name: "/claude-stats/allowed-domains",
        Value: JSON.stringify(domains),
        Type: "StringList",
        Overwrite: true,
      }),
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  // Return the domains that were written
  return ctx.args.domains;
}
