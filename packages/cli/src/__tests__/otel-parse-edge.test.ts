/**
 * Supplemental OTLP-parser edge-case coverage (Phase 4 top-up): scalar value
 * kinds, metric folding (gauge/asDouble/null-model), surface fallback, the
 * missing-binding early return, resourceLogs, and the file streaming / array /
 * malformed / non-regular-file paths. Neutral fixtures only.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  foldExportRequest,
  parseOtelFile,
  assertSafeOtelFile,
  type OtelParseResult,
} from "../otel/parse.js";

const A = "00000000-0000-0000-0000-0000000000aa";
const S = "00000000-0000-0000-0000-0000000000s1";
const ORG = "00000000-0000-0000-0000-0000000000bb";

function emptyResult(): OtelParseResult {
  return { sessions: new Map(), accounts: new Map(), recordCount: 0, malformed: 0, truncated: false };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fold = (req: unknown, r: OtelParseResult) => foldExportRequest(req as any, r);

function tmpFile(content: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "otel-edge-"));
  const f = path.join(d, "otlp.json");
  fs.writeFileSync(f, content);
  return f;
}

describe("otel parse — value kinds & metric folding", () => {
  it("coerces int/double/bool attribute values and folds token metrics (gauge, asDouble, null model)", () => {
    const req = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: "user.account_uuid", value: { stringValue: A } },
              { key: "session.id", value: { stringValue: S } },
              { key: "organization.id", value: { stringValue: ORG } },
              { key: "app.entrypoint", value: { stringValue: "cli" } },
              { key: "n_int_num", value: { intValue: 42 } },
              { key: "n_int_str", value: { intValue: "7" } },
              { key: "n_dbl", value: { doubleValue: 1.5 } },
              { key: "n_bool", value: { boolValue: true } },
              { key: "n_empty", value: {} }, // → null, skipped
              { key: "n_nokey" }, // no value, skipped
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.token.usage",
                  gauge: {
                    dataPoints: [
                      { attributes: [{ key: "model", value: { stringValue: "claude-opus-4-8" } }], asInt: "100", timeUnixNano: "1700000000000000000" },
                      { attributes: [{ key: "model", value: { stringValue: "claude-opus-4-8" } }], asDouble: 5.4 }, // asInt absent → asDouble branch
                      { attributes: [], asInt: 3 }, // model null branch
                    ],
                  },
                },
                { name: "other.metric", sum: { dataPoints: [] } }, // non-token metric skipped
              ],
            },
          ],
        },
      ],
    };
    const r = emptyResult();
    expect(fold(req, r)).toBe(1);
    const t = r.sessions.get(S)!;
    expect(t.accountUuid).toBe(A);
    expect(t.organizationUuid).toBe(ORG);
    expect(t.surface).toBe("cli");
    expect(t.tokens).toBe(100 + 5 + 3); // 5.4 → round → 5
    expect(t.models).toEqual(["claude-opus-4-8"]); // deduped
    expect(t.ts).toBe(1_700_000_000_000); // ns → ms
    expect(r.accounts.get(A)).toEqual({ organizationUuid: ORG, surface: "cli" });
  });

  it("uses terminal.type as surface fallback and skips resources missing account or session", () => {
    const r = emptyResult();
    fold(
      { resourceMetrics: [{ resource: { attributes: [
        { key: "user.account_uuid", value: { stringValue: A } },
        { key: "session.id", value: { stringValue: S } },
        { key: "terminal.type", value: { stringValue: "vscode" } },
      ] }, scopeMetrics: [] }] },
      r,
    );
    expect(r.sessions.get(S)!.surface).toBe("vscode");

    const r2 = emptyResult();
    const consumed = fold(
      { resourceMetrics: [{ resource: { attributes: [{ key: "user.account_uuid", value: { stringValue: A } }] }, scopeMetrics: [] }] },
      r2,
    );
    expect(consumed).toBe(1); // the record is counted…
    expect(r2.sessions.size).toBe(0); // …but nothing is bound without a session id
  });

  it("folds resourceLogs (no metric points) for the account binding", () => {
    const r = emptyResult();
    const consumed = fold(
      { resourceLogs: [{ resource: { attributes: [
        { key: "user.account_uuid", value: { stringValue: A } },
        { key: "session.id", value: { stringValue: S } },
      ] }, scopeLogs: [] }] },
      r,
    );
    expect(consumed).toBe(1);
    expect(r.sessions.get(S)!.tokens).toBe(0);
  });
});

describe("otel parse — file streaming & hardening", () => {
  it("streams JSONL, skipping blank and malformed lines", async () => {
    const valid = JSON.stringify({ resourceMetrics: [{ resource: { attributes: [
      { key: "user.account_uuid", value: { stringValue: A } },
      { key: "session.id", value: { stringValue: S } },
    ] }, scopeMetrics: [] }] });
    const f = tmpFile(`\n   \n${valid}\nnot json at all\n`);
    const r = await parseOtelFile(f);
    expect(r.sessions.has(S)).toBe(true);
    expect(r.malformed).toBe(1);
    expect(r.recordCount).toBe(1);
  });

  it("handles a single-line JSON array of export requests; non-object items count as malformed", async () => {
    const item = { resourceLogs: [{ resource: { attributes: [
      { key: "user.account_uuid", value: { stringValue: A } },
      { key: "session.id", value: { stringValue: S } },
    ] }, scopeLogs: [] }] };
    const f = tmpFile(JSON.stringify([item, 123]));
    const r = await parseOtelFile(f);
    expect(r.sessions.has(S)).toBe(true);
    expect(r.malformed).toBe(1);
  });

  it("counts a non-object top-level record as malformed", async () => {
    const r = await parseOtelFile(tmpFile("42\n"));
    expect(r.malformed).toBe(1);
    expect(r.sessions.size).toBe(0);
  });

  it("assertSafeOtelFile rejects a non-regular file (directory)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "otel-dir-"));
    expect(() => assertSafeOtelFile(dir)).toThrow(/not a regular file/);
  });
});
