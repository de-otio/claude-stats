# Status of `--embeddings` in 0.3.0

| Surface | Wired up? | Discoverable? |
|---|---|---|
| Standalone CLI (`packages/cli/src/cli/index.ts`) | Yes — `createEmbeddingProvider` is imported and passed into `buildDailyDigest` ([cli/index.ts:597](../../../../packages/cli/src/cli/index.ts#L597)) | `claude-stats recap --help` only |
| MCP server `summarize_day` ([cli/src/mcp/index.ts](../../../../packages/cli/src/mcp/index.ts)) | **No.** The MCP entry point never imports `createEmbeddingProvider` and never sets `deps.embeddingProvider`. `buildDailyDigest` falls through to its `?? null` default. | n/a |
| VS Code extension (`extension/`) | n/a — the extension bundles the MCP server, so it inherits the MCP gap. There is no `claude-stats.embeddings` setting and no command. | No mention in `readme.md`; one line in `changelog.md`. |
| Bundled artefact in VSIX | The `dist/mcp.js` shipped in `de-otio.claude-stats-vscode-0.3.0` contains zero references to `MiniLM`, `huggingface`, or `transformers`. The model file is not bundled. The `@huggingface/transformers` runtime is not bundled. | n/a |

So the chain is: **VSIX user → MCP `summarize_day` → no provider → Jaccard
always.** The flag mentioned in the changelog (`--embeddings=on|off|auto`)
exists only on a separately-installed CLI binary that the extension does not
ship.

This was anticipated in the source — `embeddings.ts` carries the comment:

> Bundling a 23 MB model in the npm tarball would require LFS handling and
> licence-file inclusion that is out of scope for v2.03. Bundling can be
> revisited as a v2.X follow-up if package size is acceptable.

This document is that follow-up.
