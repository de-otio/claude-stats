import type {
  PreTokenGenerationTriggerEvent,
  PreTokenGenerationTriggerHandler,
} from "aws-lambda";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});

const TABLE_NAME = process.env.TABLE_NAME!;

/**
 * Cognito PreTokenGeneration trigger.
 *
 * Injects team membership group claims into the JWT access token.
 * Queries the TeamMemberships table (GSI: MembershipsByUser) to find
 * all teams the user belongs to, then adds them as Cognito group claims
 * in the format "team:{teamId}:{role}".
 *
 * Also grants the "superadmin" group claim to users whose sub OR email
 * appears in the SUPERADMIN_SUBS allowlist (comma-separated; empty by
 * default → nobody). This is the claim the admin-only allowedDomains /
 * updateAllowedDomains resolvers gate on. AUTH-CRITICAL: changing this
 * grants org-wide superadmin — it must be human-reviewed before deploy.
 */
export const handler: PreTokenGenerationTriggerHandler = async (
  event: PreTokenGenerationTriggerEvent,
) => {
  const userId = event.request.userAttributes.sub;
  if (!userId) {
    return event;
  }

  try {
    const memberships = await getUserTeamMemberships(userId);

    // Build group claims in the format "team:{teamId}:{role}"
    const groupClaims = memberships.map(
      (m) => `team:${m.teamId}:${m.role}`,
    );

    const groupsToOverride = [...groupClaims];

    // Grant "superadmin" when the caller's sub or email is allowlisted.
    // SUPERADMIN_SUBS is a comma-separated list; empty/unset → nobody.
    const superadminAllowlist = (process.env.SUPERADMIN_SUBS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (superadminAllowlist.length > 0) {
      const sub = userId.toLowerCase();
      const email = (event.request.userAttributes.email || "")
        .toLowerCase()
        .trim();
      const isSuperadmin =
        superadminAllowlist.includes(sub) ||
        (email !== "" && superadminAllowlist.includes(email));
      if (isSuperadmin) {
        groupsToOverride.push("superadmin");
      }
    }

    // Inject groups into the token
    event.response.claimsOverrideDetails = {
      groupOverrideDetails: {
        groupsToOverride,
      },
    };
  } catch (err) {
    // Log but don't fail authentication — user can still sign in
    // without team claims; they'll just lack team-scoped permissions
    console.error("PreTokenGeneration: failed to load memberships:", err);
  }

  return event;
};

interface TeamMembership {
  teamId: string;
  role: string;
}

/**
 * Query the TeamMemberships table using the MembershipsByUser GSI
 * to find all teams a user belongs to.
 */
async function getUserTeamMemberships(
  userId: string,
): Promise<TeamMembership[]> {
  const memberships: TeamMembership[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "MembershipsByUser",
        KeyConditionExpression: "userId = :uid",
        ExpressionAttributeValues: {
          ":uid": { S: userId },
        },
        ProjectionExpression: "teamId, #r",
        ExpressionAttributeNames: {
          "#r": "role", // "role" is a DynamoDB reserved word
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    if (result.Items) {
      for (const item of result.Items) {
        const teamId = item.teamId?.S;
        const role = item.role?.S;
        if (teamId && role) {
          memberships.push({ teamId, role });
        }
      }
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return memberships;
}
