/**
 * Bounded reader for `api-request` lines (schema V28, E1 / O1 core).
 *
 * Claude Code 2.1.300+ writes one `api-request` record beside the conversation
 * per API call. The line is dominated by `params` — p50 849 B, max 273 KB, most
 * of it `params.safeguards` (classifier context) — and the fields E1 stores all
 * sit in the small HEAD before it: `type, sessionId, [agentId], id, timestamp,
 * version, querySource, shapeHash, params, …`. A1 skips these lines before
 * `JSON.parse` because they were 19% of transcript bytes; E1 reads the head
 * WITHOUT a full parse, so the skip's cost saving survives.
 *
 * Why the slice is safe: inside a JSON string every `"` is escaped, so the
 * byte sequence `,"params":` can only occur as a real key. Cutting at the
 * FIRST occurrence therefore ends the head before `params` and everything
 * after it; adversarial content smuggled into `params` (or into a head string
 * value, which cannot contain the sequence) is never read.
 *
 * Failure discipline (Fable F1/F2): a head miss — no `params` key within the
 * first 2,048 characters, or a head slice that does not parse — returns null.
 * It NEVER throws and never logs: the parser calls this from its skip branch,
 * which sits OUTSIDE the per-line try/catch, so a throw would abort the whole
 * collect and the checkpoint would never advance past the line, bricking every
 * later collect. The parse swallows its error object entirely (no
 * `String(err)` — V8 SyntaxError messages embed input context); a miss is
 * only the caller's `apiRequestHeadMisses` counter.
 *
 * Pure: no I/O, no clock.
 */
import { validIdentifier } from "../identifiers.js";
import type { ApiRequestFields } from "../types.js";

/**
 * The exact prefix of a PLAIN `api-request` line, INCLUDING the closing quote
 * of the type value: `{"type":"api-request"`. `api-request-shape` and
 * `api-request-blob` lines do NOT match — the byte after `api-request` there
 * is `-`, not the closing quote — so the A1 prefix test routes them away
 * before this reader is called.
 */
const PLAIN_API_REQUEST_PREFIX = '{"type":"api-request"';

/** True for a plain `api-request` line (never `-shape` / `-blob`). */
export function isPlainApiRequestLine(line: string): boolean {
  return line.startsWith(PLAIN_API_REQUEST_PREFIX);
}

/** The head is cut at the first `,"params":`; beyond this offset it is a miss. */
const HEAD_LIMIT_CHARS = 2048;
/** `shapeHash` is a SHA-256 hex digest. */
const SHAPE_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Epoch-ms for the head's `timestamp` (an ISO-8601 string in modern writers,
 * a number in older ones), else null. Mirrors `toEpochMs` in session.ts —
 * kept local so this module stays a leaf: session.ts imports it, and
 * importing back would create a parser-module cycle.
 */
function headTimestampMs(value: unknown): number | null {
  if (value == null) return null;
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return isFinite(ms) ? ms : null;
}

/**
 * Read the fixed field set from a plain `api-request` line's head, or null on
 * a head miss. The caller passes only lines where `isApiRequestLine(raw)` and
 * `isPlainApiRequestLine(raw)` both hold. `JSON.parse` is never given more
 * than `HEAD_LIMIT_CHARS + 1` characters of the line, and the tail
 * (`cacheControl`, `requestDigest`, `keep`, `base`) is never sliced or parsed.
 *
 * Validation happens HERE, where the values enter: an invalid `id` drops the
 * row (it is the `api_requests` primary key), and invalid `agentId` /
 * `timestamp` / `shapeHash` become null ("not recorded") — never truncated
 * into a different value, never stored raw. Unknown extra keys in the head are
 * ignored.
 */
export function readApiRequestFields(raw: string): ApiRequestFields | null {
  const paramsAt = raw.indexOf(',"params":');
  if (paramsAt < 0 || paramsAt > HEAD_LIMIT_CHARS) return null;

  let head: unknown;
  try {
    head = JSON.parse(raw.slice(0, paramsAt) + "}");
  } catch {
    // A head miss, exactly as when `params` is absent: the slice can end
    // mid-object (a nested `"params"` key inside an earlier head value) or
    // hold a raw control character inside a head string. Never throw, never
    // surface the error object — see the module doc.
    return null;
  }
  if (typeof head !== "object" || head === null) return null;
  const h = head as Record<string, unknown>;

  // An invalid id is no row at all: it would be the primary key.
  const requestId = validIdentifier(h["id"]);
  if (requestId === null) return null;

  const shapeHash = h["shapeHash"];
  return {
    requestId,
    agentId: validIdentifier(h["agentId"]),
    timestamp: headTimestampMs(h["timestamp"]),
    shapeHash:
      typeof shapeHash === "string" && SHAPE_HASH_RE.test(shapeHash)
        ? shapeHash
        : null,
  };
}
