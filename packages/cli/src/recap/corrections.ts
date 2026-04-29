/**
 * User-corrections client for the daily-recap feature (v3.09).
 *
 * Corrections are keyed by a signature of the work (project path + sorted
 * normalised file paths + prompt prefix) so they apply to recurring tasks
 * across days without being tied to a specific date.
 *
 * Security: SR-6 — All SQL writes use parameterised queries (db.prepare().run()).
 * No string interpolation around SQL is used anywhere in this file.
 *
 * File: ~/.claude-stats/recap-corrections.db, mode 0o600 (via fs-secure).
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SegmentId } from './types.js';
import { ensurePrivateDir } from './fs-secure.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CorrectionSignature {
  projectPath: string;
  filePaths: readonly string[];     // sorted, normalised
  promptPrefix: string;             // first 80 chars of normalised prompt
}

export type CorrectionAction =
  | { kind: 'merge'; otherSignature: CorrectionSignature }
  | { kind: 'split'; segmentId: SegmentId }
  | { kind: 'rename'; label: string }
  | { kind: 'hide' };

export interface CorrectionsClient {
  add(sig: CorrectionSignature, action: CorrectionAction): void;
  forSignature(sig: CorrectionSignature): readonly CorrectionAction[];
  remove(sig: CorrectionSignature, action: CorrectionAction): void;
  list(): readonly { id: number; sig: CorrectionSignature; action: CorrectionAction }[];
  close(): void;
}

// ─── Validation ───────────────────────────────────────────────────────────────

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const MAX_LABEL_LEN = 200;
const MAX_FILE_PATHS = 100;
const MAX_FILE_PATH_LEN = 500;
const MAX_PROMPT_PREFIX_LEN = 80;

/**
 * Validate and sanitise a rename label.
 * Throws with a clear message if validation fails (SR-6).
 */
function validateLabel(label: string): void {
  if (label.length > MAX_LABEL_LEN) {
    throw new Error(
      `Correction label too long: ${label.length} chars (max ${MAX_LABEL_LEN}). Truncate your label.`,
    );
  }
  if (CONTROL_CHAR_RE.test(label)) {
    throw new Error(
      'Correction label contains control characters (\\x00-\\x1f, \\x7f). Remove them and try again.',
    );
  }
}

/**
 * Validate and normalise a CorrectionSignature.
 * Truncates promptPrefix and enforces filePaths limits.
 */
