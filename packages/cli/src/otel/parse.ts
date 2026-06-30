/**
 * OTLP/JSON(L) parser (Phase 2 D) — file-based, hardened, streaming.
 *
 * Reads a user-configured OTLP export FILE (OTLP/JSON or JSONL) emitted by
 * Claude Code with telemetry enabled and extracts, per session, the
 * authoritative account binding plus token/model summary info.
 *
 * Claude Code OTEL resource attributes (verified against
 * code.claude.com/docs/en/monitoring-usage, see ASSUMPTIONS.md #36):
 *   - user.account_uuid  → accountUuid   (authoritative, default on)
 *   - organization.id    → organizationUuid
 *   - session.id         → sessionId     (default on)
 *   - app.entrypoint     → surface       (cli, claude-vscode, …; default OFF)
 *   - terminal.type      → surface fallback (iTerm.app, vscode, …)
 * Token metric `claude_code.token.usage` carries dataPoint attrs
 * `type`/`model`/`query_source` and the count in `asInt`.
 *
 * HARDENING (plan §7 sec#3):
 *   - lstatSync → reject symlink / non-regular file
 *   - reject size > MAX_FILE_BYTES (500 MB) before reading
 *   - STREAM line-by-line via readline (never readFileSync a multi-GB string)
 *   - cap parsed events at MAX_EVENTS; malformed lines counted + skipped
 *
 * This module is otherwise pure-ish: it does file I/O (the source) but takes no
 * clock and performs no DB writes. ingest.ts wires it to the store.
 */
import fs from "node:fs";
import readline from "node:readline";

/** Reject files larger than this before opening (defense vs. OTLP exhaustion). */
export const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MB
/** Stop after this many OTLP records to bound memory/CPU on hostile input. */
export const MAX_EVENTS = 5_000_000;

/** Resource-attribute keys Claude Code emits (OTEL semantic-ish conventions). */
const ATTR_ACCOUNT_UUID = "user.account_uuid";
const ATTR_ORG_ID = "organization.id";
const ATTR_SESSION_ID = "session.id";
const ATTR_ENTRYPOINT = "app.entrypoint";
const ATTR_TERMINAL = "terminal.type";

/** The Claude Code token metric name. */
const TOKEN_METRIC = "claude_code.token.usage";

/** One session's worth of attribution + summary data extracted from OTLP. */
export interface OtelSessionTuple {
  sessionId: string;
  accountUuid: string;
  organizationUuid: string | null;
  /** Surface from app.entrypoint, else terminal.type, else null. */
  surface: string | null;
  /** Models seen on this session's token metrics (deduped, insertion order). */
  models: string[];
  /** Total tokens summed across token.usage data points for this session. */
  tokens: number;
  /** Latest data-point timeUnixNano seen for this session (epoch ms), or null. */
  ts: number | null;
}

export interface OtelParseResult {
  /** sessionId → tuple. Last write wins for a repeated sessionId. */
  sessions: Map<string, OtelSessionTuple>;
  /** Distinct accountUuid → its surface/org (first seen), for observations. */
  accounts: Map<string, { organizationUuid: string | null; surface: string | null }>;
  /** Count of OTLP records (resourceMetrics+resourceLogs entries) parsed. */
  recordCount: number;
  /** Lines/records that failed to parse and were skipped. */
  malformed: number;
  /** True if MAX_EVENTS was reached and parsing stopped early. */
  truncated: boolean;
}

