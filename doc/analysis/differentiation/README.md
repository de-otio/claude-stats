# Competitive Differentiation Analysis

Analysis of claude-stats positioning relative to native Claude Code features, open-source tools, and VS Code extensions in the Claude Code usage tracking space.

## Documents

| File | Contents |
|------|----------|
| [01-landscape.md](01-landscape.md) | Market overview: native features, CLI tools, VS Code extensions, macOS apps |
| [02-feature-matrix.md](02-feature-matrix.md) | Side-by-side feature comparison across top competitors |
| [03-gaps-and-opportunities.md](03-gaps-and-opportunities.md) | Unmet needs across the ecosystem and where claude-stats can differentiate |
| [04-claudemeter-api.md](04-claudemeter-api.md) | Technical analysis of how ClaudeMeter accesses real-time usage/reset data |

## Key Findings

1. **ccusage** (11k+ stars) dominates the CLI space but has no dashboard, no incremental collection, and misses sub-agent tokens.
2. **ccboard** is the most feature-rich alternative but requires Rust and has a tiny community.
3. No single tool combines CLI + web dashboard + VS Code extension in one package.
4. All JSONL-based tools share the same fundamental accuracy limitation: sub-agent tokens are invisible.
5. Real-time rate limit data is only available via an undocumented claude.ai internal API.
6. claude-stats is the only tool with incremental SQLite-cached collection, model efficiency scoring, context analysis, and plan ROI tracking in a unified package.
