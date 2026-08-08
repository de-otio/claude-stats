/**
 * Constraint-impact — what withholding AI capability costs, on data that
 * actually exists. See doc/analysis/constraint-impact/.
 */
// Two independent measurements of the same subject, so they share a namespace:
// `beforeAfter` compares the windows either side of a declared policy change,
// `apiThrottleWait` measures what the API itself made the developer wait for.
// They were built in parallel and each claimed this specifier — the directory
// is the canonical module and neither is re-exported selectively, so a caller
// cannot end up importing one while believing it has the other.
export {
  summarizeApiThrottle,
  formatApiThrottle,
  type ApiThrottleSummary,
  type ApiThrottleAnswer,
} from "./apiThrottleWait.js";

export * from "./beforeAfter.js";
