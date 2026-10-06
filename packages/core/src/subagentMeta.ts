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
import { validIdentifier, validSpawnDepth, validToolUseId } from "./identifiers.js";

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

/**
 * Read one own property by a fixed, literal key. Never reaches the prototype
 * chain (`Object.hasOwn`), so a `__proto__` key in the JSON — which
 * `JSON.parse` creates as an ordinary own property — is just another key that
 * is never asked for.
 */
function ownValue(obj: object, key: "agentType" | "spawnDepth" | "toolUseId"): unknown {
  return Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

export function parseSubagentMeta(bytes: Uint8Array): SubagentMeta {
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const root: unknown = JSON.parse(text);
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
      return EMPTY_SUBAGENT_META;
    }
    const agentType = validIdentifier(ownValue(root, "agentType"));
    const spawnDepth = validSpawnDepth(ownValue(root, "spawnDepth"));
    const spawnToolUseId = validToolUseId(ownValue(root, "toolUseId"));
    if (agentType === null && spawnDepth === null && spawnToolUseId === null) {
      return EMPTY_SUBAGENT_META;
    }
    return Object.freeze({ agentType, spawnDepth, spawnToolUseId });
  } catch {
    // Getter-free JSON objects cannot throw on property reads, but TextDecoder
    // and JSON.parse can; anything unexpected is "not recorded".
    return EMPTY_SUBAGENT_META;
  }
}
