/**
 * Work-item key validation — the narrow gate every ticket key passes through.
 *
 * Deliberately validation only. Extraction (which sources to scan, how to grade
 * confidence, how the project-key allowlist filters noise) belongs with the
 * attribution pass; this module exists so that no unvalidated string can reach
 * the store — or, later, an org-plane sync shape, where a bounded identifier is
 * the entire reason a ticket key may cross the wire at all.
 *
 * Design: doc/analysis/ticket-attribution/01 §1.1, 03 §3.2.
 */
import type { TicketKey } from "./types/insight.js";

/**
 * Jira-style key: an uppercase project prefix, a hyphen, a number.
 *
 * Bounded on both sides on purpose. The prefix needs ≥2 characters (a bare
 * `A-1` matches far too much prose) and ≤10; the number ≤7 digits. An unbounded
 * pattern would make the key a de-facto free-text field, which is exactly what
 * the org plane's structural no-free-text guarantee forbids.
 */
export const TICKET_KEY_RE = /^[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}$/;

/** Same shape, for scanning inside a larger string. Callers add their own guards. */
export const TICKET_KEY_SCAN_RE = /\b[A-Z][A-Z0-9]{1,9}-[0-9]{1,7}\b/g;

/** True when `value` is a syntactically valid key. Narrows to the branded type. */
export function isTicketKey(value: string): value is TicketKey {
  return TICKET_KEY_RE.test(value);
}

/**
 * Validate and brand a key, or return null.
 *
 * Case is normalised up (`proj-123` → `PROJ-123`) because humans type keys in
 * branch names and prompts inconsistently, and two casings of one key must never
 * become two rows in a cost report. Surrounding whitespace is trimmed; nothing
 * else is rewritten.
 */
export function parseTicketKey(value: string): TicketKey | null {
  const normalized = value.trim().toUpperCase();
  return isTicketKey(normalized) ? (normalized as TicketKey) : null;
}

/**
 * Validate a key or throw. Use at trust boundaries (store writes, CLI args)
 * where a bad key is a caller bug rather than expected noise.
 */
export function requireTicketKey(value: string): TicketKey {
  const key = parseTicketKey(value);
  if (!key) {
    throw new Error(
      `Invalid ticket key: ${JSON.stringify(value)} (expected e.g. "PROJ-123": ` +
        `2–10 uppercase alphanumerics starting with a letter, hyphen, 1–7 digits)`,
    );
  }
  return key;
}

/**
 * True when `key` belongs to one of the configured project prefixes.
 *
 * An empty or absent allowlist means "no project filter configured" and
 * therefore matches everything — extraction still runs, but callers must cap
 * confidence, because without an allowlist the scanner cannot tell `PROJ-123`
 * from an unrelated identifier that happens to share the shape.
 */
export function matchesProjectAllowlist(key: TicketKey, allowlist?: readonly string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const prefix = key.slice(0, key.lastIndexOf("-"));
  return allowlist.some((p) => p.trim().toUpperCase() === prefix);
}
