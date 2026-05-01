/**
 * Auto-refresh pricing cache — fetches model pricing from Anthropic's
 * documentation page and caches it locally.
 *
 * Cache location: ~/.claude-stats/pricing.json
 * Refresh interval: 7 days (configurable via CACHE_TTL_MS)
 * Fallback: hardcoded defaults in pricing.ts if fetch/parse fails
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "@claude-stats/core/paths";
import type { ModelPricing } from "@claude-stats/core/pricing";
import { applyPricingCache } from "@claude-stats/core/pricing";

const PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const CACHE_FILE = path.join(paths.statsDir, "pricing.json");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface PricingCacheData {
  fetchedAt: string; // ISO date
  models: Record<string, ModelPricing>;
}

/**
 * Load cached pricing from disk and apply it.
 * Returns true if valid cache was loaded.
 */
export function loadCachedPricing(): boolean {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as PricingCacheData;
    if (!data.fetchedAt || !data.models || Object.keys(data.models).length === 0) {
      return false;
    }
    applyPricingCache(data.models, data.fetchedAt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether the cache needs refreshing.
 */
export function isCacheStale(): boolean {
  try {
    if (!fs.existsSync(CACHE_FILE)) return true;
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as PricingCacheData;
    const fetchedMs = new Date(data.fetchedAt).getTime();
    return Date.now() - fetchedMs > CACHE_TTL_MS;
  } catch {
    return true;
  }
}

/**
 * Fetch pricing from Anthropic docs, parse it, cache to disk, and apply.
 * Returns true on success. Silently returns false on any failure.
 */
export async function refreshPricingCache(): Promise<boolean> {
  try {
    const html = await fetchPricingPage();
    const models = parsePricingTable(html);
    if (Object.keys(models).length === 0) return false;

    const data: PricingCacheData = {
      fetchedAt: new Date().toISOString().slice(0, 10),
      models,
    };

    // Ensure directory exists
    fs.mkdirSync(paths.statsDir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));

    applyPricingCache(data.models, data.fetchedAt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load cache from disk, then refresh in background if stale.
 * This is the main entry point — call once at startup.
 */
export async function initPricingCache(): Promise<void> {
  loadCachedPricing();
  if (isCacheStale()) {
    // Refresh in background — don't block startup
    refreshPricingCache().catch(() => {});
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function fetchPricingPage(): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(PRICING_URL, {
      signal: controller.signal,
      headers: { Accept: "text/html" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Convert a display name like "Claude Opus 4.6" to an API prefix like "claude-opus-4-6".
 * Handles both modern (Claude Family X.Y) and legacy (Claude Family X) naming.
 */
export function displayNameToApiPrefix(displayName: string): string {
  const clean = displayName
    .replace(/\s*\([^)]*\)\s*/g, "") // remove "(deprecated)" etc.
    .trim();
  const match = clean.match(/^Claude\s+(\w+)\s+(.+)$/i);
  if (!match) return clean.toLowerCase().replace(/[\s.]+/g, "-");

  const family = match[1]!.toLowerCase();
  const version = match[2]!.replace(/\./g, "-");
  // Claude 3.x used "claude-3-X-family" format; 4+ uses "claude-family-version"
  const major = parseInt(version, 10);
  if (major <= 3) return `claude-${version}-${family}`;
  return `claude-${family}-${version}`;
}

/**
 * Parse the model pricing table from the Anthropic docs HTML.
 * Looks for the first table with columns matching the expected pricing headers.
 */
export function parsePricingTable(html: string): Record<string, ModelPricing> {
  const models: Record<string, ModelPricing> = {};

  // Extract all HTML tables
  const tableRegex = /<table[\s>][\s\S]*?<\/table>/gi;
  const tables = html.match(tableRegex);
  if (!tables) return models;

  for (const table of tables) {
    // Check if this table has the pricing columns we expect
    if (!table.includes("Base Input") && !table.includes("Output Tokens")) continue;

    // Extract rows
    const rowRegex = /<tr[\s>][\s\S]*?<\/tr>/gi;
    const rows = table.match(rowRegex);
    if (!rows || rows.length < 2) continue;

    // Parse header to find column indices
    const headerCells = extractCells(rows[0]!);
    const colMap = mapColumns(headerCells);
    if (colMap.model < 0 || colMap.input < 0 || colMap.output < 0) continue;

    // Parse data rows
    for (let i = 1; i < rows.length; i++) {
      const cells = extractCells(rows[i]!);
      if (cells.length <= Math.max(colMap.model, colMap.input, colMap.output)) continue;

      const modelName = stripHtml(cells[colMap.model]!);
      if (!modelName.toLowerCase().startsWith("claude")) continue;

      const input = parseDollarAmount(cells[colMap.input]!);
      const output = parseDollarAmount(cells[colMap.output]!);
      if (input === null || output === null) continue;

      const cacheRead = colMap.cacheRead >= 0 ? parseDollarAmount(cells[colMap.cacheRead]!) : null;
      const cacheWrite = colMap.cacheWrite5m >= 0 ? parseDollarAmount(cells[colMap.cacheWrite5m]!) : null;

      const prefix = displayNameToApiPrefix(modelName);
      models[prefix] = {
        inputPerMillion: input,
        outputPerMillion: output,
        cacheReadPerMillion: cacheRead ?? input * 0.1,
        cacheWritePerMillion: cacheWrite ?? input * 1.25,
      };
    }

    // If we found models, stop — we found the right table
    if (Object.keys(models).length > 0) break;
  }

  return models;
}

function extractCells(row: string): string[] {
  const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const cells: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = cellRegex.exec(row)) !== null) {
    cells.push(m[1]!);
  }
  return cells;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").trim();
}

function mapColumns(headers: string[]): {
  model: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
} {
  let model = -1, input = -1, output = -1, cacheRead = -1, cacheWrite5m = -1;
  for (let i = 0; i < headers.length; i++) {
    const h = stripHtml(headers[i]!).toLowerCase();
    if (h.includes("model")) model = i;
    else if (h.includes("base input") || (h.includes("input") && !h.includes("cache"))) input = i;
    else if (h.includes("output")) output = i;
    else if (h.includes("cache hit") || h.includes("cache read") || h.includes("refresh")) cacheRead = i;
    else if (h.includes("5m") || h.includes("5 min") || (h.includes("cache write") && cacheWrite5m < 0)) cacheWrite5m = i;
  }
  return { model, input, output, cacheRead, cacheWrite5m };
}

function parseDollarAmount(cell: string): number | null {
  const text = stripHtml(cell);
  // Match patterns like "$5", "$0.50", "$18.75", "$5 / MTok"
  const m = text.match(/\$\s*([\d.]+)/);
  if (!m) return null;
  const val = parseFloat(m[1]!);
  return isNaN(val) ? null : val;
}
