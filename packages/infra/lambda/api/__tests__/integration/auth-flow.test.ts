import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock AWS SDK clients
// ---------------------------------------------------------------------------

const mockDdbSend = vi.hoisted(() => vi.fn());
const mockKmsSend = vi.hoisted(() => vi.fn());
const mockSesSend = vi.hoisted(() => vi.fn());
const mockSsmSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(function () { return { send: mockDdbSend }; }),
  PutItemCommand: vi.fn(function(input: any) { return { _type: "PutItem", ...input }; }),
  GetItemCommand: vi.fn(function(input: any) { return { _type: "GetItem", ...input }; }),
  UpdateItemCommand: vi.fn(function(input: any) { return { _type: "UpdateItem", ...input }; }),
  QueryCommand: vi.fn(function(input: any) { return { _type: "Query", ...input }; }),
}));

vi.mock("@aws-sdk/client-kms", () => ({
  KMSClient: vi.fn(function () { return { send: mockKmsSend }; }),
  GenerateMacCommand: vi.fn(function(input: any) { return { _type: "GenerateMac", ...input }; }),
}));

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: vi.fn(function () { return { send: mockSesSend }; }),
  SendEmailCommand: vi.fn(function(input: any) { return { _type: "SendEmail", ...input }; }),
}));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn(function () { return { send: mockSsmSend }; }),
  GetParameterCommand: vi.fn(function(input: any) { return { _type: "GetParameter", ...input }; }),
}));

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

process.env.TABLE_NAME = "MagicLinkTokens";
process.env.KMS_KEY_ID = "arn:aws:kms:us-east-1:123456789012:key/test-key-id";
process.env.SES_FROM_EMAIL = "noreply@test.claude-stats.dev";
process.env.APP_URL = "http://localhost:5173";
process.env.MAGIC_LINK_TTL_MINUTES = "15";
process.env.MAX_REQUESTS_PER_HOUR = "3";
process.env.SSM_ALLOWED_DOMAINS_PATH =
  "/ClaudeStats-dev/auth/allowed-domains";

// ---------------------------------------------------------------------------
// Import handlers after mocks are set up
// ---------------------------------------------------------------------------

import { handler as createChallengeHandler } from "../../../auth/create-challenge.js";
import { handler as verifyChallengeHandler } from "../../../auth/verify-challenge.js";
import { handler as preTokenGenerationHandler } from "../../../auth/pre-token-generation.js";
import { handler as preSignUpHandler } from "../../../auth/pre-signup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal CreateAuthChallenge event */
function makeCreateChallengeEvent(email: string): any {
  return {
    version: "1",
    triggerSource: "CreateAuthChallenge_Authentication",
    region: "us-east-1",
    userPoolId: "us-east-1_Test",
    userName: email,
    callerContext: { awsSdkVersion: "test", clientId: "test-client" },
    request: {
      userAttributes: { email },
      challengeName: "CUSTOM_CHALLENGE",
      session: [],
    },
    response: {},
  };
}

/** Build a minimal VerifyAuthChallenge event */
function makeVerifyChallengeEvent(
  email: string,
  challengeAnswer: string,
): any {
  return {
    version: "1",
    triggerSource: "VerifyAuthChallengeResponse_Authentication",
    region: "us-east-1",
    userPoolId: "us-east-1_Test",
    userName: email,
    callerContext: { awsSdkVersion: "test", clientId: "test-client" },
    request: {
      userAttributes: { email },
      privateChallengeParameters: { challenge: "MAGIC_LINK" },
      challengeAnswer,
      session: [],
    },
    response: {},
  };
}

/** Build a minimal PreTokenGeneration event */
function makePreTokenEvent(userId: string): any {
  return {
    version: "1",
    triggerSource: "TokenGeneration_Authentication",
    region: "us-east-1",
    userPoolId: "us-east-1_Test",
    userName: "test-user",
    callerContext: { awsSdkVersion: "test", clientId: "test-client" },
    request: {
      userAttributes: { sub: userId, email: "user@example.com" },
      groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] },
    },
    response: {},
  };
}

