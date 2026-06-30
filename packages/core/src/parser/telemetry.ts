/**
 * Telemetry parser — extracts account identity from failed telemetry events.
 *
 * Claude Code stores failed-to-send telemetry events in ~/.claude/telemetry/.
 * GrowthbookExperimentEvent entries contain user_attributes with accountUUID,
 * organizationUUID, and subscriptionType linked to a sessionId.
 *
 * Files are JSONL (one JSON event per line) though a single top-level JSON
 * array is also accepted for back-compat.
 *
 * This is best-effort: only failed events are retained locally, so coverage
 * is incomplete. Sessions without a telemetry match get null account fields.
 *
 * Hardening (plan §7 sec#7):
 *   - lstatSync each file; skip non-regular files and symlinks.
 *   - Skip files larger than MAX_FILE_BYTES (50 MB).
 *   - Parse JSONL line-by-line (readFileSync is safe after the size cap);
 *     never split a multi-GB string.
 *   - Cap the number of files processed (MAX_FILES) and total events parsed
 *     (MAX_EVENTS) to bound memory/CPU on adversarially large dirs.
 *   - Ignore unparseable lines and non-GrowthbookExperimentEvent events.
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";

export interface AccountInfo {
  accountUuid: string;
  organizationUuid: string | null;
  subscriptionType: string | null;
}

/** Maximum number of telemetry files to process per invocation. */
const MAX_FILES = 1_000;

/** Maximum total events to parse across all files in one invocation. */
const MAX_EVENTS = 100_000;

/** Maximum byte size of a single telemetry file (50 MB). */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Scan telemetry files and build a sessionId → AccountInfo mapping.
 * Returns only sessions where accountUUID was found.
 *
 * Files are read as JSONL (one event per line).  A file whose first
 * non-whitespace character is `[` is also accepted as a JSON array for
 * back-compat (older Claude Code versions may have written arrays).
 */
export function collectAccountMap(): Map<string, AccountInfo> {
  const map = new Map<string, AccountInfo>();
  const telemetryDir = path.join(paths.claudeDir, "telemetry");

  if (!fs.existsSync(telemetryDir)) return map;

  let files: string[];
  try {
    files = fs.readdirSync(telemetryDir);
  } catch {
    return map;
  }

  // Filter to matching files before applying the cap so ordering is stable.
  const candidates = files.filter(
    (f) => f.startsWith("1p_failed_events") && f.endsWith(".json"),
  );

  let filesProcessed = 0;
  let totalEvents = 0;

  for (const file of candidates) {
    if (filesProcessed >= MAX_FILES) break;
    if (totalEvents >= MAX_EVENTS) break;

    const filePath = path.join(telemetryDir, file);

    // Harden: reject symlinks and non-regular files.
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }

    filesProcessed++;

    // Collect events from the file (JSONL or legacy array) into a local
    // buffer and flush to the map.  We stream line-by-line so a large file
    // is never held in memory as a split string.
    try {
      const eventsFromFile = parseEventsFromFile(filePath);
      for (const event of eventsFromFile) {
        if (totalEvents >= MAX_EVENTS) break;
        totalEvents++;
        const info = extractAccountInfo(event);
        if (info) {
          map.set(info.sessionId, info.account);
        }
      }
    } catch {
      // Malformed telemetry file — skip
    }
  }

  return map;
}

/**
 * Parse events from a single file, supporting both JSONL and legacy
 * single-array format.
 *
 * Strategy: read the file synchronously (after the lstat size cap ensures it
 * is ≤50 MB) and split on newlines.  For files larger than the cap we never
 * reach here, so the in-memory string is bounded.
 *
 * We detect array format by checking whether the first non-whitespace
 * character is `[`.  This avoids a double-parse and keeps the function pure
 * (no async readline needed given the size cap).
 */
function parseEventsFromFile(filePath: string): unknown[] {
  const raw = fs.readFileSync(filePath, "utf-8");

  // Back-compat: legacy single JSON array.
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as unknown[];
    } catch {
      // Fall through to JSONL parsing if the array parse fails.
    }
  }

  // JSONL: parse each non-empty line independently; skip unparseable lines.
  const events: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    try {
      events.push(JSON.parse(trimmedLine) as unknown);
    } catch {
      // Ignore unparseable lines (plan §7 sec#7).
    }
  }
  return events;
}

function extractAccountInfo(
  event: unknown,
): { sessionId: string; account: AccountInfo } | null {
  if (typeof event !== "object" || event === null) return null;

  const e = event as Record<string, unknown>;
  if (e.event_type !== "GrowthbookExperimentEvent") return null;

  const eventData = e.event_data;
  if (typeof eventData !== "object" || eventData === null) return null;

  const data = eventData as Record<string, unknown>;
  const sessionId = data.session_id;
  if (typeof sessionId !== "string" || !sessionId) return null;

  const userAttrsRaw = data.user_attributes;
  if (typeof userAttrsRaw !== "string") return null;

  try {
    const attrs = JSON.parse(userAttrsRaw) as Record<string, unknown>;
    const accountUuid = attrs.accountUUID;
    if (typeof accountUuid !== "string" || !accountUuid) return null;

    return {
      sessionId,
      account: {
        accountUuid,
        organizationUuid:
          typeof attrs.organizationUUID === "string"
            ? attrs.organizationUUID
            : null,
        subscriptionType:
          typeof attrs.subscriptionType === "string"
            ? attrs.subscriptionType
            : null,
      },
    };
  } catch {
    return null;
  }
}
