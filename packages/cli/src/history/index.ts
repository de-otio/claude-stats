/**
 * History search — reads ~/.claude/history.jsonl and performs
 * case-insensitive substring matching on prompt text.
 * See plans/07-history-search.md.
 */
import * as fs from "node:fs";
import { paths } from "@claude-stats/core/paths";

export interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

export interface SearchOptions {
  query: string;
  historyPath?: string; // allow override for testing
  project?: string;
  limit?: number;
}

export interface SearchResult {
  entry: HistoryEntry;
  matchIndex: number;
}

export function searchHistory(opts: SearchOptions): SearchResult[] {
  const filePath = opts.historyPath ?? paths.historyFile;
  const limit = opts.limit ?? 20;

  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const lines = contents.split("\n");
  const matches: SearchResult[] = [];
  const queryLower = opts.query.toLowerCase();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let entry: HistoryEntry;
    try {
      entry = JSON.parse(trimmed) as HistoryEntry;
    } catch {
      continue;
    }

    if (typeof entry.display !== "string") continue;

    const matchIndex = entry.display.toLowerCase().indexOf(queryLower);
    if (matchIndex === -1) continue;

    if (opts.project && entry.project !== opts.project) continue;

    matches.push({ entry, matchIndex });
  }

  // Sort by timestamp descending (most recent first)
  matches.sort((a, b) => b.entry.timestamp - a.entry.timestamp);

  return matches.slice(0, limit);
}
