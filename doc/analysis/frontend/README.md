# Frontend Visualization Options

This document evaluates approaches for rendering graphical dashboards from
`claude-stats` data.  The existing `buildDashboard()` function already produces
a well-structured `DashboardData` JSON blob (daily trends, per-project
breakdowns, model splits, cost estimates, etc.), so every option below assumes
it consumes that JSON — either directly in-process or via `claude-stats dashboard`
stdout.

---

## Option A: Local HTTP Server (recommended starting point)

Serve a single-page app from an embedded HTTP server (`claude-stats serve`).

### How it works

1. A new CLI command `claude-stats serve [--port 9120]` starts a lightweight
   HTTP server (Node built-in `node:http`, or `Hono` / `Fastify` if more
   routing is wanted).
2. On `GET /` it returns a self-contained HTML page with inline JS/CSS.
3. On `GET /api/dashboard?period=week&project=...` it calls `buildDashboard()`
   and returns JSON.
4. The HTML page fetches `/api/dashboard`, then renders charts client-side.

### Charting library choices

| Library | Size (min+gz) | Licence | Notes |
|---------|---------------|---------|-------|
| **Chart.js** | ~65 kB | MIT | Mature, good defaults, covers bar/line/pie/doughnut. Easy to get started. |
| **Lightweight Charts** (TradingView) | ~45 kB | Apache-2.0 | Excellent time-series, but limited chart types (no pie/bar). |
| **uPlot** | ~35 kB | MIT | Fastest time-series renderer, but minimal — no legends/tooltips out of the box. |
| **ECharts** | ~300 kB | Apache-2.0 | Very rich (heatmaps, treemaps, gauges), but heavy. |
| **D3** | ~90 kB | ISC | Maximum flexibility, but high authoring cost for dashboards. |
| **Plotly.js** | ~1 MB | MIT | One-liner charts, but extremely large bundle. |

**Recommendation:** Chart.js for v1. It covers every chart type we need
(line, bar, doughnut, scatter) with minimal code.  Can swap to ECharts later
if heatmaps or treemaps become important.

### Pros

- Zero installation for the user — works in any browser.
- Hot data: every page load calls `buildDashboard()` against the live SQLite
  database, so the view is always fresh.
- Simple to implement: one HTML file, one small API handler, ~200-400 lines total.
- Easy to iterate — just reload the browser.
- Can be extended with query parameters for filtering without any framework.
- Works on any OS (macOS, Linux, WSL).
- Auto-refresh via a simple `setInterval` or SSE push.

### Cons

- Requires the user to run a command and keep a terminal open.
- Slightly heavier than a static file (but the server is ~50 lines of code).
- Another port to manage (mitigated by picking a high default and detecting conflicts).

### Effort estimate

Small. The HTML + Chart.js page is ~300 lines. The HTTP handler is ~80 lines.
Can be done as a single `src/server/index.ts` module.

---

## Option B: VS Code Extension with Webviews

A VS Code extension that opens a Webview panel showing the same dashboard.

### How it works

1. A VS Code extension registers a command (e.g., `claude-stats.openDashboard`).
2. On activation, it imports `buildDashboard()` directly (same TypeScript, no
   HTTP needed) and passes the JSON into a Webview panel.
3. The Webview contains the same HTML/Chart.js page as Option A, but receives
   data via `postMessage()` instead of `fetch()`.
4. A status-bar item or sidebar view can show at-a-glance stats (today's cost,
   session count) without opening the full panel.

### Pros

- Deeply integrated into the editor — one click from the sidebar.
- No terminal, no port, no browser tab.
- Can use VS Code's theming (respects dark/light mode automatically).
- Can react to Claude Code session events (e.g., refresh after a session ends).
- Sidebar tree views can show lightweight summaries without a full Webview.
- Distribution via the VS Code Marketplace (or `.vsix` sideload).

### Cons

- Significant additional infrastructure: needs a separate `package.json`,
  `vscode` API dependency, activation events, extension manifest, Webview
  content-security-policy boilerplate.
- Webviews are sandboxed — no direct filesystem or `node:` access from the
  rendering side, so all data must be passed via message bridge.
- Only works in VS Code (not terminal-only users, not JetBrains, not Vim).
- Extension development has a steeper debug/test cycle than plain HTML.
- Keeping the extension in sync with the core library adds maintenance burden.
- The charting code is essentially the same as Option A — the Webview HTML is
  nearly identical to the standalone page.

### Effort estimate

Medium. The Webview HTML is shared with Option A, but the extension scaffold,
activation, message bridge, and packaging add ~400-600 lines of glue code plus
a separate build step.

### Hybrid approach

Build Option A first, then wrap the same HTML page inside a Webview panel.
The extension's Webview can either:
- Load the HTML directly (injecting data via `postMessage`), or
- Point at `http://localhost:9120` if the server is already running (simplest,
  but requires the server to be up).

---

## Option C: Static HTML Report Generation

Generate a self-contained `.html` file that the user opens in a browser.

### How it works

1. `claude-stats report --html > report.html` (or `claude-stats html`).
2. The command calls `buildDashboard()`, injects the JSON as a `<script>` tag
   into an HTML template (with Chart.js inlined or loaded from CDN), and writes
   the file.
