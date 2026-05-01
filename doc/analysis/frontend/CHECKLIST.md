# Frontend Visualization — Parallel Implementation Checklist

Implements the three-phase frontend described in [README.md](./README.md).
Designed for concurrent agent execution; each stream is internally ordered but
independent of other streams unless a dependency is noted.

Model tier conventions (same as `../sessions/implementation-checklist.md`):
- **Haiku** — mechanical/boilerplate, template literals, simple wiring
- **Sonnet** — multi-file edits, HTTP routing, CLI integration, data binding
- **Opus** — VS Code extension architecture, cross-cutting design decisions

> **Coverage rule:** every stream must keep `vitest run --coverage` ≥ 80% on
> lines, functions, branches, and statements.

---

## Pre-flight

- [x] `npx vitest run --coverage` passes
- [x] `npx tsc --noEmit` passes
- [x] `claude-stats dashboard --period week` produces valid JSON

---

## Stream A — HTML Template (no dependencies) — Haiku

Produces `src/server/template.ts`: a single function that accepts a
`DashboardData` object and returns a complete HTML string.  No server needed;
can be developed and tested purely with mock data.

### A1: Chart layout skeleton

- [x] **A1.1** Create `src/server/template.ts` exporting
  `renderDashboard(data: DashboardData): string`
- [x] **A1.2** HTML structure: `<head>` with Chart.js CDN script tag, `<body>`
  with a top summary bar and six `<canvas>` elements (daily-trend, model-split,
  project-breakdown, entrypoint-pie, stop-reasons, cache-gauge)
- [x] **A1.3** Summary bar shows: Sessions, Prompts, Total tokens
  (input+output), Cache efficiency %, Estimated cost — sourced from
  `data.summary`
- [x] **A1.4** Inject `data` as `<script>window.__DASHBOARD__ = {...};</script>`
  so the chart-init script can consume it without a fetch

### A2: Chart initialisation script (inline JS)

- [x] **A2.1** Daily-trend line chart: x-axis = `data.byDay[].date`,
  y-axis = input+output tokens per day; second dataset = estimated cost
  (right y-axis)
- [x] **A2.2** Model-split doughnut: labels from `data.byModel[].model`,
  values = `inputTokens + outputTokens`
- [x] **A2.3** Project bar chart (horizontal): top 10 projects by total tokens
- [x] **A2.4** Entrypoint pie: `data.byEntrypoint[]`
- [x] **A2.5** Stop-reason bar: `data.stopReasons[]`
- [x] **A2.6** Cache efficiency radial gauge: single value, green/amber/red
  thresholds at 60%/30%

### A3: Controls and period selector

- [x] **A3.1** Period `<select>` (Day / Week / Month / All) that reloads the
  page with `?period=<value>` — used by server in Stream B and by static export
  note text in Stream D
- [x] **A3.2** Auto-refresh toggle: adds `?refresh=30` to URL; page uses
  `setInterval(30_000, () => location.reload())` when param is present
- [x] **A3.3** Page title includes period and generation timestamp

### A4: Template tests

- [x] **A4.1** Create `src/__tests__/template.test.ts`
- [x] **A4.2** `renderDashboard(mockData)` returns string containing `<html>`
- [x] **A4.3** Summary bar values appear in output for each `summary` field
- [x] **A4.4** `window.__DASHBOARD__` is valid JSON when extracted from output
- [x] **A4.5** Empty `byDay` array → no chart error (verify no `undefined`
  accesses in the injected data)
- [x] **A4.6** `renderDashboard` is a pure function (same input → same output)

---

## Stream B — HTTP Server (no dependencies) — Sonnet

Produces `src/server/index.ts`: a minimal `node:http` server.  Can be written
and type-checked against the `DashboardData` interface without a finished
template; use a placeholder `"<html>loading</html>"` until Stream A merges.

### B1: Server core

- [x] **B1.1** Create `src/server/index.ts` exporting
  `startServer(port: number, store: Store): http.Server`
