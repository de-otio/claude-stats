# 02 - Feature Comparison Matrix

## CLI Tools

| Feature | claude-stats | ccusage | ccboard | claudelytics | cccost | ccburn |
|---------|:---:|:---:|:---:|:---:|:---:|:---:|
| **Data Collection** | | | | | | |
| Incremental collection | Y | - | Y (cache) | - | N/A | - |
| Sub-agent token tracking | Y | - | - | - | Y | - |
| Crash-safe checkpoints | Y | - | - | - | - | - |
| Error quarantine | Y | - | - | - | - | - |
| Schema fingerprinting | Y | - | - | - | - | - |
| Rewrite detection (SHA-256) | Y | - | - | - | - | - |
| **Reporting** | | | | | | |
| Terminal reports | Y | Y | Y | Y | - | Y |
| Web dashboard | Y | Y | - | - | - | - |
| TUI | - | - | Y | Y | - | Y |
| HTML export | Y | - | - | - | - | - |
| JSON export | Y | Y | Y | Y | Y | Y |
| CSV export | Y | - | Y | Y | - | - |
| **Analysis** | | | | | | |
| Per-model cost breakdown | Y | Y | Y | Y | Y | - |
| Cache efficiency metrics | Y | Y | - | - | - | - |
| 5-hour usage windows | Y | Y | Y | Y | - | Y |
| Plan ROI analysis | Y | - | - | - | - | - |
| Model efficiency scoring | Y | - | - | - | - | - |
| Context/compaction analysis | Y | - | - | - | - | - |
| Throttle detection | Y | - | - | - | - | - |
| Velocity metrics | Y | - | - | - | - | - |
| Budget pacing/burn rate | - | - | Y | - | - | Y |
| Credential leak detection | - | - | Y | - | - | - |
| **Session Management** | | | | | | |
| Session tagging | Y | - | - | - | - | - |
| Prompt search (FTS) | Y | - | Y | Y (fuzzy) | - | - |
| Session detail view | Y | - | Y | Y | - | - |
| **Integration** | | | | | | |
| VS Code extension | Y | - | - | - | - | - |
| Status bar widget | Y | - | - | - | - | - |
| Auto-collection (file watch) | Y | - | - | Y | N/A | - |
| MCP server | - | Y | - | - | - | - |
| **Multi-Account** | | | | | | |
| Account detection | Y | - | - | - | - | - |
| Per-account breakdown | Y | - | - | - | - | - |
| Plan recommendation | Y | - | - | - | - | - |
| **Runtime** | | | | | | |
| Language | TypeScript | TypeScript | Rust | Rust | Node.js | Python |
| Zero-install (npx) | - | Y | - | - | Y | - |
| Node.js built-in SQLite | Y | - | - | - | - | - |
| Minimal dependencies | Y | moderate | minimal | minimal | minimal | moderate |

## VS Code Extensions

| Feature | claude-stats ext | Usage Tracker | Claudemeter | Token Monitor | Clauder |
|---------|:---:|:---:|:---:|:---:|:---:|
| Full dashboard in VS Code | Y | - | - | Y | Y (web) |
| Status bar usage | Y | Y | Y | Y | Y |
| Auto-refresh | Y | Y | Y | - | Y |
| Charts/visualization | Y | - | - | Y | Y |
| Plan ROI analysis | Y | - | - | - | - |
| Model efficiency | Y | - | - | - | - |
| Context analysis | Y | - | - | - | - |
| Real-time rate limits | - | Y | Y | - | Y |
| Reset countdown | - | Y | Y | - | Y |
| Slack/Discord alerts | - | - | - | - | Y |
| Self-contained (no deps) | Y | Y | - | - (needs ccusage) | - |
| Free | Y | Y | Y | Y | freemium |

## Legend

- **Y** = supported
- **-** = not supported
- **N/A** = not applicable to tool's approach
