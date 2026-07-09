/**
 * Mutation.updateAllowedDomains — Write allowed email domains to SSM Parameter Store.
 * Superadmin only: checks for "superadmin" in the cognito:groups claim.
 *
 * Uses an HTTP datasource to call SSM PutParameter via the AWS REST API.
 * Stores domains as an SSM StringList (comma-separated) — NOT JSON — so the
 * PreSignUp Lambda (lambda/auth/pre-signup.ts) can parse it. Consistency with
 * that parser is mandatory: it splits on ",", trims, lowercases, drops empties.
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

/** 0-9 | A-Z | a-z */
function isAlnum(code) {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

/** A-Z | a-z */
function isAlpha(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** valid label character: alphanumeric or hyphen (45) */
function isLabelChar(code) {
  return isAlnum(code) || code === 45;
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
    // no leading or trailing hyphen (45)
    if (label.charCodeAt(0) === 45) {
      return true;
    }
    if (label.charCodeAt(label.length - 1) === 45) {
      return true;
    }
    // reject if any character is not a valid label char
    const badChars = label
      .split("")
      .filter((ch) => !isLabelChar(ch.charCodeAt(0)));
    return badChars.length > 0;
  });
  if (badLabels.length > 0) {
    return false;
  }
  // final label must be alphabetic and at least 2 chars
  const tld = labels[labels.length - 1];
  if (tld.length < 2) {
    return false;
  }
  const badTldChars = tld
    .split("")
    .filter((ch) => !isAlpha(ch.charCodeAt(0)));
  return badTldChars.length === 0;
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
        // StringList: comma-separated, matching pre-signup.ts parsing.
        Value: domains.join(","),
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
