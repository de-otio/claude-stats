/**
 * TanStack Query hooks for data fetching.
 * Each hook defines the query key and fetcher function.
 * Currently uses mock data; swap fetchers for real API calls later.
 */
import { useQuery } from "@tanstack/react-query";

// ─── Types ───────────────────────────────────────────────────────────

export interface KPIData {
  sessions: number;
  prompts: number;
  cost: number;
  velocity: number;
  sessionsDelta: number;
  promptsDelta: number;
  costDelta: number;
  velocityDelta: number;
}

export interface UsageTrendPoint {
  date: string;
  "Opus 4": number;
  "Sonnet 4": number;
  "Haiku 4": number;
}

export interface ModelMixEntry {
  model: string;
  tokens: number;
}

export interface ProjectEntry {
  project: string;
  prompts: number;
}

export interface Achievement {
  id: string;
  name: string;
  icon: string;
  description: string;
  earnedAt: string;
}

export interface TeamMember {
  id: string;
  name: string;
  avatarUrl: string | null;
  streakDays: number;
  prompts: number;
  cost: number;
  velocity: number;
  cacheRate: number;
}

export interface TeamInfo {
  slug: string;
  name: string;
  logoUrl: string | null;
  memberCount: number;
  chemistryScore: number;
  activeChallenge: {
    name: string;
    description: string;
    endsAt: string;
    progress: number;
  } | null;
}

export interface LeaderboardEntry {
  category: string;
  title: string;
  memberId: string;
  memberName: string;
  value: string;
}

export interface Superlative {
  label: string;
  memberName: string;
  value: string;
}

export interface TeamSummary {
  slug: string;
  name: string;
  logoUrl: string | null;
  memberCount: number;
  totalPrompts: number;
  totalCost: number;
  syncRate: number;
}

export interface InterTeamChallenge {
  id: string;
  name: string;
  description: string;
  teams: string[];
  endsAt: string;
}

// ─── Mock Data ───────────────────────────────────────────────────────

const MOCK_KPI: KPIData = {
  sessions: 47,
  prompts: 312,
  cost: 18.42,
  velocity: 1423,
  sessionsDelta: 12,
  promptsDelta: 8,
  costDelta: -3,
  velocityDelta: 5,
};

const MOCK_USAGE_TREND: UsageTrendPoint[] = [
  { date: "Mar 7", "Opus 4": 12400, "Sonnet 4": 8200, "Haiku 4": 3100 },
  { date: "Mar 8", "Opus 4": 15100, "Sonnet 4": 9400, "Haiku 4": 2800 },
  { date: "Mar 9", "Opus 4": 8900, "Sonnet 4": 7100, "Haiku 4": 4200 },
  { date: "Mar 10", "Opus 4": 17200, "Sonnet 4": 11300, "Haiku 4": 3600 },
  { date: "Mar 11", "Opus 4": 14800, "Sonnet 4": 10200, "Haiku 4": 2900 },
  { date: "Mar 12", "Opus 4": 19300, "Sonnet 4": 12100, "Haiku 4": 4500 },
  { date: "Mar 13", "Opus 4": 16700, "Sonnet 4": 9800, "Haiku 4": 3800 },
];

const MOCK_MODEL_MIX: ModelMixEntry[] = [
  { model: "Opus 4", tokens: 104400 },
  { model: "Sonnet 4", tokens: 68100 },
  { model: "Haiku 4", tokens: 24900 },
];

const MOCK_PROJECTS: ProjectEntry[] = [
  { project: "claude-stats", prompts: 87 },
  { project: "api-gateway", prompts: 64 },
  { project: "web-client", prompts: 52 },
  { project: "auth-service", prompts: 41 },
  { project: "infra-cdk", prompts: 38 },
];

