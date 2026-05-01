/**
 * Query.allowedDomains — Read allowed email domains from SSM Parameter Store.
 * Superadmin only: checks for "superadmin" in ctx.identity.groups.
 *
 * Uses an HTTP datasource to call SSM GetParameter via AWS REST API.
 * The SSM parameter stores a JSON array of domain strings.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  // Superadmin authorization check
  const groups = ctx.identity.groups || [];
  if (!groups.includes("superadmin")) {
    util.error("Not authorized. Superadmin access required.", "UnauthorizedError");
  }

  return {
    method: "POST",
    resourcePath: "/",
    params: {
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AmazonSSM.GetParameter",
      },
      body: JSON.stringify({
        Name: "/claude-stats/allowed-domains",
        WithDecryption: false,
      }),
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }

  const body = JSON.parse(ctx.result.body);

  if (body.Parameter && body.Parameter.Value) {
    try {
      return JSON.parse(body.Parameter.Value);
    } catch (e) {
      util.error("Failed to parse allowed domains", "InternalError");
    }
  }

  // Parameter not found or empty — return empty list
  return [];
}
