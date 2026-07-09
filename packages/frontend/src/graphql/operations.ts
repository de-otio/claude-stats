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

export interface GqlLinkedAccount {
  accountId: string;
  label: string;
  shareWithTeams: boolean;
}

export interface GqlUser {
  userId: string;
  email: string;
  displayName: string;
  accounts?: GqlLinkedAccount[];
  preferences?: {
    defaultShareLevel: string;
    timezone: string;
    weekStartDay: number;
    streakWeekendGrace: boolean;
  };
  streak: {
    currentStreak: number;
    longestStreak: number;
  } | null;
}

export interface GqlTeamSettings {
  leaderboardEnabled: boolean;
  challengesEnabled: boolean;
  crossTeamVisibility: string; // PRIVATE | PUBLIC_STATS | PUBLIC_DASHBOARD
  minMembersForAggregates: number;
}

export interface GqlTeam {
  teamId: string;
  teamName: string;
  teamSlug: string;
  logoUrl: string | null;
  memberCount: number;
  inviteCode?: string | null;
  settings?: GqlTeamSettings;
  members?: GqlTeamMember[];
}

export interface GqlTeamMember {
  userId: string;
  displayName: string;
  role: string;
  streak: { currentStreak: number } | null;
  // TeamMember.stats reads the TeamStats snapshot (written by the P3
  // aggregate worker); null until that worker ships.
  stats: {
    prompts: number;
    estimatedCost: number | null;
    velocityTokensPerMin: number | null;
  } | null;
}

// ── Operations ──────────────────────────────────────────────────────────────

export const ME = /* GraphQL */ `
  query Me {
    me {
      userId email displayName
      accounts { accountId label shareWithTeams }
      preferences { defaultShareLevel timezone weekStartDay streakWeekendGrace }
      streak { currentStreak longestStreak }
    }
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

export const MY_TEAMS = /* GraphQL */ `
  query MyTeams {
    myTeams { teamId teamName teamSlug logoUrl memberCount }
  }
`;

export const TEAM_BY_SLUG = /* GraphQL */ `
  query TeamBySlug($slug: String!, $period: String!) {
    teamBySlug(slug: $slug) {
      teamId teamName teamSlug logoUrl memberCount
      members {
        userId displayName role
        streak { currentStreak }
        stats(period: $period) { prompts estimatedCost velocityTokensPerMin }
      }
    }
  }
`;

// Lean settings/admin view of a team: identity + editable settings + the
// caller's own role (members[] is admin-gated server-side, so a non-member
// gets an empty list and the page falls back to read-only).
export const TEAM_SETTINGS = /* GraphQL */ `
  query TeamSettings($slug: String!) {
    teamBySlug(slug: $slug) {
      teamId teamName teamSlug inviteCode
      settings {
        leaderboardEnabled challengesEnabled
        crossTeamVisibility minMembersForAggregates
      }
      members { userId role }
    }
  }
`;

// ── Mutations ─────────────────────────────────────────────────────────────

export const LEAVE_TEAM = /* GraphQL */ `
  mutation LeaveTeam($teamId: ID!) { leaveTeam(teamId: $teamId) }
`;

export const CREATE_TEAM = /* GraphQL */ `
  mutation CreateTeam($input: CreateTeamInput!) {
    createTeam(input: $input) { teamId teamSlug teamName }
  }
`;

export const JOIN_TEAM = /* GraphQL */ `
  mutation JoinTeam($inviteCode: String!) {
    joinTeam(inviteCode: $inviteCode) { teamId teamSlug teamName }
  }
`;

export const UPDATE_PROFILE = /* GraphQL */ `
  mutation UpdateProfile($input: UpdateProfileInput!) {
    updateProfile(input: $input) { userId displayName }
  }
`;

export const UPDATE_TEAM_SETTINGS = /* GraphQL */ `
  mutation UpdateTeamSettings($teamId: ID!, $input: TeamSettingsInput!) {
    updateTeamSettings(teamId: $teamId, input: $input) {
      teamId settings { leaderboardEnabled challengesEnabled crossTeamVisibility }
    }
  }
`;

export const REGENERATE_INVITE_CODE = /* GraphQL */ `
  mutation RegenerateInviteCode($teamId: ID!) {
    regenerateInviteCode(teamId: $teamId)
  }
`;

export const DELETE_TEAM = /* GraphQL */ `
  mutation DeleteTeam($teamId: ID!) { deleteTeam(teamId: $teamId) }
`;

export const LINK_ACCOUNT = /* GraphQL */ `
  mutation LinkAccount($input: LinkAccountInput!) {
    linkAccount(input: $input) { accountId label shareWithTeams }
  }
`;

export const UNLINK_ACCOUNT = /* GraphQL */ `
  mutation UnlinkAccount($accountId: ID!) { unlinkAccount(accountId: $accountId) }
`;

export const UPDATE_ACCOUNT_SHARING = /* GraphQL */ `
  mutation UpdateAccountSharing($accountId: ID!, $shareWithTeams: Boolean) {
    updateAccountSharing(accountId: $accountId, shareWithTeams: $shareWithTeams) {
      accountId label shareWithTeams
    }
  }
`;

// ── Admin (superadmin-only): allowed sign-up email domains ──────────────────
export const ALLOWED_DOMAINS = /* GraphQL */ `
  query AllowedDomains { allowedDomains }
`;

export const UPDATE_ALLOWED_DOMAINS = /* GraphQL */ `
  mutation UpdateAllowedDomains($domains: [String!]!) {
    updateAllowedDomains(domains: $domains)
  }
`;