/** Build a minimal PreSignUp event */
function makePreSignUpEvent(email: string): any {
  return {
    version: "1",
    triggerSource: "PreSignUp_SignUp",
    region: "us-east-1",
    userPoolId: "us-east-1_Test",
    userName: email,
    callerContext: { awsSdkVersion: "test", clientId: "test-client" },
    request: {
      userAttributes: { email },
      validationData: null,
      clientMetadata: {},
    },
    response: {},
  };
}

// A stable HMAC value returned by the mock KMS
const MOCK_HMAC = Buffer.from("mock-hmac-bytes-for-testing-1234", "utf-8");
const MOCK_HMAC_B64 = MOCK_HMAC.toString("base64");

// ---------------------------------------------------------------------------
// Tests: magic link request stores token in MagicLinkTokens table
// ---------------------------------------------------------------------------

describe("auth-flow integration: create-challenge", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("stores token hash in MagicLinkTokens table after rate-limit check", async () => {
    const email = "alice@example.com";
    const event = makeCreateChallengeEvent(email);

    // Rate-limit GetItem: no existing record
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });

    // Rate-limit PutItem: success
    mockDdbSend.mockResolvedValueOnce({});

    // KMS GenerateMac: return mock HMAC
    mockKmsSend.mockResolvedValueOnce({ Mac: MOCK_HMAC });

    // Token PutItem: success
    mockDdbSend.mockResolvedValueOnce({});

    // SES SendEmail: success
    mockSesSend.mockResolvedValueOnce({ MessageId: "msg-123" });

    const result = await createChallengeHandler(event);

    // Verify DDB was called: GetItem (rate limit) + PutItem (rate limit) + PutItem (token)
    expect(mockDdbSend).toHaveBeenCalledTimes(3);

    // Check that KMS was invoked for HMAC
    expect(mockKmsSend).toHaveBeenCalledTimes(1);

    // Check that SES was used to send the email
    expect(mockSesSend).toHaveBeenCalledTimes(1);
    const sesCall = mockSesSend.mock.calls[0][0];
    expect(sesCall.Destination.ToAddresses).toContain(email);

    // Verify the response structure
    expect(result.response.publicChallengeParameters.email).toBe(email);
    expect(result.response.publicChallengeParameters.delivery).toBe("EMAIL");
    expect(result.response.privateChallengeParameters.challenge).toBe(
      "MAGIC_LINK",
    );
  });

  it("throws when rate limit is exceeded (>= MAX_REQUESTS_PER_HOUR)", async () => {
    const email = "spammer@example.com";
    const event = makeCreateChallengeEvent(email);

    const now = Math.floor(Date.now() / 1000);

    // Rate-limit GetItem: existing record within window, count = 3 (at limit)
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        requestCount: { N: "3" },
        requestWindowStart: { N: String(now - 100) }, // within the last hour
      },
    });

    await expect(createChallengeHandler(event)).rejects.toThrow(
      "Please try again later",
    );

    // No KMS or SES calls should happen after rate limit rejection
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(mockSesSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: verify-challenge checks HMAC + table TTL
// ---------------------------------------------------------------------------

describe("auth-flow integration: verify-challenge", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("marks token as used and returns answerCorrect=true for a valid token", async () => {
    const email = "alice@example.com";
    const token = "valid-magic-link-token";
    const event = makeVerifyChallengeEvent(email, token);

    const now = Math.floor(Date.now() / 1000);

    // KMS GenerateMac: return the mock HMAC
    mockKmsSend.mockResolvedValueOnce({ Mac: MOCK_HMAC });

    // DDB GetItem: return the stored token record
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        email: { S: email },
        sk: { S: "TOKEN" },
        tokenHash: { S: MOCK_HMAC_B64 },
        expiresAt: { N: String(now + 900) }, // expires in 15 minutes
        used: { BOOL: false },
      },
    });

    // DDB UpdateItem: mark token as used (success)
    mockDdbSend.mockResolvedValueOnce({});

    const result = await verifyChallengeHandler(event);

    expect(result.response.answerCorrect).toBe(true);
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
    expect(mockDdbSend).toHaveBeenCalledTimes(2); // GetItem + UpdateItem
  });

  it("returns answerCorrect=false when token has expired (TTL check)", async () => {
    const email = "alice@example.com";
    const event = makeVerifyChallengeEvent(email, "expired-token");

    const now = Math.floor(Date.now() / 1000);

    // KMS GenerateMac: return the mock HMAC
    mockKmsSend.mockResolvedValueOnce({ Mac: MOCK_HMAC });

    // DDB GetItem: token is expired
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        email: { S: email },
        sk: { S: "TOKEN" },
        tokenHash: { S: MOCK_HMAC_B64 },
        expiresAt: { N: String(now - 1000) }, // expired 1000 seconds ago
        used: { BOOL: false },
      },
    });

    const result = await verifyChallengeHandler(event);

    expect(result.response.answerCorrect).toBe(false);
    // No UpdateItem should be called for an expired token
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  it("returns answerCorrect=false when token has already been used", async () => {
    const email = "alice@example.com";
    const event = makeVerifyChallengeEvent(email, "used-token");

    const now = Math.floor(Date.now() / 1000);

    mockKmsSend.mockResolvedValueOnce({ Mac: MOCK_HMAC });

    // DDB GetItem: token already used
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        email: { S: email },
        sk: { S: "TOKEN" },
        tokenHash: { S: MOCK_HMAC_B64 },
        expiresAt: { N: String(now + 900) },
        used: { BOOL: true }, // already used
      },
    });

    const result = await verifyChallengeHandler(event);

    expect(result.response.answerCorrect).toBe(false);
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  it("returns answerCorrect=false when HMAC does not match", async () => {
    const email = "alice@example.com";
    const event = makeVerifyChallengeEvent(email, "tampered-token");

    const now = Math.floor(Date.now() / 1000);

    // KMS returns a different HMAC (simulating a different token input)
    const differentHmac = Buffer.from("different-hmac-bytes-for-testing", "utf-8");
    mockKmsSend.mockResolvedValueOnce({ Mac: differentHmac });

    // DDB GetItem: stored hash doesn't match
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        email: { S: email },
        sk: { S: "TOKEN" },
        tokenHash: { S: MOCK_HMAC_B64 }, // stored hash is different from computed
        expiresAt: { N: String(now + 900) },
        used: { BOOL: false },
      },
    });

    const result = await verifyChallengeHandler(event);

    expect(result.response.answerCorrect).toBe(false);
    // No UpdateItem on hash mismatch
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  it("handles replay attack (ConditionalCheckFailedException) gracefully", async () => {
    const email = "alice@example.com";
    const event = makeVerifyChallengeEvent(email, "replayed-token");

    const now = Math.floor(Date.now() / 1000);

    mockKmsSend.mockResolvedValueOnce({ Mac: MOCK_HMAC });

    mockDdbSend.mockResolvedValueOnce({
      Item: {
        email: { S: email },
        sk: { S: "TOKEN" },
        tokenHash: { S: MOCK_HMAC_B64 },
        expiresAt: { N: String(now + 900) },
        used: { BOOL: false },
      },
    });

    const conditionalError = new Error("ConditionalCheckFailed");
    conditionalError.name = "ConditionalCheckFailedException";
    mockDdbSend.mockRejectedValueOnce(conditionalError);

    const result = await verifyChallengeHandler(event);

    // Should not throw; should return answerCorrect=false for a replay
    expect(result.response.answerCorrect).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: pre-token-generation injects Cognito groups into JWT claims
// ---------------------------------------------------------------------------

describe("auth-flow integration: pre-token-generation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("injects team group claims into the token for a user with team memberships", async () => {
    const userId = "user-abc-123";
    const event = makePreTokenEvent(userId);

    // GSI query returns two team memberships
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        { teamId: { S: "team-1" }, role: { S: "ADMIN" } },
        { teamId: { S: "team-2" }, role: { S: "MEMBER" } },
      ],
    });

    const result = await preTokenGenerationHandler(event);

    const groups =
      result.response.claimsOverrideDetails?.groupOverrideDetails
        ?.groupsToOverride ?? [];

    expect(groups).toContain("team:team-1:ADMIN");
    expect(groups).toContain("team:team-2:MEMBER");
    expect(groups).toHaveLength(2);
  });

  it("returns event with no group overrides when user has no team memberships", async () => {
    const userId = "lone-wolf-user";
    const event = makePreTokenEvent(userId);

    // GSI query returns empty
    mockDdbSend.mockResolvedValueOnce({ Items: [] });

    const result = await preTokenGenerationHandler(event);

    const groups =
      result.response.claimsOverrideDetails?.groupOverrideDetails
        ?.groupsToOverride ?? [];

    expect(groups).toHaveLength(0);
  });

  it("does not fail authentication when DynamoDB query throws", async () => {
    const userId = "unlucky-user";
    const event = makePreTokenEvent(userId);

    mockDdbSend.mockRejectedValueOnce(new Error("DynamoDB connection error"));

    // Handler should not throw — auth continues without group claims
    const result = await preTokenGenerationHandler(event);

    // claimsOverrideDetails should not be set or should be empty
    expect(result.response.claimsOverrideDetails).toBeUndefined();
  });

  it("handles paginated team memberships correctly", async () => {
    const userId = "power-user";
    const event = makePreTokenEvent(userId);

    // First page of results with pagination key
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        { teamId: { S: "team-1" }, role: { S: "ADMIN" } },
        { teamId: { S: "team-2" }, role: { S: "MEMBER" } },
      ],
      LastEvaluatedKey: { userId: { S: userId }, teamId: { S: "team-2" } },
    });

    // Second page — no more results
    mockDdbSend.mockResolvedValueOnce({
      Items: [{ teamId: { S: "team-3" }, role: { S: "MEMBER" } }],
    });

    const result = await preTokenGenerationHandler(event);

    const groups =
      result.response.claimsOverrideDetails?.groupOverrideDetails
        ?.groupsToOverride ?? [];

    expect(groups).toHaveLength(3);
    expect(groups).toContain("team:team-3:MEMBER");
  });
});

