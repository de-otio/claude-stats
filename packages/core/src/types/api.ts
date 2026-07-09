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

/**
 * A single client-computed aggregate row, matching the deployed AppSync
 * `input AggregateSyncInput` (schema.graphql) 1:1. The org plane accepts ONLY
 * this shape — per-`(period, projectId)` counts/sums/costs, never per-session
 * content. `userId` is NOT here: the server forces it from the caller's JWT.
 *
 * `_version` is the optimistic-concurrency token: send the last-known server
 * version (0 for a never-synced row); on a ConditionalCheckFailed the server
 * returns the current `serverVersion` in {@link ConflictItem} to retry with.
 */
export interface AggregateSyncInput {
  /** ISO date bucket label, e.g. "2026-07-08" (day granularity). */
  period: string;
  projectId?: string | null;
  sessionCount: number;
  subagentSessionCount?: number | null;
  promptCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number | null;
  cacheReadTokens?: number | null;
  activeMinutes: number;
  /** Flat {toolName: count} map (AWSJSON on the wire). */
  toolUseCounts?: Record<string, number> | null;
  models: string[];
  accountId: string;
  estimatedCost: number;
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
