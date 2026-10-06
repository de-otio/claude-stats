/**
 * Shape validators for the user-authored identifiers captured since schema V25:
 * subagent types, skill names, spawn depth and the spawning `tool_use` id.
 *
 * One validator per field, used at EVERY entry point — the transcript parser,
 * the subagent `.meta.json` reader and the sync-merge apply. Validation happens
 * where a value enters because `messages` and `sessions` feed the personal-plane
 * export through `SELECT *`, so a column enrols itself in that export the moment
 * it exists.
 *
 * A value that fails is NULL ("not recorded"). It is never truncated into a
 * different identifier and never stored raw.
 *
 * Also the closed list of Claude Code's own tool names, which decides what a
 * tool name may look like once it leaves the machine (org plane).
 *
 * Pure: no I/O.
 */

/**
 * Agent-type and skill names: `my-reviewer`, `plugin:skill`, `@scope/agent`,
 * `team.reviewer`. Linear (one character class, one bounded quantifier), so no
 * input can make it backtrack.
 *
 * Names that pass include `__proto__`, `constructor` and `toString`. That is
 * acceptable ONLY because every by-name total built from these values is a
 * `Map` or an `Object.create(null)` object. A plain `{}` keyed by name loses or
 * corrupts spend.
 */
export const IDENTIFIER_RE = /^[A-Za-z0-9._:@/-]{1,128}$/;

/**
 * The id of the `tool_use` block that spawned a subagent. Bedrock and Vertex
 * issue `toolu_bdrk_…` / `toolu_vrtx_…`, hence the underscore in the tail.
 */
export const TOOL_USE_ID_RE = /^toolu_[A-Za-z0-9_]{1,80}$/;

/** Deepest spawn nesting accepted; observed values are 1–3. */
export const MAX_SPAWN_DEPTH = 16;

/**
 * An agent-type or skill name, or null.
 *
 * Beyond the character class, rejects:
 *  - anything that reads as a path (`..`, a leading `/`, `//`), so a name can
 *    never become one later through a join;
 *  - a leading `@`, `-`, `+` or `=`, which spreadsheet software evaluates as a
 *    formula when the value lands in a CSV cell.
 */
export function validIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) return null;
  if (value.includes("..") || value.includes("//") || value.startsWith("/")) return null;
  const first = value[0];
  if (first === "@" || first === "-" || first === "+" || first === "=") return null;
  return value;
}

/** A spawning `tool_use` id, or null. */
export function validToolUseId(value: unknown): string | null {
  return typeof value === "string" && TOOL_USE_ID_RE.test(value) ? value : null;
}

/** A spawn depth: a safe integer in 1..{@link MAX_SPAWN_DEPTH}, or null. */
export function validSpawnDepth(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SPAWN_DEPTH
    ? value
    : null;
}

/**
 * Subagent types that ship with Claude Code. Everything else was named by a
 * user or a plugin author and is treated as user-authored text.
 */
export const BUILT_IN_AGENT_TYPES: readonly string[] = Object.freeze([
  "general-purpose",
  "Explore",
  "Plan",
  "fork",
  "claude-code-guide",
  "statusline-setup",
]);

const builtInAgentTypes: ReadonlySet<string> = new Set(BUILT_IN_AGENT_TYPES);

export function isBuiltInAgentType(name: string): boolean {
  return builtInAgentTypes.has(name);
}

/**
 * Claude Code's own tool names, past and present. A CLOSED list, not a shape
 * rule: `^[A-Z][A-Za-z]+$` would admit any capitalised company name and any
 * tool name a model invents.
 *
 * A tool Claude Code adds later reads as `"custom"` until it is added here,
 * which under-reports and never leaks. Measured coverage on one real history:
 * 99.85% of non-MCP tool calls.
 *
 * The AppSync resolvers cannot import this module and carry an inlined copy;
 * a test in `packages/infra` pins that copy to this list.
 */
export const BUILT_IN_TOOL_NAMES: readonly string[] = Object.freeze([
  "Agent", "Artifact", "ArtifactComments", "ArtifactData", "AskUserQuestion",
  "Bash", "BashOutput", "CronCreate", "CronDelete", "CronList", "DesignSync",
  "Edit", "EnterPlanMode", "EnterWorktree", "ExitPlanMode", "ExitWorktree",
  "Glob", "Grep", "KillBash", "KillShell", "LS", "LSP", "ListAgents",
  "ListMcpResourcesTool", "Monitor", "MultiEdit", "NotebookEdit", "NotebookRead",
  "PowerShell", "PushNotification", "REPL", "Read", "ReadMcpResourceDirTool",
  "ReadMcpResourceTool", "ReportFindings", "ScheduleWakeup", "SendMessage",
  "ShareOnboardingGuide", "Skill", "SlashCommand", "Sleep", "StructuredOutput",
  "Task", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop",
  "TaskUpdate", "TeamCreate", "TeamDelete", "TodoRead", "TodoWrite", "ToolSearch",
  "WebFetch", "WebSearch", "Workflow", "Write",
]);

const builtInToolNames: ReadonlySet<string> = new Set(BUILT_IN_TOOL_NAMES);

export function isBuiltInToolName(name: string): boolean {
  return builtInToolNames.has(name);
}

/** The two buckets a non-built-in tool name collapses into off the machine. */
export type ToolNameBucket = "mcp" | "custom";

/**
 * The form a tool name may take on the org plane: a built-in name as itself,
 * any `mcp__<server>__<tool>` as `"mcp"` (the server name is whatever the user
 * called it), anything else as `"custom"`.
 */
export function bucketToolName(name: string): string {
  if (isBuiltInToolName(name)) return name;
  return name.startsWith("mcp__") ? "mcp" : "custom";
}
