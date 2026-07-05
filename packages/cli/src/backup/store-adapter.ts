/**
 * Store → export-inputs adapter (imperative shell).
 *
 * Reads the rows a backup push needs off the local SQLite {@link Store} and
 * exposes them to the pure record builder. The `localSourceFiles` set is the S3
 * origin selector: the `collection_state.file_path` values THIS device actually
 * collected. Only sessions whose `source_file` is in this set get exported, so a
 * device never re-exports rows it merged in from another device (S3).
 */

import type { Store, MessageRow, SessionRow } from "../store/index.js";

export interface ExportInputs {
  readonly sessions: readonly SessionRow[];
  readonly messagesFor: (sessionId: string) => readonly MessageRow[];
  /** `collection_state.file_path` values this device collected (the S3 selector). */
  readonly localSourceFiles: ReadonlySet<string>;
}

/** Load the sessions, per-session messages, and local-origin selector from the store. */
export function loadExportInputs(store: Store): ExportInputs {
  const sessions = store.getSessions({ includeDeleted: true, includeCI: true, includeSubagents: true });
  const localSourceFiles = new Set<string>(store.getAllCheckpoints().map((c) => c.filePath));
  return {
    sessions,
    messagesFor: (sessionId) => store.getSessionMessages(sessionId),
    localSourceFiles,
  };
}