const MOCK_ACHIEVEMENTS: Achievement[] = [
  { id: "1", name: "Cache Master", icon: "trophy", description: "Achieved 90%+ cache hit rate", earnedAt: "2026-03-10" },
  { id: "2", name: "Speed Demon", icon: "zap", description: "Over 2,000 tokens/min average velocity", earnedAt: "2026-03-08" },
  { id: "3", name: "10K Club", icon: "bar-chart", description: "10,000+ prompts lifetime", earnedAt: "2026-03-05" },
  { id: "4", name: "Night Owl", icon: "moon", description: "Active coding session past midnight", earnedAt: "2026-03-03" },
  { id: "5", name: "Streak Champion", icon: "flame", description: "12-day active streak", earnedAt: "2026-03-01" },
];

const MOCK_TEAM_MEMBERS: TeamMember[] = [
  { id: "1", name: "Alice Chen", avatarUrl: null, streakDays: 12, prompts: 312, cost: 18.42, velocity: 2341, cacheRate: 87 },
  { id: "2", name: "Bob Park", avatarUrl: null, streakDays: 5, prompts: 428, cost: 24.10, velocity: 1890, cacheRate: 91 },
  { id: "3", name: "Charlie Kim", avatarUrl: null, streakDays: 3, prompts: 195, cost: 11.80, velocity: 1650, cacheRate: 78 },
  { id: "4", name: "Diana Rivera", avatarUrl: null, streakDays: 8, prompts: 267, cost: 15.30, velocity: 2100, cacheRate: 84 },
  { id: "5", name: "Eve Zhang", avatarUrl: null, streakDays: 1, prompts: 142, cost: 8.60, velocity: 1420, cacheRate: 82 },
];

const MOCK_TEAM_INFO: TeamInfo = {
  slug: "backend-crew",
  name: "Backend Crew",
  logoUrl: null,
  memberCount: 5,
  chemistryScore: 78,
  activeChallenge: {
    name: "Sprint Week",
    description: "Most prompts per member this week",
    endsAt: "2026-03-20",
    progress: 62,
  },
};

const MOCK_LEADERBOARD: LeaderboardEntry[] = [
  { category: "prompts", title: "The Machine", memberId: "2", memberName: "Bob Park", value: "428 prompts" },
  { category: "velocity", title: "Speed Demon", memberId: "1", memberName: "Alice Chen", value: "2,341 tok/min" },
  { category: "efficiency", title: "The Optimizer", memberId: "3", memberName: "Charlie Kim", value: "$0.06/prompt" },
];

const MOCK_SUPERLATIVES: Superlative[] = [
  { label: "Longest session", memberName: "Alice Chen", value: "4h12m, 287 prompts" },
  { label: "Best cache rate", memberName: "Bob Park", value: "91% hits" },
  { label: "Most tools used", memberName: "Charlie Kim", value: "8 in one session" },
];

const MOCK_TEAMS: TeamSummary[] = [
  { slug: "backend-crew", name: "Backend Crew", logoUrl: null, memberCount: 12, totalPrompts: 2847, totalCost: 142.3, syncRate: 94 },
  { slug: "platform-team", name: "Platform Team", logoUrl: null, memberCount: 8, totalPrompts: 1923, totalCost: 98.5, syncRate: 88 },
  { slug: "frontend-guild", name: "Frontend Guild", logoUrl: null, memberCount: 6, totalPrompts: 1102, totalCost: 67.2, syncRate: 91 },
  { slug: "data-science", name: "Data Science", logoUrl: null, memberCount: 4, totalPrompts: 876, totalCost: 52.1, syncRate: 86 },
];

const MOCK_CHALLENGES: InterTeamChallenge[] = [
  {
    id: "1",
    name: "March Madness",
    description: "Most prompts per member this month",
    teams: ["Backend Crew", "Platform Team", "Frontend Guild"],
    endsAt: "2026-03-31",
  },
  {
    id: "2",
    name: "Cache Kings",
    description: "Highest team-average cache hit rate",
    teams: ["Backend Crew", "Data Science"],
    endsAt: "2026-03-20",
  },
];

// ─── Hooks ───────────────────────────────────────────────────────────

