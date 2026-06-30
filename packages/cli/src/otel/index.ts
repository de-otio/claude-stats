/**
 * OTEL/OTLP ingestion (Phase 2 D).
 *
 * File-based OTLP/JSON(L) ingestion → authoritative account attribution.
 */
export {
  parseOtelFile,
  assertSafeOtelFile,
  foldExportRequest,
  MAX_FILE_BYTES,
  MAX_EVENTS,
} from "./parse.js";
export type { OtelParseResult, OtelSessionTuple } from "./parse.js";

export { ingestOtel } from "./ingest.js";
export type { OtelIngestSummary } from "./ingest.js";
