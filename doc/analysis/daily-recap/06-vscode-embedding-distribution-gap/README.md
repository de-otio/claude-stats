# 06 — VS Code embedding-distribution gap

The 0.3.0 daily-recap release ships **embedding plumbing without an embedding
provider** through the VS Code surface. From a user installing the marketplace
extension, semantic clustering is not just opt-in — it is unreachable. This
document records the gap, why it matters, and what "ship the binary" means
concretely.

## Contents

- [02 — Why this matters](02-why-it-matters.md)
- [03 — What "ship the binary" should mean](03-ship-the-binary.md)
- [04 — Size budget](04-size-budget.md)
- [05 — Failure modes after bundling](05-failure-modes.md)
- [07 — VS Code default: `auto`](07-default-mode.md)
- [08 — Privacy & security posture](08-privacy-security.md)
