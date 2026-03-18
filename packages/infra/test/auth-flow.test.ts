/**
 * Integration tests for the magic link authentication flow.
 *
 * These tests verify the complete signup and signin flow with Cognito
 * custom auth challenges for passwordless magic-link authentication.
 */

import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
  AdminGetUserCommand,
  UserStatusType,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const cognito = new CognitoIdentityProviderClient({ region: "eu-central-1" });
const ddb = new DynamoDBClient({ region: "eu-central-1" });

const USER_POOL_ID = "eu-central-1_zJOu6ZTJd";
const SPA_CLIENT_ID = "7btinc8872uv32t80mgvsip8ar";
const TABLE_NAME = "ClaudeStats-dev-MagicLinkTokens";

describe("Magic Link Authentication Flow", () => {
  describe("SignUp", () => {
    test("should create a new user with allowed domain email", async () => {
      const email = `test-${Date.now()}@jambit.com`;

      const signUpResult = await cognito.send(
        new SignUpCommand({
          ClientId: SPA_CLIENT_ID,
          Username: email,
          Password: "TempPassword123!@#", // Ignored by PreSignUp Lambda
          UserAttributes: [
            { Name: "email", Value: email },
          ],
        })
      );

      expect(signUpResult.UserSub).toBeDefined();
      expect(signUpResult.UserSub).toMatch(/^[a-f0-9\-]+$/);

      // Verify user was auto-confirmed by PreSignUp Lambda
      const user = await cognito.send(
        new AdminGetUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: email,
        })
      );

      expect(user.UserStatus).toBe("CONFIRMED");

      const emailAttr = user.UserAttributes?.find((a) => a.Name === "email");
      expect(emailAttr?.Value).toBe(email);
    });

    test("should reject signup with disallowed domain", async () => {
      const email = `test-${Date.now()}@unauthorized-domain.com`;

      await expect(
        cognito.send(
          new SignUpCommand({
            ClientId: SPA_CLIENT_ID,
            Username: email,
            Password: "TempPassword123!@#",
            UserAttributes: [{ Name: "email", Value: email }],
          })
        )
      ).rejects.toThrow(/not allowed for/i);
    });
  });

  describe("Magic Link Challenge", () => {
    let testEmail: string;
    let userSub: string;

    beforeAll(async () => {
      // Create a user first via SignUp
      testEmail = `magic-link-test-${Date.now()}@jambit.com`;

      const signUpResult = await cognito.send(
        new SignUpCommand({
          ClientId: SPA_CLIENT_ID,
          Username: testEmail,
          Password: "TempPassword123!@#",
          UserAttributes: [{ Name: "email", Value: testEmail }],
        })
      );

      userSub = signUpResult.UserSub!;
    });

    test("should initiate auth challenge and send magic link", async () => {
      const result = await cognito.send(
        new InitiateAuthCommand({
          ClientId: SPA_CLIENT_ID,
          AuthFlow: "CUSTOM_AUTH",
          AuthParameters: {
            USERNAME: testEmail,
          },
        })
      );

      // Should return a challenge
      expect(result.ChallengeName).toBe("CUSTOM_CHALLENGE");
      expect(result.Session).toBeDefined();

      // Check public challenge parameters
      expect(result.ChallengeParameters).toEqual({
        email: testEmail,
        delivery: "EMAIL",
      });
    });

    test("should store magic link token in DynamoDB", async () => {
      // Initiate auth to trigger CreateAuthChallenge
      await cognito.send(
        new InitiateAuthCommand({
          ClientId: SPA_CLIENT_ID,
          AuthFlow: "CUSTOM_AUTH",
          AuthParameters: {
            USERNAME: testEmail,
          },
        })
      );

      // Wait a moment for Lambda to write to DynamoDB
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify token was stored
      const result = await ddb.send(
        new GetItemCommand({
          TableName: TABLE_NAME,
          Key: {
            email: { S: testEmail },
            sk: { S: "TOKEN" },
          },
        })
      );

      expect(result.Item).toBeDefined();
      expect(result.Item?.tokenHash).toBeDefined();
      expect(result.Item?.expiresAt).toBeDefined();
      expect(result.Item?.used?.BOOL).toBe(false);
    });

    test("should rate-limit magic link requests", async () => {
      const limitTestEmail = `rate-limit-test-${Date.now()}@jambit.com`;

      // Create user
      await cognito.send(
        new SignUpCommand({
          ClientId: SPA_CLIENT_ID,
          Username: limitTestEmail,
          Password: "TempPassword123!@#",
          UserAttributes: [{ Name: "email", Value: limitTestEmail }],
        })
      );

      // Make max requests (should be 3 per hour by default)
      for (let i = 0; i < 3; i++) {
        const result = await cognito.send(
          new InitiateAuthCommand({
            ClientId: SPA_CLIENT_ID,
            AuthFlow: "CUSTOM_AUTH",
            AuthParameters: {
              USERNAME: limitTestEmail,
            },
          })
        );

        expect(result.ChallengeName).toBe("CUSTOM_CHALLENGE");
      }

      // 4th request should fail
      await expect(
        cognito.send(
          new InitiateAuthCommand({
            ClientId: SPA_CLIENT_ID,
            AuthFlow: "CUSTOM_AUTH",
            AuthParameters: {
              USERNAME: limitTestEmail,
            },
          })
        )
      ).rejects.toThrow(/try again later/i);
    });
  });

  describe("Error Handling", () => {
    test("should handle non-existent users gracefully", async () => {
      // InitiateAuth with non-existent user should error
      // (Cognito checks if user exists before calling CreateAuthChallenge)
      const nonExistentEmail = `nonexistent-${Date.now()}@jambit.com`;

      try {
        await cognito.send(
          new InitiateAuthCommand({
            ClientId: SPA_CLIENT_ID,
            AuthFlow: "CUSTOM_AUTH",
            AuthParameters: {
              USERNAME: nonExistentEmail,
            },
          })
        );
        fail("Should have thrown an error for non-existent user");
      } catch (error: any) {
        // Cognito will error with UserNotFoundException or similar
        expect(error.name).toMatch(/NotFound|Invalid/i);
      }
    });
  });
});
