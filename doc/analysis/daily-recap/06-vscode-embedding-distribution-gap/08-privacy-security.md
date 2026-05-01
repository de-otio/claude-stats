# Privacy & security posture

Bundling the model is a net improvement on data-egress and trust-boundary
dimensions, but it expands the local attack surface and inherits one
silent-fallback failure mode that deserves to be loud. Each axis below
compares "today (CLI-only `on` path with HuggingFace download)" to "after
bundling (model inside signed VSIX, default `auto`)".

## Privacy

| Dimension | Today | After bundling |
|---|---|---|
| Data egress | None at inference time. Model download from HuggingFace on first `on`. | None at inference time. **No download.** Third-party dependency at runtime is removed. |
| Data locality | All inference local. | All inference local. |
| Scope of code touching prompt text | Jaccard tokenization only (deterministic, small). | Jaccard **plus** MiniLM inference (in-process, on-device, but a wider code surface). |
| Telemetry / phone-home | None. | None. |

**Net:** small privacy *improvement*. Eliminating the first-run HuggingFace
fetch removes a third-party touchpoint from the boot path. Nothing leaves
the machine before or after.

## Security

| Dimension | Today | After bundling |
|---|---|---|
| Trust boundary for the model file | HuggingFace URL + SHA-256 pin checked at runtime. | Marketplace-signed VSIX, file verified at publish time. **Stronger.** |
| Native code surface in the extension process | None from this feature. | ONNX runtime native binary loaded on every recap. **New surface.** |
| Tamper detection | SHA-256 mismatch → file deleted from cache → fall back to Jaccard. | Same SHA-256 check on the bundled path. Mismatch falls back to Jaccard **silently**. |
| Cache hardening (`0o600`) | Applies — protects the downloaded model. | Moot — bundled file is read-only inside the extension dir. |

**Net:** trust boundary improves, native attack surface grows. The increase
is small — ONNX runtime is widely deployed and the bundled binaries match
those used by Pylance, Jupyter, and other major extensions — but it is
non-zero and worth acknowledging in the threat model.

## Failure-mode change worth fixing

Today, a tampered HuggingFace download silently falls back to Jaccard. The
user gets degraded clustering quality and no signal that anything went
wrong. That is acceptable when the download is rare and behind an explicit
`on` flag.

After bundling, the same silent fallback path runs on every install of a
tampered VSIX, with `auto` as the default. The integrity check is the same;
the consequence of triggering it is now a default-on user experience that
silently downgrades. **A SHA-256 mismatch on the bundled model is a security
event** (it implies marketplace tamper or local FS tamper) and should
surface as a VS Code warning, not a silent fallback. See
[06-recommendations.md](06-recommendations.md) item 7.
