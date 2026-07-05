/**
 * Export selector (S3): export ONLY locally-originated rows.
 *
 * "Locally-originated" = a `sessions` row whose `source_file` matches one of
 * THIS device's `collection_state.source_file` values — i.e. this device
 * actually COLLECTED that JSONL, as opposed to a row that arrived by merging
 * another device's shard. Exporting only these keeps every device from
 * re-exporting everyone else's data after a merge, which would otherwise make
 * shards grow without bound and blur origin provenance (review S3).
 */

import type { ExportCandidateRow, IsLocallyOriginated } from "../types/shard.js";

/**
 * The {@link IsLocallyOriginated} predicate: true iff the row's `sourceFile` is
 * one this device collected. Pure and total.
 */
export const isLocallyOriginated: IsLocallyOriginated = (row, localSourceFiles) =>
  localSourceFiles.has(row.sourceFile);

/** Filter candidate rows down to the locally-originated ones (S3). */
export function selectLocallyOriginated<R extends ExportCandidateRow>(
  rows: readonly R[],
  localSourceFiles: ReadonlySet<string>,
): R[] {
  return rows.filter((row) => isLocallyOriginated(row, localSourceFiles));
}
