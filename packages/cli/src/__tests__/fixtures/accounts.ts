/**
 * Canonical account-attribution test fixtures.
 *
 * HARD GATE (plan §7 sec#5 / L3): every account UUID uses the
 * `00000000-0000-0000-0000-` prefix and every email uses `@example.com`. No
 * real values from `~/.claude*` may ever appear here. All attribution tests
 * import their account/observation/session shapes from this module so the
 * confidentiality grep gate stays green.
 */
import type { AccountObservation, AccountRecord, OwnerRule } from "@claude-stats/core/types";
import type { SessionRow } from "../../store/index.js";

// ─── Account UUIDs (placeholder) ──────────────────────────────────────────────

export const ACCOUNT_A_UUID = "00000000-0000-0000-0000-00000000000a";
export const ACCOUNT_B_UUID = "00000000-0000-0000-0000-00000000000b";
export const ORG_A_UUID = "00000000-0000-0000-0000-0000000000a0";
export const ORG_B_UUID = "00000000-0000-0000-0000-0000000000b0";

// sha256("a@example.com") / sha256("b@example.com") would be computed by the
// email-hash helper at runtime; fixtures just carry stable placeholder hashes.
export const EMAIL_HASH_A = "0000000000000000000000000000000000000000000000000000000000000aaa";
export const EMAIL_HASH_B = "0000000000000000000000000000000000000000000000000000000000000bbb";

// ─── AccountRecord fixtures ───────────────────────────────────────────────────

export const sampleAccountA: AccountRecord = {
  accountUuid: ACCOUNT_A_UUID,
  organizationUuid: ORG_A_UUID,
  emailHash: EMAIL_HASH_A,
  emailLabel: "a@example.com",
  organizationType: "team",
  rateLimitTier: "default_team",
  userRateLimitTier: "default_team",
  seatTier: "team_premium",
  billingType: "team",
  subscriptionType: "team_premium",
  firstObservedAt: 1_700_000_000_000,
  lastObservedAt: 1_700_100_000_000,
};

export const sampleAccountB: AccountRecord = {
  accountUuid: ACCOUNT_B_UUID,
  organizationUuid: ORG_B_UUID,
  emailHash: EMAIL_HASH_B,
  emailLabel: "b@example.com",
  organizationType: "individual",
  rateLimitTier: "default_pro",
  userRateLimitTier: "default_pro",
  seatTier: "standard",
  billingType: "stripe",
  subscriptionType: "team_standard",
  firstObservedAt: 1_700_050_000_000,
  lastObservedAt: 1_700_080_000_000,
};

export const sampleAccounts: AccountRecord[] = [sampleAccountA, sampleAccountB];

// ─── AccountObservation fixtures ──────────────────────────────────────────────

export const sampleObservationA: AccountObservation = {
  accountUuid: ACCOUNT_A_UUID,
  observedAt: 1_700_000_000_000,
  source: "observation",
  surface: "cli",
  rateLimitTier: "default_team",
  billingType: "team",
};

export const sampleObservationB: AccountObservation = {
  accountUuid: ACCOUNT_B_UUID,
  observedAt: 1_700_050_000_000,
  source: "telemetry",
  surface: "claude",
  rateLimitTier: "default_pro",
  billingType: "stripe",
};

export const sampleObservations: AccountObservation[] = [
  sampleObservationA,
  sampleObservationB,
];

// ─── Session-shaped fixtures ──────────────────────────────────────────────────

/** A minimal SessionRow with placeholder values; spread + override per test. */
export function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "00000000-0000-0000-0000-0000000000s1",
    project_path: "/home/user/project-x",
    source_file: "/home/user/.claude/projects/project-x/00000000-0000-0000-0000-0000000000s1.jsonl",
    first_timestamp: 1_700_000_000_000,
    last_timestamp: 1_700_000_100_000,
    claude_version: "1.0.0",
    entrypoint: "cli",
    git_branch: "main",
    is_interactive: 1,
    prompt_count: 3,
    assistant_message_count: 3,
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    web_search_requests: 0,
    web_fetch_requests: 0,
    tool_use_counts: "[]",
    models: "[]",
    repo_url: null,
    account_uuid: null,
    organization_uuid: null,
    subscription_type: null,
    thinking_blocks: 0,
    parent_session_id: null,
    is_subagent: 0,
    source_deleted: 0,
    throttle_events: 0,
    active_duration_ms: null,
    median_response_time_ms: null,
    ...overrides,
  };
}

export const sampleCliSession: SessionRow = makeSessionRow({
  session_id: "00000000-0000-0000-0000-0000000000c1",
  entrypoint: "cli",
});

export const sampleVscodeSession: SessionRow = makeSessionRow({
  session_id: "00000000-0000-0000-0000-0000000000v1",
  entrypoint: "claude-vscode",
});

// ─── Cost-ownership rule fixtures (placeholder) ───────────────────────────────
// Globs use the repo's placeholder path convention (/home/user/…) and a
// placeholder git host (github.com/example-org). `~` is expanded at rule-creation
// in the CLI, so stored/fixture globs are always concrete.

export const PERSONAL_PATH_GLOB = "/home/user/personal/**";
export const WORK_PATH_GLOB = "/home/user/work/**";
export const PERSONAL_REMOTE_GLOB = "github.com/example-org/*";
export const WORK_REMOTE_GLOB = "gitlab.example.com/*";

/** A minimal OwnerRule; spread + override per test. Deterministic (fixed id/time). */
export function makeOwnerRule(overrides: Partial<OwnerRule> = {}): OwnerRule {
  return {
    id: 1,
    pathGlob: PERSONAL_PATH_GLOB,
    remoteGlob: null,
    target: { kind: "account", accountUuid: ACCOUNT_A_UUID },
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}
