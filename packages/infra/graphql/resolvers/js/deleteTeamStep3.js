/**
 * Mutation.deleteTeam — Pipeline Step 3 (TeamMemberships).
 * Batch-delete every membership row stashed by Step 2. BatchDeleteItem
 * addresses tables by PHYSICAL name (CDK substitutes __TABLE_MEMBERSHIPS__).
 */
import { util, runtime } from "@aws-appsync/utils";

export function request(ctx) {
  const keys = ctx.stash.memberKeys || [];
  if (keys.length === 0) {
    // Bound to a DynamoDB data source, so skip the call via earlyReturn.
    runtime.earlyReturn(true);
  }
  return {
    operation: "BatchDeleteItem",
    tables: {
      ["__TABLE_MEMBERSHIPS__"]: keys.map((k) => util.dynamodb.toMapValues(k)),
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return true;
}