// ---------------------------------------------------------------------------
// Tests: pre-signup rejects disallowed domains
// ---------------------------------------------------------------------------

// Monotonically increasing fake time so each test's cache appears expired
// relative to the previous test's cache (pre-signup module caches domains for 5 min).
let preSignUpFakeTime = Date.now();

describe("auth-flow integration: pre-signup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Advance by 10 minutes per test so the 5-minute SSM domain cache is always expired.
    preSignUpFakeTime += 10 * 60 * 1000;
    vi.useFakeTimers();
    vi.setSystemTime(preSignUpFakeTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows sign-up for a user with an allowed email domain", async () => {
    const email = "alice@example.com";
    const event = makePreSignUpEvent(email);

    // SSM returns the allowed domains list
    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: "example.com,corp.io" },
    });

    const result = await preSignUpHandler(event);

    expect(result.response.autoConfirmUser).toBe(true);
    expect(result.response.autoVerifyEmail).toBe(true);
  });

  it("rejects sign-up for a user with a disallowed email domain", async () => {
    const email = "hacker@evil.org";
    const event = makePreSignUpEvent(email);

    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: "example.com,corp.io" },
    });

    await expect(preSignUpHandler(event)).rejects.toThrow(
      "Signup not allowed for this email domain",
    );
  });

  it("rejects sign-up when SSM parameter is missing", async () => {
    const email = "user@example.com";
    const event = makePreSignUpEvent(email);

    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: "" }, // empty value
    });

    await expect(preSignUpHandler(event)).rejects.toThrow(
      "Allowed domains parameter not found or empty",
    );
  });

  it("rejects sign-up when email is missing", async () => {
    const event = makePreSignUpEvent("");
    event.request.userAttributes.email = "";

    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: "example.com" },
    });

    await expect(preSignUpHandler(event)).rejects.toThrow(
      "Email is required",
    );
  });

  it("allows subdomains that exactly match the allowed domain list", async () => {
    // "sub.example.com" is NOT in the list — only "example.com" is
    const email = "user@sub.example.com";
    const event = makePreSignUpEvent(email);

    mockSsmSend.mockResolvedValueOnce({
      Parameter: { Value: "example.com" },
    });

    await expect(preSignUpHandler(event)).rejects.toThrow(
      "Signup not allowed for this email domain",
    );
  });
});
