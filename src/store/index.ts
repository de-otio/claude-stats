/**
 * SQLite store using Node's built-in node:sqlite module (Node >= 22.5).
 * No native build step or external dependencies required.
 *
 * All writes are wrapped in transactions for crash recovery.
 * Sessions are upserted by sessionId; messages are upserted by uuid.
 * See doc/analysis/02-collection-strategy.md — Output Format and Crash recovery.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";
import type {
  SessionRecord,
  MessageRecord,
  FileCheckpoint,
  SchemaFingerprint,
  ParseError,
  UsageWindow,
} from "../types.js";
import { estimateCost } from "../pricing.js";

const SCHEMA_VERSION = 8;

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string = paths.statsDb) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  // ─── Schema migration ───────────────────────────────────────────────────────

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    const current = row ? parseInt(row.value, 10) : 0;
    if (current < 1) this.migrateToV1();
    if (current < 2) this.migrateToV2();
    if (current < 3) this.migrateToV3();
    if (current < 4) this.migrateToV4();
    if (current < 5) this.migrateToV5();
    if (current < 6) this.migrateToV6();
    if (current < 7) this.migrateToV7();
    if (current < 8) this.migrateToV8();

    this.db
      .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
      .run("schema_version", String(SCHEMA_VERSION));
  }

  private migrateToV1(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id              TEXT PRIMARY KEY,
        project_path            TEXT NOT NULL,
        source_file             TEXT NOT NULL,
        first_timestamp         INTEGER,
        last_timestamp          INTEGER,
        claude_version          TEXT,
        entrypoint              TEXT,
        git_branch              TEXT,
        permission_mode         TEXT,
        is_interactive          INTEGER NOT NULL DEFAULT 0,
        prompt_count            INTEGER NOT NULL DEFAULT 0,
        assistant_message_count INTEGER NOT NULL DEFAULT 0,
        input_tokens            INTEGER NOT NULL DEFAULT 0,
        output_tokens           INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
        web_search_requests     INTEGER NOT NULL DEFAULT 0,
        web_fetch_requests      INTEGER NOT NULL DEFAULT 0,
        tool_use_counts         TEXT NOT NULL DEFAULT '[]',
        models                  TEXT NOT NULL DEFAULT '[]',
        source_deleted          INTEGER NOT NULL DEFAULT 0,
        updated_at              INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        uuid                  TEXT PRIMARY KEY,
        session_id            TEXT NOT NULL,
        timestamp             INTEGER,
        claude_version        TEXT,
        model                 TEXT,
        stop_reason           TEXT,
        input_tokens          INTEGER NOT NULL DEFAULT 0,
        output_tokens         INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS collection_state (
        file_path      TEXT PRIMARY KEY,
        file_size      INTEGER NOT NULL DEFAULT 0,
        last_offset    INTEGER NOT NULL DEFAULT 0,
        last_mtime     INTEGER NOT NULL DEFAULT 0,
        first_kb_hash  TEXT NOT NULL DEFAULT '',
        source_deleted INTEGER NOT NULL DEFAULT 0,
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schema_fingerprints (
        claude_version TEXT PRIMARY KEY,
        captured_at    INTEGER NOT NULL,
        fingerprint    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS quarantine (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path      TEXT NOT NULL,
        line_number    INTEGER NOT NULL,
        raw_line       TEXT NOT NULL,
        error          TEXT NOT NULL,
        timestamp      INTEGER NOT NULL,
        claude_version TEXT,
        reprocessed    INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_project   ON sessions (project_path);
      CREATE INDEX IF NOT EXISTS idx_sessions_first_ts  ON sessions (first_timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages (session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages (timestamp);
    `);
  }

  private migrateToV2(): void {
    this.db.exec(`ALTER TABLE sessions ADD COLUMN repo_url TEXT`);
  }

  private migrateToV3(): void {
    this.db.exec(`ALTER TABLE sessions ADD COLUMN account_uuid TEXT`);
    this.db.exec(`ALTER TABLE sessions ADD COLUMN organization_uuid TEXT`);
    this.db.exec(`ALTER TABLE sessions ADD COLUMN subscription_type TEXT`);
  }

  private migrateToV4(): void {
    this.db.exec(`ALTER TABLE messages ADD COLUMN tools TEXT NOT NULL DEFAULT '[]'`);
    this.db.exec(`ALTER TABLE messages ADD COLUMN thinking_blocks INTEGER NOT NULL DEFAULT 0`);
    this.db.exec(`ALTER TABLE sessions ADD COLUMN thinking_blocks INTEGER NOT NULL DEFAULT 0`);
  }

  private migrateToV5(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_tags (
        session_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, tag),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON session_tags (tag);
    `);
  }

  private migrateToV6(): void {
    // Timestamps were previously stored as ISO-8601 TEXT (e.g. "2026-03-10T09:46:58.588Z")
    // because RawSessionEntry.timestamp was mis-typed as number and the raw string was
    // passed straight through to SQLite, which stored it as TEXT despite the INTEGER affinity.
    // Convert any TEXT timestamps to epoch-milliseconds INTEGER so comparisons work correctly.
    // (julianday → epoch-ms: subtract Julian epoch offset and convert days→ms)
    this.db.exec(`
      UPDATE sessions
        SET first_timestamp = CAST((julianday(first_timestamp) - 2440587.5) * 86400000 AS INTEGER)
        WHERE first_timestamp IS NOT NULL AND typeof(first_timestamp) = 'text'
    `);
    this.db.exec(`
      UPDATE sessions
        SET last_timestamp = CAST((julianday(last_timestamp) - 2440587.5) * 86400000 AS INTEGER)
        WHERE last_timestamp IS NOT NULL AND typeof(last_timestamp) = 'text'
    `);
    this.db.exec(`
      UPDATE messages
        SET timestamp = CAST((julianday(timestamp) - 2440587.5) * 86400000 AS INTEGER)
        WHERE timestamp IS NOT NULL AND typeof(timestamp) = 'text'
    `);
  }

  private migrateToV7(): void {
    // Helper to skip ALTER TABLE if column already exists (idempotent for partial migrations)
    const addColumn = (table: string, column: string, def: string): void => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    };
    // New message-level fields for service tier, geo, and ephemeral cache breakdown
    addColumn("messages", "service_tier", "TEXT");
    addColumn("messages", "inference_geo", "TEXT");
    addColumn("messages", "ephemeral_5m_cache_tokens", "INTEGER NOT NULL DEFAULT 0");
    addColumn("messages", "ephemeral_1h_cache_tokens", "INTEGER NOT NULL DEFAULT 0");
    // New session-level fields for usage analysis
    addColumn("sessions", "throttle_events", "INTEGER NOT NULL DEFAULT 0");
    addColumn("sessions", "active_duration_ms", "INTEGER");
    addColumn("sessions", "median_response_time_ms", "INTEGER");
    // New table for 5-hour usage window tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_windows (
        window_start          INTEGER NOT NULL PRIMARY KEY,
        window_end            INTEGER NOT NULL,
        account_uuid          TEXT,
        total_cost_equivalent REAL NOT NULL DEFAULT 0,
        prompt_count          INTEGER NOT NULL DEFAULT 0,
        tokens_by_model       TEXT NOT NULL DEFAULT '{}',
        throttled             INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_windows_start ON usage_windows (window_start);
    `);
  }

  private migrateToV8(): void {
    const addColumn = (table: string, column: string, def: string): void => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    };
    // Store user prompt text paired with assistant messages for model efficiency analysis
    addColumn("messages", "prompt_text", "TEXT");
  }

  // ─── Transaction wrapper ────────────────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ─── Session upsert ─────────────────────────────────────────────────────────

  upsertSession(record: SessionRecord): void {
    this.db.prepare(`
      INSERT INTO sessions (
        session_id, project_path, source_file, first_timestamp, last_timestamp,
        claude_version, entrypoint, git_branch, permission_mode, is_interactive,
        prompt_count, assistant_message_count,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        web_search_requests, web_fetch_requests,
        tool_use_counts, models, repo_url,
        account_uuid, organization_uuid, subscription_type,
        thinking_blocks, throttle_events, active_duration_ms, median_response_time_ms,
        source_deleted, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        last_timestamp          = excluded.last_timestamp,
        claude_version          = excluded.claude_version,
        entrypoint              = COALESCE(excluded.entrypoint, sessions.entrypoint),
        is_interactive          = excluded.is_interactive,
        prompt_count            = excluded.prompt_count,
        assistant_message_count = excluded.assistant_message_count,
        input_tokens            = excluded.input_tokens,
        output_tokens           = excluded.output_tokens,
        cache_creation_tokens   = excluded.cache_creation_tokens,
        cache_read_tokens       = excluded.cache_read_tokens,
        web_search_requests     = excluded.web_search_requests,
        web_fetch_requests      = excluded.web_fetch_requests,
        tool_use_counts         = excluded.tool_use_counts,
        models                  = excluded.models,
        repo_url                = excluded.repo_url,
        account_uuid            = COALESCE(sessions.account_uuid, excluded.account_uuid),
        organization_uuid       = COALESCE(sessions.organization_uuid, excluded.organization_uuid),
        subscription_type       = COALESCE(sessions.subscription_type, excluded.subscription_type),
        thinking_blocks         = excluded.thinking_blocks,
        throttle_events         = excluded.throttle_events,
        active_duration_ms      = excluded.active_duration_ms,
        median_response_time_ms = excluded.median_response_time_ms,
        source_deleted          = excluded.source_deleted,
        updated_at              = excluded.updated_at
    `).run(
      record.sessionId,
      record.projectPath,
      record.sourceFile,
      record.firstTimestamp,
      record.lastTimestamp,
      record.claudeVersion,
      record.entrypoint,
      record.gitBranch,
      record.permissionMode,
      record.isInteractive ? 1 : 0,
      record.promptCount,
      record.assistantMessageCount,
      record.inputTokens,
      record.outputTokens,
      record.cacheCreationTokens,
      record.cacheReadTokens,
      record.webSearchRequests,
      record.webFetchRequests,
      JSON.stringify(record.toolUseCounts),
      JSON.stringify(record.models),
      record.repoUrl,
      record.accountUuid,
      record.organizationUuid,
      record.subscriptionType,
      record.thinkingBlocks,
      record.throttleEvents,
      record.activeDurationMs,
      record.medianResponseTimeMs,
      record.sourceDeleted ? 1 : 0,
      Date.now()
    );
  }

  /**
   * Upsert a session record from an incremental parse (startOffset > 0).
   *
   * Cumulative counters are ADDED to existing values (not replaced), because
   * the parser only returned the delta since the last checkpoint.
   * is_interactive uses MAX so it stays true once a queue-operation was seen
   * in any earlier parse run.
   */
  upsertSessionIncremental(record: SessionRecord): void {
    this.db.prepare(`
      INSERT INTO sessions (
        session_id, project_path, source_file, first_timestamp, last_timestamp,
        claude_version, entrypoint, git_branch, permission_mode, is_interactive,
        prompt_count, assistant_message_count,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        web_search_requests, web_fetch_requests,
        tool_use_counts, models, repo_url,
        account_uuid, organization_uuid, subscription_type,
        thinking_blocks, throttle_events, active_duration_ms, median_response_time_ms,
        source_deleted, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        last_timestamp          = MAX(sessions.last_timestamp, excluded.last_timestamp),
        claude_version          = excluded.claude_version,
        entrypoint              = COALESCE(excluded.entrypoint, sessions.entrypoint),
        is_interactive          = MAX(sessions.is_interactive, excluded.is_interactive),
        prompt_count            = sessions.prompt_count + excluded.prompt_count,
        assistant_message_count = sessions.assistant_message_count + excluded.assistant_message_count,
        input_tokens            = sessions.input_tokens + excluded.input_tokens,
        output_tokens           = sessions.output_tokens + excluded.output_tokens,
        cache_creation_tokens   = sessions.cache_creation_tokens + excluded.cache_creation_tokens,
        cache_read_tokens       = sessions.cache_read_tokens + excluded.cache_read_tokens,
        web_search_requests     = sessions.web_search_requests + excluded.web_search_requests,
        web_fetch_requests      = sessions.web_fetch_requests + excluded.web_fetch_requests,
        tool_use_counts         = excluded.tool_use_counts,
        models                  = excluded.models,
        repo_url                = excluded.repo_url,
        account_uuid            = COALESCE(sessions.account_uuid, excluded.account_uuid),
        organization_uuid       = COALESCE(sessions.organization_uuid, excluded.organization_uuid),
        subscription_type       = COALESCE(sessions.subscription_type, excluded.subscription_type),
        thinking_blocks         = sessions.thinking_blocks + excluded.thinking_blocks,
        throttle_events         = sessions.throttle_events + excluded.throttle_events,
        active_duration_ms      = COALESCE(sessions.active_duration_ms, 0) + COALESCE(excluded.active_duration_ms, 0),
        median_response_time_ms = COALESCE(sessions.median_response_time_ms, excluded.median_response_time_ms),
        source_deleted          = excluded.source_deleted,
        updated_at              = excluded.updated_at
    `).run(
      record.sessionId,
      record.projectPath,
      record.sourceFile,
      record.firstTimestamp,
      record.lastTimestamp,
      record.claudeVersion,
      record.entrypoint,
      record.gitBranch,
      record.permissionMode,
      record.isInteractive ? 1 : 0,
      record.promptCount,
      record.assistantMessageCount,
      record.inputTokens,
      record.outputTokens,
      record.cacheCreationTokens,
      record.cacheReadTokens,
      record.webSearchRequests,
      record.webFetchRequests,
      JSON.stringify(record.toolUseCounts),
      JSON.stringify(record.models),
      record.repoUrl,
      record.accountUuid,
      record.organizationUuid,
      record.subscriptionType,
      record.thinkingBlocks,
      record.throttleEvents,
      record.activeDurationMs,
      record.medianResponseTimeMs,
      record.sourceDeleted ? 1 : 0,
      Date.now()
    );
  }

  // ─── Message upsert ─────────────────────────────────────────────────────────

  upsertMessages(records: MessageRecord[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (
        uuid, session_id, timestamp, claude_version, model, stop_reason,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        tools, thinking_blocks,
        service_tier, inference_geo, ephemeral_5m_cache_tokens, ephemeral_1h_cache_tokens,
        prompt_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (uuid) DO UPDATE SET
        model                       = excluded.model,
        input_tokens                = excluded.input_tokens,
        output_tokens               = excluded.output_tokens,
        cache_creation_tokens       = excluded.cache_creation_tokens,
        cache_read_tokens           = excluded.cache_read_tokens,
        tools                       = excluded.tools,
        thinking_blocks             = excluded.thinking_blocks,
        service_tier                = excluded.service_tier,
        inference_geo               = excluded.inference_geo,
        ephemeral_5m_cache_tokens   = excluded.ephemeral_5m_cache_tokens,
        ephemeral_1h_cache_tokens   = excluded.ephemeral_1h_cache_tokens,
        prompt_text                 = COALESCE(excluded.prompt_text, messages.prompt_text)
    `);
    for (const r of records) {
      stmt.run(
        r.uuid, r.sessionId, r.timestamp, r.claudeVersion,
        r.model, r.stopReason, r.inputTokens, r.outputTokens,
        r.cacheCreationTokens, r.cacheReadTokens,
        JSON.stringify(r.tools), r.thinkingBlocks,
        r.serviceTier, r.inferenceGeo, r.ephemeral5mCacheTokens, r.ephemeral1hCacheTokens,
        r.promptText ?? null
      );
    }
  }

  // ─── Checkpoint ─────────────────────────────────────────────────────────────

  getCheckpoint(filePath: string): FileCheckpoint | null {
    const row = this.db
      .prepare("SELECT * FROM collection_state WHERE file_path = ?")
      .get(filePath) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      filePath: row["file_path"] as string,
      fileSize: row["file_size"] as number,
      lastByteOffset: row["last_offset"] as number,
      lastMtime: row["last_mtime"] as number,
      firstKbHash: row["first_kb_hash"] as string,
      sourceDeleted: Boolean(row["source_deleted"]),
    };
  }

  upsertCheckpoint(cp: FileCheckpoint): void {
    this.db.prepare(`
      INSERT INTO collection_state
        (file_path, file_size, last_offset, last_mtime, first_kb_hash, source_deleted, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (file_path) DO UPDATE SET
        file_size      = excluded.file_size,
        last_offset    = excluded.last_offset,
        last_mtime     = excluded.last_mtime,
        first_kb_hash  = excluded.first_kb_hash,
        source_deleted = excluded.source_deleted,
        updated_at     = excluded.updated_at
    `).run(
      cp.filePath, cp.fileSize, cp.lastByteOffset, cp.lastMtime,
      cp.firstKbHash, cp.sourceDeleted ? 1 : 0, Date.now()
    );
  }

  getAllCheckpoints(): FileCheckpoint[] {
    const rows = this.db
      .prepare("SELECT * FROM collection_state WHERE source_deleted = 0")
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      filePath: row["file_path"] as string,
      fileSize: row["file_size"] as number,
      lastByteOffset: row["last_offset"] as number,
      lastMtime: row["last_mtime"] as number,
      firstKbHash: row["first_kb_hash"] as string,
      sourceDeleted: Boolean(row["source_deleted"]),
    }));
  }

  /** Reset all checkpoints to force a full re-parse on next collect.
   *  Used for backfilling new fields (e.g. prompt_text). */
  resetCheckpoints(): number {
    const result = this.db.prepare("UPDATE collection_state SET last_offset = 0, last_mtime = 0").run();
    return Number(result.changes);
  }

  markSourceDeleted(filePath: string): void {
    this.db
      .prepare("UPDATE collection_state SET source_deleted = 1, updated_at = ? WHERE file_path = ?")
      .run(Date.now(), filePath);
    this.db
      .prepare("UPDATE sessions SET source_deleted = 1, updated_at = ? WHERE source_file = ?")
      .run(Date.now(), filePath);
  }

  // ─── Schema fingerprint ─────────────────────────────────────────────────────

  getFingerprint(claudeVersion: string): SchemaFingerprint | null {
    const row = this.db
      .prepare("SELECT fingerprint FROM schema_fingerprints WHERE claude_version = ?")
      .get(claudeVersion) as { fingerprint: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.fingerprint) as SchemaFingerprint;
  }

  upsertFingerprint(fp: SchemaFingerprint): void {
    this.db
      .prepare("INSERT OR REPLACE INTO schema_fingerprints (claude_version, captured_at, fingerprint) VALUES (?, ?, ?)")
      .run(fp.claudeVersion, fp.capturedAt, JSON.stringify(fp));
  }

  // ─── Quarantine ─────────────────────────────────────────────────────────────

  addToQuarantine(errors: ParseError[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO quarantine (file_path, line_number, raw_line, error, timestamp, claude_version)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const e of errors) {
      stmt.run(e.filePath, e.lineNumber, e.rawLine, e.error, e.timestamp, e.claudeVersion ?? null);
    }
  }

  // ─── Account enrichment ─────────────────────────────────────────────────────

  /** Best-effort: update account fields for sessions matched from telemetry. */
  updateSessionAccounts(mapping: Map<string, { accountUuid: string; organizationUuid: string | null; subscriptionType: string | null }>): number {
    const stmt = this.db.prepare(`
      UPDATE sessions SET
        account_uuid      = COALESCE(?, account_uuid),
        organization_uuid = COALESCE(?, organization_uuid),
        subscription_type = COALESCE(?, subscription_type),
        updated_at        = ?
      WHERE session_id = ? AND account_uuid IS NULL
    `);
    let updated = 0;
    for (const [sessionId, info] of mapping) {
      const result = stmt.run(info.accountUuid, info.organizationUuid, info.subscriptionType, Date.now(), sessionId);
      if (result.changes > 0) updated++;
    }
    return updated;
  }

  // ─── Stop reason distribution ──────────────────────────────────────────────

  getStopReasonCounts(sessionIds: string[]): Map<string, number> {
    if (sessionIds.length === 0) return new Map();
    const placeholders = sessionIds.map(() => "?").join(",");
    const stmt = this.db.prepare(`
      SELECT stop_reason, COUNT(*) as count
      FROM messages
      WHERE stop_reason IS NOT NULL AND session_id IN (${placeholders})
      GROUP BY stop_reason
      ORDER BY count DESC
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (stmt.all as (...args: any[]) => unknown[])(...sessionIds) as Array<{ stop_reason: string; count: number }>;
    const result = new Map<string, number>();
    for (const row of rows) {
      result.set(row.stop_reason, row.count);
    }
    return result;
  }

  // ─── Reporting queries ──────────────────────────────────────────────────────

  getMessageTotals(filters: {
    projectPath?: string;
    repoUrl?: string;
    since?: number;
    until?: number;
  } = {}): MessageTotalRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.projectPath) {
      conditions.push("s.project_path = ?");
      params.push(filters.projectPath);
    }
    if (filters.repoUrl) {
      conditions.push("s.repo_url = ?");
      params.push(filters.repoUrl);
    }
    if (filters.since !== undefined) {
      conditions.push("s.first_timestamp >= ?");
      params.push(filters.since);
    }
    if (filters.until !== undefined) {
      conditions.push("s.first_timestamp < ?");
      params.push(filters.until);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT
        m.model,
        SUM(m.input_tokens) AS input_tokens,
        SUM(m.output_tokens) AS output_tokens,
        SUM(m.cache_read_tokens) AS cache_read_tokens,
        SUM(m.cache_creation_tokens) AS cache_creation_tokens
      FROM messages m
      JOIN sessions s ON m.session_id = s.session_id
      ${where}
      GROUP BY m.model
    `;
    const stmt = this.db.prepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as MessageTotalRow[];
  }

  getSessions(filters: {
    projectPath?: string;
    repoUrl?: string;
    accountUuid?: string;
    entrypoint?: string;
    tag?: string;
    since?: number;
    until?: number;
    includeCI?: boolean;
    includeDeleted?: boolean;
  } = {}): SessionRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.projectPath) {
      conditions.push("project_path = ?");
      params.push(filters.projectPath);
    }
    if (filters.repoUrl) {
      conditions.push("repo_url = ?");
      params.push(filters.repoUrl);
    }
    if (filters.accountUuid) {
      conditions.push("account_uuid = ?");
      params.push(filters.accountUuid);
    }
    if (filters.entrypoint) {
      conditions.push("entrypoint = ?");
      params.push(filters.entrypoint);
    }
    if (filters.tag) {
      conditions.push("session_id IN (SELECT session_id FROM session_tags WHERE tag = ?)");
      params.push(filters.tag);
    }
    if (filters.since !== undefined) {
      conditions.push("first_timestamp >= ?");
      params.push(filters.since);
    }
    if (filters.until !== undefined) {
      conditions.push("first_timestamp < ?");
      params.push(filters.until);
    }
    if (!filters.includeCI) {
      conditions.push("is_interactive = 1");
    }
    if (!filters.includeDeleted) {
      conditions.push("source_deleted = 0");
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const stmt = this.db.prepare(
      `SELECT * FROM sessions ${where} ORDER BY first_timestamp DESC`
    );
    // node:sqlite .all() accepts rest params; cast via unknown to satisfy strict types
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as SessionRow[];
  }

  // ─── Session detail queries ────────────────────────────────────────────────

  findSession(partialId: string): SessionRow | null {
    const stmt = this.db.prepare(
      "SELECT * FROM sessions WHERE session_id LIKE ? LIMIT 2"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (stmt.all as (...args: any[]) => unknown[])(partialId + "%") as SessionRow[];
    if (rows.length === 0) return null;
    if (rows.length > 1) throw new Error(`Ambiguous session ID prefix: ${partialId}`);
    return rows[0]!;
  }

  getSessionMessages(sessionId: string): MessageRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(sessionId) as MessageRow[];
  }

  // ─── Tags ──────────────────────────────────────────────────────────────────

  addTag(sessionId: string, tag: string): void {
    const normalized = validateTag(tag);
    this.db
      .prepare("INSERT OR IGNORE INTO session_tags (session_id, tag, created_at) VALUES (?, ?, ?)")
      .run(sessionId, normalized, Date.now());
  }

  removeTag(sessionId: string, tag: string): void {
    const normalized = validateTag(tag);
    this.db
      .prepare("DELETE FROM session_tags WHERE session_id = ? AND tag = ?")
      .run(sessionId, normalized);
  }

  getTagsForSession(sessionId: string): string[] {
    const stmt = this.db.prepare("SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (stmt.all as (...args: any[]) => unknown[])(sessionId) as Array<{ tag: string }>;
    return rows.map(r => r.tag);
  }

  getTagCounts(): Array<{ tag: string; count: number }> {
    const stmt = this.db.prepare("SELECT tag, COUNT(*) as count FROM session_tags GROUP BY tag ORDER BY count DESC");
    return stmt.all() as Array<{ tag: string; count: number }>;
  }

  getSessionIdsByTag(tag: string): string[] {
    const stmt = this.db.prepare("SELECT session_id FROM session_tags WHERE tag = ?");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (stmt.all as (...args: any[]) => unknown[])(tag) as Array<{ session_id: string }>;
    return rows.map(r => r.session_id);
  }

  // ─── Usage windows ──────────────────────────────────────────────────────────

  upsertUsageWindow(w: UsageWindow): void {
    this.db.prepare(`
      INSERT INTO usage_windows
        (window_start, window_end, account_uuid, total_cost_equivalent, prompt_count, tokens_by_model, throttled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (window_start) DO UPDATE SET
        window_end            = excluded.window_end,
        account_uuid          = COALESCE(excluded.account_uuid, usage_windows.account_uuid),
        total_cost_equivalent = excluded.total_cost_equivalent,
        prompt_count          = excluded.prompt_count,
        tokens_by_model       = excluded.tokens_by_model,
        throttled             = MAX(usage_windows.throttled, excluded.throttled)
    `).run(
      w.windowStart, w.windowEnd, w.accountUuid,
      w.totalCostEquivalent, w.promptCount,
      JSON.stringify(w.tokensByModel), w.throttled ? 1 : 0
    );
  }

  getUsageWindows(filters: { since?: number; until?: number } = {}): UsageWindow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.since !== undefined) {
      conditions.push("window_start >= ?");
      params.push(filters.since);
    }
    if (filters.until !== undefined) {
      conditions.push("window_start < ?");
      params.push(filters.until);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const stmt = this.db.prepare(`SELECT * FROM usage_windows ${where} ORDER BY window_start DESC`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (stmt.all as (...args: any[]) => unknown[])(...params) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      windowStart: r["window_start"] as number,
      windowEnd: r["window_end"] as number,
      accountUuid: r["account_uuid"] as string | null,
      totalCostEquivalent: r["total_cost_equivalent"] as number,
      promptCount: r["prompt_count"] as number,
      tokensByModel: JSON.parse(r["tokens_by_model"] as string) as Record<string, number>,
      throttled: Boolean(r["throttled"]),
    }));
  }

  getCurrentWindow(): UsageWindow | null {
    const row = this.db.prepare(
      "SELECT * FROM usage_windows ORDER BY window_start DESC LIMIT 1"
    ).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      windowStart: row["window_start"] as number,
      windowEnd: row["window_end"] as number,
      accountUuid: row["account_uuid"] as string | null,
      totalCostEquivalent: row["total_cost_equivalent"] as number,
      promptCount: row["prompt_count"] as number,
      tokensByModel: JSON.parse(row["tokens_by_model"] as string) as Record<string, number>,
      throttled: Boolean(row["throttled"]),
    };
  }

  // ─── Per-session message totals (for conversation cost ranking) ─────────────

  /** Returns per-session per-model token totals for the given session IDs. */
  getMessageTotalsBySession(sessionIds: string[]): SessionMessageTotalRow[] {
    if (sessionIds.length === 0) return [];
    // Process in batches of 500 to avoid SQLite variable limit
    const results: SessionMessageTotalRow[] = [];
    for (let i = 0; i < sessionIds.length; i += 500) {
      const batch = sessionIds.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const stmt = this.db.prepare(`
        SELECT session_id, model,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(cache_creation_tokens) AS cache_creation_tokens
        FROM messages
        WHERE session_id IN (${placeholders})
        GROUP BY session_id, model
      `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (stmt.all as (...args: any[]) => unknown[])(...batch) as SessionMessageTotalRow[];
      results.push(...rows);
    }
    return results;
  }

  /** Returns per-message details for model efficiency analysis. */
  getMessagesForEfficiency(filters: {
    projectPath?: string;
    repoUrl?: string;
    since?: number;
  } = {}): EfficiencyMessageRow[] {
    const conditions: string[] = ["m.model IS NOT NULL"];
    const params: unknown[] = [];

    if (filters.projectPath) {
      conditions.push("s.project_path = ?");
      params.push(filters.projectPath);
    }
    if (filters.repoUrl) {
      conditions.push("s.repo_url = ?");
      params.push(filters.repoUrl);
    }
    if (filters.since !== undefined) {
      conditions.push("s.first_timestamp >= ?");
      params.push(filters.since);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT
        m.uuid, m.session_id, m.timestamp, m.model,
        m.input_tokens, m.output_tokens,
        m.cache_read_tokens, m.cache_creation_tokens,
        m.tools, m.thinking_blocks, m.prompt_text
      FROM messages m
      JOIN sessions s ON m.session_id = s.session_id
      ${where}
      ORDER BY m.timestamp ASC
    `;
    const stmt = this.db.prepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as EfficiencyMessageRow[];
  }

  getMessagesForContext(filters: {
    projectPath?: string;
    repoUrl?: string;
    since?: number;
  } = {}): ContextMessageRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.projectPath) {
      conditions.push("s.project_path = ?");
      params.push(filters.projectPath);
    }
    if (filters.repoUrl) {
      conditions.push("s.repo_url = ?");
      params.push(filters.repoUrl);
    }
    if (filters.since !== undefined) {
      conditions.push("s.first_timestamp >= ?");
      params.push(filters.since);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT m.session_id, m.timestamp, m.input_tokens,
             m.cache_read_tokens, m.cache_creation_tokens
      FROM messages m
      JOIN sessions s ON m.session_id = s.session_id
      ${where}
      ORDER BY m.session_id, m.timestamp ASC
    `;
    const stmt = this.db.prepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as ContextMessageRow[];
  }

  getStatus(): StatusInfo {
    let dbSize = 0;
    try { dbSize = fs.statSync(paths.statsDb).size; } catch { /* ok */ }

    const sessionCount = (this.db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;
    const messageCount = (this.db.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c;
    const quarantineCount = (this.db.prepare("SELECT COUNT(*) as c FROM quarantine WHERE reprocessed = 0").get() as { c: number }).c;
    const lastRow = this.db.prepare("SELECT MAX(updated_at) as t FROM collection_state").get() as { t: number | null };

    return { dbSize, sessionCount, messageCount, quarantineCount, lastCollected: lastRow.t };
  }
}

export function validateTag(tag: string): string {
  const normalized = tag.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(normalized)) {
    throw new Error(`Invalid tag "${tag}": use only letters, numbers, dashes, underscores (max 50 chars)`);
  }
  return normalized;
}

export interface SessionRow {
  session_id: string;
  project_path: string;
  source_file: string;
  first_timestamp: number | null;
  last_timestamp: number | null;
  claude_version: string | null;
  entrypoint: string | null;
  git_branch: string | null;
  is_interactive: number;
  prompt_count: number;
  assistant_message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  web_search_requests: number;
  web_fetch_requests: number;
  tool_use_counts: string;
  models: string;
  repo_url: string | null;
  account_uuid: string | null;
  organization_uuid: string | null;
  subscription_type: string | null;
  thinking_blocks: number;
  source_deleted: number;
  throttle_events: number;
  active_duration_ms: number | null;
  median_response_time_ms: number | null;
}

export interface MessageRow {
  uuid: string;
  session_id: string;
  timestamp: number | null;
  claude_version: string | null;
  model: string | null;
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  tools: string; // JSON array
  thinking_blocks: number;
  service_tier: string | null;
  inference_geo: string | null;
  ephemeral_5m_cache_tokens: number;
  ephemeral_1h_cache_tokens: number;
  prompt_text: string | null;
}

export interface SessionMessageTotalRow {
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface MessageTotalRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface EfficiencyMessageRow {
  uuid: string;
  session_id: string;
  timestamp: number | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  tools: string; // JSON array
  thinking_blocks: number;
  prompt_text: string | null;
}

export interface ContextMessageRow {
  session_id: string;
  timestamp: number | null;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface StatusInfo {
  dbSize: number;
  sessionCount: number;
  messageCount: number;
  quarantineCount: number;
  lastCollected: number | null;
}