- [x] **B1.2** `GET /` — calls `renderDashboard(buildDashboard(store, opts))`;
  responds with `Content-Type: text/html`
- [x] **B1.3** `GET /api/dashboard` — parses query params (`period`, `project`,
  `repo`, `entrypoint`, `timezone`, `includeCI`) and passes them to
  `buildDashboard()`; responds with `Content-Type: application/json`
- [x] **B1.4** `GET /api/status` — calls `store.getStatus()`, returns JSON
- [x] **B1.5** Any other path → 404 JSON `{ error: "not found" }`
- [x] **B1.6** Unhandled errors → 500 JSON `{ error: message }`; never crash
  the process

### B2: Graceful shutdown

- [x] **B2.1** `startServer` returns the `http.Server` so the caller can call
  `.close()`
- [x] **B2.2** Register `SIGINT` / `SIGTERM` handlers inside the CLI command
  (not inside `startServer`) so the module stays testable

### B3: Server tests

- [x] **B3.1** Create `src/__tests__/server.test.ts`
- [x] **B3.2** Start server on a random port, `GET /api/dashboard` → valid JSON
  matching `DashboardData` shape
- [x] **B3.3** `GET /api/status` → valid JSON
- [x] **B3.4** Unknown path → 404
- [x] **B3.5** `period=week` query param is forwarded to `buildDashboard`
  (verify via a spy or by inspecting returned `data.period`)
- [x] **B3.6** Server closes cleanly after test (no open handles)

---

## Stream C — CLI `serve` command (depends on B) — Haiku

Wires the HTTP server into the CLI.  Only B1 (the server export) needs to
exist; A (the template) can still be a stub.

### C1: Command

- [x] **C1.1** Add `serve` command to `src/cli/index.ts`:
  ```
  claude-stats serve [--port 9120] [--open]
  ```
- [x] **C1.2** On startup: print `Listening on http://localhost:<port>` and
  block until `SIGINT` / `SIGTERM`
- [x] **C1.3** `--open` flag: call `open(url)` using a cross-platform helper
  (Node child_process: `open` on macOS, `xdg-open` on Linux,
  `start` on Windows — no new npm dependency)
- [x] **C1.4** If port is in use: print a clear error and exit 1
- [x] **C1.5** On exit: call `server.close()` and `store.close()`

### C2: Tests

- [x] **C2.1** `serve --help` output mentions `--port` and `--open`
- [x] **C2.2** Integration smoke test: start server via `buildCli().parse([...
  "serve", "--port", "0"])`, verify it starts (port 0 = OS-assigned), then
  close — no hanging processes

---

## Stream D — Static HTML Export (depends on A) — Haiku

Adds a `--html [file]` option to the existing `report` command (or a new
`export --html` subcommand).  Reuses `renderDashboard()` from Stream A.

### D1: Export command

- [x] **D1.1** Add `--html [outfile]` option to `report` in
  `src/cli/index.ts`:
  - If `outfile` omitted → write to `claude-stats-<ISO-date>.html` in cwd
  - Print `Wrote report.html` on success
- [x] **D1.2** Implementation: call `buildDashboard(store, opts)`, pass to
  `renderDashboard()`, write with `fs.writeFileSync`
- [x] **D1.3** The generated file must be self-contained (Chart.js loaded from
  CDN; if the CDN `<script>` uses `crossorigin`, include the attribute)
- [x] **D1.4** `--html` is mutually exclusive with `--trend` and `--detail`;
  print an error and exit 1 if combined

### D2: Tests

- [x] **D2.1** `report --html` writes a file containing `<html>`
- [x] **D2.2** Default filename contains the current date
- [x] **D2.3** `--html --trend` → exits with code 1

---

## Stream E — VS Code Extension (no dependencies, Phase 2) — Opus

A separate VS Code extension package that wraps the HTTP server in a Webview.
This stream is **optional Phase 2** and can start any time, but it is
completely independent of Streams A-D.

