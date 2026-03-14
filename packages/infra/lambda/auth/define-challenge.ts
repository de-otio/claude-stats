import type {
  DefineAuthChallengeTriggerEvent,
  DefineAuthChallengeTriggerHandler,
} from "aws-lambda";

/**
 * Cognito DefineAuthChallenge trigger.
 *
 * Orchestrates the custom auth challenge sequence:
 * - Issues a CUSTOM_CHALLENGE on the first attempt
 * - Limits to 3 challenge attempts per session
 * - Fails auth if max attempts exceeded or answer is wrong on final attempt
 */
const MAX_ATTEMPTS = 3;

export const handler: DefineAuthChallengeTriggerHandler = async (
  event: DefineAuthChallengeTriggerEvent,
) => {
  const sessions = event.request.session;

  // If the user doesn't exist yet, Cognito handles signup separately
  // (the PreSignUp trigger will auto-confirm)

  // No previous session — issue first challenge
  if (sessions.length === 0) {
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = "CUSTOM_CHALLENGE";
    return event;
  }

  // Check the most recent session entry
  const lastSession = sessions[sessions.length - 1];

  // If the last challenge was answered correctly, issue tokens
  if (
    lastSession.challengeName === "CUSTOM_CHALLENGE" &&
    lastSession.challengeResult === true
  ) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
    return event;
  }

  // If we've exceeded max attempts, fail the authentication
  if (sessions.length >= MAX_ATTEMPTS) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  }

  // Otherwise, issue another challenge
  event.response.issueTokens = false;
  event.response.failAuthentication = false;
  event.response.challengeName = "CUSTOM_CHALLENGE";
  return event;
};