// ─── OTLP/JSON AnyValue + attribute shapes (Protobuf JSON mapping) ────────────

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}
interface OtlpKeyValue {
  key?: string;
  value?: OtlpAnyValue;
}
interface OtlpResource {
  attributes?: OtlpKeyValue[];
}
interface OtlpNumberDataPoint {
  attributes?: OtlpKeyValue[];
  asInt?: string | number;
  asDouble?: number;
  timeUnixNano?: string | number;
}
interface OtlpMetric {
  name?: string;
  sum?: { dataPoints?: OtlpNumberDataPoint[] };
  gauge?: { dataPoints?: OtlpNumberDataPoint[] };
}
interface OtlpScopeMetrics {
  metrics?: OtlpMetric[];
}
interface OtlpResourceMetrics {
  resource?: OtlpResource;
  scopeMetrics?: OtlpScopeMetrics[];
}
interface OtlpScopeLogs {
  logRecords?: unknown[];
}
interface OtlpResourceLogs {
  resource?: OtlpResource;
  scopeLogs?: OtlpScopeLogs[];
}
interface OtlpExportRequest {
  resourceMetrics?: OtlpResourceMetrics[];
  resourceLogs?: OtlpResourceLogs[];
}

// ─── attribute helpers ────────────────────────────────────────────────────────

/** Flatten an OTLP attribute list into a plain string-valued lookup. */
function attrMap(attrs: OtlpKeyValue[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!attrs) return m;
  for (const kv of attrs) {
    if (!kv || typeof kv.key !== "string") continue;
    const v = anyValueToString(kv.value);
    if (v !== null) m.set(kv.key, v);
  }
  return m;
}

/** Coerce an OTLP AnyValue to a string (only the scalar kinds we care about). */
function anyValueToString(v: OtlpAnyValue | undefined): string | null {
  if (!v || typeof v !== "object") return null;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.intValue === "number") return String(v.intValue);
  if (typeof v.intValue === "string") return v.intValue;
  if (typeof v.doubleValue === "number") return String(v.doubleValue);
  if (typeof v.boolValue === "boolean") return String(v.boolValue);
  return null;
}

/** Parse an OTLP int (decimal string per spec) or number → finite number | 0. */
function toInt(v: string | number | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** timeUnixNano (string|number, ns) → epoch ms, or null. */
function nanoToMs(v: string | number | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n / 1_000_000);
}

// ─── extraction ───────────────────────────────────────────────────────────────

/**
 * Fold one parsed OTLP ExportRequest into the accumulating result. Mutates
 * `result` in place; returns the number of resource records consumed (so the
 * caller can enforce MAX_EVENTS).
 */
export function foldExportRequest(
  req: OtlpExportRequest,
  result: OtelParseResult,
): number {
  let consumed = 0;
  if (Array.isArray(req.resourceMetrics)) {
    for (const rm of req.resourceMetrics) {
      consumed++;
      foldResource(rm.resource, collectMetricPoints(rm.scopeMetrics), result);
    }
  }
  if (Array.isArray(req.resourceLogs)) {
    for (const rl of req.resourceLogs) {
      consumed++;
      foldResource(rl.resource, [], result);
    }
  }
  return consumed;
}

interface MetricPoint {
  model: string | null;
  tokens: number;
  ts: number | null;
}

/** Pull token.usage data points (model + count + ts) out of scopeMetrics. */
function collectMetricPoints(
  scopeMetrics: OtlpScopeMetrics[] | undefined,
): MetricPoint[] {
  const out: MetricPoint[] = [];
  if (!Array.isArray(scopeMetrics)) return out;
  for (const sm of scopeMetrics) {
    if (!Array.isArray(sm.metrics)) continue;
    for (const metric of sm.metrics) {
      if (metric.name !== TOKEN_METRIC) continue;
      const dps = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
      for (const dp of dps) {
        const a = attrMap(dp.attributes);
        out.push({
          model: a.get("model") ?? null,
          tokens: toInt(dp.asInt) || (dp.asDouble != null ? Math.round(dp.asDouble) : 0),
          ts: nanoToMs(dp.timeUnixNano),
        });
      }
    }
  }
  return out;
}

