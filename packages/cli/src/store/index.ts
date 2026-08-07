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
  OwnerRule,
  OwnerTarget,
} from "@claude-stats/core/types";
import { estimateCost } from "@claude-stats/core/pricing";
import { requireTicketKey } from "@claude-stats/core/tickets";
import { sanitizePromptText, decodeHtmlEntities } from "@claude-stats/core/sanitize";

const SCHEMA_VERSION = 20;

/**
 * SQL narrowing a session-id column to sessions attributed to one ticket key.
 *
 * Two clauses, not one: a session qualifies when at least one NON-negated link
 * names the key, AND no tombstone row negates it. The tombstone arm is what
 * makes a user's "not this ticket" correction authoritative over any number of
 * agreeing automatic links — the discrediting failure mode for a justification
 * report is a single visibly-wrong row, so the correction has to win.
 *
 * Parameterised by column so the SAME predicate serves both halves of the
 * filter-symmetry contract: `session_id` in `getSessions` (unaliased `sessions`)
 * and `s.session_id` in `buildMessageFilter` (aliased). Two hand-written copies
 * would be free to drift, which is precisely the bug the contract exists to
 * prevent. Binds two params, both the ticket key.
 */
function ticketPredicate(col: string): string {
  return `${col} IN (SELECT tl.session_id FROM ticket_links tl WHERE tl.ticket_key = ? AND tl.negated = 0)
    AND ${col} NOT IN (SELECT tn.session_id FROM ticket_links tn WHERE tn.ticket_key = ? AND tn.negated = 1)`;
}

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
    if (current < 15) this.migrateToV15();
    if (current < 16) this.migrateToV16();
    if (current < 17) this.migrateToV17();
    if (current < 18) this.migrateToV18();
    if (current < 19) this.migrateToV19();
    if (current < 20) this.migrateToV20();

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
   * V15 — cost-ownership rules (doc 10). Durable per-project cost policy: which
   * subscription owns a project's spend. The SINGLE source of truth for owner
   * rules (no config-file storage). Additive + idempotent, zero backfill.
   */
  private migrateToV15(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_owner_rules (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        path_glob   TEXT,
        remote_glob TEXT,
        target      TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_owner_rules_created ON account_owner_rules (created_at);
    `);
  }

  /**
   * V16 — re-sanitize stored `prompt_text` in place.
   *
   * Rows ingested before the `<task-notification>` strip (and the earlier
   * escape-based sanitizer) landed carry raw system-injected tag blocks as their
   * "prompt". The `upsertMessages` UPSERT guards prompt_text with
   * `COALESCE(excluded.prompt_text, messages.prompt_text)` so that continuation /
   * privacy-stripped re-ingests don't wipe a good value — but that same COALESCE
   * means a re-parse producing the now-correct NULL can never clear a stale value,
   * and unchanged files are skipped by the collection checkpoint entirely. So the
   * fix has to reach the stored data directly. These polluted rows surfaced as the
   * junk labels ("<task-notification> <task-id>…") on the model-efficiency
   * "top overuse" chart and in prompt previews.
   *
   * Normalizes every non-null row to the canonical current form via
   * `sanitizePromptText(decodeHtmlEntities(stored))`: the decode undoes any prior
   * escaping (single pass), the sanitizer strips known blocks — now including a
   * truncated unclosed opener whose close tag fell past an old length-cap — then
   * re-escapes and re-caps. Idempotent, so a crash-retry is safe. Only rows whose
   * value actually changes are written.
   */
  private migrateToV16(): void {
    const rows = this.db
      .prepare("SELECT uuid, prompt_text FROM messages WHERE prompt_text IS NOT NULL")
      .all() as Array<{ uuid: string; prompt_text: string }>;
    const update = this.db.prepare("UPDATE messages SET prompt_text = ? WHERE uuid = ?");
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        const cleaned = sanitizePromptText(decodeHtmlEntities(r.prompt_text));
        if (cleaned !== r.prompt_text) update.run(cleaned, r.uuid);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * V17 — repair `sessions.last_timestamp` values destroyed by the NULL-poisoning
   * upserts (see the notes on `upsertSession` / `upsertSessionIncremental`).
   *
   * A delta parse that produced no timestamped entry wrote NULL over a
   * known-good `last_timestamp`; SQLite's scalar `max()` returning NULL for any
   * NULL argument made the incremental path do it too. Those rows are then
   * invisible to every `activeSince` (period) query while their messages still
   * count toward the headline cost. Recompute from `messages`, which is the
   * ground truth the aggregate column caches.
   *
   * Only touches rows where the cached value is NULL or provably too early
   * (< the session's real max message timestamp); never moves a value backwards,
   * so a session whose messages were pruned keeps its recorded end. Idempotent:
   * a second run finds nothing left to fix.
   */
  private migrateToV17(): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        UPDATE sessions SET last_timestamp = (
          SELECT MAX(m.timestamp) FROM messages m
          WHERE m.session_id = sessions.session_id AND m.timestamp IS NOT NULL
        )
        WHERE EXISTS (
          SELECT 1 FROM messages m
          WHERE m.session_id = sessions.session_id AND m.timestamp IS NOT NULL
        )
        AND (
          last_timestamp IS NULL
          OR last_timestamp < (
            SELECT MAX(m.timestamp) FROM messages m
            WHERE m.session_id = sessions.session_id AND m.timestamp IS NOT NULL
          )
        );
      `);
      // Serves the correlated message-existence arm of the `activeSince`
      // predicate: session_id equality plus a timestamp range in one index.
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_session_ts
          ON messages (session_id, timestamp);
      `);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * V18 — make the `sessions` counter columns a PROJECTION of `messages`
   * instead of an accumulator, and repair the values already inflated.
   *
   * `upsertSessionIncremental` ADDS each delta's counters. Nothing made that
   * idempotent — there is no lock around read-checkpoint → parse → add, so two
   * collectors (VS Code extension, MCP server, CLI) processing the same delta
   * both added it. `messages` was immune the whole time because its `uuid`
   * PRIMARY KEY dedupes. Measured on one real session: `output_tokens`
   * 73 553 732 stored vs 5 115 161 true — 14x, compounding forever.
   *
   * Recomputing from `messages` fixes every session in one pass and removes the
   * failure mode: a projection cannot double-count.
   *
   * Also adds the per-message signals that let the projection be TOTAL rather
   * than partial — `is_turn_start` (a real user prompt, not a tool result),
   * `web_search_requests`, `web_fetch_requests`, `is_throttled`.
   *
   * `is_turn_start` cannot be recovered exactly for existing rows (it needs the
   * transcript, and 936 of 1168 sessions no longer have one — Claude Code prunes
   * them). It IS approximable from data already stored: `prompt_text` is only
   * attached to the assistant message that answered a user turn, so
   * `prompt_text IS NOT NULL` marks turn starts wherever the prompt had
   * extractable text. Measured against sessions the new parser has since done
   * exactly, that proxy captures 68% of real turns — imperfect, but the column
   * it replaces was reporting 296 155 "prompts" for ~7 600 real ones.
   *
   * The proxy is applied ONLY to sessions with no real signal at all, so it can
   * never overwrite an exact value, and it only ever sets 0 → 1.
   *
   * Deliberately does NOT invalidate the collection checkpoints. Doing so would
   * force a ~0.7 GB re-parse on the next collect to recover the exact signal for
   * the 232 live transcripts; that is a surprising amount of work to trigger from
   * a schema migration, and it stalled the collector past its timeouts. Ongoing
   * sessions get exact values for new turns as they are appended.
   */
  private migrateToV18(): void {
    const addColumn = (table: string, column: string, def: string): void => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    };
    addColumn("messages", "is_turn_start", "INTEGER NOT NULL DEFAULT 0");
    addColumn("messages", "web_search_requests", "INTEGER NOT NULL DEFAULT 0");
    addColumn("messages", "web_fetch_requests", "INTEGER NOT NULL DEFAULT 0");
    addColumn("messages", "is_throttled", "INTEGER NOT NULL DEFAULT 0");

    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        UPDATE messages SET is_turn_start = 1
        WHERE is_turn_start = 0
          AND prompt_text IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM messages m2
            WHERE m2.session_id = messages.session_id AND m2.is_turn_start = 1
          );
      `);
      this.recomputeSessionAggregatesSql(null);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * V19 — ticket attribution links (`doc/analysis/ticket-attribution/02 §2.2`).
   *
   * One row per (session, ticket key, evidence source), so a session can
   * accumulate CORROBORATING rows — a branch-name link and a commit-subject
   * link for the same key are two rows, and agreement between independent
   * sources is what upgrades the effective confidence. Collapsing them to one
   * row per (session, key) would throw away exactly the signal the accuracy
   * ladder is built on.
   *
   * `negated` is the tombstone: a user-authored row with `negated = 1`
   * suppresses that key for that session no matter how many automatic rows
   * agree. It exists because the discrediting failure mode for a justification
   * report is one visibly-wrong attribution, and the user must be able to kill
   * it without deleting evidence.
   *
   * `evidence` (the matched branch name / commit subject) is LOCAL-ONLY: it is
   * free text and therefore can never be added to an org-plane sync shape
   * (`doc/analysis/05-privacy-security.md` — the "no field capable of carrying
   * free text" guarantee is structural, not a filter).
   *
   * Additive + idempotent; zero backfill (extraction runs in `collect`).
   */
  private migrateToV19(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticket_links (
        session_id  TEXT NOT NULL,
        ticket_key  TEXT NOT NULL,
        source      TEXT NOT NULL,
        confidence  TEXT NOT NULL,
        granularity TEXT NOT NULL DEFAULT 'session',
        first_uuid  TEXT,
        last_uuid   TEXT,
        evidence    TEXT,
        negated     INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (session_id, ticket_key, source),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ticket_links_key ON ticket_links (ticket_key);
      CREATE INDEX IF NOT EXISTS idx_ticket_links_session ON ticket_links (session_id);
    `);
  }

  /**
   * V20 — per-message git branch (`doc/analysis/ticket-attribution/02 §2.3`).
   *
   * `sessions.git_branch` is first-seen-only (`parser/session.ts:188` keeps the
   * first non-empty value), so a session that switches branches mid-way
   * mis-attributes every message after the switch — and long-lived sessions are
   * exactly the expensive ones. This column lets attribution split a session at
   * its branch boundaries.
   *
   * NULLABLE with NO backfill, deliberately. Backfill requires re-reading the
   * transcript, and V18's docstring records why a migration must not force that
   * (~0.7 GB re-parse, stalled the collector past its timeouts). Historical rows
   * therefore stay NULL and fall back to the session-level branch, which readers
   * must treat as `granularity: 'session'` evidence. Backfilling where the
   * transcript or archive still exists is an explicit, resumable, opt-in command
   * — not a side effect of opening the database.
   */
  private migrateToV20(): void {
    const addColumn = (table: string, column: string, def: string): void => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    };
    addColumn("messages", "git_branch", "TEXT");
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

  // ─── Session aggregate projection ───────────────────────────────────────────

  /**
   * Recompute the `sessions` counter columns from `messages` — the ONLY writer
   * of those columns that is safe to run twice.
   *
   * `messages` is keyed on the message uuid, so re-processing a byte range
   * cannot change it. Deriving the session counters from it therefore makes them
   * idempotent too, which is what the old additive `upsertSessionIncremental`
   * could never be (see migrateToV18 for the 14x it produced).
   *
   * Pass a session-id list to recompute just those (the collector's case) or
   * `null` for every session (the migration's case).
   *
   * `prompt_count` is only rewritten for sessions that actually carry the
   * `is_turn_start` signal. Rows ingested before V18 have it as 0 for every
   * message, and blindly recomputing would report "0 prompts" for all history
   * rather than a stale-but-nonzero number.
   */
  private recomputeSessionAggregatesSql(sessionIds: string[] | null): void {
    const scope = sessionIds === null
      ? ""
      : `AND s.session_id IN (${sessionIds.map(() => "?").join(",")})`;
    // The only bound placeholders are the session ids in `scope`; every other
    // term is a correlated subquery with no parameters.
    const params = sessionIds ?? [];

    // Written as a single UPDATE so the whole projection lands atomically per row.
    this.db
      .prepare(
        `UPDATE sessions AS s SET
           input_tokens            = (SELECT COALESCE(SUM(m.input_tokens), 0)          FROM messages m WHERE m.session_id = s.session_id),
           output_tokens           = (SELECT COALESCE(SUM(m.output_tokens), 0)         FROM messages m WHERE m.session_id = s.session_id),
           cache_read_tokens       = (SELECT COALESCE(SUM(m.cache_read_tokens), 0)     FROM messages m WHERE m.session_id = s.session_id),
           cache_creation_tokens   = (SELECT COALESCE(SUM(m.cache_creation_tokens), 0) FROM messages m WHERE m.session_id = s.session_id),
           thinking_blocks         = (SELECT COALESCE(SUM(m.thinking_blocks), 0)       FROM messages m WHERE m.session_id = s.session_id),
           assistant_message_count = (SELECT COUNT(*)                                  FROM messages m WHERE m.session_id = s.session_id),
           web_search_requests     = (SELECT COALESCE(SUM(m.web_search_requests), 0)   FROM messages m WHERE m.session_id = s.session_id),
           web_fetch_requests      = (SELECT COALESCE(SUM(m.web_fetch_requests), 0)    FROM messages m WHERE m.session_id = s.session_id),
           throttle_events         = (SELECT COALESCE(SUM(m.is_throttled), 0)          FROM messages m WHERE m.session_id = s.session_id),
           prompt_count            = CASE
             WHEN (SELECT COALESCE(SUM(m.is_turn_start), 0) FROM messages m WHERE m.session_id = s.session_id) > 0
             THEN (SELECT SUM(m.is_turn_start) FROM messages m WHERE m.session_id = s.session_id)
             ELSE s.prompt_count END
         WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.session_id) ${scope}`
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .run(...(params as any[]));
  }

  /**
   * Public entry point for the projection — see `recomputeSessionAggregatesSql`.
   *
   * Opens its own transaction so a crash can't leave counters half-updated, but
   * joins an existing one if the caller already has one open: the collector runs
   * this alongside its upserts inside a single transaction, and `BEGIN` does not
   * nest in SQLite.
   */
  recomputeSessionAggregates(sessionIds: string[] | null = null): void {
    if (sessionIds !== null && sessionIds.length === 0) return;
    if (this.db.isTransaction) {
      this.recomputeSessionAggregatesSql(sessionIds);
    } else {
      this.transaction(() => this.recomputeSessionAggregatesSql(sessionIds));
    }
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
        -- COALESCE, not a bare overwrite: a re-parse whose entries carry no
        -- usable timestamp yields lastTimestamp=null, and writing that over a
        -- known-good value silently destroys it. A NULL last_timestamp next to
        -- an early first_timestamp then drops the session from every
        -- activeSince (period) query while its MESSAGES still count toward the
        -- headline cost — the "0 sessions, non-zero cost" dashboard bug.
        last_timestamp          = COALESCE(excluded.last_timestamp, sessions.last_timestamp),
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
        -- SQLite's SCALAR max() returns NULL if ANY argument is NULL, so a bare
        -- MAX(sessions.last_timestamp, excluded.last_timestamp) wipes a
        -- known-good value whenever a delta chunk carries no timestamped entry
        -- (parseSession leaves lastTimestamp null then). COALESCE each side to
        -- the other first so a null delta is a no-op and only "both null" is
        -- null. See the note on upsertSession's last_timestamp.
        last_timestamp          = MAX(
                                    COALESCE(sessions.last_timestamp, excluded.last_timestamp),
                                    COALESCE(excluded.last_timestamp, sessions.last_timestamp)
                                  ),
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
    // A transcript replays earlier assistant turns verbatim on resume and
    // compaction, and the replayed copies carry an EMPTY usage block
    // ({input:0,output:0,cache:0}) while the FIRST occurrence holds the real
    // numbers. Plain last-write-wins therefore zeroed genuinely-billed usage —
    // measured on one real file, two messages each lost 490 output and 420 067
    // cache-read tokens that way.
    //
    // So: treat "every token field is 0" as "this copy carries NO usage
    // information" and keep what is already stored. A re-parse that reports
    // different NON-ZERO usage is a real correction and still wins, including
    // when it corrects downwards — which a blunt MAX() would have blocked.
    const carriesNoUsage =
      "excluded.input_tokens = 0 AND excluded.output_tokens = 0 AND " +
      "excluded.cache_read_tokens = 0 AND excluded.cache_creation_tokens = 0";
    const keepIfNoUsage = (col: string): string =>
      `${col} = CASE WHEN ${carriesNoUsage} THEN messages.${col} ELSE excluded.${col} END`;

    const stmt = this.db.prepare(`
      INSERT INTO messages (
        uuid, session_id, timestamp, claude_version, model, stop_reason,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
        tools, file_paths, thinking_blocks,
        service_tier, inference_geo, ephemeral_5m_cache_tokens, ephemeral_1h_cache_tokens,
        prompt_text, tool_error_count,
        is_turn_start, web_search_requests, web_fetch_requests, is_throttled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (uuid) DO UPDATE SET
        model                       = excluded.model,
        ${keepIfNoUsage("input_tokens")},
        ${keepIfNoUsage("output_tokens")},
        ${keepIfNoUsage("cache_creation_tokens")},
        ${keepIfNoUsage("cache_read_tokens")},
        ${keepIfNoUsage("thinking_blocks")},
        ${keepIfNoUsage("ephemeral_5m_cache_tokens")},
        ${keepIfNoUsage("ephemeral_1h_cache_tokens")},
        ${keepIfNoUsage("web_search_requests")},
        ${keepIfNoUsage("web_fetch_requests")},
        tools                       = excluded.tools,
        file_paths                  = COALESCE(excluded.file_paths, messages.file_paths),
        service_tier                = excluded.service_tier,
        inference_geo               = excluded.inference_geo,
        prompt_text                 = COALESCE(excluded.prompt_text, messages.prompt_text),
        tool_error_count            = excluded.tool_error_count,
        -- Turn-start and throttle are properties of the real turn, so a zeroed
        -- replay must not clear them: MAX keeps a 1 once seen. Both are 0/1 and
        -- NOT NULL, so MAX has no NULL hazard here.
        is_turn_start               = MAX(messages.is_turn_start, excluded.is_turn_start),
        is_throttled                = MAX(messages.is_throttled, excluded.is_throttled)
    `);
    for (const r of records) {
      stmt.run(
        r.uuid, r.sessionId, r.timestamp, r.claudeVersion,
        r.model, r.stopReason, r.inputTokens, r.outputTokens,
        r.cacheCreationTokens, r.cacheReadTokens,
        JSON.stringify(r.tools), JSON.stringify(r.filePaths ?? []),
        r.thinkingBlocks,
        r.serviceTier, r.inferenceGeo, r.ephemeral5mCacheTokens, r.ephemeral1hCacheTokens,
        r.promptText ?? null, r.toolErrorCount ?? 0,
        r.isTurnStart ? 1 : 0, r.webSearchRequests ?? 0, r.webFetchRequests ?? 0,
        r.isThrottled ? 1 : 0
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
   * Apply corrected project_path/repo_url pairs to sessions (repair-project-
   * paths backfill). project_path is intentionally excluded from
   * upsertSession's ON CONFLICT clause — it's set once at first insert and
   * never revisited by normal collection — so this is the only path that can
   * fix a session already stored with a lossy decoded path. Returns the
   * number of rows changed.
   */
  updateProjectPaths(
    mapping: Map<string, { projectPath: string; repoUrl: string | null }>,
  ): number {
    const stmt = this.db.prepare(
      "UPDATE sessions SET project_path = ?, repo_url = ? WHERE session_id = ?"
    );
    let changed = 0;
    for (const [sessionId, info] of mapping) {
      const result = stmt.run(info.projectPath, info.repoUrl, sessionId);
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
  getMessageTotals(filters: MessageFilter = {}): MessageTotalRow[] {
    // An account/entrypoint filter is a session-scoped bound just like
    // project/repo: it must take the raw seek path (getMessageTotalsRaw), never
    // the fully-unbounded message_hourly rollup (which has no session dimension
    // and would return every account's totals). This is what lets an
    // account-filtered get_stats headline reconcile with its byAccount split.
    // includeCI/includeDeleted are session-scoped bounds too: the rollup has no
    // session dimension, so an explicit `false` must fall through to the raw
    // seek or the fast path would silently ignore the narrowing.
    const fullyUnbounded =
      filters.since === undefined &&
      filters.until === undefined &&
      !filters.projectPath &&
      !filters.repoUrl &&
      !filters.accountUuid &&
      !filters.entrypoint &&
      filters.includeCI !== false &&
      filters.includeDeleted !== false;
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

  /**
   * Shared WHERE construction for every message-scoped aggregate.
   *
   * Period is filtered on the MESSAGE timestamp (messages SENT in the period),
   * which seeks idx_messages_timestamp. Session-scoped filters (project/repo)
   * stay in an always-emitted membership subquery — this preserves the prior
   * inner join's orphan-message drop (a message whose session_id is absent
   * from `sessions` matches neither form). Outer (m.timestamp) params are
   * bound before the subquery params to match the `?` order in the SQL, so
   * callers must interpolate `outerWhere` before `sessionAnd`.
   *
   * Every message-scoped read MUST go through this, so that the headline, the
   * per-day/per-hour/per-project splits and the per-account split all select
   * exactly the same message set and therefore reconcile by construction.
   *
   * Returns the two condition groups separately because the two query shapes
   * consume them differently: an EXISTS-subquery form (keeps the timestamp
   * index seek) and an INNER JOIN form (needs `s.*` columns in GROUP BY). Both
   * bind outer params before session params.
   */
  private buildMessageFilter(filters: MessageFilter): { outer: string[]; session: string[]; params: unknown[] } {
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
    if (filters.accountUuid) {
      sessionConditions.push("s.account_uuid = ?");
      params.push(filters.accountUuid);
    }
    if (filters.entrypoint) {
      // S3 — entrypoint symmetry: `rows` filters on entrypoint, so the headline
      // membership subquery must too, else Σ byAccount ≠ headline when a caller
      // filters by entrypoint (server ?entrypoint=, CLI --source).
      sessionConditions.push("s.entrypoint = ?");
      params.push(filters.entrypoint);
    }
    // Ticket / tag symmetry. Both narrow the SESSION set in `getSessions`; a
    // message-scoped read that ignored them would price a different set of work
    // than the session list shows — "12 sessions" beside a cost covering 40.
    // `tag` was asymmetric before this: it filtered session lists only, so
    // tag-scoped token/cost aggregates did not exist at all.
    if (filters.ticket) {
      sessionConditions.push(ticketPredicate("s.session_id"));
      params.push(filters.ticket, filters.ticket);
    }
    if (filters.tag) {
      sessionConditions.push("s.session_id IN (SELECT session_id FROM session_tags WHERE tag = ?)");
      params.push(filters.tag);
    }
    // CI / deleted symmetry. `getSessions` narrows the SESSION set on these two
    // flags; if the message-scoped reads ignore them, the two halves of every
    // aggregate describe different work again — cost would keep counting a CI
    // session that `rows` has already excluded, and a project whose only
    // session is CI would still appear in byProject under includeCI=false.
    // Explicit-false only (undefined = no narrowing), which is exactly what
    // `getSessions` does for the values buildDashboard passes it.
    if (filters.includeCI === false) {
      sessionConditions.push("s.is_interactive = 1");
    }
    if (filters.includeDeleted === false) {
      sessionConditions.push("s.source_deleted = 0");
    }

    return { outer: outerConditions, session: sessionConditions, params };
  }

  /** EXISTS-subquery WHERE clause (keeps the m.timestamp index seek). */
  private messageWhereExists(f: { outer: string[]; session: string[] }): string {
    const sessionAnd = f.session.length ? ` AND ${f.session.join(" AND ")}` : "";
    const outerAnd = f.outer.length ? `${f.outer.join(" AND ")} AND ` : "";
    return `${outerAnd}EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = m.session_id${sessionAnd})`;
  }

  /** INNER-JOIN WHERE clause, for aggregates that GROUP BY a `sessions` column. */
  private messageWhereJoin(f: { outer: string[]; session: string[] }): string {
    const all = [...f.outer, ...f.session];
    return all.length ? all.join(" AND ") : "1=1";
  }

  /**
   * Width of the time bucket `getMessageTotalsByBucket` groups into: 15 minutes.
   *
   * Buckets are UTC-aligned but consumed as tz-LOCAL day/hour buckets, so the
   * width must divide every real-world UTC offset — those include :30 (e.g.
   * Asia/Kolkata) and :45 (e.g. Asia/Kathmandu). 15 min is the coarsest width
   * that can never straddle a local day OR local hour boundary; an hour-wide
   * bucket (what `message_hourly` uses) would misplace tokens for half-hour
   * offset zones.
   */
  private static readonly BUCKET_MS = 900_000;

  /**
   * Per-time-bucket, per-model token totals for messages SENT in the window —
   * the same message set as `getMessageTotals`, just grouped by time as well as
   * model. Callers fold the buckets into tz-local days/hours.
   *
   * `bucket_start` is the epoch-ms start of the bucket, or null for messages
   * with no timestamp (only reachable when the caller passes no since/until,
   * since a period filter drops them).
   *
   * Σ over buckets == `getMessageTotals` for identical filters BY CONSTRUCTION
   * (same filter builder, same membership subquery) — that is what makes the
   * dashboard's byDay/byHour reconcile with its headline.
   */
  getMessageTotalsByBucket(filters: MessageFilter = {}): MessageBucketTotalRow[] {
    const f = this.buildMessageFilter(filters);
    const sql = `
      SELECT
        (m.timestamp / ${Store.BUCKET_MS}) * ${Store.BUCKET_MS} AS bucket_start,
        m.model AS model,
        SUM(m.input_tokens) AS input_tokens,
        SUM(m.output_tokens) AS output_tokens,
        SUM(m.cache_read_tokens) AS cache_read_tokens,
        SUM(m.cache_creation_tokens) AS cache_creation_tokens,
        COUNT(*) AS msg_count,
        SUM(m.is_turn_start) AS prompt_count
      FROM messages m
      WHERE ${this.messageWhereExists(f)}
      GROUP BY bucket_start, m.model
    `;
    const params = f.params;
    const stmt = this.db.prepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as MessageBucketTotalRow[];
  }

  /**
   * Per-project, per-model token totals for messages SENT in the window — the
   * message-scoped counterpart of the session-row `byProject` accumulation.
   * Σ over projects == `getMessageTotals` for identical filters.
   */
  getMessageTotalsByProject(filters: MessageFilter = {}): MessageProjectTotalRow[] {
    const f = this.buildMessageFilter(filters);
    // INNER JOIN reproduces the EXISTS orphan-drop exactly (one row per
    // qualifying message, `sessions.session_id` being unique) while making
    // s.project_path available to GROUP BY.
    const sql = `
      SELECT
        s.project_path AS project_path,
        m.model AS model,
        SUM(m.input_tokens) AS input_tokens,
        SUM(m.output_tokens) AS output_tokens,
        SUM(m.cache_read_tokens) AS cache_read_tokens,
        SUM(m.cache_creation_tokens) AS cache_creation_tokens,
        COUNT(*) AS msg_count,
        SUM(m.is_turn_start) AS prompt_count
      FROM messages m
      JOIN sessions s ON s.session_id = m.session_id
      WHERE ${this.messageWhereJoin(f)}
      GROUP BY s.project_path, m.model
    `;
    const params = f.params;
    const stmt = this.db.prepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as MessageProjectTotalRow[];
  }

  private getMessageTotalsRaw(filters: MessageFilter = {}): MessageTotalRow[] {
    const f = this.buildMessageFilter(filters);
    const params = f.params;
    // EXISTS (not IN): preserves orphan-drop AND lets the m.timestamp filter
    // seek idx_messages_timestamp. An `IN (SELECT all session_ids)` would make
    // the planner iterate every session_id via idx_messages_session instead,
    // defeating the timestamp seek.
    const sql = `
      SELECT
        m.model,
        SUM(m.input_tokens) AS input_tokens,
        SUM(m.output_tokens) AS output_tokens,
        SUM(m.cache_read_tokens) AS cache_read_tokens,
        SUM(m.cache_creation_tokens) AS cache_creation_tokens
      FROM messages m
      WHERE ${this.messageWhereExists(f)}
      GROUP BY m.model
    `;
    const stmt = this.db.prepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as MessageTotalRow[];
  }

  /**
   * Per-account, per-model token totals for messages SENT in the window — the
   * SAME query `getMessageTotalsRaw` runs (message-timestamp filter + the same
   * session-scoped conditions), just carrying `account_uuid` and grouping by it.
   *
   * Summing this over accounts+models therefore equals `getMessageTotalsRaw` for
   * identical filters — i.e. Σ byAccount == headline BY CONSTRUCTION. This is the
   * message-scoped source `buildDashboard.byAccount` uses instead of the session
   * `rows` set, so per-account cost reconciles with the headline even when a
   * session's `first/last_timestamp` aggregate columns drift from its actual
   * message timestamps (e.g. a NULL `last_timestamp` with an early
   * `first_timestamp` — which the session-scoped `activeSince` predicate drops
   * but the message-timestamp filter keeps).
   *
   * The INNER JOIN on the unique `sessions.session_id` reproduces
   * `getMessageTotalsRaw`'s EXISTS orphan-drop exactly (one row per qualifying
   * message), so orphan messages are dropped identically in both.
   */
  getMessageTotalsByAccount(filters: MessageFilter = {}): AccountModelTotalRow[] {
    // Shares buildMessageFilter with the headline (it used to duplicate the
    // condition list, which is how it silently missed includeCI/includeDeleted).
    const f = this.buildMessageFilter(filters);
    const params = f.params;
    const sql = `
      SELECT s.account_uuid AS account_uuid, m.model AS model,
        SUM(m.input_tokens) AS input_tokens,
        SUM(m.output_tokens) AS output_tokens,
        SUM(m.cache_read_tokens) AS cache_read_tokens,
        SUM(m.cache_creation_tokens) AS cache_creation_tokens
      FROM messages m
      JOIN sessions s ON s.session_id = m.session_id
      WHERE ${this.messageWhereJoin(f)}
      GROUP BY s.account_uuid, m.model
    `;
    const stmt = this.db.prepare(sql);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(...params) as AccountModelTotalRow[];
  }

  getSessions(filters: {
    projectPath?: string;
    repoUrl?: string;
    accountUuid?: string;
    entrypoint?: string;
    tag?: string;
    /**
     * Narrow to sessions attributed to this work-item key. Negated (tombstoned)
     * links are excluded, so a user's "not this ticket" correction wins over any
     * number of agreeing automatic links. Mirrored in `MessageFilter` — see the
     * symmetry contract there.
     */
    ticket?: string;
    since?: number;
    /**
     * Include sessions that were ACTIVE at/after this epoch-ms — i.e. their last
     * message lands in the period even if the session STARTED before it, so a
     * session straddling the period boundary (e.g. one running across midnight)
     * is counted. Use this instead of `since` when the count must agree with
     * message-timestamp-filtered metrics (cost/energy). Mutually complementary
     * with `since` (start-in-period); pass one or the other, not both.
     *
     * Membership is satisfied EITHER by the session's own aggregate columns
     * (`COALESCE(last_timestamp, first_timestamp) >= activeSince`) OR by having a
     * MESSAGE in the window. The message clause is what makes this predicate
     * agree with the message-scoped reads (getMessageTotals, getMessageTimestamps)
     * by construction rather than by coincidence: whenever those attribute cost
     * to the period, the owning session is in this set too. Without it a session
     * whose aggregates drift from its messages — historically a NULL
     * `last_timestamp` beside an early `first_timestamp` — is dropped here while
     * its cost still lands in the headline, rendering "0 sessions" beside a
     * non-zero cost.
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
    if (filters.ticket) {
      conditions.push(ticketPredicate("session_id"));
      params.push(filters.ticket, filters.ticket);
    }
    if (filters.since !== undefined) {
      conditions.push("first_timestamp >= ?");
      params.push(filters.since);
    }
    if (filters.activeSince !== undefined) {
      // Session overlaps [activeSince, until): either its own aggregate columns
      // say so, or it owns a message in the window. The second arm is the
      // authoritative one — it is the same predicate the message-scoped reads
      // use, so this set can never fall out of sync with the headline totals
      // even when a session's cached first/last_timestamp are wrong or NULL.
      const msgConds = ["m.session_id = sessions.session_id", "m.timestamp >= ?"];
      const msgParams: unknown[] = [filters.activeSince];
      if (filters.until !== undefined) {
        msgConds.push("m.timestamp < ?");
        msgParams.push(filters.until);
      }
      conditions.push(
        `(COALESCE(last_timestamp, first_timestamp) >= ?
          OR EXISTS (SELECT 1 FROM messages m WHERE ${msgConds.join(" AND ")}))`
      );
      params.push(filters.activeSince, ...msgParams);
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
  listAccounts(filters: { since?: number; until?: number; includeCI?: boolean; includeDeleted?: boolean } = {}): Array<{
    accountUuid: string;
    subscriptionType: string | null;
    sessionCount: number;
  }> {
    const conditions: string[] = ["account_uuid IS NOT NULL"];
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
    // Mirror getSessions: only exclude source_deleted rows when NOT asked to
    // include them. After buildDashboard's `rows` flip, the account selector
    // must list the same accounts byAccount can show (Blocker 2), so the
    // dashboard passes includeDeleted: true here.
    if (!filters.includeDeleted) {
      conditions.push("source_deleted = 0");
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

  /**
   * Session ids owning at least one message selected by `filters` — i.e. the
   * SESSION set implied by the message-scoped half of the filter contract.
   *
   * Exists so the two halves can be compared directly: every session the
   * message half prices must appear in `getSessions` under the same filter.
   * That property is asserted as a test, and this is the read it asserts
   * against. Also the natural basis for a coverage denominator (which sessions
   * contributed cost in the window).
   */
  getSessionIdsWithMessages(filters: MessageFilter = {}): string[] {
    const f = this.buildMessageFilter(filters);
    const where = this.messageWhereExists(f);
    const stmt = this.db.prepare(
      `SELECT DISTINCT m.session_id AS session_id FROM messages m WHERE ${where} ORDER BY m.session_id`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (stmt.all as (...args: any[]) => unknown[])(...f.params) as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id);
  }

  // ─── Ticket links ──────────────────────────────────────────────────────────
  //
  // Storage seam only. The extraction pass (which sources to scan, how to grade
  // and upgrade confidence) is a separate concern and lives outside the store —
  // it is a pure function of already-parsed data, and keeping it out of here is
  // what lets it be property-tested without a database.

  /**
   * Record one attribution link. Idempotent per (session, key, source): a
   * re-run of extraction refreshes the row rather than duplicating it.
   *
   * A MANUAL row is never overwritten by an automatic one. Extraction re-runs
   * on every collect, so without that rule a user's correction would silently
   * revert the next time the branch name was re-scanned — the single most
   * corrosive bug this feature could ship, because it would look like the tool
   * ignoring the user.
   */
  addTicketLink(link: {
    sessionId: string;
    ticketKey: string;
    source: string;
    confidence: string;
    granularity?: string;
    firstUuid?: string | null;
    lastUuid?: string | null;
    evidence?: string | null;
    negated?: boolean;
  }): void {
    const key = requireTicketKey(link.ticketKey);
    this.db
      .prepare(
        `INSERT INTO ticket_links
           (session_id, ticket_key, source, confidence, granularity,
            first_uuid, last_uuid, evidence, negated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, ticket_key, source) DO UPDATE SET
           confidence  = excluded.confidence,
           granularity = excluded.granularity,
           first_uuid  = excluded.first_uuid,
           last_uuid   = excluded.last_uuid,
           evidence    = excluded.evidence,
           negated     = excluded.negated
         WHERE ticket_links.source != 'tag'`,
      )
      .run(
        link.sessionId,
        key,
        link.source,
        link.confidence,
        link.granularity ?? "session",
        link.firstUuid ?? null,
        link.lastUuid ?? null,
        link.evidence ?? null,
        link.negated ? 1 : 0,
        Date.now(),
      );
  }

  /** Remove one link. Used to undo a manual assignment. */
  removeTicketLink(sessionId: string, ticketKey: string, source: string): void {
    this.db
      .prepare("DELETE FROM ticket_links WHERE session_id = ? AND ticket_key = ? AND source = ?")
      .run(sessionId, requireTicketKey(ticketKey), source);
  }

  /**
   * Tombstone a key for a session: "this session is NOT this ticket". Written
   * at the `tag` (manual) source so it outranks every automatic row, and so a
   * later extraction pass cannot resurrect the wrong link.
   */
  negateTicketLink(sessionId: string, ticketKey: string): void {
    const key = requireTicketKey(ticketKey);
    this.db
      .prepare(
        `INSERT INTO ticket_links
           (session_id, ticket_key, source, confidence, granularity, negated, created_at)
         VALUES (?, ?, 'tag', 'high', 'session', 1, ?)
         ON CONFLICT (session_id, ticket_key, source) DO UPDATE SET negated = 1`,
      )
      .run(sessionId, key, Date.now());
  }

  /** All links for one session, tombstones included (callers decide). */
  getTicketLinksForSession(sessionId: string): TicketLinkRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM ticket_links WHERE session_id = ? ORDER BY ticket_key, source",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (stmt.all as (...args: any[]) => unknown[])(sessionId) as TicketLinkRow[];
  }

  /**
   * Distinct ticket keys present in the store, with their session counts.
   *
   * Applies the same two-clause tombstone rule as `ticketPredicate`: a
   * (session, key) pair counts only when some row affirms it AND no row negates
   * it. Checking `negated = 0` alone would keep counting a session whose branch
   * name still says `PROJ-9` after the user explicitly said it isn't — the
   * correction has to hold everywhere the key is reported, not just where it is
   * filtered.
   */
  getTicketKeys(): Array<{ ticket_key: string; session_count: number }> {
    return this.db
      .prepare(
        `SELECT ticket_key, COUNT(DISTINCT session_id) AS session_count
           FROM ticket_links tl
          WHERE tl.negated = 0
            AND NOT EXISTS (
              SELECT 1 FROM ticket_links tn
               WHERE tn.session_id = tl.session_id
                 AND tn.ticket_key = tl.ticket_key
                 AND tn.negated = 1
            )
          GROUP BY ticket_key ORDER BY session_count DESC, ticket_key`,
      )
      .all() as Array<{ ticket_key: string; session_count: number }>;
  }

  /**
   * Every ACTIVE (non-tombstoned) `ticket_links` row, source-graded, across the
   * whole store. Query-path building block for per-ticket cost aggregation
   * (`packages/cli/src/ticketing/index.ts`): the caller already knows which
   * sessions fall in its reporting window (from `getSessionIdsWithMessages`
   * under the SAME filters used to price them), so intersecting there — rather
   * than this method taking its own period/project/account filter — keeps
   * exactly one source of truth for "which sessions are in scope" instead of
   * two overlapping filter implementations that could drift apart.
   *
   * Same two-clause tombstone rule as `getTicketKeys` / `ticketPredicate`, at
   * row (not just distinct-key) granularity, since aggregation needs every
   * corroborating source row to grade confidence correctly.
   */
  getActiveTicketLinks(): Array<{
    session_id: string;
    ticket_key: string;
    source: string;
    confidence: string;
  }> {
    return this.db
      .prepare(
        `SELECT tl.session_id, tl.ticket_key, tl.source, tl.confidence
           FROM ticket_links tl
          WHERE tl.negated = 0
            AND NOT EXISTS (
              SELECT 1 FROM ticket_links tn
               WHERE tn.session_id = tl.session_id
                 AND tn.ticket_key = tl.ticket_key
                 AND tn.negated = 1
            )`,
      )
      .all() as Array<{ session_id: string; ticket_key: string; source: string; confidence: string }>;
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

  /**
   * Returns per-session per-model token totals for the given session IDs.
   *
   * This method serves two callers that need DIFFERENT time bounds:
   *  - `getCostBySession` (→ list_sessions per-session `estimatedCost`) wants a
   *    session's WHOLE-lifetime cost regardless of the query window — it calls
   *    this UNBOUNDED (the default).
   *  - `buildDashboard`'s `sessionCostMap` (→ byAccount / byConversationCost /
   *    spending / contextAnalysis) wants each session's IN-WINDOW contribution
   *    only, since those numbers are presented as scoped to the query range —
   *    it passes `{ since, until }`.
   * (See analysis §3.3.3.) The default (no opts) is byte-for-byte the prior
   * unbounded query, so every existing caller is unchanged.
   */
  getMessageTotalsBySession(
    sessionIds: string[],
    opts: { since?: number; until?: number } = {},
  ): SessionMessageTotalRow[] {
    if (sessionIds.length === 0) return [];
    // Process in batches of 500 to avoid SQLite variable limit
    const results: SessionMessageTotalRow[] = [];
    // Optional timestamp bound, mirroring getMessageTotalsRaw's [since, until).
    // Built once; the batch ids bind first, then the bounds — matching the `?`
    // order in the SQL below.
    const boundConditions: string[] = [];
    const boundParams: unknown[] = [];
    if (opts.since !== undefined) {
      boundConditions.push("timestamp >= ?");
      boundParams.push(opts.since);
    }
    if (opts.until !== undefined) {
      boundConditions.push("timestamp < ?");
      boundParams.push(opts.until);
    }
    const boundAnd = boundConditions.length ? ` AND ${boundConditions.join(" AND ")}` : "";
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
        WHERE session_id IN (${placeholders})${boundAnd}
        GROUP BY session_id, model
      `);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (stmt.all as (...args: any[]) => unknown[])(...batch, ...boundParams) as SessionMessageTotalRow[];
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
    until?: number;
  }): { where: string; params: unknown[] } {
    // Period filtered on MESSAGE timestamp; session-scoped filters in an
    // always-emitted membership subquery (orphan-drop preserved). The
    // since/until params are bound before the subquery params to match the
    // `?` order.
    const sessionConditions: string[] = [];
    const params: unknown[] = [];
    const tsClause =
      (filters.since !== undefined ? "AND m.timestamp >= ? " : "") +
      (filters.until !== undefined ? "AND m.timestamp < ? " : "");
    if (filters.since !== undefined) { params.push(filters.since); }
    if (filters.until !== undefined) { params.push(filters.until); }
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
    until?: number;
  } = {}): EnergyAggregates {
    const fullyUnbounded =
      filters.since === undefined &&
      filters.until === undefined &&
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
    until?: number;
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

    const sessionCount = (this.db.prepare("SELECT COUNT(*) as c FROM sessions WHERE source_deleted = 0").get() as { c: number }).c;
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

  // ─── Cost-ownership rules (V15) ─────────────────────────────────────────────

  /**
   * Validate and insert an owner rule. Enforces:
   *   - at least one of pathGlob/remoteGlob is non-null
   *   - neither glob is all-wildcards (strip "*" and "/" — if empty, reject)
   *   - target is either {kind:'split'} or {kind:'account', accountUuid} where
   *     the UUID matches the expected format AND exists in the accounts table
   *   - total rule count does not exceed 200
   * Returns the created OwnerRule (with id + createdAt from DB).
   */
  createOwnerRule(
    input: { pathGlob: string | null; remoteGlob: string | null; target: OwnerTarget },
    now: () => number,
  ): OwnerRule {
    // ─── validation ───────────────────────────────────────────────────────────

    if (input.pathGlob === null && input.remoteGlob === null) {
      throw new Error("At least one of pathGlob or remoteGlob must be non-null");
    }

    // Helper: reject a glob whose non-wildcard, non-separator content is empty
    const isAllWildcard = (glob: string): boolean => {
      return glob.replace(/[*/]/g, "").length === 0;
    };

    if (input.pathGlob !== null && isAllWildcard(input.pathGlob)) {
      throw new Error(
        `pathGlob "${input.pathGlob}" is too broad (only wildcards/slashes) — it would match everything`,
      );
    }
    if (input.remoteGlob !== null && isAllWildcard(input.remoteGlob)) {
      throw new Error(
        `remoteGlob "${input.remoteGlob}" is too broad (only wildcards/slashes) — it would match everything`,
      );
    }

    // Validate target
    if (input.target.kind === "account") {
      const uuid = input.target.accountUuid;
      if (!/^[0-9a-f-]{8,64}$/i.test(uuid)) {
        throw new Error(
          `target.accountUuid "${uuid}" does not match expected UUID format (^[0-9a-f-]{8,64}$)`,
        );
      }
      const accountRow = this.db
        .prepare("SELECT 1 FROM accounts WHERE account_uuid = ?")
        .get(uuid);
      if (!accountRow) {
        throw new Error(`target.accountUuid "${uuid}" does not exist in the accounts table`);
      }
    }
    // else: target.kind === 'split' — valid, no further checks needed

    // Cap at 200 rules
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS c FROM account_owner_rules")
      .get() as { c: number };
    if (countRow.c >= 200) {
      throw new Error(
        `Cannot create owner rule: limit of 200 rules reached (currently ${countRow.c}). Delete an existing rule first.`,
      );
    }

    // Serialize target to storage form
    const targetStr = input.target.kind === "split" ? "split" : input.target.accountUuid;
    const createdAt = now();

    const result = this.db
      .prepare(`
        INSERT INTO account_owner_rules (path_glob, remote_glob, target, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(input.pathGlob, input.remoteGlob, targetStr, createdAt);

    const id = Number(result.lastInsertRowid);
    return {
      id,
      pathGlob: input.pathGlob,
      remoteGlob: input.remoteGlob,
      target: input.target,
      createdAt,
    };
  }

  /** Read all owner rules, parsing the stored target string to OwnerTarget. */
  listOwnerRules(): OwnerRule[] {
    const rows = this.db
      .prepare(
        "SELECT id, path_glob, remote_glob, target, created_at FROM account_owner_rules ORDER BY created_at ASC, id ASC",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r["id"] as number,
      pathGlob: r["path_glob"] as string | null,
      remoteGlob: r["remote_glob"] as string | null,
      target: ownerTargetFromString(r["target"] as string),
      createdAt: r["created_at"] as number,
    }));
  }

  /** Delete an owner rule by id. */
  deleteOwnerRule(id: number): void {
    this.db.prepare("DELETE FROM account_owner_rules WHERE id = ?").run(id);
  }

  /**
   * Apply an explicit owner override to sessions. UNCONDITIONAL — an explicit
   * policy outranks all inference and even otel/telemetry/anchor sources. Runs
   * all updates in a single transaction with ONE prepared statement bound per row.
   * The organization_uuid is COALESCE'd from the target account (never nulled).
   * Returns the number of rows changed.
   */
  applyOwnerOverride(
    mapping: Map<string, string> /* sessionId -> accountUuid */,
    now: () => number,
  ): number {
    if (mapping.size === 0) return 0;
    const stmt = this.db.prepare(`
      UPDATE sessions SET
        account_uuid       = ?,
        organization_uuid  = COALESCE(
          (SELECT organization_uuid FROM accounts WHERE account_uuid = ?),
          organization_uuid
        ),
        account_source     = 'override',
        account_confidence = 'authoritative',
        updated_at         = ?
      WHERE session_id = ?
    `);
    let changed = 0;
    this.transaction(() => {
      const ts = now();
      for (const [sessionId, accountUuid] of mapping) {
        const result = stmt.run(accountUuid, accountUuid, ts, sessionId);
        changed += Number(result.changes);
      }
    });
    return changed;
  }

  /**
   * Clear override attribution for a specific set of sessions. Only clears rows
   * whose account_source='override' — otel/telemetry/anchor rows are preserved.
   * This is the rule-scoped revert path: the caller passes the matched sessionIds
   * for the rule being cleared. Returns the number of rows changed.
   */
  clearOverridesForRule(sessionIds: string[]): number {
    if (sessionIds.length === 0) return 0;
    let changed = 0;
    const stmt = this.db.prepare(`
      UPDATE sessions SET
        account_uuid       = NULL,
        organization_uuid  = NULL,
        account_source     = NULL,
        account_confidence = NULL
      WHERE session_id = ? AND account_source = 'override'
    `);
    for (const sessionId of sessionIds) {
      const result = stmt.run(sessionId);
      changed += Number(result.changes);
    }
    return changed;
  }

  /**
   * Clear ALL owner-derived override attribution in a single statement. Every
   * account_source='override' row is reset to NULL (all overrides come from
   * owner rules — applyOwnerOverride is the only writer of that source), which
   * makes those rows eligible for re-inference again.
   *
   * This is the fast, set-based counterpart to clearOverridesForRule. The guided
   * classifier's apply step recomputes the WHOLE owner-rule effect from the
   * current rule set, so it must first drop any stale override — e.g. one left
   * by a rule the user just switched to 'split' or removed — before re-inferring
   * and re-applying the current rules (reattribute's reset deliberately
   * PRESERVES override rows, so it cannot do this itself). Returns rows changed.
   */
  clearAllOwnerOverrides(): number {
    const result = this.db
      .prepare(`
        UPDATE sessions SET
          account_uuid       = NULL,
          organization_uuid  = NULL,
          account_source     = NULL,
          account_confidence = NULL
        WHERE account_source = 'override'
      `)
      .run();
    return Number(result.changes);
  }

  /**
   * Compute estimated cost per session. Reuses getMessageTotalsBySession and
   * estimateCost. When sessionIds is provided, restricts to those sessions;
   * otherwise reads all sessions (by fetching all distinct session IDs from the
   * messages table).
   */
  getCostBySession(sessionIds?: string[]): Map<string, number> {
    let ids: string[];
    if (sessionIds !== undefined) {
      ids = sessionIds;
    } else {
      // Read all session IDs that have messages
      const rows = this.db
        .prepare("SELECT DISTINCT session_id FROM messages")
        .all() as Array<{ session_id: string }>;
      ids = rows.map((r) => r.session_id);
    }
    if (ids.length === 0) return new Map();

    const totals = this.getMessageTotalsBySession(ids);
    const costMap = new Map<string, number>();
    for (const row of totals) {
      const current = costMap.get(row.session_id) ?? 0;
      const { cost } = estimateCost(
        row.model,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens,
        row.cache_creation_tokens,
      );
      costMap.set(row.session_id, current + cost);
    }
    return costMap;
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

/**
 * Parse the stored target string back to a typed OwnerTarget.
 * The DB stores 'split' or the raw account UUID.
 */
export function ownerTargetFromString(stored: string): OwnerTarget {
  if (stored === "split") return { kind: "split" };
  return { kind: "account", accountUuid: stored };
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
  /** Attribution provenance (V13 columns; present at runtime via SELECT *). */
  account_source?: string | null;
  account_confidence?: string | null;
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

/** A raw `ticket_links` row (schema V19). */
export interface TicketLinkRow {
  session_id: string;
  ticket_key: string;
  source: string;
  confidence: string;
  granularity: string;
  first_uuid: string | null;
  last_uuid: string | null;
  evidence: string | null;
  negated: number;
  created_at: number;
}

export interface SessionMessageTotalRow {
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/**
 * Filter accepted by every message-scoped aggregate. Deliberately mirrors the
 * `getSessions` filters that narrow the session set, so a caller can pass the
 * SAME values to both and have the two reconcile. Adding a narrowing dimension
 * to `getSessions` without adding it here is how the halves drift apart.
 */
export interface MessageFilter {
  projectPath?: string;
  repoUrl?: string;
  accountUuid?: string;
  entrypoint?: string;
  /**
   * Work-item key (schema V19 `ticket_links`). Excludes tombstoned links, and
   * uses the same `ticketPredicate` SQL as `getSessions` so the two halves
   * cannot diverge.
   */
  ticket?: string;
  /** Session tag (schema V5 `session_tags`). Mirrors `getSessions({tag})`. */
  tag?: string;
  since?: number;
  until?: number;
  /** Explicit `false` excludes non-interactive (CI) sessions. */
  includeCI?: boolean;
  /** Explicit `false` excludes sessions whose transcript was deleted. */
  includeDeleted?: boolean;
}

export interface MessageTotalRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

/** One 15-minute time bucket × model of in-window message totals. */
export interface MessageBucketTotalRow extends MessageTotalRow {
  /** Epoch-ms start of the bucket; null for messages with no timestamp. */
  bucket_start: number | null;
  msg_count: number;
  /** Real user turns started in this bucket (Σ is_turn_start). */
  prompt_count: number;
}

/** One project × model of in-window message totals. */
export interface MessageProjectTotalRow extends MessageTotalRow {
  project_path: string;
  msg_count: number;
  /** Real user turns started in this project in the window (Σ is_turn_start). */
  prompt_count: number;
}

export interface AccountModelTotalRow {
  account_uuid: string | null;
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