export function useMyStats(_period: string = "week") {
  return useQuery({
    queryKey: ["my-stats", _period],
    queryFn: async (): Promise<KPIData> => {
      // TODO: Replace with real API call
      return MOCK_KPI;
    },
    staleTime: 60_000,
  });
}

export function useUsageTrend(_period: string = "week") {
  return useQuery({
    queryKey: ["usage-trend", _period],
    queryFn: async (): Promise<UsageTrendPoint[]> => {
      return MOCK_USAGE_TREND;
    },
    staleTime: 60_000,
  });
}

export function useModelMix(_period: string = "week") {
  return useQuery({
    queryKey: ["model-mix", _period],
    queryFn: async (): Promise<ModelMixEntry[]> => {
      return MOCK_MODEL_MIX;
    },
    staleTime: 60_000,
  });
}

export function useTopProjects(_period: string = "week") {
  return useQuery({
    queryKey: ["top-projects", _period],
    queryFn: async (): Promise<ProjectEntry[]> => {
      return MOCK_PROJECTS;
    },
    staleTime: 60_000,
  });
}

export function useAchievements() {
  return useQuery({
    queryKey: ["achievements"],
    queryFn: async (): Promise<Achievement[]> => {
      return MOCK_ACHIEVEMENTS;
    },
    staleTime: 300_000,
  });
}

export function useTeamInfo(slug: string) {
  return useQuery({
    queryKey: ["team-info", slug],
    queryFn: async (): Promise<TeamInfo> => {
      return { ...MOCK_TEAM_INFO, slug };
    },
    staleTime: 60_000,
    enabled: !!slug,
  });
}

export function useTeamMembers(slug: string) {
  return useQuery({
    queryKey: ["team-members", slug],
    queryFn: async (): Promise<TeamMember[]> => {
      return MOCK_TEAM_MEMBERS;
    },
    staleTime: 60_000,
    enabled: !!slug,
  });
}

export function useLeaderboard(slug: string) {
  return useQuery({
    queryKey: ["leaderboard", slug],
    queryFn: async (): Promise<LeaderboardEntry[]> => {
      return MOCK_LEADERBOARD;
    },
    staleTime: 60_000,
    enabled: !!slug,
  });
}

export function useSuperlatives(slug: string) {
  return useQuery({
    queryKey: ["superlatives", slug],
    queryFn: async (): Promise<Superlative[]> => {
      return MOCK_SUPERLATIVES;
    },
    staleTime: 60_000,
    enabled: !!slug,
  });
}

export function useTeams() {
  return useQuery({
    queryKey: ["teams"],
    queryFn: async (): Promise<TeamSummary[]> => {
      return MOCK_TEAMS;
    },
    staleTime: 60_000,
  });
}

export function useTeamRankings() {
  return useQuery({
    queryKey: ["team-rankings"],
    queryFn: async (): Promise<TeamSummary[]> => {
      return MOCK_TEAMS;
    },
    staleTime: 60_000,
  });
}

export function useInterTeamChallenges() {
  return useQuery({
    queryKey: ["inter-team-challenges"],
    queryFn: async (): Promise<InterTeamChallenge[]> => {
      return MOCK_CHALLENGES;
    },
    staleTime: 60_000,
  });
}

// ─── Additional Types ─────────────────────────────────────────────────

export interface SessionSummary {
  id: string;
  startTime: string;
  duration: number; // minutes
  project: string;
  prompts: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  model: string;
}

export interface SessionDetail extends SessionSummary {
  messages: Array<{ role: "user" | "assistant"; content: string; tokens: number; timestamp: string }>;
  subagents: number;
  toolUses: number;
}

export interface ProjectBreakdown {
  project: string;
  sessions: number;
  prompts: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  trend: number; // percent delta
}

export interface TeamProject {
  projectId: string;
  name: string;
  memberCount: number;
  totalPrompts: number;
  totalCost: number;
  trend: number;
}

