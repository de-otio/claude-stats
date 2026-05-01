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

    // Inject groups into the token
    event.response.claimsOverrideDetails = {
      groupOverrideDetails: {
        groupsToOverride: groupClaims,
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
