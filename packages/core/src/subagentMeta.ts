/**
 * Parse a subagent's sibling `agent-<id>.meta.json` (written by Claude Code
 * next to `<sessionId>/subagents/agent-<id>.jsonl`).
 *
 * Pure: takes the bytes, never the path. Reading the file safely (no symlink,
 * no FIFO, size cap) is the caller's job in `packages/cli`.
 *
 * CONTRACT (schema V25): reads exactly three keys — `agentType`, `spawnDepth`,
 * `toolUseId` — with `Object.hasOwn`, validates each through `identifiers.ts`,
 * and binds nothing else. The file also carries `description`, `prompt`-like
 * fields, worktree paths and branch names; none of them may ever be read into
 * a variable. Malformed input of any kind yields all-null; never throws.
 */

export interface SubagentMeta {
  readonly agentType: string | null;
  readonly spawnDepth: number | null;
  readonly spawnToolUseId: string | null;
}

export const EMPTY_SUBAGENT_META: SubagentMeta = Object.freeze({
  agentType: null,
  spawnDepth: null,
  spawnToolUseId: null,
});

/** Body lands in phase B2. */
export function parseSubagentMeta(_bytes: Uint8Array): SubagentMeta {
  return EMPTY_SUBAGENT_META;
}
