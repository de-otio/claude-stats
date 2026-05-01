# Failure modes after bundling

| Failure | Behaviour today | Behaviour after bundling |
|---|---|---|
| User offline on first run | `auto` → no download → Jaccard silently | `auto` → bundled model loads → embeddings work |
| Marketplace-tampered VSIX | n/a | SHA-256 mismatch → model deleted from cache → fall back to Jaccard. **Note:** this means a tampered extension fails *quiet*, not loud. Consider raising a VS Code warning in this case. |
| User explicitly sets `claude-stats.recap.embeddings: "off"` | n/a (no setting) | Provider returns `null`; Jaccard. |
| ONNX runtime crashes at load | n/a | `createEmbeddingProvider` returns `null` (already defensive per `embeddings.ts:615`); Jaccard. Should also surface a one-time toast. |
