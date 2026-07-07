import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VerifyAuthChallengeResponseTriggerEvent } from "aws-lambda";

// ---------------------------------------------------------------------------
// Mock AWS SDK modules
// ---------------------------------------------------------------------------

const mockDdbSend = vi.hoisted(() => vi.fn());
const mockKmsSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn(function () { return { send: mockDdbSend }; }),
  GetItemCommand: vi.fn(function (input: any) { return { _type: "GetItem", ...input }; }),
  UpdateItemCommand: vi.fn(function (input: any) { return { _type: "UpdateItem", ...input }; }),
}));

// Both MAC commands are mocked so an accidental switch back to
// GenerateMacCommand still constructs — and is then caught by the _type
// assertions below, which pin the API to the role's kms:VerifyMac-only grant
// (see auth-stack.ts). GenerateMac would AccessDeny on a real deployment.
vi.mock("@aws-sdk/client-kms", () => ({
  KMSClient: vi.fn(function () { return { send: mockKmsSend }; }),
  VerifyMacCommand: vi.fn(function (input: any) { return { _type: "VerifyMac", ...input }; }),
  GenerateMacCommand: vi.fn(function (input: any) { return { _type: "GenerateMac", ...input }; }),
}));

process.env.TABLE_NAME = "TestMagicLinkTokens";
process.env.KMS_KEY_ID = "test-key-id";

const { handler } = await import("../verify-challenge.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_SECONDS = Math.floor(Date.now() / 1000);
const STORED_MAC_B64 = Buffer.from("stored-mac-bytes").toString("base64");

function makeEvent(challengeAnswer = "token-123"): VerifyAuthChallengeResponseTriggerEvent {
  return {
    request: {
      userAttributes: { email: "User@Example.com" },
      challengeAnswer,
      privateChallengeParameters: {},
    },
    response: {},
  } as unknown as VerifyAuthChallengeResponseTriggerEvent;
}

function tokenItem(overrides: Record<string, unknown> = {}) {
  return {
    Item: {
      tokenHash: { S: STORED_MAC_B64 },
      expiresAt: { N: String(NOW_SECONDS + 300) },
      used: { BOOL: false },
      ...overrides,
    },
  };
}

function kmsInvalidMacError(): Error {
  const err = new Error("mac invalid");
  err.name = "KMSInvalidMacException";
  return err;
}

beforeEach(() => {
  mockDdbSend.mockReset();
  mockKmsSend.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VerifyAuthChallenge handler", () => {
  it("accepts a valid, unexpired, unused token and marks it used", async () => {
    mockDdbSend
      .mockResolvedValueOnce(tokenItem()) // GetItem
      .mockResolvedValueOnce({}); // UpdateItem (mark used)
    mockKmsSend.mockResolvedValueOnce({ MacValid: true });

    const result = await handler(makeEvent(), {} as never, () => {}) as VerifyAuthChallengeResponseTriggerEvent;

    expect(result.response.answerCorrect).toBe(true);
    // Replay prevention: the conditional mark-as-used write happened.
    expect(mockDdbSend.mock.calls[1]![0]._type).toBe("UpdateItem");
  });

  it("verifies via kms:VerifyMac — the ONLY action the role is granted", async () => {
    mockDdbSend.mockResolvedValueOnce(tokenItem()).mockResolvedValueOnce({});
    mockKmsSend.mockResolvedValueOnce({ MacValid: true });

    await handler(makeEvent("token-123"), {} as never, () => {});

    expect(mockKmsSend).toHaveBeenCalledTimes(1);
    const cmd = mockKmsSend.mock.calls[0]![0];
    // Grant-lockstep pin: GenerateMac here would AccessDeny in production.
    expect(cmd._type).toBe("VerifyMac");
    expect(cmd.MacAlgorithm).toBe("HMAC_SHA_256");
    expect(Buffer.from(cmd.Message).toString("utf-8")).toBe("token-123");
    // The stored base64 MAC is what gets verified against.
    expect(Buffer.from(cmd.Mac).toString("base64")).toBe(STORED_MAC_B64);
  });

  it("rejects a wrong token (KMS signals mismatch as KMSInvalidMacException)", async () => {
    mockDdbSend.mockResolvedValueOnce(tokenItem());
    mockKmsSend.mockRejectedValueOnce(kmsInvalidMacError());

    const result = await handler(makeEvent("wrong-token"), {} as never, () => {}) as VerifyAuthChallengeResponseTriggerEvent;

    expect(result.response.answerCorrect).toBe(false);
    // A failed verification must never mark the token used.
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  it("rejects an expired token without calling UpdateItem", async () => {
    mockDdbSend.mockResolvedValueOnce(
      tokenItem({ expiresAt: { N: String(NOW_SECONDS - 3600) } }),
    );
    mockKmsSend.mockResolvedValueOnce({ MacValid: true });

    const result = await handler(makeEvent(), {} as never, () => {}) as VerifyAuthChallengeResponseTriggerEvent;

    expect(result.response.answerCorrect).toBe(false);
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
  });

  it("rejects an already-used token (replay)", async () => {
    mockDdbSend.mockResolvedValueOnce(tokenItem({ used: { BOOL: true } }));
    mockKmsSend.mockResolvedValueOnce({ MacValid: true });

    const result = await handler(makeEvent(), {} as never, () => {}) as VerifyAuthChallengeResponseTriggerEvent;

    expect(result.response.answerCorrect).toBe(false);
  });

  it("rejects when no token record exists (never calls KMS)", async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });

    const result = await handler(makeEvent(), {} as never, () => {}) as VerifyAuthChallengeResponseTriggerEvent;

    expect(result.response.answerCorrect).toBe(false);
    expect(mockKmsSend).not.toHaveBeenCalled();
  });

  it("rejects when the concurrent-use conditional write fails (race replay)", async () => {
    const conditionalFailure = new Error("conditional check failed");
    conditionalFailure.name = "ConditionalCheckFailedException";
    mockDdbSend
      .mockResolvedValueOnce(tokenItem())
      .mockRejectedValueOnce(conditionalFailure);
    mockKmsSend.mockResolvedValueOnce({ MacValid: true });

    const result = await handler(makeEvent(), {} as never, () => {}) as VerifyAuthChallengeResponseTriggerEvent;

    expect(result.response.answerCorrect).toBe(false);
  });

  it("rejects when email or answer is missing, touching nothing", async () => {
    const event = makeEvent();
    (event.request as { userAttributes: Record<string, string> }).userAttributes = {};

    const result = await handler(event, {} as never, () => {}) as VerifyAuthChallengeResponseTriggerEvent;

    expect(result.response.answerCorrect).toBe(false);
    expect(mockDdbSend).not.toHaveBeenCalled();
    expect(mockKmsSend).not.toHaveBeenCalled();
  });
});
