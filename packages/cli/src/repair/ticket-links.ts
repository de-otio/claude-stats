/**
 * Ticket-link re-extraction.
 *
 * Extraction (`runTicketExtraction`) runs once per session at `collect` time and
 * only ever ADDS rows, so the configured project-key allowlist is applied at the
 * moment a session is first seen and never revisited. Change
 * `tickets.projectKeys` and nothing already recorded moves: the keys that a new
 * allowlist would now reject stay attributed, and branch matches that would now
 * qualify for `high` confidence stay at `medium`. That is the gap this repair
 * closes — the one the Settings field's own copy has to admit to until it exists.
 *
 * The safety rule, and the reason this can be a repair rather than a migration:
 *
 *   **Automatic links are derived; manual links are testimony.**
 *
 * Every non-`tag` row can be rebuilt from the session's branch name, its
 * project's commits and its own prompt text — deleting one costs nothing that
 * this pass does not immediately recompute. A `tag` row is a statement the user
 * made (an assignment, or a tombstone saying "this session is NOT that ticket")
 * that no amount of re-reading the data can reproduce. So the delete is scoped
 * to `source != 'tag'` in ONE place (`Store#deleteAutomaticTicketLinks`), and
 * the summary reports how many manual rows it left behind rather than asking to
 * be trusted about it.
 *
 * Shape follows `repair/project-paths.ts`: `--dry-run` reports without writing,
 * a real run backs up the DB file first and applies everything in one
 * transaction.
 *
 * Two properties of that transaction are deliberate:
 *
 *  - **No `git log` runs inside it.** The commit subjects every session needs
 *    are fetched in a warm-up pass beforehand, into the same cache the write
 *    pass then reads (`ticketCommitWindow` keeps the bounds identical, so the
 *    second pass is all cache hits). Otherwise a few hundred subprocesses would
 *    execute while holding SQLite's write lock, and a background `collect` from
 *    the VS Code extension would fail on a locked database.
 *  - **Parents are processed before their subagents.** Subagent inheritance
 *    reads the parent's links at call time, so `collect`'s arbitrary file order
 *    leaves it a coin flip (documented as a known limitation on
 *    `runTicketExtraction`). A bulk pass gets to choose the order, so it does —
 *    and this is the one path where subagent inheritance is reliable.
 */
import fs from "node:fs";
import type { Store, SessionRow } from "../store/index.js";
import { runTicketExtraction, ticketCommitWindow } from "../ticketing/index.js";
import { createCommitSubjectsCache, getCommitSubjectsInWindowCached } from "../recap/git.js";

export interface ReextractTicketLinksOptions {
  dryRun?: boolean;
  /** `config.tickets.projectKeys`. Absent/empty is a real mode — extraction
   *  still runs, capped at medium confidence — never "skip". */
  allowlist?: readonly string[];
  /** Path to back up before writing. Defaults to the store's own file. */
  dbPath?: string;
  /** Called during the (slow) git warm-up pass so a caller can render progress.
   *  Never called from inside the transaction. */
  onProgress?: (scanned: number, total: number) => void;
}

export interface ReextractTicketLinksSummary {
  dryRun: boolean;
  /** Sessions re-scanned — every session in the store, since every automatic
   *  row was dropped and each one has to be earned again. */
  sessionsScanned: number;
  /** Automatic rows deleted. */
  removed: number;
  /** Automatic rows this pass wrote. Lower than `removed` is the expected
   *  outcome of ADDING an allowlist; higher is the expected outcome of removing
   *  one. */
  created: number;
  /** Manual (`tag`) rows left untouched — assignments and tombstones alike. */
  manualPreserved: number;
  /** Distinct active ticket keys before and after. The pair a reader tuning an
   *  allowlist actually watches. */
  keysBefore: number;
  keysAfter: number;
  /** Path the DB was backed up to (null in a dry run). */
  backupPath: string | null;
}

/** Thrown to unwind a dry run's transaction. Never escapes this module. */
const ROLLBACK = Symbol("dry-run rollback");

/**
 * Order parents before the subagents that inherit from them.
 *
 * A stable partition, not a sort: subagent chains in practice are one level
 * deep (a session spawns subagents; those do not spawn more), and a topological
 * sort would buy nothing for the two-level case while adding a cycle question
 * nobody can answer from this data.
 */
function parentsFirst(sessions: readonly SessionRow[]): SessionRow[] {
  const parents = sessions.filter((s) => !s.is_subagent);
  const children = sessions.filter((s) => s.is_subagent);
  return [...parents, ...children];
}

export function reextractTicketLinks(
  store: Store,
  opts: ReextractTicketLinksOptions,
  now: () => number,
): ReextractTicketLinksSummary {
  const dryRun = opts.dryRun ?? false;

  // Every session, including those whose source file is gone: their messages —
  // and so their cost, and so their share of the coverage denominator — are
  // still in the store, so their links must be re-derived along with the rest.
  // Scanning a narrower set than the delete would silently drop attribution.
  const sessions = parentsFirst(
    store.getSessions({ includeCI: true, includeSubagents: true, includeDeleted: true }),
  );

  // Warm-up: every `git log` this repair needs, fetched BEFORE the transaction
  // opens. The write pass below asks for the same (project, window) pairs and
  // therefore never spawns a subprocess of its own.
  const commitCache = createCommitSubjectsCache();
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]!;
    const window = ticketCommitWindow(session);
    if (window !== null) {
      getCommitSubjectsInWindowCached(commitCache, session.project_path, window.start, window.end);
    }
    opts.onProgress?.(i + 1, sessions.length);
  }

  const keysBefore = store.getTicketKeys().length;

  /** The mutation, identical in a dry run and a real one. */
  const apply = (): Omit<ReextractTicketLinksSummary, "dryRun" | "backupPath"> => {
    const removed = store.deleteAutomaticTicketLinks();
    for (const session of sessions) {
      runTicketExtraction(store, session, { allowlist: opts.allowlist, commitCache });
    }
    const counts = store.getTicketLinkCounts();
    return {
      sessionsScanned: sessions.length,
      removed,
      created: counts.automatic,
      manualPreserved: counts.manual,
      keysBefore,
      keysAfter: store.getTicketKeys().length,
    };
  };

  // A dry run does the real work and rolls it back, rather than predicting it.
  // The alternative — counting what extraction "would" write — is a second
  // implementation of upsert-per-source, manual-wins and subagent inheritance,
  // free to disagree with the real one; a preview that disagrees with the run it
  // previews is worse than no preview.
  if (dryRun) {
    let preview: Omit<ReextractTicketLinksSummary, "dryRun" | "backupPath"> | undefined;
    try {
      store.transaction(() => {
        preview = apply();
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
    // Reaching here without a preview would mean the transaction helper
    // swallowed the sentinel — i.e. the work was COMMITTED. Fail loudly rather
    // than report zeros, because the "nothing was written" promise would be
    // false and nothing else in the summary would say so.
    if (preview === undefined) throw new Error("dry run did not roll back");
    return { ...preview, dryRun: true, backupPath: null };
  }

  let backupPath: string | null = null;
  // The store's OWN file, not `paths.statsDb`: this must copy the database it
  // is about to delete rows from.
  const dbPath = opts.dbPath ?? store.dbPath;
  if (fs.existsSync(dbPath)) {
    backupPath = `${dbPath}.pre-repair-ticket-links-${now()}`;
    fs.copyFileSync(dbPath, backupPath);
  }

  const result = store.transaction(apply);
  return { ...result, dryRun: false, backupPath };
}
