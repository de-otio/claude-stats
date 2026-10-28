/**
 * `isPlaceholderOutput` (packages/core/src/hygiene/placeholderOutput.ts) as a
 * SQLite boolean expression, for the aggregate disclosure query (plan A4).
 *
 * The TS predicate stays the definition; this is its SQL twin, and a test
 * (`placeholder-disclosure.test.ts`) runs both over a table of cases.
 *
 * Semantics reproduced:
 *  - subagent session, and no stop reason (NULL or ''),
 *  - writer version parses as semver (`v`? X.Y.Z, optional `-pre`, optional
 *    `+build`, ASCII digits only) and sorts strictly below 2.1.307 by NUMERIC
 *    component compare (a string compare puts '2.1.99' above '2.1.307');
 *    a prerelease sorts below its own release; missing/unparseable → false.
 *
 * Pure string building: no values are interpolated except the fixed
 * threshold, and column names come from the callers in this package.
 */

/** Fixed threshold, mirrored from `PLACEHOLDER_FIXED_IN` ("2.1.307"). */
const FIXED_IN: readonly [number, number, number] = [2, 1, 307];

export interface PlaceholderColumns {
  /** Column holding `sessions.is_subagent` (NULL when the session row is absent). */
  isSubagent: string;
  /** Column holding `messages.claude_version`. */
  claudeVersion: string;
  /** Column holding `messages.stop_reason`. */
  stopReason: string;
}

/** SQL expression: 1 when the row is a placeholder-output row, else 0. */
export function placeholderOutputSql(c: PlaceholderColumns): string {
  // t: trimmed version; v: without one leading 'v'.
  const t = `trim(coalesce(${c.claudeVersion}, ''))`;
  const v = `(CASE WHEN substr(${t}, 1, 1) = 'v' THEN substr(${t}, 2) ELSE ${t} END)`;
  // cut: 1-based position where the core ends (first '-' or '+'), 0 if none.
  const iMinus = `instr(${v}, '-')`;
  const iPlus = `instr(${v}, '+')`;
  const cut = `(CASE WHEN ${iMinus} > 0 AND (${iPlus} = 0 OR ${iMinus} < ${iPlus}) THEN ${iMinus}` +
    ` WHEN ${iPlus} > 0 THEN ${iPlus} ELSE 0 END)`;
  const core = `(CASE WHEN ${cut} = 0 THEN ${v} ELSE substr(${v}, 1, ${cut} - 1) END)`;
  const tail = `(CASE WHEN ${cut} = 0 THEN '' ELSE substr(${v}, ${cut}) END)`;

  // core must be exactly three non-empty ASCII-digit groups.
  const coreOk =
    `(${core} <> '' AND ${core} NOT GLOB '*[^0-9.]*' AND ${core} NOT GLOB '.*' AND ${core} NOT GLOB '*.'` +
    ` AND ${core} NOT GLOB '*..*' AND length(${core}) - length(replace(${core}, '.', '')) = 2)`;

  // tail: '' | '-' pre ['+' build] | '+' build, identifiers over [0-9A-Za-z.-], non-empty.
  const idOk = (x: string) => `(${x} <> '' AND ${x} NOT GLOB '*[^0-9A-Za-z.-]*')`;
  const plusInTail = `instr(${tail}, '+')`;
  const preStr = `(CASE WHEN ${plusInTail} = 0 THEN substr(${tail}, 2) ELSE substr(${tail}, 2, ${plusInTail} - 2) END)`;
  const buildAfterPlus = `substr(${tail}, ${plusInTail} + 1)`;
  const tailOk =
    `(${tail} = ''` +
    ` OR (substr(${tail}, 1, 1) = '-' AND ${idOk(preStr)} AND (${plusInTail} = 0 OR ${idOk(buildAfterPlus)}))` +
    ` OR (substr(${tail}, 1, 1) = '+' AND ${idOk(`substr(${tail}, 2)`)}))`;
  const isPre = `(substr(${tail}, 1, 1) = '-')`;

  // numeric components of the (validated) core
  const d1 = `instr(${core}, '.')`;
  const rest1 = `substr(${core}, ${d1} + 1)`;
  const d2 = `instr(${rest1}, '.')`;
  const maj = `CAST(substr(${core}, 1, ${d1} - 1) AS INTEGER)`;
  const min = `CAST(substr(${rest1}, 1, ${d2} - 1) AS INTEGER)`;
  const pat = `CAST(substr(${rest1}, ${d2} + 1) AS INTEGER)`;

  const [fa, fb, fc] = FIXED_IN;
  const before =
    `(${maj} < ${fa} OR (${maj} = ${fa} AND (${min} < ${fb} OR (${min} = ${fb} AND` +
    ` (${pat} < ${fc} OR (${pat} = ${fc} AND ${isPre}))))))`;

  return (
    `(CASE WHEN coalesce(${c.isSubagent}, 0) = 1 AND coalesce(${c.stopReason}, '') = ''` +
    ` AND ${coreOk} AND ${tailOk} AND ${before} THEN 1 ELSE 0 END)`
  );
}
