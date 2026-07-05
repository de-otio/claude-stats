/**
 * Archive path derivation and defensive path validation.
 *
 * The archive mirrors each Claude Code session JSONL to
 *   <archiveRoot>/<projectDirName>/<sessionId>.jsonl
 *
 * Both `projectDirName` and `sessionId` are attacker-influenceable in principle
 * (they derive from on-disk directory names and session-file basenames), so
 * every component that becomes a path segment is validated to a strict
 * allow-list BEFORE it is joined. This is the shared guard the retention and
 * purge paths reuse — a single choke point rather than ad-hoc checks.
 */
import * as os from "node:os";
import * as path from "node:path";

/** A single path segment may contain only these characters. Rejects `/`, `\`,
 *  `..`, NUL, and leading dots — anything that could escape the archive tree. */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export class ArchivePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchivePathError";
  }
}

/**
 * Validate one path segment (a project dir name or a session-file basename).
 * Returns the segment unchanged when safe; throws otherwise. Never returns a
 * value that, when joined, could resolve outside its parent.
 */
export function assertSafeSegment(segment: string, kind: string): string {
  if (typeof segment !== "string" || segment.length === 0) {
    throw new ArchivePathError(`empty ${kind} segment`);
  }
  if (segment === "." || segment === "..") {
    throw new ArchivePathError(`${kind} segment resolves to a relative path: ${segment}`);
  }
  if (segment.length > 255) {
    throw new ArchivePathError(`${kind} segment too long`);
  }
  if (!SAFE_SEGMENT_RE.test(segment)) {
    throw new ArchivePathError(`${kind} segment has unsafe characters: ${segment}`);
  }
  // Defence in depth: the segment must survive a basename round-trip unchanged,
  // so a platform-specific separator can never sneak through.
  if (path.basename(segment) !== segment) {
    throw new ArchivePathError(`${kind} segment is not a bare basename: ${segment}`);
  }
  return segment;
}

/** Resolve the mirror file path for one session, validating every segment. */
export function mirrorFilePath(
  archiveRoot: string,
  projectDirName: string,
  sessionId: string,
): string {
  const safeProject = assertSafeSegment(projectDirName, "projectDir");
  const safeSession = assertSafeSegment(sessionId, "sessionId");
  const resolvedRoot = path.resolve(archiveRoot);
  const full = path.join(resolvedRoot, safeProject, `${safeSession}.jsonl`);
  // Final belt-and-braces containment check: the resolved file must live under
  // the resolved root. `path.relative` starting with ".." means it escaped.
  const rel = path.relative(resolvedRoot, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ArchivePathError(`mirror path escapes archive root: ${full}`);
  }
  return full;
}

/**
 * Refuse to recursively delete a path unless it is plausibly one of our own
 * data directories. This is the guard in front of every destructive purge
 * operation — it must reject `/`, the home directory, and any ancestor of it,
 * plus anything too shallow to be a real data dir.
 *
 * Rules (all must pass):
 *   1. non-empty after resolution;
 *   2. not the filesystem root;
 *   3. not the home directory, and not an ancestor of the home directory
 *      (deleting `~` or above must be impossible);
 *   4. at least 3 path segments deep (so `/tmp`, `/Users` can't be targets).
 */
export function assertSafeToDelete(target: string): string {
  if (typeof target !== "string" || target.length === 0) {
    throw new ArchivePathError("refusing to delete an empty path");
  }
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    throw new ArchivePathError("refusing to delete the filesystem root");
  }
  const home = os.homedir();
  if (resolved === home) {
    throw new ArchivePathError("refusing to delete the home directory");
  }
  // Ancestor-of-home check: if home is inside `resolved`, then resolved is an
  // ancestor of home — deleting it would take the home dir with it.
  const relFromTarget = path.relative(resolved, home);
  if (relFromTarget !== "" && !relFromTarget.startsWith("..") && !path.isAbsolute(relFromTarget)) {
    throw new ArchivePathError(`refusing to delete an ancestor of the home directory: ${resolved}`);
  }
  const segments = resolved.split(path.sep).filter((s) => s.length > 0);
  if (segments.length < 3) {
    throw new ArchivePathError(`refusing to delete a shallow path: ${resolved}`);
  }
  return resolved;
}
