/**
 * Query.allowedDomains — Read allowed email domains from SSM Parameter Store.
 * Superadmin only: checks for "superadmin" in the cognito:groups claim.
 *
 * Uses an HTTP datasource to call SSM GetParameter via the AWS REST API.
 * The SSM parameter is a comma-separated String (Type=String — the writer
 * updateAllowedDomains cannot use StringList because the param is created by
 * CDK as a String and SSM forbids type changes on Overwrite), matching how the
 * PreSignUp Lambda parses it — NOT a JSON array. Parsing MUST stay in sync
 * with lambda/auth/pre-signup.ts (split ",", trim, lowercase, drop empties).
 *
 * "__ALLOWED_DOMAINS_PARAM__" is substituted centrally to the env-scoped
 * SSM path /ClaudeStats-<env>/auth/allowed-domains (auth-stack
 * SSM_ALLOWED_DOMAINS_PATH), the same parameter the signup path reads.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  // Superadmin authorization check
  const groups = ctx.identity.claims["cognito:groups"] || [];
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
        Name: "__ALLOWED_DOMAINS_PARAM__",
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
    // StringList: comma-separated. Parse exactly like pre-signup.ts.
    return body.Parameter.Value
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0);
  }

  // Parameter not found or empty — return empty list
  return [];
}
