/**
 * Mutation.updateAllowedDomains — Write allowed email domains to SSM Parameter Store.
 * Superadmin only: checks for "superadmin" in the cognito:groups claim.
 *
 * Uses an HTTP datasource to call SSM PutParameter via the AWS REST API.
 * Stores domains as a comma-separated SSM String (Type=String, NOT StringList
 * — see the PutParameter body below for why) — NOT JSON — so the PreSignUp
 * Lambda (lambda/auth/pre-signup.ts) can parse it. Consistency with that
 * parser is mandatory: it splits on ",", trims, lowercases, drops empties.
 *
 * "__ALLOWED_DOMAINS_PARAM__" is substituted centrally to the env-scoped
 * SSM path /ClaudeStats-<env>/auth/allowed-domains (auth-stack
 * SSM_ALLOWED_DOMAINS_PATH).
 *
 * Domain validation is done with pure char-code checks (APPSYNC_JS bans
 * regex literals and for/while loops):
 *   - overall length <= 253
 *   - >= 2 dot-separated labels
 *   - each label 1-63 chars, only [A-Za-z0-9-], no leading/trailing "-"
 *   - final label (TLD) alphabetic only, length >= 2
 *
 * Args:
 *   domains: [String!]!
 */
import { util } from "@aws-appsync/utils";

// Character-set membership, NOT char codes: APPSYNC_JS 1.0.0 does NOT support
// String.prototype.charCodeAt (INVALID_FUNCTION_INVOCATION at synth-gate). We
// use the supported String.includes / startsWith / endsWith / split instead.
const ALPHA_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LABEL_CHARS = ALPHA_CHARS + "0123456789-";

/** true when every character of `str` is present in `allowed`. */
function allCharsIn(str, allowed) {
  return str.split("").filter((ch) => !allowed.includes(ch)).length === 0;
}

function isValidDomain(domain) {
  if (!domain || domain.length > 253) {
    return false;
  }
  const labels = domain.split(".");
  if (labels.length < 2) {
    return false;
  }
  const badLabels = labels.filter((label) => {
    if (label.length < 1 || label.length > 63) {
      return true;
    }
    // no leading or trailing hyphen
    if (label.startsWith("-") || label.endsWith("-")) {
      return true;
    }
    // reject if any character is not a valid label char (alnum or hyphen)
    return !allCharsIn(label, LABEL_CHARS);
  });
  if (badLabels.length > 0) {
    return false;
  }
  // final label (TLD) must be alphabetic and at least 2 chars
  const tld = labels[labels.length - 1];
  if (tld.length < 2) {
    return false;
  }
  return allCharsIn(tld, ALPHA_CHARS);
}

export function request(ctx) {
  // Superadmin authorization check
  const groups = ctx.identity.claims["cognito:groups"] || [];
  if (!groups.includes("superadmin")) {
    util.error("Not authorized. Superadmin access required.", "UnauthorizedError");
  }

  const { domains } = ctx.args;

  // Validate each domain (no for/while, no regex)
  domains.forEach((domain) => {
    if (!domain || domain.length > 253) {
      util.error(`Invalid domain: ${domain}`, "ValidationError");
    }
    if (!isValidDomain(domain)) {
      util.error(`Invalid domain format: ${domain}`, "ValidationError");
    }
  });

  return {
    method: "POST",
    resourcePath: "/",
    params: {
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AmazonSSM.PutParameter",
      },
      body: JSON.stringify({
        Name: "__ALLOWED_DOMAINS_PARAM__",
        // Comma-separated, matching pre-signup.ts parsing. Type MUST be
        // "String" (not "StringList"): the param is first created by the
        // Auth stack via CDK `StringParameter` (Type=String), and SSM
        // PutParameter rejects a type change on Overwrite — a "StringList"
        // write would fail at runtime the first time an admin edits domains.
        Value: domains.join(","),
        Type: "String",
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