> Coordinate with the project owner before starting Stream E — it introduces
> a second `package.json` and a separate build step.

### E1: Extension scaffold

- [x] **E1.1** Create `src/extension/` directory with its own
  `package.json` (publisher, activationEvents, contributes.commands,
  contributes.viewsContainers, engines.vscode)
- [x] **E1.2** `src/extension/extension.ts`:
  - `activate(context)` — registers `claude-stats.openDashboard` command
  - `deactivate()` — stops server if running
- [x] **E1.3** `src/extension/panel.ts`:
  - `DashboardPanel` class managing a single `vscode.WebviewPanel`
  - `createOrShow(context, store)` — reuse existing panel if visible
  - Panel title: "Claude Stats"
  - Webview content: either loads `http://localhost:9120` (if server is
    running) or calls `renderDashboard()` directly + posts data via
    `postMessage`

### E2: Status bar item

- [x] **E2.1** On extension activation, create a status bar item showing
  today's token count (input+output) and estimated cost:
  `$(graph) 142k tokens · ~$1.40`
- [x] **E2.2** Clicking the status bar item opens the dashboard panel
- [x] **E2.3** Refresh the status bar every 5 minutes or when the panel is
  opened

### E3: Extension configuration

- [x] **E3.1** Contribute a VS Code setting `claude-stats.port` (default 9120)
  so users can change the HTTP port without touching the CLI
- [x] **E3.2** Contribute `claude-stats.autoRefreshSeconds` (default 30, 0 =
  disabled)

### E4: Extension tests

- [x] **E4.1** Unit test `DashboardPanel.createOrShow` with a mocked
  `vscode.window.createWebviewPanel`
- [x] **E4.2** Status bar item displays correct formatted values from mock data

---

## Execution Order & Parallelism

```
Time →  T0                    T1              T2
        ┌────────────────────┐
        │ A: Template        │
        │   A1 skeleton      │
        │   A2 chart init    │──────────────────────────────┐
        │   A3 controls      │                              ↓
        │   A4 tests         │                     ┌─────────────────┐
        └────────────────────┘                     │ D: Static HTML  │
                                                   │   D1, D2        │
        ┌────────────────────┐                     └─────────────────┘
        │ B: HTTP Server     │
        │   B1 server core   │──┐
        │   B2 shutdown      │  │
        │   B3 tests         │  ↓
        └────────────────────┘  ┌─────────────────┐
                                │ C: serve CLI    │
                                │   C1, C2        │
                                └─────────────────┘

        ┌──────────────────────────────────────────────────┐
        │ E: VS Code Extension (independent, Phase 2)     │
        │   E1 scaffold · E2 status bar · E3 config · E4  │
        └──────────────────────────────────────────────────┘
```

**Max parallelism at T0:** 3 agents (A, B, E)

---

## File Change Matrix

| File | A | B | C | D | E |
|------|---|---|---|---|---|
| `src/server/template.ts` | **new** | | | reads | |
| `src/server/index.ts` | | **new** | reads | | |
| `src/cli/index.ts` | | | W | W | |
| `src/__tests__/template.test.ts` | **new** | | | | |
| `src/__tests__/server.test.ts` | | **new** | | | |
| `src/extension/` | | | | | **new** |

No existing source files are modified except `src/cli/index.ts` (C and D each
add one new command/option block — additive, low merge conflict risk).

---

## Post-flight Checks

- [x] `npx vitest run --coverage` passes with ≥ 80% on all metrics
- [x] `npx tsc --noEmit` passes
- [x] `claude-stats serve` starts and `http://localhost:9120` shows charts
- [x] `claude-stats report --html` writes a valid HTML file that opens in a
  browser with charts rendered
- [x] `claude-stats serve --open` launches the default browser
- [x] All six chart panels render without JS console errors
- [x] Period selector changes charts without a server restart
