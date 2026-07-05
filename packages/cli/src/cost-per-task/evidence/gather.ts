/**
 * T0.5 — pure evidence transform.
 *
 * Converts a flat list of MessageRows into a TaskEvidence struct consumed by
 * Tier-0 outcome detectors. No I/O, no side-effects.
 *
 * Ordering guarantee: messages are sorted ascending by (timestamp ?? 0) then
 * uuid before any processing, so all derived sequences are deterministic.
 *
 * PRIVACY: prompt_text is forwarded as-is into userPrompts (for the
 * conversational detector). It MUST NOT flow into any OutcomeSignal or
 * OutcomeVerdict — that constraint is enforced at the detector layer, not here.
 */

import type { MessageRow } from '../../store/index.js';
import type { EditEvent, TaskEvidence } from '../outcome-types.js';

/** Tools whose use constitutes a mutating/edit event. */
const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Parse a JSON string that is expected to be a string array.
 * Returns [] on any parse error or if the result is not an array.
 */
function safeParseStringArray(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/**
 * Build a TaskEvidence from a set of MessageRows and a commit flag.
 *
 * @param messages  All rows belonging to this task's window (order not assumed).
 * @param committed Whether the task produced a commit.
 */
export function buildTaskEvidence(
  messages: readonly MessageRow[],
  committed: boolean,
  commitSubjects: readonly string[] = [],
): TaskEvidence {
  // Deterministic sort: ascending (timestamp ?? 0), tie-break by uuid.
  const sorted = [...messages].sort((a, b) => {
    const tA = a.timestamp ?? 0;
    const tB = b.timestamp ?? 0;
    if (tA !== tB) return tA - tB;
    return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
  });

  const userPrompts: string[] = [];
  const stopReasons: string[] = [];
  const editEvents: EditEvent[] = [];
  let lastActivityMs = 0;
  let toolErrors = 0;

  for (const m of sorted) {
    // Phase B: accumulate failed tool calls (additive; missing → 0).
    toolErrors += m.tool_error_count ?? 0;

    // Collect user prompts.
    if (m.prompt_text != null && m.prompt_text !== '') {
      userPrompts.push(m.prompt_text);
    }

    // Collect stop reasons.
    if (m.stop_reason != null) {
      stopReasons.push(m.stop_reason);
    }

    // Track last activity timestamp.
    const ts = m.timestamp ?? 0;
    if (ts > lastActivityMs) lastActivityMs = ts;

    // Collect edit events from mutating tools.
    const tools = safeParseStringArray(m.tools);
    const filePaths = safeParseStringArray(m.file_paths);

    for (const tool of tools) {
      if (!MUTATING_TOOLS.has(tool)) continue;

      if (filePaths.length === 0) {
        // Mutating tool present but no file paths recorded.
        editEvents.push({ tool, filePath: '', ts });
      } else {
        for (const filePath of filePaths) {
          editEvents.push({ tool, filePath, ts });
        }
      }
    }
  }

  return {
    userPrompts,
    stopReasons,
    editEvents,
    committed,
    lastActivityMs,
    toolErrors,
    commitSubjects: [...commitSubjects],
  };
}