export interface ChallengeEntry {
  rank: number;
  memberName: string;
  memberId: string;
  score: number;
  joinedAt: string;
}

export interface TeamChallenge {
  id: string;
  name: string;
  description: string;
  metric: string;
  startAt: string;
  endsAt: string;
  status: "active" | "completed" | "pending";
  entries: ChallengeEntry[];
}

export interface InterTeamChallengeDetail extends InterTeamChallenge {
  metric: string;
  status: "active" | "completed" | "pending";
  teamScores: Array<{ teamName: string; teamSlug: string; score: number; normalizedScore: number }>;
}

export interface AdminDomain {
  domain: string;
  addedAt: string;
}

export interface AdminTeam {
  slug: string;
  name: string;
  memberCount: number;
  createdAt: string;
  totalPrompts: number;
}

// ─── Additional Mock Data ─────────────────────────────────────────────

const MOCK_SESSIONS: SessionSummary[] = [
  { id: "s1", startTime: "2026-03-13T09:14:00Z", duration: 47, project: "claude-stats", prompts: 34, cost: 2.18, inputTokens: 12400, outputTokens: 8900, cacheTokens: 3200, model: "claude-sonnet-4-6" },
  { id: "s2", startTime: "2026-03-13T07:02:00Z", duration: 22, project: "api-gateway", prompts: 18, cost: 1.05, inputTokens: 6200, outputTokens: 4100, cacheTokens: 1800, model: "claude-haiku-4" },
  { id: "s3", startTime: "2026-03-12T20:45:00Z", duration: 93, project: "web-client", prompts: 61, cost: 4.72, inputTokens: 22100, outputTokens: 16400, cacheTokens: 7100, model: "claude-opus-4" },
  { id: "s4", startTime: "2026-03-12T14:30:00Z", duration: 35, project: "auth-service", prompts: 27, cost: 1.84, inputTokens: 9800, outputTokens: 6700, cacheTokens: 2900, model: "claude-sonnet-4-6" },
  { id: "s5", startTime: "2026-03-11T16:00:00Z", duration: 68, project: "infra-cdk", prompts: 45, cost: 3.21, inputTokens: 15600, outputTokens: 11200, cacheTokens: 4800, model: "claude-sonnet-4-6" },
  { id: "s6", startTime: "2026-03-11T10:22:00Z", duration: 15, project: "claude-stats", prompts: 11, cost: 0.67, inputTokens: 3800, outputTokens: 2600, cacheTokens: 900, model: "claude-haiku-4" },
  { id: "s7", startTime: "2026-03-10T09:00:00Z", duration: 120, project: "web-client", prompts: 87, cost: 6.91, inputTokens: 31200, outputTokens: 22800, cacheTokens: 9400, model: "claude-opus-4" },
];

const MOCK_SESSION_DETAIL: SessionDetail = {
  id: "s1",
  startTime: "2026-03-13T09:14:00Z",
  duration: 47,
  project: "claude-stats",
  prompts: 34,
  cost: 2.18,
  inputTokens: 12400,
  outputTokens: 8900,
  cacheTokens: 3200,
  model: "claude-sonnet-4-6",
  subagents: 2,
  toolUses: 18,
  messages: [
    { role: "user", content: "Can you help me implement the sessions page for the frontend?", tokens: 42, timestamp: "2026-03-13T09:14:05Z" },
    { role: "assistant", content: "Sure! Let me start by reading the existing code structure to understand the patterns used.", tokens: 310, timestamp: "2026-03-13T09:14:08Z" },
    { role: "user", content: "Also add the session detail page with token breakdown and message list.", tokens: 58, timestamp: "2026-03-13T09:22:00Z" },
    { role: "assistant", content: "I'll add the session detail page. It will show a header with project and model info, KPI cards for token counts, and a scrollable message list.", tokens: 480, timestamp: "2026-03-13T09:22:05Z" },
    { role: "user", content: "Looks good. Can you also wire up the routes in App.tsx?", tokens: 36, timestamp: "2026-03-13T09:35:00Z" },
    { role: "assistant", content: "Absolutely. I'll update App.tsx to replace the Placeholder routes with the real page components.", tokens: 290, timestamp: "2026-03-13T09:35:04Z" },
  ],
};

