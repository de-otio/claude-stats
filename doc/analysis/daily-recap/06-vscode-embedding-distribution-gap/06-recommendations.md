# Recommendations

In priority order:

1. **Wire `summarize_day` to call `createEmbeddingProvider`.** This is a
   ~15-line change and unblocks the VS Code surface from inheriting the gap
   even if bundling is deferred. Without this, no other work matters for VS
   Code users.
2. **Bundle the model in per-target VSIXes.** `darwin-{arm64,x64}`,
   `linux-{x64,arm64}`, `win32-x64`. CI step downloads the SHA-256-verified
   model, places it under `media/embed-model/`, and `vsce package` includes
   it. ~32 MB per user.
3. **Add the `claude-stats.recap.embeddings` setting** with a default of
   `"auto"`. The flag values map directly to `createEmbeddingProvider`'s
   `mode` parameter.
4. **Update the MCP tool description for `summarize_day`** to mention
   embeddings explicitly so the calling agent surfaces the capability when
   the user asks "can you cluster these better?".
5. **One line in `readme.md` and one line in the next changelog** confirming
   the feature is on by default in the extension. The changelog is the
   discovery channel; the readme is what the marketplace renders.
6. **Consider WASM backend as a fallback path** if per-target VSIX
   maintenance becomes painful, or if Linux ARM64 ONNX binary availability
   regresses. Not blocking.
7. **Raise a loud warning on SHA-256 mismatch.** Today the integrity check
   silently falls back to Jaccard. Once `auto` is the default and the model
   ships in a signed VSIX, a hash mismatch implies marketplace or local-FS
   tamper — that is a security event and should surface as a VS Code
   warning notification, not just a degraded clustering result. Pair with
   the existing fail-closed behaviour (delete the bad file, fall back to
   Jaccard) so the feature still works while flagging the anomaly. See
   [08-privacy-security.md](08-privacy-security.md).
8. **Acknowledge the new native code surface in the extension threat
   model.** Bundling adds the ONNX runtime native binary to the extension
   process. Risk is small (broadly deployed, used by Pylance/Jupyter) but
   non-zero. Track ONNX runtime CVEs alongside other native dependencies
   and pin to a known-good version in `package.json`.
