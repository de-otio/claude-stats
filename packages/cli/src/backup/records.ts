/**
 * Build the STAMPED records this device exports into its shard subtree.
 *
 * Pure core: turns `sessions` rows (+ their messages) into
 * {@link StampedRecord}s, keeping ONLY locally-originated rows (S3) and stamping
 * each with the cross-device {@link OriginClock} — the WRITING device's monotonic
 * counter + a wall-clock hint + the origin device id. The clock and counter are
 * INJECTED (never `Date.now()` in logic), so a given input set projects to
 * byte-stable records for pinned tests.
 */

import type { DeviceId, OriginClock, StampedRecord } from "@claude-stats/core/types/shard";
import { selectLocallyOriginated } from "@claude-stats/core/bundle";
import type { MessageRow, SessionRow } from "../store/index.js";

/**
 * One exported record's value: a session and its messages. This is
 * personal-plane data (it MAY carry `prompt_text` / `file_paths`) — legitimate
 * here because the whole plane is end-to-end encrypted to the user's own keys.
 * It is NEVER the org-plane payload (that is the minimized `AggregateProjection`).
 */
export interface SessionExportPayload {
  readonly session: SessionRow;
  readonly messages: readonly MessageRow[];
}

export interface BuildRecordsOptions {
  /** This device — stamped as `OriginClock.originDevice` (the merge tiebreak). */
  readonly originDevice: DeviceId;
  /** This device's `collection_state.source_file` set — the S3 origin selector. */
  readonly localSourceFiles: ReadonlySet<string>;
  /** Wall-clock hint (injected; ordering aid only, never the merge key). */
  readonly wallMs: number;
  /** Monotonic counter base; each record gets a strictly-increasing value. */
  readonly startCounter: number;
}

/**
 * Project locally-originated sessions into stamped export records, sorted by
 * `session_id` for determinism and stamped with strictly-increasing counters
 * from `startCounter`. Merged-in rows (whose `source_file` this device never
 * collected) are dropped, so no device re-exports another's data (S3).
 */
export function buildSessionRecords(
  sessions: readonly SessionRow[],
  messagesFor: (sessionId: string) => readonly MessageRow[],
  options: BuildRecordsOptions,
): StampedRecord<SessionExportPayload>[] {
  const candidates = sessions.map((s) => ({ sessionId: s.session_id, sourceFile: s.source_file, row: s }));
  const local = selectLocallyOriginated(candidates, options.localSourceFiles);
  const sorted = [...local].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));

  return sorted.map((c, i): StampedRecord<SessionExportPayload> => {
    const clock: OriginClock = {
      wallMs: options.wallMs,
      counter: options.startCounter + i,
      originDevice: options.originDevice,
    };
    return {
      clock,
      value: { session: c.row, messages: messagesFor(c.sessionId) },
    };
  });
}

/** The next monotonic counter after a batch of records (for the caller's state). */
export function nextCounterAfter(records: readonly StampedRecord<unknown>[], startCounter: number): number {
  return startCounter + records.length;
}
