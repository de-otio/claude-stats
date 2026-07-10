/**
 * Mutation.refreshTeamStats — local (NONE data source) resolver.
 *
 * IAM-only (@aws_iam): the aggregate-stats worker calls this after upserting a
 * team-period's TeamStats rows. It does no storage work — resolving the
 * mutation is what makes AppSync fan out the `onTeamStatsUpdated(teamId)`
 * subscription. The returned TeamStatsUpdate is the subscription payload.
 */
import { util } from "@aws-appsync/utils";

export function request(ctx) {
  return {
    payload: {
      teamId: ctx.args.teamId,
      period: ctx.args.period,
      computedAt: util.time.nowEpochSeconds(),
    },
  };
}

export function response(ctx) {
  return ctx.result;
}
