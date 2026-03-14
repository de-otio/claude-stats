/**
 * Telemetry parser — extracts account identity from failed telemetry events.
 *
 * Claude Code stores failed-to-send telemetry events in ~/.claude/telemetry/.
 * GrowthbookExperimentEvent entries contain user_attributes with accountUUID,
 * organizationUUID, and subscriptionType linked to a sessionId.
 *
 * This is best-effort: only failed events are retained locally, so coverage
 * is incomplete. Sessions without a telemetry match get null account fields.
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";

export interface AccountInfo {
  accountUuid: string;
  organizationUuid: string | null;
  subscriptionType: string | null;
}

/**
 * Scan telemetry files and build a sessionId → AccountInfo mapping.
 * Returns only sessions where accountUUID was found.
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

  for (const file of files) {
    if (!file.startsWith("1p_failed_events") || !file.endsWith(".json")) continue;

    const filePath = path.join(telemetryDir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const events = JSON.parse(raw) as unknown[];
      if (!Array.isArray(events)) continue;

      for (const event of events) {
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

function extractAccountInfo(
  event: unknown
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
        organizationUuid: typeof attrs.organizationUUID === "string" ? attrs.organizationUUID : null,
        subscriptionType: typeof attrs.subscriptionType === "string" ? attrs.subscriptionType : null,
      },
    };
  } catch {
    return null;
  }
}
