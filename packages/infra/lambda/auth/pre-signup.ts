import type {
  PreSignUpTriggerEvent,
  PreSignUpTriggerHandler,
} from "aws-lambda";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});

const SSM_ALLOWED_DOMAINS_PATH = process.env.SSM_ALLOWED_DOMAINS_PATH!;

/** Cached allowed domains list */
let cachedDomains: string[] | null = null;
let cacheTimestamp = 0;

/** Cache refresh interval: 5 minutes */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Cognito PreSignUp trigger.
 *
 * Enforces domain restriction: only emails from allowed domains can sign up.
 * The allowed domains list is loaded from SSM Parameter Store and cached
 * for 5 minutes to reduce SSM API calls.
 *
 * Auto-confirms the user and verifies their email (magic link already
 * proves email ownership).
 */
export const handler: PreSignUpTriggerHandler = async (
  event: PreSignUpTriggerEvent,
) => {
  const domains = await getAllowedDomains();

  const email = event.request.userAttributes.email?.toLowerCase().trim();
  if (!email) {
    throw new Error("Email is required");
  }

  const domain = email.split("@")[1];
  if (!domain || !domains.includes(domain)) {
    throw new Error("Signup not allowed for this email domain");
  }

  // Auto-confirm user and email — the magic link flow already verified
  // that the user controls this email address
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;

  return event;
};

/**
 * Load allowed domains from SSM, with a 5-minute cache.
 */
async function getAllowedDomains(): Promise<string[]> {
  const now = Date.now();

  if (cachedDomains && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedDomains;
  }

  const result = await ssm.send(
    new GetParameterCommand({
      Name: SSM_ALLOWED_DOMAINS_PATH,
    }),
  );

  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error("Allowed domains parameter not found or empty");
  }

  cachedDomains = value
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  cacheTimestamp = now;

  return cachedDomains;
}