const MOCK_PROJECT_BREAKDOWN: ProjectBreakdown[] = [
  { project: "claude-stats", sessions: 14, prompts: 87, cost: 5.42, inputTokens: 31200, outputTokens: 22400, trend: 12 },
  { project: "api-gateway", sessions: 10, prompts: 64, cost: 3.91, inputTokens: 22800, outputTokens: 16100, trend: -5 },
  { project: "web-client", sessions: 8, prompts: 52, cost: 3.18, inputTokens: 18600, outputTokens: 13200, trend: 8 },
  { project: "auth-service", sessions: 7, prompts: 41, cost: 2.47, inputTokens: 14700, outputTokens: 10400, trend: 2 },
  { project: "infra-cdk", sessions: 6, prompts: 38, cost: 2.31, inputTokens: 13600, outputTokens: 9600, trend: -11 },
];

const MOCK_TEAM_PROJECTS: TeamProject[] = [
  { projectId: "p1", name: "claude-stats", memberCount: 4, totalPrompts: 342, totalCost: 21.4, trend: 14 },
  { projectId: "p2", name: "api-gateway", memberCount: 3, totalPrompts: 218, totalCost: 13.8, trend: -3 },
  { projectId: "p3", name: "web-client", memberCount: 5, totalPrompts: 189, totalCost: 11.2, trend: 7 },
  { projectId: "p4", name: "auth-service", memberCount: 2, totalPrompts: 134, totalCost: 8.6, trend: 0 },
  { projectId: "p5", name: "infra-cdk", memberCount: 3, totalPrompts: 97, totalCost: 5.9, trend: -8 },
];

const MOCK_TEAM_CHALLENGES: TeamChallenge[] = [
  {
    id: "c1",
    name: "Sprint Week",
    description: "Most prompts per member this week",
    metric: "prompts",
    startAt: "2026-03-10",
    endsAt: "2026-03-20",
    status: "active",
    entries: [
      { rank: 1, memberName: "Bob Park", memberId: "2", score: 428, joinedAt: "2026-03-10" },
      { rank: 2, memberName: "Alice Chen", memberId: "1", score: 312, joinedAt: "2026-03-10" },
      { rank: 3, memberName: "Diana Rivera", memberId: "4", score: 267, joinedAt: "2026-03-11" },
      { rank: 4, memberName: "Charlie Kim", memberId: "3", score: 195, joinedAt: "2026-03-10" },
      { rank: 5, memberName: "Eve Zhang", memberId: "5", score: 142, joinedAt: "2026-03-12" },
    ],
  },
  {
    id: "c2",
    name: "Cache Kings",
    description: "Highest cache hit rate for the month",
    metric: "cache_rate",
    startAt: "2026-03-01",
    endsAt: "2026-03-15",
    status: "completed",
    entries: [
      { rank: 1, memberName: "Bob Park", memberId: "2", score: 91, joinedAt: "2026-03-01" },
      { rank: 2, memberName: "Alice Chen", memberId: "1", score: 87, joinedAt: "2026-03-01" },
      { rank: 3, memberName: "Diana Rivera", memberId: "4", score: 84, joinedAt: "2026-03-01" },
    ],
  },
];

const MOCK_INTER_CHALLENGE_DETAIL: InterTeamChallengeDetail = {
  id: "1",
  name: "March Madness",
  description: "Most prompts per member this month",
  teams: ["Backend Crew", "Platform Team", "Frontend Guild"],
  endsAt: "2026-03-31",
  metric: "prompts_per_member",
  status: "active",
  teamScores: [
    { teamName: "Backend Crew", teamSlug: "backend-crew", score: 312, normalizedScore: 100 },
    { teamName: "Platform Team", teamSlug: "platform-team", score: 241, normalizedScore: 77 },
    { teamName: "Frontend Guild", teamSlug: "frontend-guild", score: 184, normalizedScore: 59 },
  ],
};