3. User opens `report.html` in any browser.

### Pros

- Zero runtime dependencies — no server process.
- The file can be shared, emailed, or committed to a repo.
- Works offline after generation.
- Trivial to implement (~150 lines for the template + `fs.writeFileSync`).

### Cons

- Stale by definition — shows a snapshot, not live data.
- User must re-run the command to get an updated view.
- No interactivity beyond what Chart.js tooltips provide (no filtering,
  no drill-down without reimplementing query logic in JS).
- Large file if charting library is inlined (~100+ kB).

### Effort estimate

Small. Essentially a template string with placeholders. Can share the same
Chart.js rendering code as Options A/B.

---

## Option D: Terminal UI (TUI)

A rich terminal dashboard using a library like `blessed`, `blessed-contrib`,
or `ink` (React for CLIs).

### How it works

1. `claude-stats dashboard --tui` opens a full-screen terminal UI.
2. Uses `blessed-contrib` for line charts, bar charts, gauges, and tables
   rendered in the terminal.
3. Keyboard navigation for switching between views.

### Pros

- No browser, no VS Code, no GUI at all — works over SSH.
- Feels native for terminal-centric users.
- Can auto-refresh on a timer.

### Cons

- Much lower visual fidelity — terminal charts are coarse (character-cell
  rendering, limited colors, no anti-aliasing).
- Libraries like `blessed` are unmaintained (last publish 2017).  `ink` is
  maintained but focuses on layout, not charts — charting plugins are thin.
- Difficult to show multiple dense charts simultaneously.
- Cannot export or share views easily.
- Accessibility: hard to read for users with certain visual needs.

### Effort estimate

Medium, with poor visual payoff compared to browser-based options.

**Verdict:** Not recommended as the primary frontend.  Could complement a
browser dashboard for quick terminal glances, but the effort-to-quality ratio
is unfavorable.

---

## Option E: Electron / Tauri Desktop App

A standalone desktop application.

### Pros

- Polished native-feeling app, system tray icon, menu bar integration.
- Can run background collection and show notifications.

### Cons

- Massive overhead for what is essentially a local web page.
- Electron adds ~150 MB to the install size.
- Tauri is lighter (~5 MB) but requires Rust toolchain and has less mature
  Node integration.
- Distribution, auto-update, code signing — significant maintenance.
- Users who already have VS Code or a browser gain nothing.

**Verdict:** Over-engineered for this use case. Not recommended.

---

## Comparison Matrix

| Criterion | A: HTTP Server | B: VS Code Ext | C: Static HTML | D: TUI | E: Desktop App |
|-----------|---------------|----------------|----------------|--------|----------------|
| Implementation effort | **Low** | Medium | **Low** | Medium | High |
| Visual quality | High | High | High | Low | High |
| Live data | Yes | Yes | No (snapshot) | Yes | Yes |
| Interactivity | High | High | Low | Medium | High |
| No browser needed | No | **Yes** | No | **Yes** | **Yes** |
| Portability | All OS | VS Code only | All OS | All OS | Per-platform |
| Maintenance burden | **Low** | Medium | **Low** | Medium | High |
| Distribution | npm (built-in) | Marketplace | npm (built-in) | npm (built-in) | Separate |

---

## Recommended Approach: A first, then B as an optional wrapper

### Phase 1 — Local HTTP Server (`claude-stats serve`)

Build a single self-contained dashboard served over HTTP.  This gives the
highest value for the lowest effort and works for all users regardless of
editor.

Key implementation decisions:
- **Server:** Use `node:http` directly (zero dependencies). The API surface
  is tiny: one HTML route, one JSON API route.
- **Charts:** Chart.js loaded from a CDN `<script>` tag, or bundled inline
  for fully-offline use.
- **Layout:** Single-page with a top summary bar (sessions, tokens, cost,
  cache efficiency) and 4-6 chart panels below (daily trend, model split,
  project breakdown, tool usage, entrypoint pie, stop reasons).
- **Filtering:** Query params passed through to `buildDashboard()`: period
  selector (day/week/month/all), project dropdown, entrypoint filter.
- **Auto-refresh:** Optional `?refresh=30` query param or a toggle button.

### Phase 2 — VS Code Extension (optional)

Wrap the same HTML page in a Webview panel.  The extension can either:
1. Import `buildDashboard()` directly and inject data via `postMessage`, or
2. Start the HTTP server internally and load `http://localhost:9120` in the
   Webview (less code, reuses all server logic).

The extension adds value through:
- Sidebar summary (token count, cost today) visible at a glance.
- Automatic refresh when Claude Code sessions are detected.
- Respecting the user's VS Code color theme.

### Phase 3 — Static HTML export (trivial add-on)

Once Phase 1 exists, `claude-stats report --html` is a ~30-line wrapper that
calls `buildDashboard()`, interpolates the result into the same HTML template,
and writes to stdout.

---

## File placement

```
src/
  server/
    index.ts          # HTTP server, API routes
    template.ts       # HTML template with Chart.js (template literal)
  extension/          # (Phase 2) VS Code extension scaffold
    extension.ts
    package.json
```
