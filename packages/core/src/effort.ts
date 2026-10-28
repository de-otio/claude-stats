/**
 * Reasoning-effort tier helpers (#125 D1).
 *
 * The tier set is OPEN: `low`, `medium`, `high`, `xhigh` and `max` are in use
 * and a new one can arrive with any Claude Code release. A value is the
 * shape-validated short token the parser stores; an unknown tier passes through
 * verbatim and is never folded into a neighbour. `null` means "Claude Code did
 * not report an effort" — a bucket, never a tier.
 *
 * Pure; no I/O.
 */

/** Known tiers, lowest to highest. Anything else sorts after these, A-Z. */
export const KNOWN_EFFORT_ORDER: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Normalise a stored/raw value to a tier or `null`. Non-strings and the empty
 * string are `null`; every other string is kept verbatim, so an unknown future
 * tier is preserved.
 */
export function normaliseEffort(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Rank in the display order; unknown tiers share one rank after the known ones. */
function rank(effort: string): number {
  const i = KNOWN_EFFORT_ORDER.indexOf(effort);
  return i === -1 ? KNOWN_EFFORT_ORDER.length : i;
}

/**
 * Total order for display: `low < medium < high < xhigh < max`, then any other
 * value alphabetically, then `null` last. Usable directly with `Array#sort`.
 */
export function compareEffort(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const d = rank(a) - rank(b);
  if (d !== 0) return d;
  return a < b ? -1 : 1;
}