const MOCK_ADMIN_DOMAINS: AdminDomain[] = [
  { domain: "acme.com", addedAt: "2026-01-10" },
  { domain: "example.org", addedAt: "2026-02-03" },
  { domain: "devteam.io", addedAt: "2026-03-01" },
];

const MOCK_ADMIN_TEAMS: AdminTeam[] = [
  { slug: "backend-crew", name: "Backend Crew", memberCount: 12, createdAt: "2026-01-15", totalPrompts: 2847 },
  { slug: "platform-team", name: "Platform Team", memberCount: 8, createdAt: "2026-01-20", totalPrompts: 1923 },
  { slug: "frontend-guild", name: "Frontend Guild", memberCount: 6, createdAt: "2026-02-05", totalPrompts: 1102 },
  { slug: "data-science", name: "Data Science", memberCount: 4, createdAt: "2026-02-18", totalPrompts: 876 },
];

// ─── Additional Hooks ─────────────────────────────────────────────────

export function useSessions(_period: string = "week") {
  return useQuery({
    queryKey: ["sessions", _period],
    queryFn: async (): Promise<SessionSummary[]> => {
      return MOCK_SESSIONS;
    },
    staleTime: 60_000,
  });
}

export function useSessionDetail(id: string) {
  return useQuery({
    queryKey: ["session-detail", id],
    queryFn: async (): Promise<SessionDetail> => {
      return { ...MOCK_SESSION_DETAIL, id };
    },
    staleTime: 60_000,
    enabled: !!id,
  });
}

export function useProjectBreakdown(_period: string = "week") {
  return useQuery({
    queryKey: ["project-breakdown", _period],
    queryFn: async (): Promise<ProjectBreakdown[]> => {
      return MOCK_PROJECT_BREAKDOWN;
    },
    staleTime: 60_000,
  });
}

export function useTeamProjects(slug: string) {
  return useQuery({
    queryKey: ["team-projects", slug],
    queryFn: async (): Promise<TeamProject[]> => {
      return MOCK_TEAM_PROJECTS;
    },
    staleTime: 60_000,
    enabled: !!slug,
  });
}

export function useTeamChallenges(slug: string) {
  return useQuery({
    queryKey: ["team-challenges", slug],
    queryFn: async (): Promise<TeamChallenge[]> => {
      return MOCK_TEAM_CHALLENGES;
    },
    staleTime: 60_000,
    enabled: !!slug,
  });
}

export function useTeamChallenge(slug: string, challengeId: string) {
  return useQuery({
    queryKey: ["team-challenge", slug, challengeId],
    queryFn: async (): Promise<TeamChallenge> => {
      return MOCK_TEAM_CHALLENGES.find((c) => c.id === challengeId) ?? MOCK_TEAM_CHALLENGES[0];
    },
    staleTime: 60_000,
    enabled: !!slug && !!challengeId,
  });
}

export function useInterTeamChallenge(id: string) {
  return useQuery({
    queryKey: ["inter-team-challenge", id],
    queryFn: async (): Promise<InterTeamChallengeDetail> => {
      return { ...MOCK_INTER_CHALLENGE_DETAIL, id };
    },
    staleTime: 60_000,
    enabled: !!id,
  });
}

export function useAdminDomains() {
  return useQuery({
    queryKey: ["admin-domains"],
    queryFn: async (): Promise<AdminDomain[]> => {
      return MOCK_ADMIN_DOMAINS;
    },
    staleTime: 60_000,
  });
}

export function useAdminTeams() {
  return useQuery({
    queryKey: ["admin-teams"],
    queryFn: async (): Promise<AdminTeam[]> => {
      return MOCK_ADMIN_TEAMS;
    },
    staleTime: 60_000,
  });
}
