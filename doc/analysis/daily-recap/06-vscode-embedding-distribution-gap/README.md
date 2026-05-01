# 06 — VS Code embedding-distribution gap

The 0.3.0 daily-recap release ships **embedding plumbing without an embedding
provider** through the VS Code surface. From a user installing the marketplace
extension, semantic clustering is not just opt-in — it is unreachable. This
document records the gap, why it matters, and what "ship the binary" means
concretely.

## Contents

1. [Status of `--embeddings` in 0.3.0](01-status.md)
2. [Why this matters](02-why-it-matters.md)
3. [What "ship the binary" should mean](03-ship-the-binary.md)
4. [Size budget](04-size-budget.md)
5. [Failure modes after bundling](05-failure-modes.md)
6. [Recommendations](06-recommendations.md)
7. [VS Code default — `auto`](07-default-mode.md)
8. [Privacy & security posture](08-privacy-security.md)
