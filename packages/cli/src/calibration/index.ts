/**
 * Outcome calibration — the imperative shell.
 *
 * Gathers the labelled subset from the two places ground truth actually
 * accumulates on a developer's machine, and hands it to the pure gate in
 * `@claude-stats/core/calibration`:
 *
 *  - **attribution** — `ticket_links`. The automatic pass proposes; the user's
 *    `claude-stats ticket …` / `--negate` rulings (Lane L) affirm or strike.
 *  - **outcome** — the corrections DB's `task-outcome` labels, already scored
 *    against the unaided proxy by `buildCalibrationReport`. That report has
 *    existed as a raw JSON diagnostic with no minimum sample, no interval, and
 *    no statement of what its accuracy figure actually measures; this module is
 *    the gate it never had.
 *
 * The classifier is the ONE subject deliberately absent, and its absence is a
 * finding rather than an omission. Its agreement figure
 * (`__tests__/task-class-agreement.test.ts`, ≥0.80 fine / ≥0.90 coarse) is
 * measured against a GENERATED corpus at build time, and there is no runtime
 * ground truth to calibrate against: no correction kind labels a session's task
 * class, so a user cannot disagree with the classifier even if they want to.
 * Reporting the corpus figure here would present a fixed, synthetic,
 * shared-authorship number as if it were a measurement of the user's own data —
 * the precise misreading I1 forbids. Calibrating the classifier needs a
 * class-correction surface first; that is its enablement path.
 *
 * Everything decision-shaped is in core. This file only reads.
 */
import {
  calibrate,
  reviewAttributionLinks,
  type AttributionReview,
  type CalibrationEstimate,
  type CalibrationScope,
  type TicketLinkGrade,
} from "@claude-stats/core/calibration";
import { calibrationCaveat, calibrationEnablement } from "@claude-stats/core/insight";
import type { AttributionSource } from "@claude-stats/core/types/insight";
import type { Store } from "../store/index.js";
import type { CalibrationReport } from "../cost-per-task/calibration.js";

/** The four sources the extractor and the manual surfaces can write. */
const KNOWN_SOURCES: ReadonlySet<string> = new Set<AttributionSource>(["tag", "branch", "commit", "prompt"]);

export interface AttributionCalibration {
  readonly estimate: CalibrationEstimate;
  /** The recall-side counts, reported beside the rate and never folded into it. */
  readonly review: AttributionReview;
}

/**
 * Calibrate the automatic attribution pass against the user's explicit rulings.
 *
 * Whole-store by design (see `getTicketLinkGrades`). Rows with an unrecognised
 * `source` are dropped rather than guessed at: `source` is a TEXT column, so a
 * row written by a future version could carry a value this build cannot grade,
 * and silently treating an unknown source as automatic would let it be "upheld"
 * by a manual affirmation it has nothing to do with.
 */
export function buildAttributionCalibration(store: Store): AttributionCalibration {
  const rows: TicketLinkGrade[] = [];
  for (const row of store.getTicketLinkGrades()) {
    if (!KNOWN_SOURCES.has(row.source)) continue;
    rows.push({
      sessionId: row.session_id,
      ticketKey: row.ticket_key,
      source: row.source as AttributionSource,
      negated: row.negated !== 0,
    });
  }
  const review = reviewAttributionLinks(rows);
  // `getTicketLinkGrades()` takes no date bound, so this counts every ruling in
  // the store — including rulings made long before the window the caller is
  // rendering. That is the deliberate choice (a per-window cut of a scarce
  // sample would read "uncalibrated" forever), and stating it here is what makes
  // it a choice rather than an accident the reader absorbs as "this period".
  return { estimate: calibrate("attribution", review, { scope: "whole-store" }), review };
}

/**
 * Gate the existing outcome-calibration report.
 *
 * Reads `proxyOnly` — the UNAIDED ladder — rather than `withSignals`. The
 * signals path is opt-in and experimental (`config.experimentalSignals`), so
 * calibrating it would describe a mechanism most stores are not running. The
 * proxy is what actually produced the success counts the dashboard and the pack
 * quote, and it is those counts that need their confidence earned.
 *
 * `null` in (the report failed to build, or was never attached) yields an
 * uncalibrated estimate at n = 0 — the same honest state as "no labels yet",
 * because from the reader's side it is the same state: no measurement exists.
 *
 * `scope` is required and has no default. Unlike attribution's, this subject's
 * window is decided by the CALLER — `attachCalibration` passes the dashboard's
 * period (capping `all` at a month for performance), the MCP tool passes a
 * month outright. Only the caller knows which, so only the caller may say.
 */
export function outcomeCalibrationFrom(
  report: CalibrationReport | null | undefined,
  scope: CalibrationScope,
): CalibrationEstimate {
  const m = report?.proxyOnly;
  const agreed = m?.hits ?? 0;
  const disagreed = m ? m.n - m.hits : 0;
  return calibrate("outcome", { agreed, disagreed }, { scope });
}

// ─── Machine-readable shape (MCP) ─────────────────────────────────────────────

/**
 * What the rate is a rate OF, as a stable machine token rather than prose.
 *
 * A calling agent will otherwise reach for the obvious reading — "attribution is
 * 88% accurate" — and the caveat sentence it would have to parse to know better
 * is localized, so it cannot be relied on to carry the distinction. The token
 * is a discriminant in the same spirit as `InsightUnavailable.reason`: not
 * localized, because consumers branch on it.
 */
export const CALIBRATION_MEASURES = "agreement-on-reviewed-subset" as const;

export interface CalibrationJson {
  readonly subject: CalibrationEstimate["subject"];
  /** The window the rulings were gathered over. A machine token, like
   *  `measures` — a calling agent comparing two subjects' rates must be able to
   *  see they were not counted over the same span without parsing prose. */
  readonly scope: CalibrationEstimate["scope"];
  readonly state: CalibrationEstimate["state"];
  readonly n: number;
  readonly agreed: number;
  readonly disagreed: number;
  readonly rate: number | null;
  readonly interval: CalibrationEstimate["interval"];
  readonly minN: number;
  readonly needed: number;
  readonly measures: typeof CALIBRATION_MEASURES;
  /** The localized honesty sentence — the same one the dashboard renders. */
  readonly caveat: string;
  /** The localized labelling nudge; null once measured. */
  readonly enablement: string | null;
  /**
   * Attribution only: manual links naming a key the automatic pass never
   * proposed. A RECALL figure, kept out of `rate` — see `core/calibration.ts`.
   */
  readonly unproposed?: number;
}

/** Minimal translator signature — the CLI's `t` and the dashboard's both fit. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/** Shape one estimate for a JSON surface, sentences included. */
export function calibrationJson(
  t: TranslateFn,
  estimate: CalibrationEstimate,
  extra: { unproposed?: number } = {},
): CalibrationJson {
  return {
    subject: estimate.subject,
    scope: estimate.scope,
    state: estimate.state,
    n: estimate.n,
    agreed: estimate.agreed,
    disagreed: estimate.disagreed,
    rate: estimate.rate,
    interval: estimate.interval,
    minN: estimate.minN,
    needed: estimate.needed,
    measures: CALIBRATION_MEASURES,
    caveat: calibrationCaveat(t, estimate),
    enablement: calibrationEnablement(t, estimate),
    ...(extra.unproposed !== undefined ? { unproposed: extra.unproposed } : {}),
  };
}

