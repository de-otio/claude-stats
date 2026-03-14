/**
 * Authentication and user profile types.
 * Derived from doc/analysis/team-app/02-authentication.md and 04-data-model.md.
 */

export interface LinkedAccount {
  accountId: string;
  label: string;
  shareWithTeams: boolean;
  sharePrompts: boolean;
}

export interface UserPreferences {
  timezone: string;
  weekStartDay: number;
  defaultShareLevel: "full" | "summary" | "minimal";
  streakWeekendGrace: boolean;
}

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  accounts: LinkedAccount[];
  preferences: UserPreferences;
  personalityType: string | null;
  userSalt: string;
  createdAt: number;
  lastSyncAt: number;
  updatedAt: number;
}

/** Public view of a user — no sensitive fields. */
export interface UserPublicProfile {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  personalityType: string | null;
}

export interface MagicLinkToken {
  email: string;
  tokenHash: string;
  expiresAt: number;
  used: boolean;
  createdAt: number;
  requestCount: number;
  requestWindowStart: number;
}
