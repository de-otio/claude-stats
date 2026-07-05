/**
 * Transcript archive — Phase A seed. Public surface for the Wire/UX phases.
 *
 * The archive is an opt-in, best-effort raw-transcript mirror written DURING
 * collect. Nothing here runs unless the user has explicitly opted in via
 * `config.archive.enable`. See `mirror.ts` (byte-range copy + self-heal),
 * `retention.ts` (prune by real activity), `purge.ts` (delete everything), and
 * `paths.ts` (the shared path guard).
 *
 * Collector integration (done by the Wire phase, NOT here):
 *   1. inside the per-file loop, AFTER parse and BEFORE `store.upsertCheckpoint`,
 *      call `archiveDuringCollect(config, archiveRoot, { ...mode, lastGoodOffset })`;
 *   2. once per collect, call `pruneArchive(archiveRoot, retentionDays, now)`.
 */
import { paths } from "@claude-stats/core/paths";
import type { Config } from "../config.js";
import { isArchiveEnabled, archiveRetentionDays } from "../config.js";
import { mirrorSessionRange, type MirrorInput, type MirrorResult } from "./mirror.js";
import { pruneArchive, type PruneResult } from "./retention.js";

export { mirrorSessionRange } from "./mirror.js";
export type { MirrorInput, MirrorResult, ChangeMode } from "./mirror.js";
export {
  pruneArchive,
  computeLastActivity,
  clampRetentionDays,
  DEFAULT_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from "./retention.js";
export type { PruneResult } from "./retention.js";
export { purgeAllData } from "./purge.js";
export type { PurgeOptions, PurgeResult, PurgeTargetOutcome } from "./purge.js";
export { unregisterMcpServerFromClaudeJson, MCP_KEY } from "./unregister.js";
export {
  mirrorFilePath,
  assertSafeSegment,
  assertSafeToDelete,
  ArchivePathError,
} from "./paths.js";

/**
 * Consent-gated collect-time entry point. Returns null (a no-op) when the
 * archive is disabled, so the collector can call it unconditionally. Uses
 * `paths.archiveDir` by default; tests inject an explicit root.
 */
export function archiveDuringCollect(
  config: Config,
  input: MirrorInput,
  archiveRoot: string = paths.archiveDir,
): MirrorResult | null {
  if (!isArchiveEnabled(config)) return null;
  return mirrorSessionRange(archiveRoot, input);
}

/**
 * Consent-gated retention sweep. No-op (null) when disabled. Applies the
 * configured, clamped retention window.
 */
export function pruneDuringCollect(
  config: Config,
  archiveRoot: string = paths.archiveDir,
  now: () => number = Date.now,
): PruneResult | null {
  if (!isArchiveEnabled(config)) return null;
  return pruneArchive(archiveRoot, archiveRetentionDays(config), now);
}
