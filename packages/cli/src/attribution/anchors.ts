/**
 * Anchor pins (doc 03 §B) — live-session ground truth.
 *
 * Reads `~/.claude/sessions/<pid>.json` (per-process live-session state) and
 * emits an anchor pin for each CLI-surface session that was active within the
 * current account's still-open interval. A live CLI session belongs, with
 * certainty, to the account currently logged in on the CLI — so these are the
 * strongest FORWARD pins. Pins are persisted (`store.recordAnchorPin`) because
 * the session files are ephemeral; the attribution engine then applies them at
 * `anchor` precedence long after the process ends.
 *
 * Surface discipline: only sessions whose OWN `entrypoint` ∈ CLI_SURFACES are
 * pinned — `~/.claude.json`'s account reflects the CLI login only, never the IDE
 * extension's (doc 07). Recency guard: only sessions whose file was last
 * modified at/after `currentIntervalStart` are pinned, so a stale file left over
 * from before an account switch is never mis-pinned to the new account.
 *
 * Hardened I/O (mirrors the OTEL/telemetry readers): missing dir → `[]`; per
 * file `lstat` rejects symlinks / non-regular / oversized files; malformed JSON
 * is skipped, never thrown; the file count is capped.
 */
import fs from "node:fs";
import path from "node:path";
import { CLI_SURFACES } from "@claude-stats/core/types";
import { paths } from "@claude-stats/core/paths";

const CLI_SURFACE_SET = new Set<string>(CLI_SURFACES);
const MAX_SESSION_FILES = 10_000;
const MAX_FILE_BYTES = 1_000_000; // live-session files are tiny (<10 KB)
const LIVE_SESSION_SOURCE = "live-session";

export interface AnchorPin {
  sessionId: string;
  accountUuid: string;
  observedAt: number;
  source: string;
}

/**
 * Collect live-session anchor pins for `currentAccountUuid`. Returns `[]` when
 * the sessions directory is absent or holds no eligible files. Pure w.r.t. the
 * clock (`now` injected); the only I/O is reading the sessions directory.
 */
export function collectLiveSessionPins(
  currentAccountUuid: string,
  currentIntervalStart: number,
  now: number,
  sessionsDir: string = paths.sessionsDir,
): AnchorPin[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return []; // no sessions dir → no pins
  }

  const pins: AnchorPin[] = [];
  let processed = 0;
  for (const name of entries) {
    if (processed >= MAX_SESSION_FILES) break;
    if (!name.endsWith(".json")) continue;
    const fp = path.join(sessionsDir, name);

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fp);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue; // reject symlinks / dirs / sockets
    if (stat.size > MAX_FILE_BYTES) continue; // implausible for a session file
    processed++;

    // Recency guard: file untouched since before the current interval → the
    // session predates the current account, so it is NOT current-account truth.
    if (stat.mtimeMs < currentIntervalStart) continue;

    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch {
      continue; // malformed → skip
    }
    if (data === null || typeof data !== "object") continue;

    const rec = data as Record<string, unknown>;
    const sessionId = rec["sessionId"];
    const entrypoint = rec["entrypoint"];
    if (typeof sessionId !== "string" || sessionId.length === 0) continue;
    // Surface discipline: pin CLI-entrypoint sessions only.
    if (typeof entrypoint !== "string" || !CLI_SURFACE_SET.has(entrypoint)) continue;

    pins.push({
      sessionId,
      accountUuid: currentAccountUuid,
      observedAt: now,
      source: LIVE_SESSION_SOURCE,
    });
  }
  return pins;
}
