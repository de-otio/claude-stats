/**
 * AppSync GraphQL client + operation documents.
 *
 * The client authenticates with the Cognito user-pool session (defaultAuthMode
 * "userPool", configured in amplify.ts). All operations here are the real
 * server contract from packages/infra/graphql/schema.graphql.
 */
import { generateClient } from "aws-amplify/api";

// A single lazily-created client. generateClient() reads the Amplify config
// set by configureAmplify(); it must run after configuration. Typed as
// `unknown`/cast at the call site because Amplify v6's typed-document generics
// blow the TS instantiation-depth limit on raw string operations.
let _client: { graphql: (opts: unknown) => Promise<unknown> } | null = null;
function client() {
  if (!_client) {
    _client = generateClient() as unknown as typeof _client;
  }
  return _client!;
}

/** Run an authenticated GraphQL query and return `data`. */
export async function gql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = (await client().graphql({ query, variables })) as {
    data: T;
    errors?: Array<{ message: string }>;
  };
  if (res.errors?.length) {
    throw new Error(res.errors.map((e) => e.message).join("; "));
  }
  return res.data;
}

// ── Server-shape types (subset of schema.graphql actually queried) ──────────

export interface GqlMemberStats {
  sessions: number;
  prompts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  activeMinutes: number | null;
  modelsUsed: string | null; // AWSJSON: {modelName: count}
  topTools: string[] | null;
  velocityTokensPerMin: number | null;
  subagentRatio: number | null;
}

export interface GqlProjectStats {
  projectId: string;
  sessions: number;
  prompts: number;
  estimatedCost: number | null;
}

export interface GqlAchievement {
  achievementId: string;
  name: string;
  description: string;
  icon: string;
  unlockedAt: number; // AWSTimestamp (epoch seconds)
}

export interface GqlUserAggregate {
  period: string;
  projectId: string | null;
  sessionCount: number;
  promptCount: number;
  inputTokens: number;
  outputTokens: number;
  activeMinutes: number;
  models: string[];
  estimatedCost: number;
}

export interface GqlUser {
  userId: string;
  email: string;
  displayName: string;
  streak: {
    currentStreak: number;
    longestStreak: number;
  } | null;
}

// ── Operations ──────────────────────────────────────────────────────────────

export const ME = /* GraphQL */ `
  query Me {
    me { userId email displayName streak { currentStreak longestStreak } }
  }
`;

export const MY_STATS = /* GraphQL */ `
  query MyStats($period: String!) {
    myStats(period: $period) {
      sessions prompts inputTokens outputTokens estimatedCost
      activeMinutes modelsUsed topTools velocityTokensPerMin subagentRatio
    }
  }
`;

export const MY_PROJECTS = /* GraphQL */ `
  query MyProjects($period: String!) {
    myProjects(period: $period) { projectId sessions prompts estimatedCost }
  }
`;

export const MY_ACHIEVEMENTS = /* GraphQL */ `
  query MyAchievements {
    myAchievements { achievementId name description icon unlockedAt }
  }
`;

export const MY_AGGREGATES = /* GraphQL */ `
  query MyAggregates($from: String, $to: String, $limit: Int) {
    myAggregates(from: $from, to: $to, limit: $limit) {
      period projectId sessionCount promptCount
      inputTokens outputTokens activeMinutes models estimatedCost
    }
  }
`;
