# Size budget

Rough numbers, to make the bundling argument concrete:

| Component | Size | Notes |
|---|---|---|
| Current 0.3.0 VSIX | ~2 MB | Webview + bundled MCP |
| MiniLM-L6-v2 int8 ONNX | ~23 MB | Already SHA-256-pinned |
| `@huggingface/transformers` JS | ~3 MB | Tree-shaken for inference-only |
| ONNX runtime native (per-platform) | ~6–10 MB | One per `os-arch` we ship |
| Model card + Apache-2.0 LICENSE | ~10 KB | |

**Single-platform VSIX (e.g. `darwin-arm64`):** ~32–35 MB.

**All-platforms VSIX:** ~55–65 MB. Above the soft norm but not above the
marketplace hard limit (which is implicit, but extensions of this size
publish fine).

VS Code's marketplace supports per-target VSIXes (`vsce package --target
darwin-arm64`, etc.), and the marketplace serves the right one to each user
based on `engines` and platform — this is the standard pattern for extensions
with native binaries (e.g. Pylance). That keeps download size at ~32 MB per
user. Recommendation: ship per-target VSIXes.

The WASM-backend alternative collapses this to a single ~30 MB cross-platform
VSIX, at a runtime cost that probably does not matter for daily-recap.
