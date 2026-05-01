# B1 — Local embeddings for clustering

| | |
|---|---|
| Cost lever | Higher quality + lower LLM-fallback usage |
| When it pays off | Whenever segments touch *related but non-identical* files/prompts |
| Effort | Medium |

## Rationale

The v1 cluster step uses set-based similarity:

- File-path Jaccard for "did these segments touch the same code?"
- Prompt-prefix Jaccard (40% normalised match) for "are these the same
  task description?"

Set-based similarity is fast and zero-cost but blind to semantics:

| Pair | Jaccard signal | Truth |
|---|---|---|
| `"add russian locale"` vs `"add japanese locale"` | Low (0.33) | Same task family |
| `"fix the silent fallback bug"` vs `"investigate why fallbacks are silent"` | Low | Same task |
| `"refactor auth"` vs `"rewrite authentication"` | 0 | Same task |

A small local sentence-embedding model handles all three correctly via
cosine similarity on dense vectors.

## Suggested model

`all-MiniLM-L6-v2` (or any equivalent ≤30MB ONNX model):

- 384-dimensional vectors
- ~25MB on disk
- ~5ms per text on CPU (Node + onnxruntime-node)
- Trained on a generic semantic-similarity corpus — well-suited for
  short prompts and commit subjects

Embeddings are deterministic and cacheable per
`(model_id, sha256(text))`. A user with 10k unique prompts caches
~15MB of vectors total.

## Implementation sketch

New module `packages/cli/src/recap/embeddings.ts`:

```typescript
export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
}

export function createEmbeddingProvider(): EmbeddingProvider;
```

- Lazy-load `onnxruntime-node` so users not opting in don't pay the
  startup cost.
- Cache file: `~/.claude-stats/embed-cache/<model_id>.sqlite`,
  schema `(text_sha256 PRIMARY KEY, vector BLOB)`.
- Public API returns `Float32Array(384)` so callers can compute cosine
  similarity directly.

In `recap/cluster.ts`, replace prompt-prefix Jaccard with:

```
cosine(embedding(segmentA.firstPrompt), embedding(segmentB.firstPrompt)) >= 0.65
```

File-path Jaccard stays as-is — file paths are exact tokens, embeddings
add nothing there.

## Configuration / opt-in

Embeddings are **opt-in**. A `--embeddings=on|off|auto` flag on
`claude-stats recap`, defaulting to `auto`:

- `auto` → enable if the model file exists *and* its hash matches;
  otherwise fall back to Jaccard.
- `on` → enable; download the model on first use after explicit consent.
- `off` → strictly Jaccard.

Rationale: a 25MB model download should be an explicit user action, not
a silent install. The fallback to Jaccard means the recap still works
without embeddings.

## Model integrity (security)

A tampered embedding model is a real attack surface — adversarial
embeddings could manipulate clustering to surface or hide specific
activity. The implementation MUST:

1. **Pin a SHA-256 hash** of the chosen model file in source code
   (`packages/cli/src/recap/embeddings.ts`). Update with each model
   version bump.
2. **Pin the upstream URL** to a specific tagged release on a known
   host (e.g. Hugging Face's `huggingface.co/sentence-transformers/...`
   at a specific commit). Plain HTTPS, no following redirects to
   untrusted hosts.
3. **Verify the hash** after download, before first use. On hash
   mismatch, delete the file and refuse to enable embeddings; surface
   a clear error and fall back to Jaccard.
4. **Refuse user-supplied model paths.** No `--model-path` flag in v2.
   If a future release allows it, the same hash-pin requirement
   applies and there must be a separate explicit-trust flag.
5. **Bundling option.** If the 25MB size is acceptable for npm, prefer
   bundling the model in the package over downloading. This eliminates
   the trust boundary entirely. The cost is a larger install size; the
   benefit is no network dependency at runtime.

The model cache file lives at
`~/.claude-stats/embed-models/<model_id>-<sha256>.onnx` with mode `0600`.
The vector cache (per-text embeddings) lives separately in
`~/.claude-stats/embed-cache/<model_id>.sqlite`.

## Interaction with other strategies

- **[A2 — Tiered model routing](a2-tiered-model-routing.md):** B1
  removes most of A2's classifier traffic; the LLM-cluster fallback
  becomes vestigial when embeddings are on.
- **Supersedes the LLM-cluster fallback** described in
  [03-hybrid-pipeline.md](../03-hybrid-pipeline.md). Embeddings are
  cheaper, faster, and more deterministic.
- **[B2 — Confidence scores](b2-confidence-scores.md):** embedding
  similarity itself can feed into confidence — high cosine similarity
  between a digest item's first-prompt and a corresponding commit
  subject is a strong "this really shipped" signal.

## Privacy

Embeddings are computed locally; no text leaves the machine. The cache
file lives alongside `stats.db` with the same `0600` posture.
