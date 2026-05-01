/**
 * GraphQL API input/output types.
 * Derived from doc/analysis/team-app/05-api-design.md.
 */
import type { ShareLevel, CrossTeamVisibility } from "./team.js";

// ── Input types ────────────────────────────────────────────────────────────

export interface UpdateProfileInput {
  displayName?: string;
  avatarUrl?: string;
  timezone?: string;
  weekStartDay?: number;
  defaultShareLevel?: ShareLevel;
  streakWeekendGrace?: boolean;
  personalityType?: string;
}

export interface LinkAccountInput {
  accountId: string;
  label: string;
  shareWithTeams: boolean;
  sharePrompts?: boolean;
}

export interface CreateTeamInput {
  teamName: string;
  logoUrl?: string;
}

export interface TeamSettingsInput {
  leaderboardEnabled?: boolean;
  leaderboardCategories?: string[];
  challengesEnabled?: boolean;
  minMembersForAggregates?: number;
  crossTeamVisibility?: CrossTeamVisibility;
}

export interface MembershipInput {
  displayName?: string;
  shareLevel?: ShareLevel;
  sharedAccounts?: string[];
}

export interface ChallengeInput {
  name: string;
  metric: string;
  startTime: number;
  endTime: number;
}

export interface InterTeamChallengeInput {
  name: string;
  metric: string;
  startTime: number;
  endTime: number;
}

export interface SyncSessionInput {
  sessionId: string;
  projectId?: string;
  projectPathHash?: string;
  firstTimestamp: number;
  lastTimestamp: number;
  claudeVersion: string;
  entrypoint: string;
  promptCount: number;
  assistantMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  toolUseCounts?: Record<string, number>;
  models: string[];
  accountId: string;
  isSubagent: boolean;
  parentSessionId?: string;
  thinkingBlocks?: number;
  estimatedCost: number;
  _version: number;
}

export interface SyncMessageInput {
  sessionId: string;
  uuid: string;
  timestamp: number;
  model: string;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  tools?: string[];
  thinkingBlocks?: number;
  serviceTier?: string;
  promptText?: string;
  _version: number;
}

// ── Result types ───────────────────────────────────────────────────────────

export interface SyncResult {
  itemsWritten: number;
  itemsSkipped: number;
  conflicts: ConflictItem[];
}

export interface ConflictItem {
  key: string;
  serverVersion: number;
  serverItem: unknown;
}

export interface LogoUploadUrl {
  uploadUrl: string;
  logoUrl: string;
}
