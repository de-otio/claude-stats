# What "ship the binary" should mean

There are three artefacts that have to make it into the user's machine for
the feature to work end-to-end:

1. **The runtime** — `@huggingface/transformers` (v3) plus the ONNX runtime it
   pulls in.
2. **The model file** — `model_quantized.onnx` (~23 MB, int8 MiniLM-L6-v2),
   SHA-256 pinned to `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`.
3. **The wiring** — `summarize_day` in the MCP server has to instantiate the
   provider and pass it to `buildDailyDigest`, gated on a setting.

Each has its own decisions; bundling vs. on-demand is a separate choice for
each.

## 3.1 Runtime — bundle, no question

`@huggingface/transformers` v3 is already declared as an optional dependency
of `packages/cli`. The VSIX build step (esbuild + `vsce package`) should
include it as a regular dependency for the extension. ONNX runtime ships
prebuilt native binaries for `darwin-{arm64,x64}`, `linux-{x64,arm64}`,
`win32-x64` — the standard four-platform matrix VS Code extensions already
target. Total size impact: ~15–25 MB depending on which platform binaries are
included (see [04-size-budget.md](04-size-budget.md)).

Alternative: `@huggingface/transformers` v3 supports a WASM/ONNX-Web backend
that does not need per-platform native binaries. Slower (~3–5×) but
cross-platform from a single bundle. Worth considering if the per-platform
matrix becomes painful, but a daily-recap workload is small (low hundreds of
short prompts per day) and a 5× slowdown is still <1 s.

## 3.2 Model — bundle, with caveats

The strategy doc and the source comment both mark bundling as the preferred
posture once size is acceptable. For a VS Code extension specifically, three
arguments push toward bundling:

- **Trust boundary.** The B1 doc is explicit: bundling "eliminates the trust
  boundary entirely." A model file in the VSIX is signed alongside the rest
  of the extension by the marketplace. A first-run download happens in the
  user's working environment, against a Hugging Face URL, with the SHA-256
  guard as the only protection. Bundling moves verification from runtime to
  publish time.
- **Discovery.** A bundled model means embeddings can default to `auto` and
  *just work* on first use — no consent prompt, no download progress UI, no
  silent failure when the user is offline. Discovery via the changelog is
  acceptable when the answer is "it's already on."
- **Marketplace size norms.** The VS Code marketplace soft-caps extensions
  around 50–100 MB; popular extensions (Pylance, Jupyter) ship ~30–80 MB
  routinely. A 23 MB ONNX file is well within norms.

Caveats:

- **LFS in the source repo.** Already flagged by `embeddings.ts`. Either
  commit the file via Git LFS, or fetch it from a pinned URL during
  `vsce package` (CI step) with the existing SHA-256 verification, and
  include the verified file in the VSIX without committing it. The latter
  keeps the source repo small and is the cleaner option.
- **Licence file.** MiniLM-L6-v2 is Apache-2.0. The model card and `LICENSE`
  must be included alongside the binary in the VSIX (e.g.
  `media/embed-model/{model_quantized.onnx,LICENSE,MODEL-CARD.md}`).
- **Per-architecture ONNX binaries.** This is the runtime, not the model.
  See §3.1.

## 3.3 Wiring — the MCP server has to opt in

The CLI does this today; the MCP server does not. The required change in
[packages/cli/src/mcp/index.ts](../../../../packages/cli/src/mcp/index.ts) is
small:

```ts
server.tool(
  "summarize_day",
  /* ...existing description... */,
  {
    date: z.string().optional()./* ... */,
    embeddings: z.enum(["on", "off", "auto"]).optional()
      .describe("Semantic clustering. 'auto' (default) uses embeddings if available. 'off' forces Jaccard."),
  },
  async ({ date, embeddings = "auto" }) => {
    const { createEmbeddingProvider } = await import("../recap/embeddings.js");
    const { buildDailyDigest } = await import("../recap/index.js");
    const embeddingProvider = await createEmbeddingProvider({
      mode: embeddings,
      modelDir: bundledModelDir(),  // points into the VSIX
    });
    const digest = await buildDailyDigest(store, { date, embeddingProvider });
    return formatResult(digest);
  },
);
```

Two non-obvious bits:

- `bundledModelDir()` resolves to the VSIX-internal model path
  (`<extensionPath>/media/embed-model/`). `createEmbeddingProvider` already
  does SHA-256 verification on whatever directory it loads from, so the
  bundled location gets the same integrity check as a downloaded one — a
  marketplace-tampered VSIX would fail open into Jaccard, exactly as a
  tampered download does.
- The MCP tool description should explicitly mention that embeddings are
  enabled by default; this is how Claude (the calling agent) and the user
  will *discover* the feature exists. The changelog is read once; the tool
  description is read every time the agent picks the tool.

## 3.4 VS Code surface

To make the feature discoverable by humans, not just the agent:

- A new setting `claude-stats.recap.embeddings: "auto" | "off"` (no `"on"`
  needed once bundled — `auto` always succeeds when the model is in the VSIX).
  Default `"auto"`.
- A one-line entry in `readme.md` under "What's included": *"Daily-recap
  digests with local semantic clustering (no data leaves your machine)."*
- The MCP-registration toast on first activation (already exists for failure
  cases, see 0.2.0 changelog) can be reused on success after a version bump
  to point users at `summarize_day`.