/** Fold one resource (its account/session binding + any metric points). */
function foldResource(
  resource: OtlpResource | undefined,
  points: MetricPoint[],
  result: OtelParseResult,
): void {
  const attrs = attrMap(resource?.attributes);
  const accountUuid = attrs.get(ATTR_ACCOUNT_UUID);
  const sessionId = attrs.get(ATTR_SESSION_ID);
  // No authoritative binding without both an account and a session id.
  if (!accountUuid || !sessionId) return;

  const organizationUuid = attrs.get(ATTR_ORG_ID) ?? null;
  const surface = attrs.get(ATTR_ENTRYPOINT) ?? attrs.get(ATTR_TERMINAL) ?? null;

  if (!result.accounts.has(accountUuid)) {
    result.accounts.set(accountUuid, { organizationUuid, surface });
  }

  const existing = result.sessions.get(sessionId);
  const tuple: OtelSessionTuple = existing ?? {
    sessionId,
    accountUuid,
    organizationUuid,
    surface,
    models: [],
    tokens: 0,
    ts: null,
  };
  // Last write wins for the binding fields (matches telemetry parser behaviour).
  tuple.accountUuid = accountUuid;
  tuple.organizationUuid = organizationUuid;
  if (surface) tuple.surface = surface;

  for (const p of points) {
    tuple.tokens += p.tokens;
    if (p.model && !tuple.models.includes(p.model)) tuple.models.push(p.model);
    if (p.ts != null && (tuple.ts == null || p.ts > tuple.ts)) tuple.ts = p.ts;
  }

  result.sessions.set(sessionId, tuple);
}

// ─── file reading (hardened, streaming) ────────────────────────────────────────

/**
 * Validate the path is a safe, regular, bounded file. Throws on symlink /
 * non-regular / oversize. Returns the (bounded) size in bytes.
 */
export function assertSafeOtelFile(filePath: string): number {
  // lstat (NOT stat) so a symlink is detected rather than followed.
  const st = fs.lstatSync(filePath);
  if (st.isSymbolicLink()) {
    throw new Error(`OTLP file is a symlink, refusing to read: ${filePath}`);
  }
  if (!st.isFile()) {
    throw new Error(`OTLP path is not a regular file: ${filePath}`);
  }
  if (st.size > MAX_FILE_BYTES) {
    throw new Error(
      `OTLP file too large (${st.size} bytes > ${MAX_FILE_BYTES} limit): ${filePath}`,
    );
  }
  return st.size;
}

function emptyResult(): OtelParseResult {
  return {
    sessions: new Map(),
    accounts: new Map(),
    recordCount: 0,
    malformed: 0,
    truncated: false,
  };
}

/**
 * Parse an OTLP/JSON or JSONL file into an {@link OtelParseResult}.
 *
 * Streams line-by-line. Each non-empty line is parsed as one OTLP
 * ExportRequest. A single-line file containing one top-level JSON object (the
 * non-JSONL case) is handled by the same path, since it is exactly one "line".
 * Malformed lines are skipped and counted, never thrown.
 *
 * @param filePath  path to a regular, non-symlink file ≤ MAX_FILE_BYTES.
 */
export async function parseOtelFile(filePath: string): Promise<OtelParseResult> {
  assertSafeOtelFile(filePath);

  const result = emptyResult();
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const rawLine of rl) {
      if (result.recordCount >= MAX_EVENTS) {
        result.truncated = true;
        break;
      }
      const line = rawLine.trim();
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        result.malformed++;
        continue;
      }
      result.recordCount += foldRecord(parsed, result);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return result;
}

/**
 * Fold one parsed JSON record. The record may be a single OTLP ExportRequest
 * object or an ARRAY of them (some exporters write a JSON array, not JSONL).
 * Returns the number of resource records consumed.
 */
function foldRecord(parsed: unknown, result: OtelParseResult): number {
  if (Array.isArray(parsed)) {
    let consumed = 0;
    for (const item of parsed) {
      if (item && typeof item === "object") {
        consumed += foldExportRequest(item as OtlpExportRequest, result);
      } else {
        result.malformed++;
      }
      if (result.recordCount + consumed >= MAX_EVENTS) break;
    }
    return consumed;
  }
  if (parsed && typeof parsed === "object") {
    return foldExportRequest(parsed as OtlpExportRequest, result);
  }
  result.malformed++;
  return 0;
}
