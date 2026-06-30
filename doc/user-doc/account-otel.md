# Account attribution via OpenTelemetry (OTEL)

claude-stats can attribute sessions to the correct Claude account using the
OpenTelemetry data Claude Code itself emits. This is the **most reliable**
source of attribution: it covers every surface (CLI, VS Code, desktop, SDK)
and is treated as *authoritative* — it is never overwritten by the heuristic
observation-timeline fallback.

Because claude-stats is a **local, no-network** tool, it does not run an OTLP
receiver. Instead you point Claude Code at an OTLP export **file**, then feed
that file to `claude-stats account otel ingest`.

## 1. Enable telemetry in Claude Code (a one-time, manual step)

Set these in your shell profile (or your Claude Code settings env). This is a
**human step** — claude-stats never edits your environment or settings.

```bash
# Turn telemetry on.
export CLAUDE_CODE_ENABLE_TELEMETRY=1

# Export metrics as OTLP/JSON.
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json

# Include the surface so attribution can record it (default OFF).
export OTEL_METRICS_INCLUDE_ENTRYPOINT=true
# user.account_uuid and session.id are included by default.
```

You then need the OTLP data written to a **file** on disk. The simplest path is
a local OpenTelemetry Collector with a `file` exporter:

```yaml
# otel-collector.yaml
receivers:
  otlp:
    protocols:
      http:
      grpc:
exporters:
  file:
    path: /path/to/claude-otlp.jsonl   # one OTLP request per line (JSONL)
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [file]
    logs:
      receivers: [otlp]
      exporters: [file]
```

Run the collector and point Claude Code at it
(`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`). The collector writes
each export request as a line of OTLP/JSON to `claude-otlp.jsonl`.

> Either format works: a `.jsonl`/`.ndjson` file (one OTLP `ExportRequest` per
> line) **or** a single-file OTLP/JSON document (one object, or an array of
> requests).

## 2. Ingest the file

```bash
claude-stats account otel ingest --file /path/to/claude-otlp.jsonl
```

This reads the file, extracts the `user.account_uuid` ↔ `session.id` bindings
from each record's **resource attributes**, and applies them with
`source = otel`, `confidence = authoritative`. It also records an append-only
observation and an `accounts` row for each account it sees.

Example output:

```
Ingested 1240 OTLP records: 87 sessions, 2 accounts, 81 attribution changes.
```

## 3. What gets read

| OTLP resource attribute | Used for |
|---|---|
| `user.account_uuid` | the account (authoritative) |
| `session.id` | the session to attribute |
| `organization.id` | organization UUID |
| `app.entrypoint` / `terminal.type` | recorded surface (cli, claude-vscode, …) |

Token metrics (`claude_code.token.usage`) are read for the per-session model
list and token totals shown in the summary; the attribution itself comes from
the resource-level account/session binding, not the metric values.

## Safety

The ingester is hardened against misconfigured or hostile files:

- **symlinks and non-regular files are rejected** (the path is `lstat`-checked,
  not followed);
- **files larger than 500 MB are rejected** before any read;
- the file is **streamed line-by-line** (never loaded whole into memory);
- parsing stops after a large event cap;
- malformed lines are **counted and skipped**, never fatal.

claude-stats never enables telemetry for you, never writes to `~/.claude*`, and
only reads the file you pass with `--file`.

## Notes

- OTLP carries no subscription/plan tier, so the plan label still comes from
  your `~/.claude.json` account read (`claude-stats account`) or from telemetry.
- Re-running ingest is safe and idempotent: authoritative attributions are
  monotonic and are never downgraded by later heuristic passes.
