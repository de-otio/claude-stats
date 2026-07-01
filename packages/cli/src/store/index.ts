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
import { paths } from "@claude-stats/core/paths";
import type {
  SessionRecord,
  MessageRecord,
  FileCheckpoint,
  SchemaFingerprint,
  ParseError,
  UsageWindow,
  AccountObservation,
  AccountRecord,
} from "@claude-stats/core/types";
import { estimateCost } from "@claude-stats/core/pricing";

const SCHEMA_VERSION = 14;

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
    if (current < 9) this.migrateToV9();
    if (current < 10) this.migrateToV10();
    if (current < 11) this.migrateToV11();
    if (current < 12) this.migrateToV12();
    if (current < 13) this.migrateToV13();
    if (current < 14) this.migrateToV14();

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

  private migrateToV9(): void {
    const addColumn = (table: string, column: string, def: string): void => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    };
    addColumn("sessions", "parent_session_id", "TEXT");
    addColumn("sessions", "is_subagent", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id)`);
  }

  private migrateToV10(): void {
    const addColumn = (table: string, column: string, def: string): void => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    };
    // Dedicated column for file paths extracted from tool_use block.input at parse time.
    // Stored as a JSON array of strings; defaults to '[]' so old rows are still valid.
    addColumn("messages", "file_paths", "TEXT NOT NULL DEFAULT '[]'");
  }

  private migrateToV11(): void {
    const addColumn = (table: string, column: string, def: string): void => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    };
    // Count of tool_result blocks flagged is_error per message (failed tool calls
    // — non-zero Bash exit, failed Edit). Additive; old rows default to 0. Feeds
    // the Phase-B outcome signal; re-collection backfills it from the JSONL.
    addColumn("messages", "tool_error_count", "INTEGER NOT NULL DEFAULT 0");
  }

  private migrateToV12(): void {
    // Persisted hourly rollup of per-message token sums (issue #7). Serves the
    // additive energy/totals reads from O(hours) pre-aggregated rows instead of
    // re-scanning every message. See doc/analysis/startup-performance/05-rollup-design.md.
    //
    // INCLUSION PREDICATE: EXISTS-only — a message contributes iff its session
    // exists in `sessions` (orphan-drop), with NO is_interactive / source_deleted
    // / is_subagent / model filter. This reproduces EXACTLY the raw reads in
    // getMessageTotals / getEnergyAggregates (which filter only via the EXISTS
    // membership subquery). NULL-model rows are stored under model='' so the
    // totals read (counts null-model) sees them; the energy read later filters
    // model!='' to drop them. NULL inference_geo is stored as '' and NULL/absent
    // timestamps land in the hour_utc=-1 sentinel bucket.
    this.db.exec(`
      -- message_hourly is a pure derived cache (rebuilt from messages by the
      -- backfill below), so DROP+CREATE is safe and keeps the schema correct
      -- if this migration's definition evolved before release.
      DROP TABLE IF EXISTS message_hourly;
      CREATE TABLE IF NOT EXISTS message_hourly (
        hour_utc      INTEGER NOT NULL,
        -- project_path/model/inference_geo are stored as their ACTUAL values
        -- including NULL (no '' sentinel): real data has empty-string and NULL
        -- inference_geo as DISTINCT values, so a '' sentinel would conflate
        -- them. SQLite permits NULL in a PRIMARY KEY; the DELETE-by-hour +
        -- GROUP BY recompute (no ON CONFLICT) treats NULL as one group safely.
        project_path  TEXT,
        model         TEXT,
        inference_geo TEXT,
        input_tokens          INTEGER NOT NULL,
        output_tokens         INTEGER NOT NULL,
        cache_read_tokens     INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL,
        th_input_tokens          INTEGER NOT NULL,
        th_output_tokens         INTEGER NOT NULL,
        th_cache_read_tokens     INTEGER NOT NULL,
        th_cache_creation_tokens INTEGER NOT NULL,
        msg_count    INTEGER NOT NULL,
        th_msg_count INTEGER NOT NULL,
        min_ts       INTEGER,
        PRIMARY KEY (hour_utc, project_path, model, inference_geo)
      );
      CREATE INDEX IF NOT EXISTS idx_message_hourly_hour ON message_hourly (hour_utc);
    `);
    // Idempotent one-shot backfill. The leading DELETE inside recomputeMessageHourly
    // (full-rebuild branch) plus IF NOT EXISTS above make a crash-retry safe —
    // a re-run rebuilds from current `messages` rather than double-counting.
    this.recomputeMessageHourly();
  }

  private migrateToV13(): void {
    // Account-attribution foundation (Phase 1). All statements are
    // independently idempotent (migrations run outside a wrapping txn); we open
    // V13's own BEGIN/COMMIT so the schema lands atomically. ZERO backfill —
    // attribution is computed later by the Phase-2 engine.
    const addColumn = (table: string, column: string, def: string): void => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    };

    this.db.exec("BEGIN");
    try {
      // Latest-known metadata per account (one row per account_uuid).
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          account_uuid         TEXT PRIMARY KEY,
          organization_uuid    TEXT,
          email_hash           TEXT,
          email_label          TEXT,
          organization_type    TEXT,
          rate_limit_tier      TEXT,
          user_rate_limit_tier TEXT,
          seat_tier            TEXT,
          billing_type         TEXT,
          subscription_type    TEXT,
          first_observed_at    INTEGER,
          last_observed_at     INTEGER
        );
      `);

      // Append-only log of account activity observations (one row per sighting).
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS account_observations (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          account_uuid    TEXT NOT NULL,
          observed_at     INTEGER NOT NULL,
          source          TEXT NOT NULL,
          surface         TEXT,
          rate_limit_tier TEXT,
          billing_type    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_acct_obs_time ON account_observations (observed_at);
      `);

      // Per-session attribution provenance (filled by the Phase-2 engine).
      addColumn("sessions", "account_source", "TEXT");
      addColumn("sessions", "account_confidence", "TEXT");
      // Per-message account attribution (filled by the Phase-2 engine).
      addColumn("messages", "account_uuid", "TEXT");

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * V14 — anchor pins. Durable, session-keyed ground-truth pins produced by the
   * attribution engine's anchor signal (live CLI sessions observed active under
   * the currently-read account). Persisted because the live-session files are
   * ephemeral, so `reattribute` can re-apply them at the `anchor` precedence
   * long after the session ended. Additive + idempotent (CREATE IF NOT EXISTS),
   * zero backfill.
   */
  private migrateToV14(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS anchor_pins (
        session_id   TEXT PRIMARY KEY,
        account_uuid TEXT NOT NULL,
        observed_at  INTEGER NOT NULL,
        source       TEXT NOT NULL
      );
    `);
  }

  // ─── Rollup recompute (shared: backfill + incremental) ──────────────────────

  /**
   * Recompute message_hourly from the current `messages` table. The SINGLE
   * source of truth for both the migrateToV12 backfill and (Phase 2) the
   * per-collect incremental maintenance, so the two cannot drift.
   *
   * - `hours` omitted → full rebuild: DELETE all rows, INSERT over every hour.
   * - `hours` given → partition recompute: DELETE only those buckets, INSERT
   *   only rows whose hour_utc is in the set. Hours not listed are untouched.
   *
   * The INSERT SELECT inclusion predicate is EXISTS-only (orphan-drop), matching
   * the raw reads exactly. Hour list is bound via parameterized placeholders
   * (one `?` each, like getStopReasonCounts) — never string-interpolated. Runs
   * in a transaction so DELETE+INSERT are atomic.
   */
  recomputeMessageHourly(hours?: number[]): void {
    if (hours && hours.length === 0) return;

    // hour_utc = CAST(m.timestamp/3600000 AS INTEGER); NULL ts -> -1 sentinel.
    const hourExpr = "COALESCE(CAST(m.timestamp / 3600000 AS INTEGER), -1)";
    const placeholders = hours ? hours.map(() => "?").join(",") : "";

    const deleteSql = hours
      ? `DELETE FROM message_hourly WHERE hour_utc IN (${placeholders})`
      : `DELETE FROM message_hourly`;

    const hourFilter = hours ? ` AND ${hourExpr} IN (${placeholders})` : "";
    const insertSql = `
      INSERT INTO message_hourly
      SELECT
        ${hourExpr} AS hour_utc,
        (SELECT project_path FROM sessions s2 WHERE s2.session_id = m.session_id) AS project_path,
        m.model AS model,
        m.inference_geo AS inference_geo,
        SUM(m.input_tokens),
        SUM(m.output_tokens),
        SUM(m.cache_read_tokens),
        SUM(m.cache_creation_tokens),
        SUM(CASE WHEN m.thinking_blocks > 0 THEN m.input_tokens ELSE 0 END),
        SUM(CASE WHEN m.thinking_blocks > 0 THEN m.output_tokens ELSE 0 END),
        SUM(CASE WHEN m.thinking_blocks > 0 THEN m.cache_read_tokens ELSE 0 END),
        SUM(CASE WHEN m.thinking_blocks > 0 THEN m.cache_creation_tokens ELSE 0 END),
        COUNT(*),
        SUM(CASE WHEN m.thinking_blocks > 0 THEN 1 ELSE 0 END),
        MIN(m.timestamp)
      FROM messages m
      WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = m.session_id)${hourFilter}
      GROUP BY hour_utc, project_path, model, inference_geo
    `;

    this.transaction(() => {
      if (hours) {
        const del = this.db.prepare(deleteSql);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (del.run as (...args: any[]) => unknown)(...hours);
        const ins = this.db.prepare(insertSql);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ins.run as (...args: any[]) => unknown)(...hours);
      } else {
        this.db.exec(deleteSql);
        this.db.prepare(insertSql).run();
      }
      // Freshness watermark: the messages-table row count this rollup was last
      // built/maintained against. The read dispatcher uses the rollup only when
      // this still matches the current count (else falls back to the raw seek).
      // collect() recomputes every touched hour and then this runs, so after a
      // collect the watermark equals the current count and the rollup is fresh.
      // Direct upsertMessages that bypass a recompute (e.g. tests) leave the
      // count ahead of the watermark, so reads correctly fall back to raw.
      this.db
        .prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('message_hourly_watermark', (SELECT CAST(COUNT(*) AS TEXT) FROM messages))")
        .run();
    });
  }

  /**
   * True when message_hourly is in sync with the messages table — i.e. the
   * recorded watermark equals the current message count. Cheap (two counts),
   * and the guard that lets the unbounded read dispatch to the rollup safely.
   */
  private isMessageHourlyFresh(): boolean {
    const wm = this.db
      .prepare("SELECT value FROM metadata WHERE key = 'message_hourly_watermark'")
      .get() as { value: string } | undefined;
    if (!wm) return false;
    const cur = this.db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number };
    return Number(wm.value) === cur.c;
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
        parent_session_id, is_subagent,
        source_deleted, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        parent_session_id       = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
        is_subagent             = MAX(sessions.is_subagent, excluded.is_subagent),
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
      record.parentSessionId,
      record.isSubagent ? 1 : 0,
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
        parent_session_id, is_subagent,
        source_deleted, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        parent_session_id       = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
        is_subagent             = MAX(sessions.is_subagent, excluded.is_subagent),
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
      record.parentSessionId,
      record.isSubagent ? 1 : 0,
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
        tools, file_paths, thinking_blocks,
        service_tier, inference_geo, ephemeral_5m_cache_tokens, ephemeral_1h_cache_tokens,
        prompt_text, tool_error_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (uuid) DO UPDATE SET
        model                       = excluded.model,
        input_tokens                = excluded.input_tokens,
        output_tokens               = excluded.output_tokens,
        cache_creation_tokens       = excluded.cache_creation_tokens,
        cache_read_tokens           = excluded.cache_read_tokens,
        tools                       = excluded.tools,
        file_paths                  = COALESCE(excluded.file_paths, messages.file_paths),
        thinking_blocks             = excluded.thinking_blocks,
        service_tier                = excluded.service_tier,
        inference_geo               = excluded.inference_geo,
        ephemeral_5m_cache_tokens   = excluded.ephemeral_5m_cache_tokens,
        ephemeral_1h_cache_tokens   = excluded.ephemeral_1h_cache_tokens,
        prompt_text                 = COALESCE(excluded.prompt_text, messages.prompt_text),
        tool_error_count            = excluded.tool_error_count
    `);
    for (const r of records) {
      stmt.run(
        r.uuid, r.sessionId, r.timestamp, r.claudeVersion,
        r.model, r.stopReason, r.inputTokens, r.outputTokens,
        r.cacheCreationTokens, r.cacheReadTokens,
        JSON.stringify(r.tools), JSON.stringify(r.filePaths ?? []),
        r.thinkingBlocks,
        r.serviceTier, r.inferenceGeo, r.ephemeral5mCacheTokens, r.ephemeral1hCacheTokens,
        r.promptText ?? null, r.toolErrorCount ?? 0
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

  // ─── Account attribution (Phase 1 foundation) ───────────────────────────────

  /** Append one observation of an account being active (append-only log). */
  recordAccountObservation(obs: AccountObservation): void {
    this.db.prepare(`
      INSERT INTO account_observations
        (account_uuid, observed_at, source, surface, rate_limit_tier, billing_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      obs.accountUuid,
      obs.observedAt,
      obs.source,
      obs.surface,
      obs.rateLimitTier,
      obs.billingType,
    );
  }

  /**
   * Read observations ordered by observed_at ascending. When `surface` is
   * given, only observations for that surface are returned.
   */
  getAccountObservations(surface?: string): AccountObservation[] {
    const where = surface !== undefined ? "WHERE surface = ?" : "";
    const params: unknown[] = surface !== undefined ? [surface] : [];
    const stmt = this.db.prepare(`
      SELECT account_uuid, observed_at, source, surface, rate_limit_tier, billing_type
      FROM account_observations
      ${where}
      ORDER BY observed_at ASC
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (stmt.all as (...args: any[]) => unknown[])(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      accountUuid: r["account_uuid"] as string,
      observedAt: r["observed_at"] as number,
      source: r["source"] as string,
      surface: r["surface"] as string | null,
      rateLimitTier: r["rate_limit_tier"] as string | null,
      billingType: r["billing_type"] as string | null,
    }));
  }

  /**
   * Record (upsert) an anchor pin — durable, session-keyed ground truth that a
   * session belonged to an account (V14). One row per session; a later pin with
   * a `observed_at` at/after the stored one refreshes it (an older sighting
   * never overwrites a newer one). Produced by the live-session anchor writer
   * during `collect`; consumed by the attribution engine at `anchor` precedence.
   */
  recordAnchorPin(pin: {
    sessionId: string;
    accountUuid: string;
    observedAt: number;
    source: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO anchor_pins (session_id, account_uuid, observed_at, source)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET
          account_uuid = excluded.account_uuid,
          observed_at  = excluded.observed_at,
          source       = excluded.source
        WHERE excluded.observed_at >= anchor_pins.observed_at
      `)
      .run(pin.sessionId, pin.accountUuid, pin.observedAt, pin.source);
  }

  /** Load all anchor pins as sessionId → {accountUuid, observedAt, source}. */
  getAnchorPins(): Map<string, { accountUuid: string; observedAt: number; source: string }> {
    const rows = this.db
      .prepare("SELECT session_id, account_uuid, observed_at, source FROM anchor_pins")
      .all() as Array<Record<string, unknown>>;
    const map = new Map<string, { accountUuid: string; observedAt: number; source: string }>();
    for (const r of rows) {
      map.set(r["session_id"] as string, {
        accountUuid: r["account_uuid"] as string,
        observedAt: r["observed_at"] as number,
        source: r["source"] as string,
      });
    }
    return map;
  }

  /**
   * Upsert an account row, refreshing last_observed_at and the tier/billing
   * metadata. first_observed_at is set on insert and never moved backwards;
   * COALESCE keeps an existing non-null value when the incoming field is null.
   */
  upsertAccount(a: AccountRecord): void {
    this.db.prepare(`
      INSERT INTO accounts (
        account_uuid, organization_uuid, email_hash, email_label,
        organization_type, rate_limit_tier, user_rate_limit_tier, seat_tier,
        billing_type, subscription_type, first_observed_at, last_observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_uuid) DO UPDATE SET
        organization_uuid    = COALESCE(excluded.organization_uuid, accounts.organization_uuid),
        email_hash           = COALESCE(excluded.email_hash, accounts.email_hash),
        email_label          = COALESCE(excluded.email_label, accounts.email_label),
        organization_type    = COALESCE(excluded.organization_type, accounts.organization_type),
        rate_limit_tier      = COALESCE(excluded.rate_limit_tier, accounts.rate_limit_tier),
        user_rate_limit_tier = COALESCE(excluded.user_rate_limit_tier, accounts.user_rate_limit_tier),
        seat_tier            = COALESCE(excluded.seat_tier, accounts.seat_tier),
        billing_type         = COALESCE(excluded.billing_type, accounts.billing_type),
        subscription_type    = COALESCE(excluded.subscription_type, accounts.subscription_type),
        first_observed_at    = MIN(
                                 COALESCE(accounts.first_observed_at, excluded.first_observed_at),
                                 COALESCE(excluded.first_observed_at, accounts.first_observed_at)
                               ),
        last_observed_at     = MAX(
                                 COALESCE(accounts.last_observed_at, excluded.last_observed_at),
                                 COALESCE(excluded.last_observed_at, accounts.last_observed_at)
                               )
    `).run(
      a.accountUuid,
      a.organizationUuid,
      a.emailHash,
      a.emailLabel,
      a.organizationType,
      a.rateLimitTier,
      a.userRateLimitTier,
      a.seatTier,
      a.billingType,
      a.subscriptionType,
      a.firstObservedAt,
      a.lastObservedAt,
    );
  }

  /** All rows from the accounts table. */
  listAccountsFull(): AccountRecord[] {
    const stmt = this.db.prepare(`
      SELECT account_uuid, organization_uuid, email_hash, email_label,
             organization_type, rate_limit_tier, user_rate_limit_tier, seat_tier,
             billing_type, subscription_type, first_observed_at, last_observed_at
      FROM accounts
      ORDER BY last_observed_at DESC
    `);
    const rows = stmt.all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      accountUuid: r["account_uuid"] as string,
      organizationUuid: r["organization_uuid"] as string | null,
      emailHash: r["email_hash"] as string | null,
      emailLabel: r["email_label"] as string | null,
      organizationType: r["organization_type"] as string | null,
      rateLimitTier: r["rate_limit_tier"] as string | null,
      userRateLimitTier: r["user_rate_limit_tier"] as string | null,
      seatTier: r["seat_tier"] as string | null,
      billingType: r["billing_type"] as string | null,
      subscriptionType: r["subscription_type"] as string | null,
      firstObservedAt: r["first_observed_at"] as number | null,
      lastObservedAt: r["last_observed_at"] as number | null,
    }));
  }

  /**
   * Re-attribution reset (plan §4, B1). Clears account attribution on rows
   * that were never authoritatively attributed (NULL source = pre-V13 / blind
   * fallback) or only weakly guessed (low/medium confidence). NEVER touches
   * rows whose source is otel/telemetry/anchor/override. Returns rows changed.
   */
  resetAttributableSessions(): number {
    const result = this.db.prepare(`
      UPDATE sessions SET
        account_uuid       = NULL,
        organization_uuid  = NULL,
        account_source     = NULL,
        account_confidence = NULL
      WHERE account_source IS NULL
         OR account_source NOT IN ('override', 'otel', 'telemetry', 'anchor')
    `).run();
    return Number(result.changes);
  }

  /**
   * Apply a computed attribution mapping to sessions. Monotonic: a row is only
   * updated when it is currently unattributed or weakly attributed
   * (account_uuid IS NULL OR account_source IS NULL OR confidence in low/medium)
   * AND its existing source is not one of the strong sources
   * (override/otel/telemetry/anchor) — so a stronger source is never overwritten
   * by a later, weaker assignment. Parameterized; clock injected via `now`.
   * Returns the number of rows changed.
   */
  applyAttribution(
    mapping: Map<string, { accountUuid: string; organizationUuid: string | null; subscriptionType: string | null; source: string; confidence: string }>,
    now: () => number,
  ): number {
    const stmt = this.db.prepare(`
      UPDATE sessions SET
        account_uuid       = ?,
        organization_uuid  = ?,
        subscription_type  = COALESCE(?, subscription_type),
        account_source     = ?,
        account_confidence = ?,
        updated_at         = ?
      WHERE session_id = ?
        AND (account_uuid IS NULL OR account_source IS NULL OR account_confidence IN ('low', 'medium'))
        AND (account_source IS NULL OR account_source NOT IN ('override', 'otel', 'telemetry', 'anchor'))
    `);
    let changed = 0;
    for (const [sessionId, info] of mapping) {
      const result = stmt.run(
        info.accountUuid,
        info.organizationUuid,
        info.subscriptionType,
        info.source,
        info.confidence,
        now(),
        sessionId,
      );
      if (result.changes > 0) changed++;
    }
    return changed;
  }

  /**
   * Clear per-message straddle attribution (messages.account_uuid). Message-
   * level account_uuid is produced ONLY by the attribution engine's straddle
   * path — nothing else writes it — so a full re-attribution can safely clear it
   * all and re-derive from the freshly computed overrides. Returns rows changed.
   */
  resetMessageAttribution(): number {
    const result = this.db
      .prepare("UPDATE messages SET account_uuid = NULL WHERE account_uuid IS NOT NULL")
      .run();
    return Number(result.changes);
  }

  /**
   * Persist per-message straddle splits onto messages.account_uuid. Each
   * override stamps the messages of one session whose timestamp falls in the
   * half-open range [boundaryFrom, boundaryTo) with that range's account. The
   * ranges mirror disjoint CLI intervals, so within a session they never
   * overlap — application is order-independent and no message is stamped twice,
   * so the returned count is the exact number of distinct messages stamped.
   * Null-timestamp messages never match and keep the session-level account.
   * `boundaryTo === Infinity` means the still-open final interval (no upper
   * bound). The override shape is inlined (not imported from ../attribution) to
   * keep the store free of a store→attribution dependency cycle.
   */
  applyMessageOverrides(
    overrides: Array<{
      sessionId: string;
      boundaryFrom: number;
      boundaryTo: number;
      accountUuid: string;
    }>,
  ): number {
    if (overrides.length === 0) return 0;
    const bounded = this.db.prepare(
      `UPDATE messages SET account_uuid = ?
         WHERE session_id = ? AND timestamp IS NOT NULL
           AND timestamp >= ? AND timestamp < ?`,
    );
    const open = this.db.prepare(
      `UPDATE messages SET account_uuid = ?
         WHERE session_id = ? AND timestamp IS NOT NULL AND timestamp >= ?`,
    );
    let changed = 0;
    for (const o of overrides) {
      const result = Number.isFinite(o.boundaryTo)
        ? bounded.run(o.accountUuid, o.sessionId, o.boundaryFrom, o.boundaryTo)
        : open.run(o.accountUuid, o.sessionId, o.boundaryFrom);
      changed += Number(result.changes);
    }
    return changed;
  }

  /**
   * Delete and recompute usage_windows whose window_start falls in
   * [since, until]. Used by re-attribution so windows reflect corrected
   * session accounts over the affected range (the incremental collect path
   * uses computeAndUpsertWindows). Runs in one transaction.
   */
  recomputeWindowsInRange(since: number, until: number): void {
    this.transaction(() => {
      this.db
        .prepare("DELETE FROM usage_windows WHERE window_start >= ? AND window_start <= ?")
        .run(since, until);
      // Recompute from sessions whose first_timestamp is in range. Reuses the
      // same greedy 5-hour grouping as the aggregator's computeAndUpsertWindows.
      const windows = this.computeWindowsSince(since, until);
      for (const w of windows) {
        this.upsertUsageWindow(w);
      }
    });
  }

  /**
   * Pure-ish window computation shared with recomputeWindowsInRange: greedy
   * 5-hour grouping of sessions whose first_timestamp is in [since, until].
   * Mirrors the aggregator's computeAndUpsertWindows algorithm exactly.
   */
  private computeWindowsSince(since: number, until: number): UsageWindow[] {
    const WINDOW_DURATION_MS = 5 * 60 * 60 * 1000; // 5 hours
    const sessions = this.getSessions({ since, until, includeCI: true, includeDeleted: true });
    const sorted = sessions
      .filter((s) => s.first_timestamp != null)
      .sort((a, b) => a.first_timestamp! - b.first_timestamp!);
    if (sorted.length === 0) return [];

    const sessionIds = sorted.map((s) => s.session_id);
    const msgTotals = this.getMessageTotalsBySession(sessionIds);
    const sessionCostMap = new Map<string, { cost: number; tokensByModel: Record<string, number> }>();
    for (const row of msgTotals) {
      const entry = sessionCostMap.get(row.session_id) ?? { cost: 0, tokensByModel: {} };
      const { cost } = estimateCost(row.model, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_creation_tokens);
      entry.cost += cost;
      entry.tokensByModel[row.model] = (entry.tokensByModel[row.model] ?? 0) + row.input_tokens + row.output_tokens;
      sessionCostMap.set(row.session_id, entry);
    }

    const windows: UsageWindow[] = [];
    let windowStart: number | null = null;
    let currentWindow: UsageWindow | null = null;
    for (const session of sorted) {
      const ts = session.first_timestamp!;
      if (windowStart === null || ts >= windowStart + WINDOW_DURATION_MS) {
        windowStart = ts;
        currentWindow = {
          windowStart: ts,
          windowEnd: ts + WINDOW_DURATION_MS,
          accountUuid: session.account_uuid,
          totalCostEquivalent: 0,
          promptCount: 0,
          tokensByModel: {},
          throttled: false,
        };
        windows.push(currentWindow);
      }
      const costs = sessionCostMap.get(session.session_id);
      if (costs) {
        currentWindow!.totalCostEquivalent += costs.cost;
        for (const [model, tokens] of Object.entries(costs.tokensByModel)) {
          currentWindow!.tokensByModel[model] = (currentWindow!.tokensByModel[model] ?? 0) + tokens;
        }
      }
      currentWindow!.promptCount += session.prompt_count;
      if (session.throttle_events > 0) currentWindow!.throttled = true;
    }
    for (const w of windows) {
      w.totalCostEquivalent = Math.round(w.totalCostEquivalent * 10000) / 10000;
    }
    return windows;
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

  /**
   * Per-model token totals. Dispatches to a rollup read when the request is
   * FULLY UNBOUNDED (no period and no session-scoped filter) — the 'all'-period
   * fast path, since period 'all' reaches the store with since===undefined.
   * Any bound (since/until/projectPath/repoUrl) falls back to the Build-1 seek
   * path (getMessageTotalsRaw), which is unchanged.
   */
  getMessageTotals(filters: {
    projectPath?: string;
    repoUrl?: string;
    since?: number;
    until?: number;
  } = {}): MessageTotalRow[] {
    const fullyUnbounded =
      filters.since === undefined &&
      filters.until === undefined &&
      !filters.projectPath &&
      !filters.repoUrl;
    if (fullyUnbounded && this.isMessageHourlyFresh()) return this.getMessageTotalsFromRollup();
    return this.getMessageTotalsRaw(filters);
  }

  /**
   * 'all'-period fast path: reproduce getMessageTotalsRaw({}) EXACTLY from the
   * message_hourly rollup. Sums every bucket per model; model is stored as its
   * actual value (null-model messages keep model NULL), matching raw's
   * GROUP BY m.model which returns model:null for null-model messages.
   */
  private getMessageTotalsFromRollup(): MessageTotalRow[] {
    const stmt = this.db.prepare(`
      SELECT
        model,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens
      FROM message_hourly
      GROUP BY model
    `);
    return stmt.all() as unknown as MessageTotalRow[];
  }

  private getMessageTotalsRaw(filters: {
    projectPath?: string;
    repoUrl?: string;
    since?: number;
    until?: number;
  } = {}): MessageTotalRow[] {
    // Period is filtered on the MESSAGE timestamp (messages SENT in the period),
    // which seeks idx_messages_timestamp. Session-scoped filters (project/repo)
    // stay in an always-emitted membership subquery — this preserves the prior
    // inner join's orphan-message drop (a message whose session_id is absent
    // from `sessions` matches neither form). Outer (m.timestamp) params are
    // bound before the subquery params to match the `?` order in the SQL.
    const outerConditions: string[] = [];
    const sessionConditions: string[] = [];
    const params: unknown[] = [];

    if (filters.since !== undefined) {
      outerConditions.push("m.timestamp >= ?");
      params.push(filters.since);
    }
    if (filters.until !== undefined) {
      outerConditions.push("m.timestamp < ?");
      params.push(filters.until);
    }
    if (filters.projectPath) {
      sessionConditions.push("s.project_path = ?");
      params.push(filters.projectPath);
    }
    if (filters.repoUrl) {
      sessionConditions.push("s.repo_url = ?");
      params.push(filters.repoUrl);
    }

    // EXISTS (not IN): preserves orphan-drop AND lets the m.timestamp filter
    // seek idx_messages_timestamp. An `IN (SELECT all session_ids)` would make
    // the planner iterate every session_id via idx_messages_session instead,
    // defeating the timestamp seek.
    const sessionAnd = sessionConditions.length ? ` AND ${sessionConditions.join(" AND ")}` : "";
    const outerWhere = outerConditions.length ? `${outerConditions.join(" AND ")} AND ` : "";
    const sql = `
      SELECT
        m.model,
        SUM(m.input_tokens) AS input_tokens,
        SUM(m.output_tokens) AS output_tokens,
        SUM(m.cache_read_tokens) AS cache_read_tokens,
        SUM(m.cache_creation_tokens) AS cache_creation_tokens
      FROM messages m
      WHERE ${outerWhere}EXISTS (
        SELECT 1 FROM sessions s WHERE s.session_id = m.session_id${sessionAnd}
      )
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
    /**
     * Include sessions that were ACTIVE at/after this epoch-ms — i.e. their last
     * message lands in the period even if the session STARTED before it. Filters
     * on `COALESCE(last_timestamp, first_timestamp) >= activeSince`, so a session
     * straddling the period boundary (e.g. one running across midnight) is
     * counted. Use this instead of `since` when the count must agree with
     * message-timestamp-filtered metrics (cost/energy). Mutually complementary
     * with `since` (start-in-period); pass one or the other, not both.
     */
    activeSince?: number;
    until?: number;
    includeCI?: boolean;
    includeDeleted?: boolean;
    /** When false, exclude subagent sessions (is_subagent=1). Defaults to
     *  including them, preserving prior behaviour for existing callers. */
    includeSubagents?: boolean;
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
    if (filters.activeSince !== undefined) {
      // Session overlaps [activeSince, ∞): its last activity is at/after the
      // period start. COALESCE so sessions with a null last_timestamp fall back
      // to their start time rather than being dropped.
      conditions.push("COALESCE(last_timestamp, first_timestamp) >= ?");
      params.push(filters.activeSince);
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
    if (filters.includeSubagents === false) {
      conditions.push("(is_subagent = 0 OR is_subagent IS NULL)");
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const stmt = this.db.prepare(
      `SELECT * FROM sessions ${where} ORDER BY first_timestamp DESC`
    );
    // node:sqlite .all() accepts rest params; cast via unknown to satisfy strict types
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as SessionRow[];
  }

  /**
   * Distinct accounts present in the session store, with the most-recent
   * subscription_type and session count for each. Used to populate the
   * dashboard's account selector independent of the current account filter.
   */
  listAccounts(filters: { since?: number; until?: number; includeCI?: boolean } = {}): Array<{
    accountUuid: string;
    subscriptionType: string | null;
    sessionCount: number;
  }> {
    const conditions: string[] = ["account_uuid IS NOT NULL", "source_deleted = 0"];
    const params: unknown[] = [];
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
    const where = `WHERE ${conditions.join(" AND ")}`;
    const stmt = this.db.prepare(`
      SELECT account_uuid AS accountUuid,
             MAX(subscription_type) AS subscriptionType,
             COUNT(*) AS sessionCount
      FROM sessions
      ${where}
      GROUP BY account_uuid
      ORDER BY sessionCount DESC
    `);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as Array<{
      accountUuid: string;
      subscriptionType: string | null;
      sessionCount: number;
    }>;
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

  /**
   * Per-session MAX(uuid) over messages whose timestamp is in [startMs, endMs),
   * for the given session ids. Used by the recap snapshot-hash to compute
   * per-session and global last-message-uuid WITHOUT fetching every message row
   * (the full rows are only needed on a cache miss). Sessions with no in-window
   * message are simply absent from the result (caller defaults them to null).
   */
  getMaxMessageUuidsInWindow(
    sessionIds: string[],
    startMs: number,
    endMs: number,
  ): Array<{ session_id: string; max_uuid: string }> {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => "?").join(",");
    const stmt = this.db.prepare(
      `SELECT session_id, MAX(uuid) AS max_uuid
       FROM messages
       WHERE session_id IN (${placeholders})
         AND timestamp >= ? AND timestamp < ?
       GROUP BY session_id`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(
      ...sessionIds, startMs, endMs,
    ) as Array<{ session_id: string; max_uuid: string }>;
  }

  /**
   * Returns all message timestamps (ms since epoch) for sessions matching the
   * provided filters, sorted ascending. Used to compute active interaction time
   * by merging timestamps across parallel sessions before measuring gaps.
   */
  getMessageTimestamps(filters: {
    projectPath?: string;
    repoUrl?: string;
    accountUuid?: string;
    since?: number;
  } = {}): number[] {
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
    if (filters.accountUuid) {
      conditions.push("s.account_uuid = ?");
      params.push(filters.accountUuid);
    }
    if (filters.since !== undefined) {
      conditions.push("m.timestamp >= ?");
      params.push(filters.since);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT m.timestamp AS ts
      FROM messages m
      JOIN sessions s ON m.session_id = s.session_id
      ${where}
      ORDER BY m.timestamp ASC
    `;
    const stmt = this.db.prepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (stmt.all as (...args: any[]) => unknown[])(...params) as Array<{ ts: number }>;
    return rows.map(r => r.ts);
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

  /**
   * Returns per-message cost inputs (model + token columns) for the given
   * message UUIDs, batched ≤500 to stay under the SQLite variable limit.
   * Used to attribute task cost to exactly the messages in a task's segments
   * (rather than every message in a contributing session).
   */
  getMessageCostInputsByUuids(uuids: string[]): MessageCostInputRow[] {
    if (uuids.length === 0) return [];
    const results: MessageCostInputRow[] = [];
    for (let i = 0; i < uuids.length; i += 500) {
      const batch = uuids.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      const stmt = this.db.prepare(`
        SELECT uuid, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
        FROM messages
        WHERE uuid IN (${placeholders})
      `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (stmt.all as (...args: any[]) => unknown[])(...batch) as MessageCostInputRow[];
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
    // Period is filtered on the MESSAGE timestamp (messages SENT in the
    // period); session-scoped filters stay in an always-emitted membership
    // subquery, preserving the prior inner join's orphan-message drop (see
    // getMessageTotals). Param order follows the `?` order in the SQL.
    const conditions: string[] = ["m.model IS NOT NULL"];
    const sessionConditions: string[] = [];
    const params: unknown[] = [];

    if (filters.since !== undefined) {
      conditions.push("m.timestamp >= ?");
      params.push(filters.since);
    }
    if (filters.projectPath) {
      sessionConditions.push("s.project_path = ?");
      params.push(filters.projectPath);
    }
    if (filters.repoUrl) {
      sessionConditions.push("s.repo_url = ?");
      params.push(filters.repoUrl);
    }

    // EXISTS preserves orphan-drop while letting the m.timestamp filter seek
    // (see getMessageTotals).
    const sessionAnd = sessionConditions.length ? ` AND ${sessionConditions.join(" AND ")}` : "";
    conditions.push(`EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = m.session_id${sessionAnd})`);
    const where = `WHERE ${conditions.join(" AND ")}`;
    const sql = `
      SELECT
        m.uuid, m.session_id, m.timestamp, m.model,
        m.input_tokens, m.output_tokens,
        m.cache_read_tokens, m.cache_creation_tokens,
        m.tools, m.thinking_blocks, m.prompt_text
      FROM messages m
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
    // Period is filtered on the MESSAGE timestamp; session-scoped filters stay
    // in an always-emitted membership subquery, preserving orphan-drop (see
    // getMessageTotals). Param order follows the `?` order in the SQL.
    const outerConditions: string[] = [];
    const sessionConditions: string[] = [];
    const params: unknown[] = [];

    if (filters.since !== undefined) {
      outerConditions.push("m.timestamp >= ?");
      params.push(filters.since);
    }
    if (filters.projectPath) {
      sessionConditions.push("s.project_path = ?");
      params.push(filters.projectPath);
    }
    if (filters.repoUrl) {
      sessionConditions.push("s.repo_url = ?");
      params.push(filters.repoUrl);
    }

    // EXISTS preserves orphan-drop while letting the m.timestamp filter seek
    // (see getMessageTotals).
    const sessionAnd = sessionConditions.length ? ` AND ${sessionConditions.join(" AND ")}` : "";
    const outerWhere = outerConditions.length ? `${outerConditions.join(" AND ")} AND ` : "";
    const sql = `
      SELECT m.session_id, m.timestamp, m.input_tokens,
             m.cache_read_tokens, m.cache_creation_tokens
      FROM messages m
      WHERE ${outerWhere}EXISTS (
        SELECT 1 FROM sessions s WHERE s.session_id = m.session_id${sessionAnd}
      )
      ORDER BY m.session_id, m.timestamp ASC
    `;
    const stmt = this.db.prepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as ContextMessageRow[];
  }

  /**
   * Build the message-level seek WHERE clause + params shared by every energy
   * aggregation query. Uses the same `m.session_id IN (SELECT session_id FROM
   * sessions WHERE <session filters>)` membership subquery as
   * getMessagesForEnergy, so each aggregate is O(period), not O(all messages).
   */
  private energyAggregateWhere(filters: {
    projectPath?: string;
    repoUrl?: string;
    accountUuid?: string;
    since?: number;
  }): { where: string; params: unknown[] } {
    // Period filtered on MESSAGE timestamp; session-scoped filters in an
    // always-emitted membership subquery (orphan-drop preserved). The since
    // param is bound before the subquery params to match the `?` order.
    const sessionConditions: string[] = [];
    const params: unknown[] = [];
    const tsClause = filters.since !== undefined ? "AND m.timestamp >= ? " : "";
    if (filters.since !== undefined) { params.push(filters.since); }
    if (filters.projectPath) { sessionConditions.push("s.project_path = ?"); params.push(filters.projectPath); }
    if (filters.repoUrl) { sessionConditions.push("s.repo_url = ?"); params.push(filters.repoUrl); }
    if (filters.accountUuid) { sessionConditions.push("s.account_uuid = ?"); params.push(filters.accountUuid); }
    // EXISTS preserves orphan-drop while letting the m.timestamp filter seek
    // (see getMessageTotals).
    const sessionAnd = sessionConditions.length ? ` AND ${sessionConditions.join(" AND ")}` : "";
    const where = `WHERE m.model IS NOT NULL ${tsClause}AND EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = m.session_id${sessionAnd})`;
    return { where, params };
  }

  /**
   * In-DB aggregations for the energy dashboard section. Replaces the
   * per-message loop in buildEnergySection with GROUP BY rollups that are
   * exact (to display-rounding precision) because estimateEnergy is linear in
   * the four token counts at fixed per-model-class rates and a fixed
   * section-level {region, gridIntensity}.
   *
   * All sub-queries share the same session-id membership seek (energyAggregateWhere)
   * so the whole section is O(period).
   */
  /**
   * Dispatcher: FULLY UNBOUNDED requests (no period, no session-scoped filter)
   * read the message_hourly rollup ('all'-period fast path); any bound falls
   * back to the Build-1 seek path (getEnergyAggregatesRaw), unchanged.
   */
  getEnergyAggregates(filters: {
    projectPath?: string;
    repoUrl?: string;
    accountUuid?: string;
    since?: number;
  } = {}): EnergyAggregates {
    const fullyUnbounded =
      filters.since === undefined &&
      !filters.projectPath &&
      !filters.repoUrl &&
      !filters.accountUuid;
    if (fullyUnbounded && this.isMessageHourlyFresh()) return this.getEnergyAggregatesFromRollup();
    return this.getEnergyAggregatesRaw(filters);
  }

  /**
   * 'all'-period fast path: reproduce getEnergyAggregatesRaw({}) EXACTLY from
   * message_hourly. Energy excludes null-model messages (the raw WHERE has
   * `m.model IS NOT NULL`), so every aggregate filters `model IS NOT NULL`.
   * model and inference_geo are stored as their ACTUAL values (incl. NULL —
   * no '' sentinel, since real data has empty-string AND null geo as distinct
   * values). Null-timestamp messages bucket at hour_utc = -1 (mapped back to a
   * NULL hour_bucket in byHourModel). thinkingSessions (distinct
   * session_id) is NOT additive, so it runs the same live COUNT(DISTINCT) query
   * getEnergyAggregatesRaw uses.
   */
  private getEnergyAggregatesFromRollup(): EnergyAggregates {
    // 1. byModel — per-model token sums + msg_count; MIN(min_ts) as the
    //    first-seen tiebreak. model='' (null-model) excluded.
    const byModel = this.db.prepare(`
      SELECT model AS model,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(cache_creation_tokens) AS cache_creation_tokens,
             SUM(msg_count) AS msgs,
             MIN(min_ts) AS min_ts
      FROM message_hourly
      WHERE model IS NOT NULL
      GROUP BY model
    `).all() as unknown as EnergyModelAgg[];

    // 2. byProjectModel — GROUP BY project_path, model (model='' excluded).
    const byProjectModel = this.db.prepare(`
      SELECT project_path AS project_path,
             model AS model,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(cache_creation_tokens) AS cache_creation_tokens,
             MIN(min_ts) AS min_ts
      FROM message_hourly
      WHERE model IS NOT NULL
      GROUP BY project_path, model
    `).all() as unknown as EnergyProjectModelAgg[];

    // 3. byHourModel — GROUP BY hour_utc, model; hour_utc=-1 (null-timestamp
    //    sentinel) maps back to a NULL hour_bucket (raw used NULL).
    const byHourModelRows = this.db.prepare(`
      SELECT hour_utc AS hour_utc,
             model AS model,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(cache_creation_tokens) AS cache_creation_tokens
      FROM message_hourly
      WHERE model IS NOT NULL
      GROUP BY hour_utc, model
    `).all() as Array<Omit<EnergyHourModelAgg, "hour_bucket"> & { hour_utc: number }>;
    const byHourModel: EnergyHourModelAgg[] = byHourModelRows.map(({ hour_utc, ...rest }) => ({
      ...rest,
      hour_bucket: hour_utc === -1 ? null : hour_utc,
    }));

    // 4. byGeo — GROUP BY inference_geo, SUM(msg_count). inference_geo is stored
    //    as its actual value (incl. NULL and ''), matching raw's GROUP BY
    //    m.inference_geo. model NULL excluded (raw byGeo is over the
    //    model-not-null energy WHERE).
    const byGeo = this.db.prepare(`
      SELECT inference_geo AS inference_geo, SUM(msg_count) AS msgs
      FROM message_hourly
      WHERE model IS NOT NULL
      GROUP BY inference_geo
    `).all() as unknown as EnergyGeoAgg[];

    // 5. geoByEarliest — distinct non-null geos with earliest min_ts, ASC.
    const geoByEarliest = this.db.prepare(`
      SELECT inference_geo AS inference_geo, MIN(min_ts) AS min_ts
      FROM message_hourly
      WHERE model IS NOT NULL AND inference_geo IS NOT NULL AND min_ts IS NOT NULL
      GROUP BY inference_geo
      ORDER BY min_ts ASC
    `).all() as Array<{ inference_geo: string; min_ts: number }>;

    // 6a. thinkingSessions — distinct session_id is NOT additive in the rollup,
    //     so run the SAME live query getEnergyAggregatesRaw uses.
    const { where, params } = this.energyAggregateWhere({});
    const thinkingSessionsRow = (() => {
      const stmt = this.db.prepare(`
        SELECT COUNT(DISTINCT m.session_id) AS c
        FROM messages m
        ${where} AND m.thinking_blocks > 0
      `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (stmt.get as (...args: any[]) => unknown)(...params) as { c: number } | undefined;
    })();

    // 6b. thinkingByModel — th_* columns as the token sums, th_msg_count as
    //     msgs; only buckets with thinking messages (th_msg_count > 0).
    const thinkingByModel = this.db.prepare(`
      SELECT model AS model,
             SUM(th_input_tokens) AS input_tokens,
             SUM(th_output_tokens) AS output_tokens,
             SUM(th_cache_read_tokens) AS cache_read_tokens,
             SUM(th_cache_creation_tokens) AS cache_creation_tokens,
             SUM(th_msg_count) AS msgs
      FROM message_hourly
      WHERE model IS NOT NULL AND th_msg_count > 0
      GROUP BY model
    `).all() as unknown as EnergyModelAgg[];

    // bounds — totalMessages = SUM(msg_count); minTimestamp = MIN(min_ts).
    const boundsRow = this.db.prepare(`
      SELECT SUM(msg_count) AS total, MIN(min_ts) AS min_ts
      FROM message_hourly
      WHERE model IS NOT NULL
    `).get() as { total: number | null; min_ts: number | null };

    return {
      byModel,
      byProjectModel,
      byHourModel,
      byGeo,
      geoByEarliest,
      sessionsWithThinking: thinkingSessionsRow?.c ?? 0,
      thinkingByModel,
      totalMessages: boundsRow?.total ?? 0,
      minTimestamp: boundsRow?.min_ts ?? null,
    };
  }

  private getEnergyAggregatesRaw(filters: {
    projectPath?: string;
    repoUrl?: string;
    accountUuid?: string;
    since?: number;
  } = {}): EnergyAggregates {
    const { where, params } = this.energyAggregateWhere(filters);
    const run = <T>(sql: string, ...extra: unknown[]): T[] => {
      const stmt = this.db.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (stmt.all as (...args: any[]) => unknown[])(...params, ...extra) as T[];
    };
    const runOne = <T>(sql: string): T | undefined => {
      const stmt = this.db.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (stmt.get as (...args: any[]) => unknown)(...params) as T | undefined;
    };

    // 1. GROUP BY model — per-model token sums + msg count. min_ts replicates
    //    the legacy first-seen Map-insertion order used as the sort tiebreak.
    const byModel = run<EnergyModelAgg>(`
      SELECT m.model AS model,
             SUM(m.input_tokens) AS input_tokens,
             SUM(m.output_tokens) AS output_tokens,
             SUM(m.cache_read_tokens) AS cache_read_tokens,
             SUM(m.cache_creation_tokens) AS cache_creation_tokens,
             COUNT(*) AS msgs,
             MIN(m.timestamp) AS min_ts
      FROM messages m
      ${where}
      GROUP BY m.model
    `);

    // 2. GROUP BY project_path, model — project_path resolved via the session
    //    (correlated subquery, like getMessagesForEnergy's project_path).
    //    model is needed for the per-class rate; project_path min_ts replicates
    //    the legacy first-seen order.
    const byProjectModel = run<EnergyProjectModelAgg>(`
      SELECT (SELECT project_path FROM sessions WHERE session_id = m.session_id) AS project_path,
             m.model AS model,
             SUM(m.input_tokens) AS input_tokens,
             SUM(m.output_tokens) AS output_tokens,
             SUM(m.cache_read_tokens) AS cache_read_tokens,
             SUM(m.cache_creation_tokens) AS cache_creation_tokens,
             MIN(m.timestamp) AS min_ts
      FROM messages m
      ${where}
      GROUP BY project_path, m.model
    `);

    // 3. GROUP BY (UTC hour bucket, model) — re-bucketed to local day in JS.
    //    NULL timestamps land in their own bucket (hour_bucket IS NULL).
    const byHourModel = run<EnergyHourModelAgg>(`
      SELECT CAST(m.timestamp / 3600000 AS INTEGER) AS hour_bucket,
             m.model AS model,
             SUM(m.input_tokens) AS input_tokens,
             SUM(m.output_tokens) AS output_tokens,
             SUM(m.cache_read_tokens) AS cache_read_tokens,
             SUM(m.cache_creation_tokens) AS cache_creation_tokens
      FROM messages m
      ${where}
      GROUP BY hour_bucket, m.model
    `);

    // 4. GROUP BY inference_geo — histogram for coverage + region detection.
    const byGeo = run<EnergyGeoAgg>(`
      SELECT m.inference_geo AS inference_geo, COUNT(*) AS msgs
      FROM messages m
      ${where}
      GROUP BY m.inference_geo
    `);

    // 5. detectedRegion source: distinct non-null geos with their earliest
    //    in-period timestamp, ASC. The caller maps each to a region and takes
    //    the first MAPPABLE one — matching aggregateEnergy's
    //    estimates.find(e => e.detectedRegion) over ORDER BY timestamp ASC,
    //    which skips messages whose geo does not map to a region.
    const geoByEarliest = run<{ inference_geo: string; min_ts: number }>(`
      SELECT m.inference_geo AS inference_geo, MIN(m.timestamp) AS min_ts
      FROM messages m
      ${where} AND m.inference_geo IS NOT NULL AND m.timestamp IS NOT NULL
      GROUP BY m.inference_geo
      ORDER BY min_ts ASC
    `);

    // 6a. thinkingImpact: distinct sessions with any thinking block.
    const thinkingSessionsRow = runOne<{ c: number }>(`
      SELECT COUNT(DISTINCT m.session_id) AS c
      FROM messages m
      ${where} AND m.thinking_blocks > 0
    `);

    // 6b. thinkingImpact energy: per-model token sums over thinking messages.
    const thinkingByModel = run<EnergyModelAgg>(`
      SELECT m.model AS model,
             SUM(m.input_tokens) AS input_tokens,
             SUM(m.output_tokens) AS output_tokens,
             SUM(m.cache_read_tokens) AS cache_read_tokens,
             SUM(m.cache_creation_tokens) AS cache_creation_tokens,
             COUNT(*) AS msgs
      FROM messages m
      ${where} AND m.thinking_blocks > 0
      GROUP BY m.model
    `);

    // Period bounds + total message count (for empty-period detection and the
    // "all time" earliest-timestamp fallback). minTimestamp ignores NULLs,
    // matching the legacy `m.timestamp != null` guard.
    const boundsRow = runOne<{ total: number; min_ts: number | null }>(`
      SELECT COUNT(*) AS total, MIN(m.timestamp) AS min_ts
      FROM messages m
      ${where}
    `);

    return {
      byModel,
      byProjectModel,
      byHourModel,
      byGeo,
      geoByEarliest,
      sessionsWithThinking: thinkingSessionsRow?.c ?? 0,
      thinkingByModel,
      totalMessages: boundsRow?.total ?? 0,
      minTimestamp: boundsRow?.min_ts ?? null,
    };
  }

  getMessagesForEnergy(filters: {
    projectPath?: string;
    repoUrl?: string;
    accountUuid?: string;
    since?: number;
  } = {}): EnergyMessageRow[] {
    // Outer (message-level) conditions stay on the messages query; the
    // session-scoped filters become a seek subquery (output-preserving vs.
    // the prior inner join — see getMessageTotals). The selected
    // s.project_path is preserved via a correlated subquery; because the
    // membership subquery already restricts to existing sessions, exactly
    // one matching session row exists per message and the value is identical
    // to the join's.
    // Period filtered on MESSAGE timestamp; session-scoped filters in an
    // always-emitted membership subquery (orphan-drop preserved). since param
    // is bound before the subquery params to match the `?` order.
    const conditions: string[] = ["m.model IS NOT NULL"];
    const sessionConditions: string[] = [];
    const params: unknown[] = [];

    if (filters.since !== undefined) {
      conditions.push("m.timestamp >= ?");
      params.push(filters.since);
    }
    if (filters.projectPath) {
      sessionConditions.push("s.project_path = ?");
      params.push(filters.projectPath);
    }
    if (filters.repoUrl) {
      sessionConditions.push("s.repo_url = ?");
      params.push(filters.repoUrl);
    }
    if (filters.accountUuid) {
      sessionConditions.push("s.account_uuid = ?");
      params.push(filters.accountUuid);
    }

    // EXISTS preserves orphan-drop while letting the m.timestamp filter seek
    // (see getMessageTotals).
    const sessionAnd = sessionConditions.length ? ` AND ${sessionConditions.join(" AND ")}` : "";
    conditions.push(`EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = m.session_id${sessionAnd})`);
    const where = `WHERE ${conditions.join(" AND ")}`;
    const sql = `
      SELECT
        m.session_id, m.timestamp, m.model,
        m.input_tokens, m.output_tokens,
        m.cache_read_tokens, m.cache_creation_tokens,
        m.ephemeral_5m_cache_tokens, m.ephemeral_1h_cache_tokens,
        m.thinking_blocks, m.inference_geo,
        (SELECT project_path FROM sessions WHERE session_id = m.session_id) AS project_path
      FROM messages m
      ${where}
      ORDER BY m.timestamp ASC
    `;
    const stmt = this.db.prepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as EnergyMessageRow[];
  }

  // ─── Subagent queries ─────────────────────────────────────────────────────

  /** Resolve a message UUID (parentUuid from JSONL) to its owning session ID. */
  resolveParentSessionId(messageUuid: string): string | null {
    const row = this.db
      .prepare("SELECT session_id FROM messages WHERE uuid = ? LIMIT 1")
      .get(messageUuid) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  /** Get child (subagent) sessions for a given parent session. */
  getChildSessions(parentSessionId: string): SessionRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY first_timestamp ASC"
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(parentSessionId) as SessionRow[];
  }

  /**
   * Earliest session first_timestamp across all non-deleted sessions, or null
   * when there are none. Used to bound the 'all' window for cost-per-task
   * aggregation so it never enumerates from the epoch.
   */
  getEarliestSessionTimestamp(): number | null {
    const row = this.db
      .prepare("SELECT MIN(first_timestamp) AS t FROM sessions WHERE source_deleted = 0 AND first_timestamp IS NOT NULL")
      .get() as { t: number | null };
    return row?.t ?? null;
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

  // ─── Spending report ────────────────────────────────────────────────────────

  getSpendingReport(filters: {
    projectPath?: string;
    repoUrl?: string;
    accountUuid?: string;
    since?: number;
    until?: number;
    limit?: number;
  } = {}): SpendingReport {
    const limit = filters.limit ?? 20;

    // Shared WHERE clause builder for session-based queries
    const sessionConditions: string[] = ["s.is_interactive = 1", "s.source_deleted = 0"];
    const sessionParams: unknown[] = [];
    if (filters.projectPath) { sessionConditions.push("s.project_path = ?"); sessionParams.push(filters.projectPath); }
    if (filters.repoUrl) { sessionConditions.push("s.repo_url = ?"); sessionParams.push(filters.repoUrl); }
    if (filters.accountUuid) { sessionConditions.push("s.account_uuid = ?"); sessionParams.push(filters.accountUuid); }
    if (filters.since !== undefined) { sessionConditions.push("s.first_timestamp >= ?"); sessionParams.push(filters.since); }
    if (filters.until !== undefined) { sessionConditions.push("s.first_timestamp < ?"); sessionParams.push(filters.until); }
    const sessionWhere = `WHERE ${sessionConditions.join(" AND ")}`;

    // 1. Top sessions by token cost
    const topSessions = (() => {
      const sql = `SELECT * FROM sessions s ${sessionWhere}
        ORDER BY (s.input_tokens + s.output_tokens + s.cache_creation_tokens) DESC LIMIT ?`;
      const stmt = this.db.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (stmt.all as (...args: any[]) => unknown[])(...sessionParams, limit) as SessionRow[];
    })();

    // 2. Top messages by token cost
    const topMessages = (() => {
      const sql = `SELECT m.uuid, m.session_id, m.model, m.input_tokens, m.output_tokens,
          m.cache_read_tokens, m.cache_creation_tokens, m.thinking_blocks, m.tools,
          m.prompt_text, m.timestamp, m.stop_reason
        FROM messages m JOIN sessions s ON m.session_id = s.session_id
        ${sessionWhere}
        ORDER BY (m.input_tokens + m.output_tokens + m.cache_creation_tokens) DESC LIMIT ?`;
      const stmt = this.db.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (stmt.all as (...args: any[]) => unknown[])(...sessionParams, limit) as SpendingMessageRow[];
    })();

    // 3. By model — reuse getMessageTotals
    const byModel = this.getMessageTotals({
      projectPath: filters.projectPath,
      repoUrl: filters.repoUrl,
      since: filters.since,
      until: filters.until,
    });

    // 4. By project
    const byProject = (() => {
      const sql = `SELECT s.project_path,
          SUM(s.input_tokens) AS input_tokens,
          SUM(s.output_tokens) AS output_tokens,
          SUM(s.cache_read_tokens) AS cache_read_tokens,
          SUM(s.cache_creation_tokens) AS cache_creation_tokens,
          SUM(s.prompt_count) AS prompt_count,
          COUNT(*) AS session_count
        FROM sessions s ${sessionWhere}
        GROUP BY s.project_path
        ORDER BY (input_tokens + output_tokens + cache_creation_tokens) DESC`;
      const stmt = this.db.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (stmt.all as (...args: any[]) => unknown[])(...sessionParams) as SpendingProjectRow[];
    })();

    // 5. Cache efficiency per session
    const cacheEfficiency = (() => {
      const sql = `SELECT m.session_id,
          SUM(m.cache_read_tokens) AS cache_hits,
          SUM(m.input_tokens) AS uncached_input,
          SUM(m.cache_creation_tokens) AS cache_writes,
          ROUND(
            CAST(SUM(m.cache_read_tokens) AS REAL) /
            NULLIF(SUM(m.cache_read_tokens) + SUM(m.input_tokens), 0) * 100,
            1
          ) AS cache_hit_pct
        FROM messages m JOIN sessions s ON m.session_id = s.session_id
        ${sessionWhere}
        GROUP BY m.session_id
        ORDER BY cache_hit_pct ASC`;
      const stmt = this.db.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (stmt.all as (...args: any[]) => unknown[])(...sessionParams) as CacheEfficiencyRow[];
    })();

    // 6. Subagent cost attribution
    const subagentCosts = (() => {
      const sql = `SELECT
          parent.session_id AS parent_session_id,
          parent.project_path,
          SUM(child.input_tokens + child.output_tokens + child.cache_creation_tokens) AS subagent_tokens,
          COUNT(child.session_id) AS subagent_count,
          parent.input_tokens + parent.output_tokens + parent.cache_creation_tokens AS parent_tokens
        FROM sessions parent
        JOIN sessions child ON child.parent_session_id = parent.session_id
        WHERE parent.first_timestamp >= COALESCE(?, 0)
        GROUP BY parent.session_id
        ORDER BY subagent_tokens DESC`;
      const stmt = this.db.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (stmt.all as (...args: any[]) => unknown[])(filters.since ?? 0) as SubagentCostRow[];
    })();

    return { topSessions, topMessages, byModel, byProject, cacheEfficiency, subagentCosts };
  }

  // ─── MCP server token breakdown ─────────────────────────────────────────────

  /**
   * Get all messages that used MCP tools, with their token counts and tool lists.
   * Uses LIKE '%mcp__%' on the tools JSON column for efficient filtering.
   */
  getMcpMessages(filters: {
    projectPath?: string;
    repoUrl?: string;
    accountUuid?: string;
    since?: number;
    until?: number;
  } = {}): McpMessageRow[] {
    const conditions: string[] = [
      "s.is_interactive = 1",
      "s.source_deleted = 0",
      "m.tools LIKE '%mcp__%'",
    ];
    const params: unknown[] = [];
    if (filters.projectPath) { conditions.push("s.project_path = ?"); params.push(filters.projectPath); }
    if (filters.repoUrl) { conditions.push("s.repo_url = ?"); params.push(filters.repoUrl); }
    if (filters.accountUuid) { conditions.push("s.account_uuid = ?"); params.push(filters.accountUuid); }
    if (filters.since !== undefined) { conditions.push("s.first_timestamp >= ?"); params.push(filters.since); }
    if (filters.until !== undefined) { conditions.push("s.first_timestamp < ?"); params.push(filters.until); }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const sql = `SELECT m.uuid, m.session_id, m.model, m.input_tokens, m.output_tokens,
        m.cache_read_tokens, m.cache_creation_tokens, m.tools, s.project_path
      FROM messages m JOIN sessions s ON m.session_id = s.session_id
      ${where}
      ORDER BY (m.input_tokens + m.output_tokens) DESC`;
    const stmt = this.db.prepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as McpMessageRow[];
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
  parent_session_id: string | null;
  is_subagent: number;
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
  file_paths: string; // JSON array of file paths extracted from tool_use block.input
  thinking_blocks: number;
  service_tier: string | null;
  inference_geo: string | null;
  ephemeral_5m_cache_tokens: number;
  ephemeral_1h_cache_tokens: number;
  prompt_text: string | null;
  /** Count of failed tool calls in this message (added schema v11; old rows = 0). */
  tool_error_count?: number;
  /**
   * Per-message account override (added schema v13). Non-null ONLY for messages
   * that fall in a later account's interval within a straddling CLI session
   * (see attribution/assign.ts); null means the session-level account applies.
   */
  account_uuid?: string | null;
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

export interface MessageCostInputRow {
  uuid: string;
  model: string | null;
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

export interface EnergyMessageRow {
  session_id: string;
  timestamp: number | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  ephemeral_5m_cache_tokens: number;
  ephemeral_1h_cache_tokens: number;
  thinking_blocks: number;
  inference_geo: string | null;
  project_path: string;
}

/** Per-model token sums + message count (GROUP BY model). */
export interface EnergyModelAgg {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  msgs: number;
  /** MIN(timestamp) across the group (NULLs ignored); first-seen tiebreak. */
  min_ts?: number | null;
}

/** Per-(project, model) token sums (GROUP BY project_path, model). */
export interface EnergyProjectModelAgg {
  project_path: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** MIN(timestamp) across the group (NULLs ignored); first-seen tiebreak. */
  min_ts?: number | null;
}

/** Per-(UTC hour bucket, model) token sums (GROUP BY timestamp/3600000, model). */
export interface EnergyHourModelAgg {
  hour_bucket: number | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/** Per-inference-geo message count (GROUP BY inference_geo). */
export interface EnergyGeoAgg {
  inference_geo: string | null;
  msgs: number;
}

/** Pre-grouped aggregates feeding buildEnergySection (replaces the per-message loop). */
export interface EnergyAggregates {
  byModel: EnergyModelAgg[];
  byProjectModel: EnergyProjectModelAgg[];
  byHourModel: EnergyHourModelAgg[];
  byGeo: EnergyGeoAgg[];
  /** Distinct non-null geos with their earliest in-period timestamp, ASC by timestamp. */
  geoByEarliest: Array<{ inference_geo: string; min_ts: number }>;
  sessionsWithThinking: number;
  thinkingByModel: EnergyModelAgg[];
  totalMessages: number;
  /** MIN(timestamp) over in-period messages, NULLs ignored (for "all time" period start). */
  minTimestamp: number | null;
}

export interface StatusInfo {
  dbSize: number;
  sessionCount: number;
  messageCount: number;
  quarantineCount: number;
  lastCollected: number | null;
}

// ─── Spending report types ──────────────────────────────────────────────────

export interface SpendingMessageRow {
  uuid: string;
  session_id: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  thinking_blocks: number;
  tools: string;
  prompt_text: string | null;
  timestamp: number | null;
  stop_reason: string | null;
}

export interface SpendingProjectRow {
  project_path: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  prompt_count: number;
  session_count: number;
}

export interface CacheEfficiencyRow {
  session_id: string;
  cache_hits: number;
  uncached_input: number;
  cache_writes: number;
  cache_hit_pct: number;
}

export interface SubagentCostRow {
  parent_session_id: string;
  project_path: string;
  subagent_tokens: number;
  subagent_count: number;
  parent_tokens: number;
}

export interface SpendingReport {
  topSessions: SessionRow[];
  topMessages: SpendingMessageRow[];
  byModel: MessageTotalRow[];
  byProject: SpendingProjectRow[];
  cacheEfficiency: CacheEfficiencyRow[];
  subagentCosts: SubagentCostRow[];
}

export interface McpMessageRow {
  uuid: string;
  session_id: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  tools: string;
  project_path: string;
}