function validateAndNormaliseSig(sig: CorrectionSignature): CorrectionSignature {
  if (sig.filePaths.length > MAX_FILE_PATHS) {
    throw new Error(
      `Signature filePaths too many: ${sig.filePaths.length} (max ${MAX_FILE_PATHS}).`,
    );
  }
  for (const fp of sig.filePaths) {
    if (fp.length > MAX_FILE_PATH_LEN) {
      throw new Error(
        `Signature file path too long: ${fp.length} chars (max ${MAX_FILE_PATH_LEN}).`,
      );
    }
  }
  return {
    ...sig,
    promptPrefix: sig.promptPrefix.slice(0, MAX_PROMPT_PREFIX_LEN),
  };
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  file_paths_json TEXT NOT NULL,
  prompt_prefix TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  action_payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corrections_signature
  ON corrections(project_path, prompt_prefix);
`;

// ─── Row helpers ──────────────────────────────────────────────────────────────

interface CorrectionsRow {
  id: number;
  project_path: string;
  file_paths_json: string;
  prompt_prefix: string;
  action_kind: string;
  action_payload_json: string;
  created_at: number;
}

function rowToEntry(row: CorrectionsRow): {
  id: number;
  sig: CorrectionSignature;
  action: CorrectionAction;
} {
  const sig: CorrectionSignature = {
    projectPath: row.project_path,
    filePaths: JSON.parse(row.file_paths_json) as string[],
    promptPrefix: row.prompt_prefix,
  };

  const payload = JSON.parse(row.action_payload_json) as Record<string, unknown>;
  let action: CorrectionAction;

  switch (row.action_kind) {
    case 'merge':
      action = { kind: 'merge', otherSignature: payload['otherSignature'] as CorrectionSignature };
      break;
    case 'split':
      action = { kind: 'split', segmentId: payload['segmentId'] as SegmentId };
      break;
    case 'rename':
      action = { kind: 'rename', label: payload['label'] as string };
      break;
    case 'hide':
      action = { kind: 'hide' };
      break;
    default:
      throw new Error(`Unknown correction kind: ${row.action_kind}`);
  }

  return { id: row.id, sig, action };
}

function actionToKindAndPayload(action: CorrectionAction): {
  kind: string;
  payload: Record<string, unknown>;
} {
  switch (action.kind) {
    case 'merge':
      return { kind: 'merge', payload: { otherSignature: action.otherSignature } };
    case 'split':
      return { kind: 'split', payload: { segmentId: action.segmentId } };
    case 'rename':
      return { kind: 'rename', payload: { label: action.label } };
    case 'hide':
      return { kind: 'hide', payload: {} };
  }
}

// ─── openCorrections ─────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  '.claude-stats',
  'recap-corrections.db',
);

/**
 * Open (creating if absent) a corrections database at dbPath.
 * The file and parent directory are created with private permissions (SR-3).
 */
export function openCorrections(opts?: { dbPath?: string }): CorrectionsClient {
  const dbPath = opts?.dbPath ?? DEFAULT_DB_PATH;
  const dbDir = path.dirname(dbPath);

  // Ensure parent directory exists with 0o700 (SR-3)
  ensurePrivateDir(dbDir);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA_SQL);

  // Set file mode 0o600 after open (SR-3)
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // Non-fatal if already correct
  }

  // ─── Prepared statements ────────────────────────────────────────────────────
  // All writes use parameterised queries (SR-6).

  const stmtInsert = db.prepare(
    `INSERT INTO corrections
      (project_path, file_paths_json, prompt_prefix, action_kind, action_payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const stmtSelectBySig = db.prepare(
    `SELECT * FROM corrections
     WHERE project_path = ? AND prompt_prefix = ?
     ORDER BY id ASC`,
  );

  const stmtDelete = db.prepare(
    `DELETE FROM corrections
     WHERE project_path = ? AND prompt_prefix = ?
       AND action_kind = ? AND action_payload_json = ?`,
  );

  const stmtSelectAll = db.prepare(
    `SELECT * FROM corrections ORDER BY id ASC`,
  );

  return {
    add(sig: CorrectionSignature, action: CorrectionAction): void {
      const normSig = validateAndNormaliseSig(sig);

      // Validate label for rename actions (SR-6)
      if (action.kind === 'rename') {
        validateLabel(action.label);
      }

      const { kind, payload } = actionToKindAndPayload(action);

      stmtInsert.run(
        normSig.projectPath,
        JSON.stringify([...normSig.filePaths].sort()),
        normSig.promptPrefix,
        kind,
        JSON.stringify(payload),
        Date.now(),
      );
    },

    forSignature(sig: CorrectionSignature): readonly CorrectionAction[] {
      const normSig = validateAndNormaliseSig(sig);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = ((stmtSelectBySig.all as (...args: any[]) => unknown[])(
        normSig.projectPath,
        normSig.promptPrefix,
      )) as unknown as CorrectionsRow[];

      // Filter by file_paths_json match (the index only covers project_path + prompt_prefix)
      const filePathsJson = JSON.stringify([...normSig.filePaths].sort());
      return rows
        .filter((row) => row.file_paths_json === filePathsJson)
        .map((row) => rowToEntry(row).action);
    },

    remove(sig: CorrectionSignature, action: CorrectionAction): void {
      const normSig = validateAndNormaliseSig(sig);
      const { kind, payload } = actionToKindAndPayload(action);

      stmtDelete.run(
        normSig.projectPath,
        normSig.promptPrefix,
        kind,
        JSON.stringify(payload),
      );
    },

    list(): readonly { id: number; sig: CorrectionSignature; action: CorrectionAction }[] {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = stmtSelectAll.all() as unknown as CorrectionsRow[];
      return rows.map((row) => rowToEntry(row));
    },

    close(): void {
      db.close();
    },
  };
}

// ─── computeSignature helper ────────────────────────────────────────────────

const PUNCTUATION_RE_SIG = /[^\p{L}\p{N}\s]/gu;
const STOP_WORDS_SIG = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'is', 'was',
  'in', 'on', 'for', 'with', 'this', 'that', 'my', 'your',
  'please', 'can', 'could', 'will',
]);

/**
 * Normalise a prompt for use in a correction signature.
 * Lowercase, strip punctuation, drop stop-words, take first 80 chars.
 * Must be consistent with the normalisation used in cluster.ts.
 */
export function normalisePromptForSig(text: string): string {
  return text
    .toLowerCase()
    .replace(PUNCTUATION_RE_SIG, '')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS_SIG.has(w))
    .join(' ')
    .slice(0, MAX_PROMPT_PREFIX_LEN);
}

/**
 * Compute a CorrectionSignature from a DailyDigestItem.
 * Shared between the cluster integration and CLI handlers so both use
 * the exact same normalisation (single source of truth).
 */
export function computeSignature(item: {
  project: string;
  filePathsTouched: readonly string[];
  firstPrompt: string | null;
}): CorrectionSignature {
  // wrapUntrusted prepends an advisory note line and wraps the real content
  // in <untrusted-stored-content>...</untrusted-stored-content> tags. Extract
  // the inner content so signatures from CLI-supplied digest items match the
  // signatures the clusterer computes from raw prompt text. Stripping only
  // the tags would leave the advisory note polluting the prefix.
  let rawPrompt = '';
  if (item.firstPrompt) {
    const match = item.firstPrompt.match(
      /<untrusted-stored-content>([\s\S]*?)<\/untrusted-stored-content>/
    );
    rawPrompt = (match ? match[1]! : item.firstPrompt).trim();
  }

  return {
    projectPath: item.project,
    filePaths: [...item.filePathsTouched].sort(),
    promptPrefix: normalisePromptForSig(rawPrompt),
  };
}
