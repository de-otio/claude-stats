/**
 * CLI authentication via Cognito.
 *
 * Uses the REFRESH_TOKEN_AUTH flow for ongoing access and a device
 * authorization-style flow (magic link) for initial setup.
 *
 * Token lifecycle:
 *   - Access token: in-memory only, 1-hour TTL, re-derived from refresh token
 *   - Refresh token: stored in SQLite sync_config (optionally encrypted via OS keychain)
 *   - ID token: used only during setup to extract the `sub` claim
 *
 * See doc/analysis/team-app/17-client-setup.md -- Token Storage.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { SyncConfig } from "./index.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number; // epoch-ms when accessToken expires
}

export interface DeviceAuthResponse {
  verificationUri: string;
  userCode: string;
  deviceCode: string;
  expiresIn: number; // seconds
}

// ── Token persistence ───────────────────────────────────────────────────────

const TOKEN_DIR = path.join(os.homedir(), ".claude-stats");
const TOKEN_FILE = path.join(TOKEN_DIR, "auth-tokens.json");

/**
 * Load saved tokens from disk.
 * Returns null if no tokens are stored or the file is corrupt.
 */
export function loadTokens(): AuthTokens | null {
  try {
    const data = fs.readFileSync(TOKEN_FILE, "utf-8");
    const parsed = JSON.parse(data) as Partial<AuthTokens>;
    if (
      typeof parsed.accessToken === "string" &&
      typeof parsed.refreshToken === "string" &&
      typeof parsed.idToken === "string" &&
      typeof parsed.expiresAt === "number"
    ) {
      return parsed as AuthTokens;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save tokens to disk with restricted permissions (0600).
 */
export function saveTokens(tokens: AuthTokens): void {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
}

/**
 * Remove saved tokens from disk.
 */
export function clearTokens(): void {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch {
    // File may not exist -- that's fine.
  }
}

// ── Cognito auth helpers ────────────────────────────────────────────────────

/**
 * Build the Cognito IDP endpoint URL for the given config.
 */
function cognitoEndpoint(config: SyncConfig): string {
  return `https://cognito-idp.${config.region}.amazonaws.com`;
}

/**
 * Initiate the device/magic-link auth flow.
 *
 * In practice this calls Cognito CUSTOM_AUTH which triggers the magic link
 * Lambda. The CLI either opens a local HTTP listener for the redirect or
 * asks the user to paste the link.
 *
 * Returns a DeviceAuthResponse with the verification URI and codes.
 */
export async function initiateAuth(
  config: SyncConfig,
  email: string,
): Promise<DeviceAuthResponse> {
  const response = await fetch(cognitoEndpoint(config), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "CUSTOM_AUTH",
      ClientId: config.clientId,
      AuthParameters: {
        USERNAME: email,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cognito InitiateAuth failed (${response.status}): ${body}`);
  }

  const result = (await response.json()) as {
    Session?: string;
    ChallengeParameters?: Record<string, string>;
    ChallengeName?: string;
  };

  // The session token acts as our "device code" for polling.
  // The ChallengeParameters may contain a verification URI.
  const session = result.Session ?? "";
  const verificationUri =
    result.ChallengeParameters?.["verificationUri"] ??
    result.ChallengeParameters?.["verification_uri"] ??
    "";
  const userCode =
    result.ChallengeParameters?.["userCode"] ??
    result.ChallengeParameters?.["user_code"] ??
    "";

  return {
    verificationUri,
    userCode,
    deviceCode: session,
    expiresIn: 300, // 5 minutes default
  };
}

/**
 * Respond to the auth challenge (e.g. after user clicks magic link).
 * The challengeAnswer is the verification code from the magic link callback.
 */
export async function respondToChallenge(
  config: SyncConfig,
  session: string,
  challengeAnswer: string,
): Promise<AuthTokens> {
  const response = await fetch(cognitoEndpoint(config), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.RespondToAuthChallenge",
    },
    body: JSON.stringify({
      ChallengeName: "CUSTOM_CHALLENGE",
      ClientId: config.clientId,
      Session: session,
      ChallengeResponses: {
        USERNAME: "user",
        ANSWER: challengeAnswer,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cognito RespondToAuthChallenge failed (${response.status}): ${body}`);
  }

  const result = (await response.json()) as {
    AuthenticationResult?: {
      AccessToken: string;
      RefreshToken: string;
      IdToken: string;
      ExpiresIn: number;
    };
  };

  if (!result.AuthenticationResult) {
    throw new Error("Authentication did not complete. The challenge may have expired.");
  }

  const auth = result.AuthenticationResult;
  return {
    accessToken: auth.AccessToken,
    refreshToken: auth.RefreshToken,
    idToken: auth.IdToken,
    expiresAt: Date.now() + auth.ExpiresIn * 1000,
  };
}

/**
 * Poll for auth completion by periodically checking with respondToChallenge.
 * Used when the user opens the magic link in their browser and the CLI waits.
 *
 * @param config - Sync configuration
 * @param deviceCode - The Cognito Session from initiateAuth
 * @param intervalMs - Polling interval (default 3 seconds)
 * @param timeoutMs - Max wait time (default 5 minutes)
 */
export async function pollForTokens(
  config: SyncConfig,
  deviceCode: string,
  intervalMs: number = 3000,
  timeoutMs: number = 300_000,
): Promise<AuthTokens> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      // Attempt to complete the challenge -- Cognito will return tokens
      // once the user has verified via the magic link.
      const tokens = await respondToChallenge(config, deviceCode, "POLL");
      return tokens;
    } catch {
      // Expected: challenge not yet answered. Wait and retry.
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Authentication timed out. Please try again.");
}

/**
 * Refresh expired tokens using the refresh token.
 * Returns new access/id tokens. The refresh token itself may also be rotated.
 */
export async function refreshTokens(
  config: SyncConfig,
  refreshToken: string,
): Promise<AuthTokens> {
  const response = await fetch(cognitoEndpoint(config), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: config.clientId,
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${body}`);
  }

  const result = (await response.json()) as {
    AuthenticationResult?: {
      AccessToken: string;
      RefreshToken?: string;
      IdToken: string;
      ExpiresIn: number;
    };
  };

  if (!result.AuthenticationResult) {
    throw new Error("Token refresh did not return new tokens. Please re-authenticate.");
  }

  const auth = result.AuthenticationResult;
  return {
    accessToken: auth.AccessToken,
    refreshToken: auth.RefreshToken ?? refreshToken, // May not be rotated
    idToken: auth.IdToken,
    expiresAt: Date.now() + auth.ExpiresIn * 1000,
  };
}

/**
 * Ensure we have a valid (non-expired) access token.
 * Refreshes automatically if the current token is expired or about to expire.
 *
 * @returns Valid AuthTokens, or null if no tokens are available.
 */
export async function ensureValidTokens(config: SyncConfig): Promise<AuthTokens | null> {
  const tokens = loadTokens();
  if (!tokens) return null;

  // Refresh if token expires within 5 minutes
  const REFRESH_MARGIN_MS = 5 * 60 * 1000;
  if (tokens.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return tokens;
  }

  try {
    const refreshed = await refreshTokens(config, tokens.refreshToken);
    saveTokens(refreshed);
    return refreshed;
  } catch {
    // Refresh token may be expired (30-day lifetime)
    return null;
  }
}
